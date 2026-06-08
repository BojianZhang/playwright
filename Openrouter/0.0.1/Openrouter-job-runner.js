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
const { runBatchOrchestration } = require('../../shared-batch-orchestration');
const { createBrowserRuntime } = require('../../shared-browser-runtime/create-browser-runtime');
const { runOpenrouterRegisterFlow } = require('./Openrouter-register');
const exportTemplates = require('./export-templates');
const { installTurnstileIntercept } = require('./openrouter-turnstile');
const { computeWorkerWindowLayout } = require('../../shared-window-layout');
const { execSync } = require('child_process');
let LAYOUT_PROFILE = {};
try { LAYOUT_PROFILE = require('../../shared-window-layout/window-layout-profile.json'); } catch (_e) { LAYOUT_PROFILE = {}; }

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
try { CONFIG = require('./config.json'); } catch (_e) { CONFIG = {}; }
try { CONFIG = deepMerge(CONFIG, require('./config.local.json')); } catch (_e) { /* optional */ }
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
    publish = () => {},
  } = opts;

  const startedAt = Date.now();
  const failureStats = { total: 0, byClass: {}, byReason: {} };
  const concurrency = Math.max(1, Number(runParams.concurrency) || 1);
  // 本 job 的实时计数（由 processTask 增减），配合全局信号量一起推给前端展示。
  const live = { running: 0, queued: 0, done: 0 };

  // 结果导出：成功账号实时写入文件（关页面也不丢；可在 /download?jobId= 下载）。
  const resultsDir = path.join(__dirname, CONFIG.output?.baseDir || 'batch-results');
  let successFile = '';
  try { fs.mkdirSync(resultsDir, { recursive: true }); successFile = path.join(resultsDir, `${jobId}-success.txt`); } catch (_e) { successFile = ''; }
  const recordSuccess = (rendered, raw) => {
    if (!successFile) return;
    try { fs.appendFileSync(successFile, `${rendered}\n`); } catch (_e) { /* ignore */ }
    try { fs.appendFileSync(path.join(resultsDir, `${jobId}-success.jsonl`), `${JSON.stringify(raw)}\n`); } catch (_e) { /* ignore */ }
  };

  publish(jobId, 'log', `job ${jobId} 启动：账号 ${accounts.length} 个，并发 ${concurrency}`);
  if (!CONFIG.captcha?.apiKey) publish(jobId, 'log', '⚠ 未配置 2Captcha key（config.local.json captcha.apiKey），Turnstile 无法求解');
  if (!CONFIG.mailbox?.apiKey) publish(jobId, 'log', '⚠ 未配置 Firstmail key（config.local.json mailbox.apiKey），邮箱验证无法读信');

  // 每账号一条任务。account/proxy 必须是顶层字段：task-queue 会把整个 item 包成
  // task.payload，orchestration 再以 task.payload.account 驱动 worker 状态。
  const tasks = accounts.map((account, i) => ({
    id: `acct-${i + 1}`,
    account,
    proxy: proxies.length ? proxies[i % proxies.length] : null,
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
  });
  const statsTimer = setInterval(emitStats, 1200);
  emitStats();

  try {
    await runBatchOrchestration({
    tasks,
    concurrency,
    runTask: ({ workerId, payload }) => processTask({
      workerId, concurrency, account: payload.account, proxy: payload.proxy,
      runParams, taskParams, successTemplate, failureStats, jobId, publish, live, emitStats, recordSuccess,
    }),
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
 * 重试用全新浏览器；只有最终结果才计入成功/失败统计与回显。
 */
const NON_RETRYABLE_REASONS = new Set(['ACCOUNT_ALREADY_EXISTS']);
async function processTask(ctx) {
  const { workerId, concurrency = 1, account, proxy, runParams, taskParams, successTemplate, failureStats, jobId, publish, live = {}, emitStats = () => {}, recordSuccess = () => {} } = ctx;
  const maxAttempts = Math.max(1, Number(process.env.OPENROUTER_MAX_ATTEMPTS) || Number(CONFIG?.batch?.maxAttempts) || 3);

  // 有头需要显示器：Linux 上若无 DISPLAY(没装/没起 Xvfb)则自动降级无头，避免启动崩溃。
  let headed = !!runParams.headed;
  if (headed && process.platform !== 'win32' && !process.env.DISPLAY) {
    headed = false;
    if (workerId === 1) publish(jobId, 'log', '⚠ 无 DISPLAY(未启动 Xvfb),有头模式自动降级为无头');
  }
  const slowMo = Number(CONFIG?.browser?.slowMo) || 0;

  // 并发错峰启动（仅首次）：避免多个 worker 同时打 Turnstile/2Captcha 造成拥塞与失败。
  if (concurrency > 1) {
    const staggerMs = (Number(CONFIG?.batch?.workerStartStaggerMs) || 1500) * ((workerId - 1) % concurrency);
    if (staggerMs > 0) await new Promise(r => setTimeout(r, staggerMs));
  }

  const attemptCtx = { workerId, concurrency, account, proxy, headed, slowMo, taskParams, jobId, publish, live, emitStats };
  let last = { success: false, reason: 'UNKNOWN' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await runAttempt({ ...attemptCtx, attempt });
    if (last.success) {
      const rendered = exportTemplates.render(successTemplate || CONFIG?.export?.template, last.payload || {});
      recordSuccess(rendered, last.payload || {});
      publish(jobId, 'account-success', { rendered, raw: last.payload, attempts: attempt });
      return { success: true };
    }
    if (NON_RETRYABLE_REASONS.has(last.reason) || attempt >= maxAttempts) break;
    publish(jobId, 'log', `W${workerId} ${account.email} 第 ${attempt}/${maxAttempts} 次失败(${last.reason}),换浏览器重试…`);
    publish(jobId, 'worker-update', { worker: { workerId, status: 'running', stage: `retry-${attempt + 1}`, account: account.email } });
    await new Promise(r => setTimeout(r, 1500 + (workerId % 5) * 300));
  }
  // 最终失败：计入统计 + 回显
  const failClass = classify(last.reason);
  recordFailure(failureStats, last.reason, failClass);
  publish(jobId, 'account-failed', { email: account.email, reason: last.reason, failClass, stage: last.stage, attempts: maxAttempts });
  publish(jobId, 'failure-stats', failureStats);
  return { success: false, reason: last.reason };
}

/**
 * 单次尝试：占槽 → 启动浏览器 → 跑注册流 → 关浏览器 → 释放槽。
 * 不直接做最终回显/统计，只返回 { success, reason, stage, payload }，由 processTask 汇总。
 */
async function runAttempt(actx) {
  const { workerId, concurrency = 1, account, proxy, headed, slowMo, taskParams, jobId, publish, live = {}, emitStats = () => {} } = actx;

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

  const baseLaunch = {
    headed, slowMo, windowLayout, extraArgs,
    proxy: proxy && proxy.server ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
    blockedResourceTypes: [],
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

  // 优先真实 Chrome 通道（过 Turnstile 更稳）；若该通道不可用（服务器未装 Chrome），回退内置 Chromium。
  const preferredChannel = CONFIG?.browser?.channel === '' ? undefined : (CONFIG?.browser?.channel || 'chrome');
  let runtimeBundle = null;
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

  // 安装 Turnstile 拦截 + 收集 Cloudflare 请求 URL（sitekey 兜底）。
  const cfRequestUrls = [];
  try {
    await installTurnstileIntercept(runtimeBundle.context);
    runtimeBundle.page.on('request', (req) => { if (req.url().includes('challenges.cloudflare.com')) cfRequestUrls.push(req.url()); });
  } catch (e) { /* 非致命 */ }

  const runtime = { headed, taskParams, ipCheck: runtimeBundle.ipCheck, config: CONFIG };

  try {
    const result = await runOpenrouterRegisterFlow({
      page: runtimeBundle.page,
      account,
      proxy: proxy || {},
      runtime,
      context: {
        cfRequestUrls,
        log: (m) => publish(jobId, 'log', `W${workerId} ${m}`),
        onStageStart: (stage) => publish(jobId, 'worker-update', {
          worker: { workerId, status: 'running', stage, account: account.email },
        }),
      },
    });

    if (result.success) {
      return { success: true, payload: result.detail?.deliveryPayload || {} };
    }
    return { success: false, reason: result.reason, stage: result.stage };
  } catch (error) {
    return { success: false, reason: 'REGISTER_FLOW_THREW', detail: String(error && error.stack || error) };
  } finally {
    if (runtimeBundle?.context) await runtimeBundle.context.close().catch(() => {});
    if (runtimeBundle?.browser) await runtimeBundle.browser.close().catch(() => {});
    releaseSlot(); // 浏览器关闭后再释放全局槽位
  }
}

// 临时分类：Step 7 会换成 failure-classifier.js。
function classify(reason) {
  const r = String(reason || '');
  if (/PROXY|BROWSER|TIMEOUT|CONNECT/i.test(r)) return 'proxy-soft';
  if (/REJECT|EXISTS|RATE_LIMIT|INVALID/i.test(r)) return 'business';
  return 'unknown';
}

function recordFailure(failureStats, reason, failClass) {
  failureStats.total += 1;
  failureStats.byClass[failClass] = (failureStats.byClass[failClass] || 0) + 1;
  failureStats.byReason[reason] = (failureStats.byReason[reason] || 0) + 1;
}

module.exports = { runJob };
