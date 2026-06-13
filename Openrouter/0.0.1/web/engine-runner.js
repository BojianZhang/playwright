'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 多引擎启动器 — Openrouter / web / engine-runner
//
// 把 web 控制台的「开始执行」对接到 Python 流水线:
//   selenium → run.py(纯 Selenium)   hybrid → hybrid_run.py(Playwright+Selenium 混合)
//   split    → 随机分流:groupA 跑 run.py + groupB 跑 hybrid_run.py 并发
// spawn 子进程 → readline 逐行读 stdout/stderr → eventBus.publish(jobId,'log',line);
// 解析单号结果行累加 ok/fail;进程结束读结果文件本次新增行 → job-done + 返回 summary(给 runs-store)。
// 零依赖、CommonJS。playwright(Node)引擎不走这里,仍走 Openrouter-job-runner.runJob。
// ═══════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const tempInputs = require('./temp-inputs');
const procRegistry = require('./proc-registry');
const configRw = require('./config-rw');
const usageStore = require('./usage-store');
const proxyStore = require('./proxy-store');
const adspowerEndpointStore = require('./adspower-endpoint-store');
const serviceKeys = require('./service-keys');

const SELENIUM_DIR = path.join(__dirname, '..', 'selenium-e2e');
const STATE_DIR = path.join(SELENIUM_DIR, 'state');
const RESULTS = {
  selenium: path.join(STATE_DIR, 'results.jsonl'),
  hybrid: path.join(STATE_DIR, 'hybrid_results.jsonl'),
};

function pythonBin() {
  return process.env.OPENROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch (_e) { return 0; }
}
// stats(可选):{ dropped } 累加无法解析的行数 —— 调用方据此告警「部分结果行损坏」,
// 不再把坏行静默丢弃当作"没有这些账号"(be-4)。不传 stats 时行为与原来完全一致(向后兼容,failure-analytics 仍可用)。
function readTail(file, fromLine, stats) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(fromLine);
    const out = [];
    let dropped = 0;
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch (_e) { dropped += 1; } }
    if (stats && dropped) stats.dropped = (stats.dropped || 0) + dropped;
    return out;
  } catch (_e) { return []; }
}
// Python 结果行:ok=true 或 steps.card=='card-bound' 视为成功
function isSuccessRow(r) { return !!(r && (r.ok === true || (r.steps && r.steps.card === 'card-bound'))); }

// Python 失败行 → 原因/阶段(供详情表展示)
function pyFailReason(r) {
  const s = r.steps || {};
  if (typeof s.auth === 'string' && s.auth.indexOf('fail') === 0) return s.auth;
  if (s.card && s.card !== 'card-bound') return 'card:' + s.card;
  if (s.pw === false && s.pw_reason) return 'pw:' + s.pw_reason;
  if (r.giveup_permanent) return 'giveup' + (r.steps && r.steps.giveup ? ':' + r.steps.giveup : '');
  if (r.not_allowed) return 'ACCOUNT_NOT_ALLOWED';
  if (r.error) return String(r.error).slice(0, 80);
  return s && Object.keys(s).length ? JSON.stringify(s).slice(0, 60) : 'unknown';
}
// Python 结果行 → 前端账号表形状(success / failed)。accByEmail:把输入账号的原密码 join 回来(结果文件不含密码)。
function mapRow(r, accByEmail) {
  const exitIp = String(r.proxy || '').split(':')[0] || '';
  const orig = (accByEmail && accByEmail.get(r.email)) || '';
  if (isSuccessRow(r)) {
    return ['success', { email: r.email, password: r.password || orig, originalPassword: orig, apiKey: r.api_key || '', apiKeyName: r.api_key_name || '', billingStatus: r.billing_status || (r.steps && r.steps.card) || '', charged: r.charge != null ? r.charge : 0, cardLast4: r.card_last4 || '', passwordChanged: !!(r.steps && r.steps.changepw), exitIp, proxy: r.proxy || '', createdAt: r.at || '' }];
  }
  return ['failed', { email: r.email, password: orig, originalPassword: orig, reason: pyFailReason(r), stage: (r.steps && (typeof r.steps.auth === 'string' ? 'auth' : (r.steps.card ? 'card' : (r.steps.pw === false ? 'register' : '')))) || '', failClass: r.hcap_mode || '', attempts: r.crash_restarts != null ? r.crash_restarts : (r.reopen_count || 0), proxy: r.proxy || '', createdAt: r.at || '' }];
}

