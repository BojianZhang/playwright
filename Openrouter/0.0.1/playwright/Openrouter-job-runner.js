'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / job-runner（Web ↔ 编排 桥）
//
// 文件定位：Openrouter/0.0.1/Openrouter-job-runner.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 接收 Web 表单组装的 job 配置，用 runBatchOrchestration 并发驱动每账号
//            自动化（createBrowserRuntime → runOpenrouterRegisterFlow → 关浏览器），
//            把进度/结果通过注入的 publish() 推到 event-bus（→ SSE）。
// ❌ 不负责 —— http / SSE 本身（web/server.js）、页面 DOM 操作（Sn-*/adapter.js）。
//
// 现状【Step 2】：阶段链为 no-op 占位（见 Openrouter-register.js），故每账号会真实
//   启动浏览器、做 IP 检测、跑空阶段后“成功”。验证浏览器启动 + onWorkerUpdate 流。
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const { runBatchOrchestration } = require('../../../shared-batch-orchestration');
const { createBrowserRuntime } = require('../../../shared-browser-runtime/create-browser-runtime');
const { runOpenrouterRegisterFlow } = require('./Openrouter-register');
const accountStore = require('../data/account-store');
const failurePolicy = require('./failure-policy');
const errorLog = require('./error-log');
const usageStore = require('../web/usage-store');
const proxyStore = require('../web/proxy-store');
const serviceKeys = require('../web/service-keys');
const exportTemplates = require('./export-templates');
const { installTurnstileIntercept } = require('./openrouter-turnstile');
const { installHCaptchaIntercept } = require('./openrouter-hcaptcha');
const { installStealth, IGNORE_DEFAULT_ARGS } = require('./openrouter-stealth');
const adspower = require('./openrouter-adspower');
const browserProviders = require('../browser-provider'); // 可插拔指纹浏览器层(adspower/bitbrowser/dolphin/…)
const { computeWorkerWindowLayout } = require('../../../shared-window-layout');
const { execSync } = require('child_process');
let LAYOUT_PROFILE = {};
try { LAYOUT_PROFILE = require('../../../shared-window-layout/window-layout-profile.json'); } catch (_e) { LAYOUT_PROFILE = {}; }