const DETAILS_DIR = path.join(__dirname, '..', 'data', 'run-details');
const NODE_RESULTS_DIR = path.join(__dirname, '..', 'data', 'batch-results');
function writeDetail(jobId, engine, successRows, failedRows) {
  try {
    fs.mkdirSync(DETAILS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DETAILS_DIR, jobId + '.json'), JSON.stringify({ jobId, engine, success: successRows.slice(0, 5000), failed: failedRows.slice(0, 5000) }));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }   // 失败不再静默(be-8):返回给调用方告警
}
function readDetail(jobId) {
  try { return JSON.parse(fs.readFileSync(path.join(DETAILS_DIR, jobId + '.json'), 'utf8')); } catch (_e) { return null; }
}
// 模板渲染({{field}} 替换),与 Node 引擎回显一致
function renderTpl(tpl, row) {
  if (!tpl) return `${row.email || ''}:${row.apiKey || row.password || ''}`;
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_m, k) => { const v = row[k]; return v == null ? '' : String(v); });
}
// 写 Node 同款 batch-results 文件 → /download、/api/results、聚合页 对 Python 任务也生效
function writeBatchResults(jobId, successRows, failedRows, successTpl, failureTpl) {
  try {
    fs.mkdirSync(NODE_RESULTS_DIR, { recursive: true });
    const jsonl = (arr) => (arr.length ? arr.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-success.jsonl`), jsonl(successRows));
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-failed.jsonl`), jsonl(failedRows));
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-success.txt`), successRows.map((r) => renderTpl(successTpl, r)).join('\n'));
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-failed.txt`), failedRows.map((r) => renderTpl(failureTpl, r)).join('\n'));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }   // 失败不再静默(be-8):磁盘满时让调用方告警,而非假"完成"
}

// stdout 单号结果行解析(run.py / hybrid 两种格式)
function parseResultLine(line) {
  let m = line.match(/════\s*结果\s+(\S+?)\s+ok=(\w+)\s+steps=/);   // run.py:  ════ 结果 NAME ok=B steps=...
  if (m) return { name: m[1], ok: /^true$/i.test(m[2]) };
  m = line.match(/════\s+(\S+?)\s+结果\s+ok=(\w+)/);                // hybrid:  ════ NAME 结果 ok=B pw=...
  if (m) return { name: m[1], ok: /^true$/i.test(m[2]) };
  return null;
}

// 有限数才用,否则回退默认;不要用 `Number(x) || d`(会把合法的 0 顶成默认)。
// 但空串/空白 = 字段留空 → 用默认(Number('')===0 会误判成显式 0,故先判空)。
function _numOr(v, d) { const s = String(v == null ? '' : v).trim(); if (s === '') return d; const n = Number(s); return Number.isFinite(n) ? n : d; }

// UI 选项 → run.py 参数
function seleniumArgs(accFile, pxFile, p, jobId) {
  const a = ['--accounts', accFile, '--proxies', pxFile, '--concurrency', String(Math.max(1, Number(p.concurrency) || 1))];
  a.push(p.doApiKey === false ? '--no-key' : '--do-key');
  if (p.doCard) a.push('--do-card');
  if (p.doPurchase) { a.push('--do-purchase', '--amount', String(Math.max(5, Number(p.amount) || 5))); }
  if (p.doChangePw && p.unifiedPassword) a.push('--do-changepw', '--unified-pw', p.unifiedPassword);
  if (Number(p.proxyOffset)) a.push('--proxy-offset', String(Number(p.proxyOffset)));
  if (Number(p.gap)) a.push('--gap', String(Number(p.gap)));
  if (p.noDeleteEnv) a.push('--no-delete-env');
  if (p.resume === false) a.push('--no-resume'); // 「断点续跑」取消勾选 → 忽略已完成/坏邮箱状态、整组强制重跑
  if (jobId) a.push('--job-id', String(jobId)); // 结果行写 job_id → web 按 job 隔离取结果,防同引擎并发串号
  a.push('--auto-hcaptcha-only'); // web 无人值守:hCaptcha 只走自动(求解模式由 FIXC_SOLVE_HCAPTCHA 控),不停下等人工
  return a;
}
// UI 选项 → hybrid_run.py 参数(混合全流程:注册→取key→绑地址→加卡)
function hybridArgs(accFile, pxFile, p, jobId) {
  const a = ['--accounts', accFile, '--proxies', pxFile, '--concurrency', String(Math.max(1, Number(p.concurrency) || 1))];
  if (p.unifiedPassword) a.push('--op-pw', p.unifiedPassword);
  a.push('--max-rotations', String(_numOr(p.maxRotations, 3)));
  a.push('--cooldown-hours', String(_numOr(p.cooldownHours, 3)));
  a.push('--max-reopen', String(_numOr(p.maxReopen, 3)));
  if (p.doPurchase) { a.push('--do-purchase', '--amount', String(Math.max(5, Number(p.amount) || 5))); }
  if (p.isolate) a.push('--isolate');
  if (p.manualCard) a.push('--manual-card');
  if (p.noDeleteEnv) a.push('--no-delete-env');
  if (p.noGc) a.push('--no-gc');
  if (p.resume === false) a.push('--no-resume'); // 「断点续跑」取消勾选 → 忽略已绑/被拒/冷却状态、整组强制重跑
  if (jobId) a.push('--job-id', String(jobId)); // 结果行写 job_id → web 按 job 隔离取结果,防同引擎并发串号
  return a;
}

// 透传/覆盖给 Python 的环境变量(求解模式/止损/熔断等)
function buildEnv(p) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  // 验证码/邮箱 key 池:挑一个可用 key 注入 env(Python common/config.py 读它们);池空回退 config。
  try { Object.assign(env, serviceKeys.envPatch()); } catch (_e) { /* 用 config 兜底 */ }
  // 跨节点下发:中心机随 payload 复制了它生效的验证码/邮箱 key → 子机优先用下发的(覆盖本机池/config)。
  if (p.captchaApiKey) { env.OPENROUTER_CAPTCHA_KEY = String(p.captchaApiKey); if (p.captchaProvider) env.OPENROUTER_CAPTCHA_PROVIDER = String(p.captchaProvider); }
  if (p.mailboxApiKey) { env.OPENROUTER_FIRSTMAIL_KEY = String(p.mailboxApiKey); if (p.mailboxApiBaseUrl) env.OPENROUTER_FIRSTMAIL_BASE = String(p.mailboxApiBaseUrl); }
  // AdsPower 端点:优先端点池(本机有多个端点时选一个;p.adspowerEndpoint 指定 id,否则首个 active);
  // 端点池为空 → 回退 config.local.json 的 adspower.*(单端点向后兼容)。Python 一批用一个端点。
  try {
    const eps = adspowerEndpointStore.activeFull();
    let chosen = null;
    if (eps.length) chosen = (p.adspowerEndpoint && eps.find((e) => e.id === p.adspowerEndpoint)) || eps[0];
    if (chosen) {
      env.OPENROUTER_ADSPOWER_API = chosen.apiBase;
      if (chosen.apiKey && String(chosen.apiKey).trim()) env.OPENROUTER_ADSPOWER_TOKEN = String(chosen.apiKey).trim();
    } else {
      const ap = (configRw.readMerged() || {}).adspower || {};
      if (ap.apiBase && String(ap.apiBase).trim()) env.OPENROUTER_ADSPOWER_API = String(ap.apiBase).trim();
      if (ap.apiKey && String(ap.apiKey).trim()) env.OPENROUTER_ADSPOWER_TOKEN = String(ap.apiKey).trim();
    }
  } catch (_e) { /* 配置读失败用默认端点 */ }
  if (p.solveHcaptcha && ['on', 'off', 'random', 'solve', 'swap'].includes(String(p.solveHcaptcha))) env.FIXC_SOLVE_HCAPTCHA = String(p.solveHcaptcha);
  if (Number(p.cardDeadline) > 0) env.FIXC_CARD_DEADLINE = String(Number(p.cardDeadline));
  if (Number(p.solveFutileCap) >= 0 && p.solveFutileCap !== undefined && p.solveFutileCap !== '') env.FIXC_SOLVE_FUTILE_CAP = String(Number(p.solveFutileCap));
  // 只在是有限数时注入,否则非数字会把字符串 'NaN' 塞进子进程环境变量(Python 解析报错/取默认)。
  const _nSwaps = Number(p.maxHcaptchaCardSwaps);
  if (p.maxHcaptchaCardSwaps !== undefined && p.maxHcaptchaCardSwaps !== '' && Number.isFinite(_nSwaps)) env.MAX_HCAPTCHA_CARD_SWAPS = String(_nSwaps);
  const _nCardSwaps = Number(p.maxCardSwaps);
  if (p.maxCardSwaps !== undefined && p.maxCardSwaps !== '' && Number.isFinite(_nCardSwaps)) env.MAX_CARD_SWAPS = String(_nCardSwaps);
  // 点框后复检等待(秒):Fix C 点完 I am human 后轮询复检框是否消失的时间窗(控制台可配)
  const _nRecheck = Number(p.hcRecheckWait);
  if (p.hcRecheckWait !== undefined && p.hcRecheckWait !== '' && Number.isFinite(_nRecheck)) env.FIXC_HC_RECHECK_WAIT = String(_nRecheck);
  return env;
}