// 自动探测当前屏幕可用工作区。Windows 用 WinForms WorkingArea；Linux(含 Xvfb)用
// xdpyinfo / xrandr 读 DISPLAY 分辨率。探测一次缓存复用；失败返回 null（回退默认）。
let _SCREEN_CACHE; // undefined=未探测; null=失败; {width,height}=成功
function detectWorkspace() {
  if (_SCREEN_CACHE !== undefined) return _SCREEN_CACHE;
  const parse = (s) => { const m = String(s).match(/(\d{3,5})\s*x\s*(\d{3,5})/); return m ? { width: Number(m[1]), height: Number(m[2]) } : null; };
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; Write-Output ($b.Width.ToString()+\'x\'+$b.Height.ToString())"',
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
      ).trim();
      _SCREEN_CACHE = parse(out); if (_SCREEN_CACHE) return _SCREEN_CACHE;
    } else if (process.platform === 'darwin') {
      // macOS：osascript 读 Finder 桌面 bounds（形如 "0, 0, 1920, 1080" → 末两位为 W,H；非 WxH 格式,单独解析）。
      // 须在 DISPLAY 分支【之前】判 darwin：装了 XQuartz 的 Mac 也可能设了 DISPLAY,会误走 Linux 分支。
      const out = execSync(
        `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
        { encoding: 'utf8', timeout: 6000 },
      ).trim();
      const n = out.split(/[,\s]+/).map(Number).filter((v) => !Number.isNaN(v));
      if (n.length === 4 && n[2] > 0 && n[3] > 0) { _SCREEN_CACHE = { width: n[2], height: n[3] }; return _SCREEN_CACHE; }
    } else if (process.env.DISPLAY) {
      // Linux：优先 xdpyinfo，回退 xrandr
      try {
        const out = execSync("xdpyinfo | grep -m1 dimensions", { encoding: 'utf8', timeout: 6000 });
        _SCREEN_CACHE = parse(out); if (_SCREEN_CACHE) return _SCREEN_CACHE;
      } catch (_e) { /* try xrandr */ }
      const out2 = execSync("xrandr --current 2>/dev/null | grep -m1 '*'", { encoding: 'utf8', timeout: 6000 });
      _SCREEN_CACHE = parse(out2); if (_SCREEN_CACHE) return _SCREEN_CACHE;
    }
  } catch (_e) { /* fallthrough */ }
  _SCREEN_CACHE = null;
  return _SCREEN_CACHE;
}

// 合并 config.json + config.local.json（local 覆盖,放密钥,已 gitignore）。
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k];
  }
  return out;
}
let CONFIG = {};
try { CONFIG = require('../config/config.json'); } catch (_e) { CONFIG = {}; }
try { CONFIG = deepMerge(CONFIG, require('../config/config.local.json')); } catch (_e) { /* optional */ }
// 环境变量兜底密钥
if (process.env.OPENROUTER_CAPTCHA_KEY) CONFIG = deepMerge(CONFIG, { captcha: { apiKey: process.env.OPENROUTER_CAPTCHA_KEY } });
if (process.env.OPENROUTER_FIRSTMAIL_KEY) CONFIG = deepMerge(CONFIG, { mailbox: { apiKey: process.env.OPENROUTER_FIRSTMAIL_KEY } });

// ── 全局并发信号量 ────────────────────────────────────────────────────────
// 跨「所有 job / 所有用户」限制同时运行的浏览器总数，避免多用户同时提交把服务器打爆。
// 单个 job 内部仍由 runBatchOrchestration 按其 concurrency 调度；这里是更高一层的总闸。
function createSemaphore(max) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const waiters = [];
  return {
    get active() { return active; },
    get max() { return limit; },
    get waiting() { return waiters.length; },
    async acquire() {
      if (active < limit) { active += 1; return; }
      await new Promise((resolve) => waiters.push(resolve)); // 交接槽位：被唤醒即已持有，不再自增
    },
    release() {
      if (waiters.length) { waiters.shift()(); } // 把槽位直接交给下一个等待者（不减计数）
      else { active = Math.max(0, active - 1); }
    },
  };
}
// 根据服务器配置自动决定可同时跑多少浏览器（任务）。
// 优先级：环境变量 OPENROUTER_MAX_BROWSERS > config 显式数字 > 按 CPU/内存自动估算。
const os = require('os');
function resolveMaxBrowsers() {
  const env = Number(process.env.OPENROUTER_MAX_BROWSERS);
  if (env > 0) return { value: Math.floor(env), source: 'env' };
  const cfg = CONFIG?.batch?.maxGlobalConcurrency;
  if (Number(cfg) > 0) return { value: Math.floor(Number(cfg)), source: 'config' };
  // auto：每个浏览器约占 0.5GB 内存 + 一定 CPU。
  const cpus = (os.cpus() || []).length || 2;
  const totalGb = os.totalmem() / (1024 ** 3);
  const perBrowserGb = Number(CONFIG?.batch?.perBrowserMemGb) || 0.5;
  const byMem = Math.floor((totalGb * 0.7) / perBrowserGb); // 留 30% 给系统
  const byCpu = cpus * 2;                                   // 浏览器偏 I/O，可超配
  const value = Math.max(1, Math.min(32, byMem, byCpu));
  return { value, source: `auto(cpu=${cpus}, mem=${totalGb.toFixed(1)}GB → byMem=${byMem}, byCpu=${byCpu})` };
}
const _MAXB = resolveMaxBrowsers();
// eslint-disable-next-line no-console
console.log(`[Openrouter] 全局浏览器并发上限 = ${_MAXB.value} [${_MAXB.source}]`);
const GLOBAL_SEM = createSemaphore(_MAXB.value);

/**
 * 运行一个 job（fire-and-forget；调用方不 await，由 SSE 汇报进度）。
 *
 * @param {object} opts
 * @param {string}   opts.jobId
 * @param {Array<{email,password}>} opts.accounts
 * @param {Array<object>} [opts.proxies]
 * @param {object}   [opts.runParams]   { headed, concurrency, count, timeoutMs }
 * @param {object}   [opts.taskParams]  { apiKeyName, topUpAmount, card }
 * @param {string}   [opts.successTemplate]
 * @param {Function} opts.publish       (jobId, type, data) => void
 * @returns {Promise<object>} summary
 */
async function runJob(opts = {}) {
  const {
    jobId,
    accounts = [],
    proxies = [],
    runParams = {},
    taskParams = {},
    successTemplate = '',
    failureTemplate = '',
    publish = () => {},
  } = opts;

  const startedAt = Date.now();
  const failureStats = { total: 0, byClass: {}, byReason: {} };
  const concurrency = Math.max(1, Number(runParams.concurrency) || 1);
  // 本 job 的实时计数（由 processTask 增减），配合全局信号量一起推给前端展示。
  const live = { running: 0, queued: 0, done: 0 };

  // 结果导出：成功账号实时写入文件（关页面也不丢；可在 /download?jobId= 下载）。
  const resultsDir = path.join(__dirname, '..', CONFIG.output?.baseDir || 'data/batch-results');
  let successFile = '';
  let dirOk = false; // 目录真建成才落盘;resultsDir 是路径串恒真,不能拿它当守卫(否则建目录失败时成败两路不对称)
  try { fs.mkdirSync(resultsDir, { recursive: true }); dirOk = true; successFile = path.join(resultsDir, `${jobId}-success.txt`); } catch (_e) { successFile = ''; }
  // 资源使用记录(诊断/排查用):host 反查 proxyId;Node 引擎 envId 来自 raw.adspowerEnvId。
  const _pxByHost = new Map(proxyStore.list().map((p) => [p.host, p.id]));
  const _usage = (raw, ok) => {
    try {
      const host = String(raw.proxy || '').split(':')[0];
      usageStore.record({ jobId, engine: 'playwright', email: raw.email || '', host, exitIp: raw.exitIp || '', proxyId: _pxByHost.get(host) || '', cardLast4: raw.cardLast4 || '', envId: raw.adspowerEnvId || '', endpoint: '', stage: raw.stage || (ok ? 'done' : ''), ok, reason: raw.reason || '' });
    } catch (_e) { /* 使用记录失败不致命 */ }
  };
  // 写盘失败不再静默(rel-5):磁盘满时成功账号会丢且 job 仍报"完成",/download 与聚合拿到残缺数据。
  // 至少在运行日志告警一次(不刷屏),让操作员知道结果可能不全。
  let _resultWriteWarned = false;
  const _warnWrite = (e) => {
    if (_resultWriteWarned) return; _resultWriteWarned = true;
    publish(jobId, 'log', `⚠ 结果文件写入失败(成功/失败账号可能未落盘,下载与结果聚合会不全): ${e && e.message}`);
  };
  const recordSuccess = (rendered, raw) => {
    if (!dirOk) return;
    try { fs.appendFileSync(successFile, `${rendered}\n`); fs.appendFileSync(path.join(resultsDir, `${jobId}-success.jsonl`), `${JSON.stringify(raw)}\n`); } catch (e) { _warnWrite(e); }
    _usage(raw, true);
  };
  // 失败账号也落盘（email:password:reason 等），方便复盘/重跑。
  const recordFailed = (rendered, raw) => {
    if (!dirOk) return;
    try { fs.appendFileSync(path.join(resultsDir, `${jobId}-failed.txt`), `${rendered}\n`); fs.appendFileSync(path.join(resultsDir, `${jobId}-failed.jsonl`), `${JSON.stringify(raw)}\n`); } catch (e) { _warnWrite(e); }
    _usage(raw, false);
  };

  publish(jobId, 'log', `job ${jobId} 启动：账号 ${accounts.length} 个，并发 ${concurrency}`);
  if (!CONFIG.captcha?.apiKey) publish(jobId, 'log', '⚠ 未配置 2Captcha key（config.local.json captcha.apiKey），Turnstile 无法求解');
  if (!CONFIG.mailbox?.apiKey) publish(jobId, 'log', '⚠ 未配置 Firstmail key（config.local.json mailbox.apiKey），邮箱验证无法读信');

  // 每账号一条任务。account/proxy 必须是顶层字段：task-queue 会把整个 item 包成
  // task.payload，orchestration 再以 task.payload.account 驱动 worker 状态。
  // 指纹浏览器接管：环境ID池（每账号一个，自带代理+指纹）。兼容旧 adspowerEnvIds。
  const envIds = Array.isArray(taskParams.browserEnvIds) ? taskParams.browserEnvIds.filter(Boolean)
    : (Array.isArray(taskParams.adspowerEnvIds) ? taskParams.adspowerEnvIds.filter(Boolean) : []);
  // 环境池(全 worker 共享，经闭包传入每个 task)：账号因本环境被目标站点风控而失败时，换一个【干净】环境重试，
  // 并把被烧环境本次 run 内全局规避。空池(原生模式/未配环境) → null，相关分支安全 no-op，行为与今天一致。
  const envPool = envIds.length ? browserProviders.createEnvPool(envIds) : null;
  const tasks = accounts.map((account, i) => ({
    id: `acct-${i + 1}`,
    account,
    proxy: proxies.length ? proxies[i % proxies.length] : null,
    proxies, // 全代理池：错误策略 retry-new-proxy 用来轮换
    adspowerEnvId: envIds.length ? envIds[i % envIds.length] : null,
  }));

  // 周期推送运行时统计：全局浏览器在用/上限/排队 + 本 job 运行中/排队/完成。
  const emitStats = () => publish(jobId, 'runtime-stats', {
    browsersActive: GLOBAL_SEM.active,
    browsersMax: GLOBAL_SEM.max,
    browsersQueued: GLOBAL_SEM.waiting,
    jobRunning: live.running,
    jobQueued: live.queued,
    jobDone: live.done,
    jobTotal: accounts.length,
    // 指纹环境池：总数 / 占用中 / 已被风控(烧)。让操作者实时看到环境被烧光时该补干净环境了。
    envTotal: envPool ? envPool.size : 0,
    envInUse: envPool ? envPool.inUseCount : 0,
    envBurned: envPool ? envPool.burnedCount : 0,
  });
  let statsTimer;

  try {
    statsTimer = setInterval(emitStats, 1200);   // 放进 try:setup 阶段抛错也能被 finally 的 clearInterval 兜底(be-6,无泄漏定时器)
    emitStats();
    await runBatchOrchestration({
    tasks,
    concurrency,
    runTask: async ({ workerId, payload }) => {
      try {
        return await processTask({
          workerId, concurrency, account: payload.account, proxy: payload.proxy, proxies: payload.proxies, adspowerEnvId: payload.adspowerEnvId, envPool,
          runParams, taskParams, successTemplate, failureTemplate, failureStats, jobId, publish, live, emitStats, recordSuccess, recordFailed,
        });
      } catch (e) {
        // processTask 设计上自报失败、不抛;万一意外抛出也记为失败,否则 summary.success=total-failed 会把它误算成成功。
        const email = (payload.account && payload.account.email) || '';
        try { recordFailure(failureStats, 'TASK_THREW', 'crash'); } catch (_e) { /* ignore */ }
        try { recordFailed(`${email} | TASK_THREW`, { email, reason: 'TASK_THREW', detail: String((e && e.message) || e) }); } catch (_e) { /* ignore */ }
        try { publish(jobId, 'log', `账号任务异常(已记失败): ${email} → ${(e && e.message) || e}`); } catch (_e) { /* ignore */ }
        return { success: false };
      }
    },
    onWorkerUpdate: (workerState, snapshot) => {
      publish(jobId, 'worker-update', {
        worker: {
          workerId: workerState.workerId,
          status: workerState.status,
          stage: workerState.stage || (workerState.detail && workerState.detail.stage) || '',
          account: workerState.account && workerState.account.email,
        },
        queueSummary: snapshot.queueSummary,
        workerSummary: snapshot.workerSummary,
      });
    },
    });
  } finally {
    clearInterval(statsTimer);
    emitStats();
  }

  // 从 failureStats 推回成功/失败计数（runBatchOrchestration 内部把 throw 当失败，
  // 但我们的 processTask 不 throw，靠 result.success 自报，这里统一汇总）。
  const total = accounts.length;
  const failed = failureStats.total;
  const summary = {
    jobId,
    total,
    success: total - failed,
    failed,
    failureStats,
    durationMs: Date.now() - startedAt,
  };
  publish(jobId, 'job-done', summary);
  return summary;
}

/**
 * 单账号任务（含失败自动重试）：循环尝试直到成功 / 永久失败 / 次数用尽。
 * 重试动作由 failure-policy 按错误路由（换代理 / 重登 / 拉黑 / 重试 / 放弃）。
 */
// 用已存状态拼交付 payload（预启动短路用，字段对齐 buildDeliveryPayload）。
function buildPayloadFromState(ps, tp) {
  return {
    email: ps.email || '',
    password: ps.loginPassword || ps.originalPassword || '',
    originalPassword: ps.originalPassword || '',
    mailboxPassword: ps.mailboxPassword || ps.originalPassword || '',
    passwordChanged: !!ps.passwordChanged,
    apiKey: ps.apiKey || '',
    apiKeyName: ps.apiKeyName || '',
    topUpAmount: Number(tp.topUpAmount) || 0,
    billingStatus: ps.billingStatus || 'skipped',
    charged: ps.charged || 0,
    cardLast4: ps.cardLast4 || '',
    proxy: '',
    exitIp: ps.exitIp || '',
    createdAt: ps.updatedAt || new Date().toISOString(),
    resumedFromCache: true,
  };
}

// 账号是否已对所选动作完全完成（可短路、无需开浏览器）。尊重阶段开关。
function isFullyDone(ps, tp) {
  if (!ps || !ps.registered) return false;
  if (tp.doApiKey !== false && !ps.apiKey) return false; // 需要取Key但没有 → 不短路
  if (!accountStore.billingSatisfied(ps.billingStatus, tp.billingAction || 'none')) return false;
  const unified = String(tp.unifiedPassword || '').trim();
  if (unified && ps.loginPassword && unified !== String(ps.loginPassword)) return false; // 密码不一致 → 不短路
  const wantPw = tp.doPasswordChange === true || (tp.doPasswordChange === undefined && !!unified);
  if (wantPw && !ps.passwordChanged) return false; // 要改密但还没改 → 不算完成
  return true;
}

// 换代理：从池里选下一个(next-index，按 raw 匹配)；≤1 个则原样返回。
function proxyKeyOf(p) { return p && (p.raw || (p.host ? `${p.host}:${p.port}` : '')); }
function proxyPicker(proxies, current) {
  if (!Array.isArray(proxies) || proxies.length <= 1) return current;
  const cur = proxyKeyOf(current);
  let idx = proxies.findIndex((p) => proxyKeyOf(p) === cur);
  if (idx < 0) idx = 0;
  return proxies[(idx + 1) % proxies.length];
}

async function processTask(ctx) {
  const { workerId, concurrency = 1, account, proxy, proxies = [], adspowerEnvId = null, envPool = null, runParams, taskParams, successTemplate, failureTemplate, failureStats, jobId, publish, live = {}, emitStats = () => {}, recordSuccess = () => {}, recordFailed = () => {} } = ctx;
  const maxAttempts = Math.max(1, Number(process.env.OPENROUTER_MAX_ATTEMPTS) || Number(CONFIG?.batch?.maxAttempts) || 3);

  // 预启动短路：断点续跑下，账号已对所选动作完全完成 → 直接用已存状态交付，不开浏览器。
  if (taskParams.resume !== false) {
    const ps = accountStore.get(account.email);
    if (isFullyDone(ps, taskParams)) {
      const payload = buildPayloadFromState(ps, taskParams);
      const rendered = exportTemplates.render(successTemplate || CONFIG?.export?.template, payload);
      recordSuccess(rendered, payload);
      publish(jobId, 'account-success', { rendered, raw: payload, attempts: 0 });
      publish(jobId, 'log', `W${workerId} ${account.email} 已完成(状态缓存)，跳过浏览器秒过`);
      return { success: true };
    }
    // 已拉黑(永久失败)的账号 → 直接判失败，不开浏览器。
    if (ps && ps.blacklisted) {
      const reason = ps.blacklistReason || 'BLACKLISTED';
      // 现密码=统一密码(设了就用)→ 否则台账已注册 loginPassword → 否则原密码;originalPassword 保持原密码。默认未设统一密码且 ps 无 loginPassword → 回退原密码,逐字节不变。
      const _blPw = String(taskParams.unifiedPassword || '').trim() || ps.loginPassword || account.password || '';
      const failRaw = { email: account.email || '', password: _blPw, originalPassword: account.password || '', reason, stage: 'blacklist', failClass: 'business', attempts: 0, detail: '账号已拉黑(永久失败)，如需重试请在「账号状态」重置', proxy: '', createdAt: new Date().toISOString() };
      const rendered = exportTemplates.render(failureTemplate || '{{email}}:{{password}}:{{reason}}', failRaw);
      recordFailed(rendered, failRaw);
      recordFailure(failureStats, reason, 'business');
      publish(jobId, 'account-failed', { ...failRaw, rendered });
      errorLog.record({ email: account.email, stage: 'blacklist', reason, action: 'blacklist', attempt: 0, jobId }).catch(() => {});
      publish(jobId, 'log', `W${workerId} ${account.email} 已拉黑(${reason})，跳过`);
      return { success: false, reason };
    }
  }

  // 有头需要显示器：【仅 Linux】上若无 DISPLAY(没装/没起 Xvfb)才自动降级无头，避免启动崩溃。
  // macOS 有原生 Quartz 显示、不靠 X11 DISPLAY → 绝不能在此把 Mac 降级(否则有头永远失效、detectWorkspace 的
  // darwin 屏幕探测分支永不触发);Windows 同理有原生 GUI。原条件 `!== 'win32'` 误把 macOS 也降级了。
  let headed = !!runParams.headed;
  if (headed && process.platform === 'linux' && !process.env.DISPLAY) {
    headed = false;
    if (workerId === 1) publish(jobId, 'log', '⚠ 无 DISPLAY(未启动 Xvfb),有头模式自动降级为无头');
  }
  const slowMo = Number(CONFIG?.browser?.slowMo) || 0;

  // 并发错峰启动（仅首次）：避免多个 worker 同时打 Turnstile/2Captcha 造成拥塞与失败。
  if (concurrency > 1) {
    const staggerMs = (Number(CONFIG?.batch?.workerStartStaggerMs) || 1500) * ((workerId - 1) % concurrency);
    if (staggerMs > 0) await new Promise(r => setTimeout(r, staggerMs));
  }

  const attemptCtx = { workerId, concurrency, account, headed, slowMo, taskParams, jobId, publish, live, emitStats, adspowerEnvId };
  let last = { success: false, reason: 'UNKNOWN' };
  let made = 0; // 实际尝试次数
  let curProxy = proxy;     // 可换：retry-new-proxy 时轮换
  let overrideMode = null;  // relogin 时下次强制登录模式
  const budget = {};        // 每动作的内层重试预算
  let curEnv = adspowerEnvId;            // 本账号当前环境(初始=静态分配，亲和保留热身会话/代理)；retry-new-env 时换干净环境
  // 每账号最多换几次环境：默认把池里【其它】环境各试一遍(size-1)；可经 env/config 调小。仍受 maxAttempts 硬顶兜底。
  const envRotateCap = Number(process.env.OPENROUTER_MAX_ENV_ROTATIONS) || Number(CONFIG?.batch?.maxEnvRotations) || 0;
  const envRotateMax = envPool ? (envRotateCap > 0 ? Math.min(envRotateCap, envPool.size - 1) : Math.max(0, envPool.size - 1)) : 0;
  let poolWaits = 0;                      // 环境池暂满时连续等待次数(有上限，超了按可重试错误收口)
  const maxPoolWaits = Number(process.env.OPENROUTER_MAX_ENV_POOL_WAITS) || 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    made = attempt;
    // 为本次尝试【占用】一个环境：优先 curEnv(亲和)，被烧的环境 acquire 内部自动跳过。
    // 池满(其它 worker 正占着所有可用环境) → acquire 返回 null：绝不退回 curEnv 裸开!
    //   裸开会与持锁 worker 双开同一指纹环境(违反独占)，且谁先结束就把对方的环境关掉。
    //   → 退避后重试占用(不计入尝试次数)，连续多次仍占不到才按可重试错误收口。
    let leasedEnv = null;
    if (envPool && envPool.size) {
      leasedEnv = envPool.acquire(curEnv);
      if (leasedEnv) {
        curEnv = leasedEnv; poolWaits = 0;
      } else {
        poolWaits += 1;
        if (poolWaits > maxPoolWaits) {
          publish(jobId, 'log', `W${workerId} ${account.email} 环境池持续繁忙(${maxPoolWaits} 次仍无空闲) → 本轮放弃，请加环境或降并发后重跑`);
          last = { success: false, code: 'ENV_POOL_BUSY', reason: 'ENV_POOL_BUSY', stage: '' };
          break;
        }
        publish(jobId, 'log', `W${workerId} ${account.email} 环境池暂满(无空闲干净环境)，退避后重试占用 (${poolWaits}/${maxPoolWaits})…`);
        await new Promise(r => setTimeout(r, 1500 + (workerId % 5) * 300));
        attempt -= 1; // 没开浏览器/没跑流程 → 不计入尝试次数
        continue;
      }
    }
    try {
      // 有池时只用【已租到】的 leasedEnv(绝不裸开)；无池(原生模式)沿用原静态 adspowerEnvId，行为不变。
      last = await runAttempt({ ...attemptCtx, proxy: curProxy, overrideMode, attempt, adspowerEnvId: (envPool && envPool.size) ? leasedEnv : adspowerEnvId });
    } finally {
      if (leasedEnv) envPool.release(leasedEnv);
    }
    if (last.success) {
      const sp = last.payload || {};
      if (!sp.proxy) sp.proxy = proxyKeyOf(curProxy) || '';
      if (!sp.adspowerEnvId) sp.adspowerEnvId = curEnv || adspowerEnvId || '';
      const rendered = exportTemplates.render(successTemplate || CONFIG?.export?.template, sp);
      recordSuccess(rendered, sp);
      publish(jobId, 'account-success', { rendered, raw: sp, attempts: attempt });
      return { success: true };
    }
    // 账单服务端/网关错 或 declined换卡用尽(本环境疑似被目标站点风控/IP脏) → 优先换一个【干净】环境重试(抢在 classify→abort 之前)。
    // 只认细码 last.reason(=BILLING_SERVER_ERROR / BILLING_DECLINED_EXHAUSTED)：笼统的 last.code 是 'BILLING_FAILED'(→abort)，不能用它判定。
    const billEnvRotate = last.reason === 'BILLING_SERVER_ERROR' || last.reason === 'BILLING_DECLINED_EXHAUSTED';
    if (envPool && envPool.size && billEnvRotate) {
      envPool.markBurned(curEnv);
      budget['env-rotate'] = (budget['env-rotate'] || 0) + 1;
      if (budget['env-rotate'] <= envRotateMax && attempt < maxAttempts && envPool.hasFresh()) {
        errorLog.record({ email: account.email, stage: last.stage, reason: last.reason, action: 'retry-new-env', attempt, jobId }).catch(() => {});
        const why = last.reason === 'BILLING_DECLINED_EXHAUSTED' ? '换卡均被拒(疑IP/AVS风控)' : '付款服务端错误(疑似被风控)';
        publish(jobId, 'log', `W${workerId} ${account.email} 环境 ${curEnv} ${why} → 换干净环境(新IP+刷指纹)重试 (${budget['env-rotate']}/${envRotateMax})`);
        publish(jobId, 'worker-update', { worker: { workerId, status: 'running', stage: `retry-env-${attempt + 1}`, account: account.email } });
        await new Promise(r => setTimeout(r, 1500 + (workerId % 5) * 300));
        continue; // 不走 classify(否则 BILLING_FAILED→abort)；下一轮 acquire 自动挑未试·未烧的环境
      }
      publish(jobId, 'log', `W${workerId} ${account.email} 环境 ${curEnv} 疑似被风控，但暂无其它干净环境可换 → 按账单失败处理`);
      // 落到下面 classify('BILLING_FAILED')→abort(今天的行为，不变)
    }
    // 错误 → 恢复动作：用稳定错误码(rcode)分类/路由/记录，而非原始报错文本。
    const rcode = last.code || last.reason || 'UNKNOWN';
    const { action, maxRetries } = failurePolicy.classify(rcode);
    errorLog.record({ email: account.email, stage: last.stage, reason: rcode, action, attempt, jobId }).catch(() => {});
    if (action === 'blacklist') {
      try { await accountStore.update(account.email, { blacklisted: true, blacklistReason: rcode }); }
      catch (e) { publish(jobId, 'log', `W${workerId} ⚠ 拉黑落盘失败 ${account.email}(下次可能重复跑该号): ${e && e.message}`); }   // rel-4:不再静默
      publish(jobId, 'log', `W${workerId} ${account.email} 判定拉黑(${rcode})，不再重试`);
      break;
    }
    budget[action] = (budget[action] || 0) + 1;
    if (action === 'abort' || budget[action] > maxRetries || attempt >= maxAttempts) break;
    let how = '重试';
    if (action === 'retry-new-proxy') { const np = proxyPicker(proxies, curProxy); how = (proxyKeyOf(np) !== proxyKeyOf(curProxy)) ? `换代理(${proxyKeyOf(np) || '无'})` : '重试(无备用代理)'; curProxy = np; }
    else if (action === 'relogin') { overrideMode = 'login'; how = '重新登录'; }
    publish(jobId, 'log', `W${workerId} ${account.email} 第 ${attempt}/${maxAttempts} 次失败(${rcode}) → ${how}…`);
    publish(jobId, 'worker-update', { worker: { workerId, status: 'running', stage: `retry-${attempt + 1}`, account: account.email } });
    await new Promise(r => setTimeout(r, 1500 + (workerId % 5) * 300));
  }
  // 最终失败：reason 用稳定错误码(分组/策略/回显键)，原始报错文本进 detail。
  const code = last.code || last.reason || 'UNKNOWN';
  const rawMsg = (last.reason && last.reason !== code) ? last.reason : last.detail;
  const failClass = classify(code);
  recordFailure(failureStats, code, failClass);
  // 失败号「现密码」与成功号(buildPayloadFromState/register 交付)口径对齐:当前真实 OpenRouter 登录密码
  //   = 统一密码(设了就用)→ 否则状态库已注册的 loginPassword → 否则原始输入密码。originalPassword 始终=原密码不动。
  //   默认(未设统一密码且未注册成功)→ 回退 account.password,逐字节不变。priorState 是 runAttempt 局部、此处不可见 → accountStore.get 重读(line 341 已有先例)。
  const _unified = String(taskParams.unifiedPassword || '').trim();
  const _ps = accountStore.get(account.email);
  const _curPw = _unified || (_ps && _ps.loginPassword) || account.password || '';
  const failRaw = {
    email: account.email || '',
    password: _curPw,
    originalPassword: account.password || '',
    reason: code,
    stage: last.stage || '',
    failClass,
    attempts: made,
    detail: (rawMsg ? String(rawMsg).slice(0, 300) : ''),
    proxy: proxyKeyOf(curProxy) || '',
    adspowerEnvId: curEnv || adspowerEnvId || '',
    createdAt: new Date().toISOString(),
  };
  const failRendered = exportTemplates.render(failureTemplate || '{{email}}:{{password}}:{{reason}}', failRaw);
  recordFailed(failRendered, failRaw);
  publish(jobId, 'account-failed', { ...failRaw, rendered: failRendered });
  publish(jobId, 'failure-stats', failureStats);
  return { success: false, reason: code };
}

/**
 * 单次尝试：占槽 → 启动浏览器 → 跑注册流 → 关浏览器 → 释放槽。
 * 不直接做最终回显/统计，只返回 { success, reason, stage, payload }，由 processTask 汇总。
 */
async function runAttempt(actx) {
  const { workerId, concurrency = 1, account, proxy, headed, slowMo, taskParams, jobId, publish, live = {}, emitStats = () => {}, overrideMode = null, adspowerEnvId = null } = actx;

  // 窗口平铺布局：按 workerId/并发数计算位置，避免有头模式下窗口全叠在一起。
  // 工作区尺寸优先级：config 显式数字 > 自动探测当前屏幕 > profile 默认。
  const winCfg = CONFIG?.browser?.window || {};
  const display = { ...(LAYOUT_PROFILE.display || {}), ...winCfg };
  const cfgW = Number(winCfg.workspaceWidth); const cfgH = Number(winCfg.workspaceHeight);
  if (!(cfgW > 0) || !(cfgH > 0)) {
    const screen = headed ? detectWorkspace() : null;
    if (screen) {
      display.workspaceWidth = screen.width;
      display.workspaceHeight = screen.height;
      display.taskbarReservedPx = 0; // WorkingArea 已排除任务栏
      if (workerId === 1) publish(jobId, 'log', `自动探测屏幕工作区: ${screen.width}x${screen.height}`);
    }
  }
  const profile = { ...LAYOUT_PROFILE, display };
  // 关键：为“当前并发”注入一个保证够用的网格档位（presets 是按最接近挑选，中间值会缺格导致窗口溢出屏幕）。
  const maxCols = Math.max(1, Number(profile.defaults?.maxAutoColumns) || 5);
  const cols = Math.min(maxCols, Math.ceil(Math.sqrt(concurrency)));
  const rows = Math.ceil(concurrency / cols);
  const scale = concurrency <= 4 ? 1 : concurrency <= 9 ? 0.85 : concurrency <= 16 ? 0.72 : 0.6;
  profile.presets = { ...(profile.presets || {}), [String(concurrency)]: { cols, rows, scale, usageRatio: 0.96, mode: 'grid' } };
  const windowLayout = headed ? computeWorkerWindowLayout({ workerId, concurrency, profile }) : null;

  // Turnstile 需要真实 Chrome 通道 + 隐藏自动化特征（见记忆 openrouter-turnstile-solution）。
  // 注意：故意不拦截图片/字体，避免影响 Clerk/Turnstile 资源加载。
  // Linux/Docker 必需参数，避免沙箱/共享内存导致 Chrome 崩溃。
  const extraArgs = ['--disable-blink-features=AutomationControlled'];
  if (process.platform !== 'win32') extraArgs.push('--no-sandbox', '--disable-dev-shm-usage');

  // 降低 Stripe 付款风控：浏览器语言/时区必须与美国代理 IP 一致——否则「IP 在美国、时区在亚洲」
  // 是 Stripe Radar 头号高风险信号，会触发 hCaptcha 九宫格 + Error 502。
  // 这里强制 en-US + 随机一个美国时区（覆盖共享 fingerprint.js 里会随机到 Asia 的默认池）。
  const US_TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
  const usTimezone = US_TIMEZONES[Math.floor(Math.random() * US_TIMEZONES.length)];
  const baseLaunch = {
    headed, slowMo, windowLayout, extraArgs,
    proxy: proxy && proxy.server ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
    blockedResourceTypes: [],
    // userAgent:null → 用真实 Chrome 自身 UA(与 Client Hints 一致，避免覆写池版本对不上而露馅)。
    runtime: { locale: 'en-US', timezoneId: usTimezone, userAgent: null, enableRandomFingerprint: true },
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS, // 去掉 --enable-automation 等自动化开关(反检测)
    browserIpCheckTimeoutMs: Number(CONFIG?.proxy?.connectivityTimeoutMs) || 8000,
  };
  // 全局并发闸：占用一个浏览器槽位（满了就排队），保证多用户/多任务下浏览器总数受控。
  const willQueue = GLOBAL_SEM.active >= GLOBAL_SEM.max;
  if (willQueue) {
    live.queued = (live.queued || 0) + 1;
    publish(jobId, 'worker-update', { worker: { workerId, status: 'queued', stage: 'waiting-slot', account: account.email } });
    emitStats();
  }
  await GLOBAL_SEM.acquire();
  if (willQueue) live.queued = Math.max(0, (live.queued || 0) - 1);
  live.running = (live.running || 0) + 1;
  emitStats();
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      live.running = Math.max(0, (live.running || 0) - 1);
      GLOBAL_SEM.release();
      emitStats();
    }
  };

  // 反检测模式选择：
  //   AdsPower 接管(useAdsPower + 分到 env) → 用 AdsPower 指纹浏览器(自带代理+指纹)，CDP 接管，过 Stripe 最稳；
  //   否则 → 原生 Playwright(真实 Chrome 通道 + stealth 补丁 + 去自动化开关)。
  // 指纹浏览器 provider(可插拔)。向后兼容：旧 useAdsPower 勾选映射成 adspower。
  const browserProvider = (taskParams.browserProvider && taskParams.browserProvider !== 'none')
    ? taskParams.browserProvider
    : (taskParams.useAdsPower ? 'adspower' : 'none');
  const useAds = browserProvider !== 'none' && !!adspowerEnvId;
  let runtimeBundle = null;
  let adsUserId = null;
  if (useAds) {
    adsUserId = adspowerEnvId;
    publish(jobId, 'log', `W${workerId} 用 ${browserProvider} 环境 ${adsUserId} 接管(自带代理+指纹)`);
    try {
      runtimeBundle = await browserProviders.createRuntime(browserProvider, adsUserId, { headless: !headed, windowLayout, log: (m) => publish(jobId, 'log', `W${workerId} ${m}`) });
    } catch (error) {
      releaseSlot();
      return { success: false, reason: 'BROWSER_PROVIDER_LAUNCH_FAILED', detail: String(error?.message || error) };
    }
  } else {
    // 优先真实 Chrome 通道（过 Turnstile 更稳）；若不可用回退内置 Chromium。
    const preferredChannel = CONFIG?.browser?.channel === '' ? undefined : (CONFIG?.browser?.channel || 'chrome');
    try {
      runtimeBundle = await createBrowserRuntime({ ...baseLaunch, channel: preferredChannel });
    } catch (error) {
      if (preferredChannel) {
        publish(jobId, 'log', `W${workerId} ${preferredChannel} 通道不可用,回退内置 Chromium: ${String(error?.message || error).slice(0, 120)}`);
        try {
          runtimeBundle = await createBrowserRuntime({ ...baseLaunch, channel: undefined });
        } catch (error2) {
          releaseSlot();
          return { success: false, reason: 'BROWSER_LAUNCH_FAILED', detail: String(error2?.message || error2) };
        }
      } else {
        releaseSlot();
        return { success: false, reason: 'BROWSER_LAUNCH_FAILED', detail: String(error?.message || error) };
      }
    }
    // 原生模式打 stealth 反检测补丁（AdsPower 模式不需要，其自身指纹已处理）。
    try { await installStealth(runtimeBundle.context); } catch (_e) { /* 非致命 */ }
  }

  // 安装 Turnstile 拦截 + 收集 Cloudflare 请求 URL（sitekey 兜底）。
  const cfRequestUrls = [];
  try {
    await installTurnstileIntercept(runtimeBundle.context);
    await installHCaptchaIntercept(runtimeBundle.context); // 加卡/付款阶段 Stripe 会弹 hCaptcha
    runtimeBundle.page.on('request', (req) => { if (req.url().includes('challenges.cloudflare.com')) cfRequestUrls.push(req.url()); });
  } catch (e) { /* 非致命 */ }

  // 断点续跑：加载该账号已存进度。registered → 强制登录(不重注册)；密码以已存为准并对不一致告警。
  const resume = taskParams.resume !== false;
  const priorState = resume ? accountStore.get(account.email) : null;
  if (priorState && String(taskParams.unifiedPassword || '').trim() && priorState.loginPassword
      && String(taskParams.unifiedPassword).trim() !== String(priorState.loginPassword)) {
    publish(jobId, 'log', `W${workerId} ⚠ ${account.email} 本次统一密码与已存登录密码不一致，续跑沿用已存密码（如需轮换请先在「账号状态」重置该账号）`);
  }
  // 登录模式来源：错误策略 relogin 的本次 override > 已注册账号续跑强制登录 > 原 mode。
  const effectiveTaskParams = (overrideMode || (priorState && priorState.registered))
    ? { ...taskParams, mode: overrideMode || 'login' }
    : taskParams;
  // 验证码/邮箱 key 池:用选用的 key 覆盖本次流程的 config(池空则等同原 CONFIG);不碰求解逻辑。
  // 跨节点下发时 taskParams 里带了中心机复制来的 key → applyToConfig 优先用它(覆盖本机池/config)。
  const runtime = { headed, taskParams: effectiveTaskParams, priorState, resume, ipCheck: runtimeBundle.ipCheck, config: serviceKeys.applyToConfig(CONFIG, taskParams), adspower: runtimeBundle.adspower, providerMeta: runtimeBundle.providerMeta };

  try {
    const result = await runOpenrouterRegisterFlow({
      page: runtimeBundle.page,
      account,
      proxy: proxy || {},
      runtime,
      context: {
        cfRequestUrls,
        workerId,
        jobId,
        log: (m) => publish(jobId, 'log', `W${workerId} ${m}`),
        onStageStart: (stage) => publish(jobId, 'worker-update', {
          worker: { workerId, status: 'running', stage, account: account.email },
        }),
        // 卡池实时统计推送(billing 阶段调用)。
        onCard: (pool, last) => publish(jobId, 'card-stats', { pool, last }),
        // 充值台账实时推送(billing 阶段每账号终态)。
        onBilling: (summary, last) => publish(jobId, 'billing-stats', { summary, last }),
        // 账号进度落盘(支撑断点续跑；成功/失败都写部分进度)。update 是 async(mutex),
        // 必须接住 Promise 拒绝(否则 unhandledRejection)+ 落盘失败要告警(sec-1/rel-4),别静默吞。
        saveState: (snap) => { Promise.resolve(accountStore.update(snap.email, snap)).catch((e) => publish(jobId, 'log', `W${workerId} ⚠ 进度落盘失败 ${snap.email}: ${e && e.message}`)); },
      },
    });

    if (result.success) {
      return { success: true, payload: result.detail?.deliveryPayload || {} };
    }
    // code = 稳定错误码(阶段的 state)，用于分类/分组/策略；reason 可能是原始报错文本，留作 detail。
    return { success: false, code: result.state || result.reason, reason: result.reason, stage: result.stage };
  } catch (error) {
    return { success: false, code: 'REGISTER_FLOW_THREW', reason: 'REGISTER_FLOW_THREW', stage: '', detail: String(error && error.stack || error) };
  } finally {
    if (useAds) {
      // CDP 接管：断开连接 + 调对应指纹浏览器 API 关闭该环境（不直接关 context，避免影响其客户端）。
      if (runtimeBundle?.browser) await runtimeBundle.browser.close().catch(() => {});
      if (adsUserId) await browserProviders.stopRuntime(browserProvider, adsUserId).catch(() => {});
    } else {
      if (runtimeBundle?.context) await runtimeBundle.context.close().catch(() => {});
      if (runtimeBundle?.browser) await runtimeBundle.browser.close().catch(() => {});
    }
    releaseSlot(); // 浏览器关闭后再释放全局槽位
  }
}

// 临时分类：Step 7 会换成 failure-classifier.js。
function classify(reason) {
  const r = String(reason || '');
  if (/PROXY|BROWSER|TIMEOUT|CONNECT/i.test(r)) return 'proxy-soft';
  if (/REJECT|EXISTS|RATE_LIMIT|INVALID|NOT_ALLOWED|LOCKED/i.test(r)) return 'business';
  return 'unknown';
}

function recordFailure(failureStats, reason, failClass) {
  failureStats.total += 1;
  failureStats.byClass[failClass] = (failureStats.byClass[failClass] || 0) + 1;
  failureStats.byReason[reason] = (failureStats.byReason[reason] || 0) + 1;
}

module.exports = { runJob, isFullyDone, buildPayloadFromState, proxyPicker };