// 起一个子进程 spec。返回 Promise<void>(进程结束 resolve)。计数写进 shared.counters。
function runSpec(jobId, spec, publish, shared) {
  if (!shared.exits) shared.exits = [];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonBin(), [spec.script, ...spec.args], {
        cwd: SELENIUM_DIR, env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // unix:独立进程组,便于杀树
      });
    } catch (e) {
      publish(jobId, 'log', `${spec.label}启动失败: ${e && e.message}`);
      shared.exits.push({ started: false });
      return resolve();
    }
    if (!child.pid) { publish(jobId, 'log', `${spec.label}未拿到 pid(python 未安装?设 OPENROUTER_PYTHON)`); shared.exits.push({ started: false }); return resolve(); }
    procRegistry.register(jobId, child.pid, shared.engine);
    publish(jobId, 'log', `${spec.label}已启动(pid=${child.pid}):${path.basename(spec.script)} ${spec.args.join(' ')}`);

    const onLine = (line) => {
      if (!line) return;
      const tagged = spec.tag ? `${spec.tag} ${line}` : line;
      publish(jobId, 'log', tagged);
      const r = parseResultLine(line);
      if (r) {
        // 结果行去重:onLine 同时挂在 stdout+stderr,且 Python 偶有重复打印 → 按账号名只计一次,防成败双计、UI 双事件。
        if (shared.seenResults.has(r.name)) return;
        shared.seenResults.add(r.name);
        if (r.ok) shared.counters.ok += 1; else shared.counters.fail += 1;
        const _orig = (shared.accByEmail && shared.accByEmail.get(r.name)) || '';
        publish(jobId, r.ok ? 'account-success' : 'account-failed', { email: r.name, rendered: tagged, reason: r.ok ? '' : 'see-log', password: _orig, originalPassword: _orig });
        publish(jobId, 'runtime-stats', { jobDone: shared.counters.ok + shared.counters.fail, jobTotal: shared.total, browsersActive: 0, browsersMax: 0 });
      }
    };
    // 【B3 修】readline 接口存引用 + 挂 'error' 兜底:子进程被 kill 时 stdout/stderr 异常关闭会 emit error,
    //   原来没监听 → 未捕获 error 冒泡可能崩主进程;且 close 时主动 .close() 释放接口。
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on('line', onLine); rlOut.on('error', () => { /* 子进程被杀,流异常,忽略 */ });
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on('line', (l) => onLine(l)); rlErr.on('error', () => { /* 同上 */ });
    child.on('error', (e) => { publish(jobId, 'log', `${spec.label}进程错误: ${e && e.message}`); });
    child.on('close', (code, signal) => {
      try { rlOut.close(); rlErr.close(); } catch (_e) { /* ignore */ }
      procRegistry.unregister(jobId, child.pid);
      publish(jobId, 'log', `${spec.label}结束(code=${code}${signal ? ' signal=' + signal : ''})`);
      shared.exits.push({ started: true, code, signal });
      resolve();
    });
  });
}

// 主入口:engine ∈ selenium | hybrid | split。payload 已带 accounts/proxies(server 解析好)。
// 返回 Promise<summary>(给 runsStore.finish)。
async function spawnEngine(jobId, engine, payload, publish) {
  const startedAt = Date.now();
  const env = buildEnv(payload);
  // 邮箱→原密码映射(结果行不含密码):流式 account-failed 带上它,前端「重跑(登录)」才能回填 email:密码,否则只剩 email: 空密码登不进。
  const shared = { engine, counters: { ok: 0, fail: 0 }, total: (payload.accounts || []).length, accByEmail: new Map((payload.accounts || []).map((a) => [a.email, a.password || ''])), seenResults: new Set() };

  let specs = [];
  let resultFiles = [];
  let startLines = {};
  try {
    if (engine === 'split') {
      const w = tempInputs.writeSplit(jobId, payload.accounts, payload.proxies, Number(payload.splitRatio));
      publish(jobId, 'log', `两引擎随机分流:Selenium 组 ${w.groupA.count} 个 / 混合组 ${w.groupB.count} 个`);
      startLines.selenium = countLines(RESULTS.selenium);
      startLines.hybrid = countLines(RESULTS.hybrid);
      // 多引擎共屏:两进程各自 slot 都从 0 起会叠窗(layout.py 用 GRID_TOTAL/GRID_SLOT_OFFSET 统一网格)。
      // 各进程跑 concurrency 个 worker(slot 0..C-1)→ 共同 GRID_TOTAL=2C,A 偏移 0、B 偏移 C → 两组窗口不重叠。
      const _c = Math.max(1, Number(payload.concurrency) || 1);
      const envA = { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: '0' };
      const envB = { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: String(_c) };
      specs = [
        { script: path.join(SELENIUM_DIR, 'run.py'), args: seleniumArgs(w.groupA.accFile, w.pxFile, payload, jobId), env: envA, label: '[引擎A·Selenium]', tag: '[A]' },
        { script: path.join(SELENIUM_DIR, 'hybrid_run.py'), args: hybridArgs(w.groupB.accFile, w.pxFile, payload, jobId), env: envB, label: '[引擎B·混合]', tag: '[B]' },
      ];
      resultFiles = [RESULTS.selenium, RESULTS.hybrid];
    } else {
      const w = tempInputs.write(jobId, payload.accounts, payload.proxies);
      const isHybrid = engine === 'hybrid';
      const script = path.join(SELENIUM_DIR, isHybrid ? 'hybrid_run.py' : 'run.py');
      const args = isHybrid ? hybridArgs(w.accFile, w.pxFile, payload, jobId) : seleniumArgs(w.accFile, w.pxFile, payload, jobId);
      const rf = isHybrid ? RESULTS.hybrid : RESULTS.selenium;
      startLines[isHybrid ? 'hybrid' : 'selenium'] = countLines(rf);
      specs = [{ script, args, env, label: isHybrid ? '[混合]' : '[Selenium]' }];
      resultFiles = [rf];
    }
  } catch (e) {
    publish(jobId, 'log', `准备输入文件失败: ${e && e.message}`);
    publish(jobId, 'job-done', { jobId, error: String(e && e.message) });
    tempInputs.cleanup(jobId);   // 早退也清临时输入(rel-1:writeSplit/write 可能已半写文件)
    return { jobId, total: shared.total, success: 0, failed: 0, durationMs: Date.now() - startedAt, error: String(e && e.message) };
  }

  try {
  await Promise.all(specs.map((s) => runSpec(jobId, s, publish, shared)));

  // 进程都结束 → 读结果文件本次新增行,作为权威结果。
  // 同引擎并发(两个 selenium/两个 hybrid 同时跑)会往同一 append-only 文件交错写,纯按行号 tail 会把对方的行算进自己 → 串号。
  // 故按【行级】判定:留本 job 的行(job_id===jobId)+ 无 job_id 的行(旧 Python 未重启,无从区分→保留);
  // 排除其它 job(不同 job_id)的行。比"文件级 all-or-nothing"稳:新旧 Python 混跑时不会把本 job 的结果整批丢掉。
  const _tailStats = { dropped: 0 };
  const harvest = (file, startLine) => readTail(file, startLine, _tailStats).filter((r) => r && (!r.job_id || r.job_id === jobId));
  const rows = [];
  if (engine === 'split') {
    harvest(RESULTS.selenium, startLines.selenium).forEach((r) => rows.push(r));
    harvest(RESULTS.hybrid, startLines.hybrid).forEach((r) => rows.push(r));
  } else {
    const key = engine === 'hybrid' ? 'hybrid' : 'selenium';
    harvest(RESULTS[key], startLines[key]).forEach((r) => rows.push(r));
  }
  // 把输入账号的原密码 join 回结果(结果文件不含密码)→ 导出/重跑能拿到 email:原密码
  const accByEmail = new Map((payload.accounts || []).map((a) => [a.email, a.password || '']));
  const successRows = [];
  const failedRows = [];
  for (const r of rows) { const [k, v] = mapRow(r, accByEmail); (k === 'success' ? successRows : failedRows).push(v); }
  let success = successRows.length;
  let failed = failedRows.length;
  // 结果文件没拿到行(被中途 kill / 没写)→ 退回 stdout 解析计数
  if (!rows.length) { success = shared.counters.ok; failed = shared.counters.fail; }
  // 子进程异常退出(没起来 / 自行非零退出且非被 kill)且零结果 → 这是真失败,不能登记成 0/0 的"完成"。
  const exits = shared.exits || [];
  const crashed = exits.some((e) => !e.started || (typeof e.code === 'number' && e.code !== 0 && !e.signal));
  const crashError = (crashed && success === 0 && failed === 0)
    ? 'Python 子进程异常退出(无结果)—— 见运行日志(python 未安装/导入失败/启动报错?)' : '';
  // 资源使用记录(诊断/排查用):host 反查 proxyId;Python 自动建环境 → envId 留空(诚实)。
  try {
    const pxByHost = new Map(proxyStore.list().map((p) => [p.host, p.id]));
    const host = (s) => String(s || '').split(':')[0];
    const usage = [
      ...successRows.map((v) => ({ jobId, engine, email: v.email, host: host(v.proxy), exitIp: v.exitIp || '', proxyId: pxByHost.get(host(v.proxy)) || '', cardLast4: v.cardLast4 || '', envId: '', endpoint: '', stage: 'done', ok: true, reason: '' })),
      ...failedRows.map((v) => ({ jobId, engine, email: v.email, host: host(v.proxy), exitIp: '', proxyId: pxByHost.get(host(v.proxy)) || '', cardLast4: '', envId: '', endpoint: '', stage: v.stage || '', ok: false, reason: v.reason || '' })),
    ];
    usageStore.recordMany(usage);
  } catch (_e) { /* 使用记录失败不致命 */ }
  // 结果落盘:失败不再静默(be-8)。tail 丢行(be-4)/落盘失败都告警到运行日志,
  // 避免前端看到"完成"却拿到残缺的下载/详情而毫无提示。
  if (_tailStats.dropped) publish(jobId, 'log', `⚠ 结果文件有 ${_tailStats.dropped} 行无法解析被跳过 —— 这些账号可能未计入结果(磁盘/编码/半写?)`);
  const _wd = writeDetail(jobId, engine, successRows, failedRows);   // 每 job 详情快照(Python 结果文件是 append-only 非 per-job)
  // 写 Node 同款 batch-results(txt 按用户模板渲染 + jsonl 映射后形状)→ 下载/聚合/详情 对 Python 也生效
  const _wb = writeBatchResults(jobId, successRows, failedRows, payload.successTemplate, payload.failureTemplate);
  if ((_wd && !_wd.ok) || (_wb && !_wb.ok)) publish(jobId, 'log', `⚠ 结果落盘失败(下载/详情/聚合可能不全): ${(_wd && _wd.error) || ''} ${(_wb && _wb.error) || ''}`.trim());
  const summary = { jobId, total: shared.total, success, failed, durationMs: Date.now() - startedAt, engine, resultFiles, ...(crashError ? { error: crashError } : {}) };
  if (crashError) publish(jobId, 'log', crashError);
  publish(jobId, 'job-done', summary);
  return summary;
  } finally {
    tempInputs.cleanup(jobId);   // ★ 不管 Promise.all/后处理是否抛错,临时输入文件都必清(rel-1)
  }
}

module.exports = { spawnEngine, RESULTS, isSuccessRow, readTail, countLines, readDetail, mapRow, renderTpl };
