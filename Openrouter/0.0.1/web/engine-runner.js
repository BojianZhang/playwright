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
const accountStore = require('../data/account-store');   // 把 Python 引擎结果(注册/key/充值/拉黑)桥接进账号台账,让账号页回显

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

// 统一「号被 OpenRouter 永久拒绝(拉黑)」判据 —— 覆盖两引擎:
//   hybrid 写 res["not_allowed"]=True;纯Sel(run.py:131)靠 steps.auth 以 NOT_ALLOWED 结尾;另兼容 steps.banned 标记。
function isNotAllowed(r) {
  if (!r) return false;
  if (r.not_allowed) return true;
  const s = r.steps || {};
  if (typeof s.auth === 'string' && /NOT_ALLOWED$/.test(s.auth)) return true;
  if (s.banned === 'not-allowed') return true;
  return false;
}

// Python 失败行 → 原因/阶段(供详情表展示)
function pyFailReason(r) {
  const s = r.steps || {};
  if (typeof s.auth === 'string' && s.auth.indexOf('fail') === 0) return s.auth;
  if (s.card && s.card !== 'card-bound') return 'card:' + s.card;
  if (s.pw === false && s.pw_reason) return 'pw:' + s.pw_reason;
  if (r.giveup_permanent) return 'giveup' + (r.steps && r.steps.giveup ? ':' + r.steps.giveup : '');
  if (isNotAllowed(r)) return 'ACCOUNT_NOT_ALLOWED';
  if (r.error) return String(r.error).slice(0, 80);
  return s && Object.keys(s).length ? JSON.stringify(s).slice(0, 60) : 'unknown';
}

// 跨引擎衔接(split 第二轮)分类:某失败行该转去哪个引擎再试一次,返回 'hybrid'|'selenium'|null。
// ★结果行不含 engine 字段 → 「当前引擎」由【来源结果文件】决定(results.jsonl=selenium / hybrid_results.jsonl=hybrid),
//   故 sourceEngine 必须由调用方按文件传入,绝不从行里读。只对失败行判定。
//   - selenium 失败且 steps.key===false(取 key 向导进了但抓不到 key,WIZARD_NO_KEY)→ 转 hybrid(Playwright 能过新页面)。
//   - hybrid 失败且加卡人机验证过不去(card==='hcaptcha' / giveup_reason==='hcaptcha' / card_hcaptcha)→ 转 selenium。
//   其它失败(declined / not_allowed / 代理网络 / 注册 Turnstile)不转。
function handoffTarget(row, sourceEngine) {
  if (!row || isSuccessRow(row)) return null;
  const s = row.steps || {};
  if (sourceEngine === 'selenium') return s.key === false ? 'hybrid' : null;
  if (sourceEngine === 'hybrid') {
    const hcap = s.card === 'hcaptcha' || row.giveup_reason === 'hcaptcha' || row.card_hcaptcha === true;
    return hcap ? 'selenium' : null;
  }
  return null;
}
// Python 结果行 → 前端账号表形状(success / failed)。accByEmail:把输入账号的原密码 join 回来(结果文件不含密码)。
function mapRow(r, accByEmail) {
  const exitIp = String(r.proxy || '').split(':')[0] || '';
  const orig = (accByEmail && accByEmail.get(r.email)) || '';
  if (isSuccessRow(r)) {
    // ★充值额键名:hybrid 写 res["charged"]、纯Sel 也补写 charged;旧 r.charge 兜底。balance_after=充值后真实积分余额。
    const _charged = r.charged != null ? r.charged : (r.charge != null ? r.charge : 0);
    return ['success', { email: r.email, password: r.password || orig, originalPassword: orig, apiKey: r.api_key || '', apiKeyName: r.api_key_name || '', billingStatus: r.billing_status || (r.steps && r.steps.card) || '', charged: _charged, balanceAfter: r.balance_after != null ? r.balance_after : null, cardLast4: r.card_last4 || '', passwordChanged: !!(r.steps && r.steps.changepw), exitIp, proxy: r.proxy || '', createdAt: r.at || '' }];
  }
  return ['failed', { email: r.email, password: orig, originalPassword: orig, reason: pyFailReason(r), stage: (r.steps && (typeof r.steps.auth === 'string' ? 'auth' : (r.steps.card ? 'card' : (r.steps.pw === false ? 'register' : '')))) || '', failClass: r.hcap_mode || '', attempts: r.crash_restarts != null ? r.crash_restarts : (r.reopen_count || 0), blacklisted: isNotAllowed(r), blacklistReason: isNotAllowed(r) ? 'ACCOUNT_NOT_ALLOWED' : '', proxy: r.proxy || '', createdAt: r.at || '' }];
}

const DETAILS_DIR = path.join(__dirname, '..', 'data', 'run-details');
const NODE_RESULTS_DIR = path.join(__dirname, '..', 'data', 'batch-results');

// 把本次 job 的结果行桥接进【账号台账 accountStore】(账号页 /api/accounts + 续跑读它)。
// 根因:Python 引擎(selenium/hybrid/split)结果只进 results.jsonl,从不更新台账 → 账号页对它们一片空白
//   (充值不回显、拉黑不体现)。这里在每个 job 收口时,把结果(注册/key/billing/充值/卡/改密/拉黑)合并进台账。
// 安全:只写【有意义的字段】(不拿空 key/卡/充值去覆盖既有数据);accountStore.update 是幂等 upsert+原子落盘。
async function bridgeToAccountStore(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const byEmail = new Map();
  for (const r of rows) { if (r && r.email) byEmail.set(r.email, r); }   // 同号多行 → 取最后一行(最新)
  const ups = [];
  for (const r of byEmail.values()) {
    try {
      const prior = accountStore.get(r.email) || {};
      const success = isSuccessRow(r);
      const patch = {};
      if (r.api_key) { patch.apiKey = r.api_key; patch.registered = true; }
      if (r.api_key_name) patch.apiKeyName = r.api_key_name;
      if (r.registered || success) patch.registered = true;
      // ★billingStatus 单调护栏(防二次扣款):只在新状态【账单等级 ≥ 旧状态】时才覆盖。否则失败行(declined/hcaptcha
      //   写进 steps.card)会把已达标的 card-bound/success 降级 → Playwright 续跑读 billingSatisfied 误判未达标
      //   → 对【已绑卡/已充值】号重新加卡/充值(真金白银,不可回滚)。
      const billing = r.billing_status || (r.steps && r.steps.card) || '';
      if (billing && accountStore.attainedLevel(billing) >= accountStore.attainedLevel(prior.billingStatus)) patch.billingStatus = billing;
      // 充值额:只写【正数】真实充值。失败/跳过会写 charged=0(hybrid_run),若覆盖已有正充值额同样造成降级误判 → 只升不降。
      const charged = r.charged != null ? r.charged : (r.charge != null ? r.charge : null);
      if (charged != null && charged > 0) patch.charged = charged;
      // 成功元数据(充值后余额、绑成卡尾号)只在【成功行】写,避免失败行(declined 卡尾号/0 余额)污染已成功记录。
      if (success && r.balance_after != null) patch.balanceAfter = r.balance_after;
      if (success && r.card_last4) patch.cardLast4 = r.card_last4;
      if (r.steps && r.steps.changepw) patch.passwordChanged = true;
      const exitIp = String(r.proxy || '').split(':')[0];
      if (exitIp) patch.exitIp = exitIp;   // 最近一次出口 IP(诊断用),失败行也更新无妨
      if (isNotAllowed(r)) { patch.blacklisted = true; patch.blacklistReason = 'ACCOUNT_NOT_ALLOWED'; }
      else if (success) { patch.blacklisted = false; patch.blacklistReason = ''; }   // ★成功(--no-resume 救回)→ 翻转拉黑,避免"既拉黑又有key"矛盾态
      ups.push(Promise.resolve(accountStore.update(r.email, patch)).catch(() => { /* 单号失败不致命 */ }));
    } catch (_e) { /* 单号桥接失败不影响其它号 */ }
  }
  if (ups.length) await Promise.allSettled(ups);
}
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
// 实时成功判定必须与 isSuccessRow 对齐:ok=true 或 steps.card=='card-bound' 都算成功。
// 否则实时面板只按 ok= 单判 → 「加卡绑成但没取到 Key」的号被流成 account-failed,
// 与最终聚合/运行详情/结果聚合(card-bound 计成功)对不上,成功账号面板空着不回显。
function parseResultLine(line) {
  const cardBound = /['"]card['"]\s*:\s*['"]card-bound['"]/.test(line); // 行内 steps 是 Python repr(单引号)
  let m = line.match(/════\s*结果\s+(\S+?)\s+ok=(\w+)\s+steps=/);   // run.py:  ════ 结果 NAME ok=B steps=...
  if (m) return { name: m[1], ok: /^true$/i.test(m[2]) || cardBound };
  m = line.match(/════\s+(\S+?)\s+结果\s+ok=(\w+)/);                // hybrid:  ════ NAME 结果 ok=B pw=...
  if (m) return { name: m[1], ok: /^true$/i.test(m[2]) || cardBound };
  return null;
}

// 从 stdout 结果行尽力提取失败真因(run.py 行内含 Python repr 的 steps)→ 让实时 account-failed 事件带真因,
// 不再只显示占位 'see-log'(本会话痛点:跑批时看不到失败原因)。提取不到(如 hybrid 行格式不同)回退 'see-log',无回归。
function reasonFromLine(line) {
  try {
    let m = line.match(/['"]auth['"]\s*:\s*['"](fail[^'"]*)['"]/i);   // 注册/登录失败:fail:FORM_NOT_FILLED 等
    if (m) return m[1];
    m = line.match(/['"]card['"]\s*:\s*['"]([^'"]+)['"]/i);            // 加卡态(card-bound 是成功,不进失败分支)
    if (m && m[1] !== 'card-bound') return 'card:' + m[1];
    if (/['"]key['"]\s*:\s*(False|false)\b/.test(line)) return 'key:false';
    m = line.match(/['"]giveup['"]\s*:\s*['"]([^'"]+)['"]/i);
    if (m) return 'giveup:' + m[1];
  } catch (_e) { /* 行格式异常→回退 see-log */ }
  return 'see-log';
}

// 有限数才用,否则回退默认;不要用 `Number(x) || d`(会把合法的 0 顶成默认)。
// 但空串/空白 = 字段留空 → 用默认(Number('')===0 会误判成显式 0,故先判空)。
function _numOr(v, d) { const s = String(v == null ? '' : v).trim(); if (s === '') return d; const n = Number(s); return Number.isFinite(n) ? n : d; }

// ★并发硬上限(防 AdsPower 在高并发下批量掉线 session-deleted)。高级参数页 maxConcurrency 设了就把【任何 job】
//   的每进程并发钳到 ≤ 它,无论控制台请求多少;留空/<=0 = 不限(老行为逐字节不变)。读 advanced-store(持久),
//   每次起 job 时算 → 设一次以后都生效,不用每次手调。split 模式两引擎各跑 _clampConc 个 = 总 2× 上限,注意。
function _clampConc(req, jobId) {
  const c = Math.max(1, Number(req) || 1);
  let cap = 0;
  try { cap = Number((require('./advanced-store').get() || {}).maxConcurrency) || 0; } catch (_e) { cap = 0; }
  if (cap > 0 && c > cap) {
    try { console.error(`[engine-runner] 并发 ${c} 超过高级参数上限 ${cap} → 钳制为 ${cap}${jobId ? ` (job ${jobId})` : ''}`); } catch (_e) { /* 日志失败不影响钳制 */ }
    return cap;
  }
  return c;
}

// UI 选项 → run.py 参数
function seleniumArgs(accFile, pxFile, p, jobId) {
  const a = ['--accounts', accFile, '--proxies', pxFile, '--concurrency', String(_clampConc(p.concurrency, jobId))];
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
  const a = ['--accounts', accFile, '--proxies', pxFile, '--concurrency', String(_clampConc(p.concurrency, jobId))];
  if (p.unifiedPassword) a.push('--op-pw', p.unifiedPassword);
  if (p.doChangePw && p.unifiedPassword) a.push('--do-changepw'); // 改密目标=统一密码(已由 --op-pw 带入);混合现支持改密
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
  // 高级参数(全局/共用调优旋钮 advanced-store):只注用户【显式设的覆盖值】(空=Python 用内置默认)。
  // 放在下方引擎配置 FIXC_*/WIZARD_* 显式注入【之前】→ 引擎配置(per-engine)优先;且两边键去重不重叠,互不覆盖。
  try { Object.assign(env, require('./advanced-store').envPatch()); } catch (_e) { /* 覆盖失败不致命,用默认 */ }
  // 元素选择器覆盖(selectors-store → ORSEL_*):页面改了关键元素定位规则就注进去;common.selectors.sel() 读,空=用内置默认。
  try { Object.assign(env, require('./selectors-store').envPatch()); } catch (_e) { /* 覆盖失败不致命,用内置默认 */ }
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
  // 绑卡结果等待上限(秒):点 Save 后轮询绑成/被拒结果的上限,到点转去刷新核验(fixc_core 读 FIXC_RESULT_WAIT)。引擎配置可调。
  const _nResWait = Number(p.cardResultWait);
  if (p.cardResultWait !== undefined && p.cardResultWait !== '' && Number.isFinite(_nResWait) && _nResWait > 0) env.FIXC_RESULT_WAIT = String(_nResWait);
  // Save card 存卡弹窗处理(fixc_core 读 FIXC_SAVECARD):默认 dismiss=秒关弹窗立即判绑成(不注 env);仅显式选 wait
  //   才注入 → 还原"不关、等满 FIXC_RESULT_WAIT 再核验"旧行为(供用户对照测试,默认逐字节是 dismiss 快路径)。
  if (p.cardSaveDialog === 'wait') env.FIXC_SAVECARD = 'wait';
  // 取key卡死自救阈值(秒):某一屏卡过这么久不前进 → 刷新逃逸(steps_key 读 WIZARD_STALL_REFRESH)。仅纯 Selenium 取key 用。
  const _nStall = Number(p.wizardStallRefresh);
  if (p.wizardStallRefresh !== undefined && p.wizardStallRefresh !== '' && Number.isFinite(_nStall) && _nStall > 0) env.WIZARD_STALL_REFRESH = String(_nStall);
  // 每引擎「走法」变体(引擎配置预设里设;空=不注=Python 用内置默认 → 默认运行逐字节不变)。
  // 放在 advanced-store(line 195)之后 → 每引擎设了就覆盖全局;各项枚举/数值白名单后才写,手改 JSON 也注不进任意 env。
  if (['address', 'later', 'random'].includes(String(p.wizardPayMode))) env.WIZARD_PAY_MODE = String(p.wizardPayMode);
  if (['skip', 'credits', 'random'].includes(String(p.wizardCreditMode))) env.WIZARD_CREDIT_MODE = String(p.wizardCreditMode);
  if (['random', 'spread', 'concentrate'].includes(String(p.cardStrategy))) env.CARD_STRATEGY = String(p.cardStrategy);
  const _nZip = Number(p.zipRetry);
  if (p.zipRetry !== undefined && p.zipRetry !== '' && Number.isFinite(_nZip) && _nZip >= 0) env.ZIP_RETRY = String(_nZip);
  if (String(p.cardFillMethod) === 'selenium') env.FIXC = '0';   // 旧 Selenium 填卡;Fix C(默认)绝不显式设 FIXC,保持与今天一致
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
      // 逐号阶段进度标记(Python common.log_stage 发):转成 worker-update 画线程进度条,并吞掉这行不刷屏运行日志。
      // 格式与 base.py 对齐:@@STAGE@@ slot=<int> stage=<name> status=<running|done> email=<email>
      const sm = line.match(/@@STAGE@@\s+slot=(\d+)\s+stage=(\S+)\s+status=(\S+)\s+email=(\S+)/);
      if (sm) {
        publish(jobId, 'worker-update', { worker: {
          workerId: Number(sm[1]) + (spec.slotBase || 0),   // split 两子进程槽位都从 0 起 → 按 spec 偏移防 workerId 撞车
          status: sm[3] === 'done' ? 'done' : 'running', stage: sm[2], account: sm[4],
        } });
        return;
      }
      const tagged = spec.tag ? `${spec.tag} ${line}` : line;
      publish(jobId, 'log', tagged);
      const r = parseResultLine(line);
      if (r) {
        // 结果行去重:onLine 同时挂在 stdout+stderr,且 Python 偶有重复打印 → 按账号名只计一次,防成败双计、UI 双事件。
        if (shared.seenResults.has(r.name)) return;
        shared.seenResults.add(r.name);
        if (r.ok) shared.counters.ok += 1; else shared.counters.fail += 1;
        const _orig = (shared.accByEmail && shared.accByEmail.get(r.name)) || '';
        publish(jobId, r.ok ? 'account-success' : 'account-failed', { email: r.name, rendered: tagged, reason: r.ok ? '' : reasonFromLine(tagged), password: _orig, originalPassword: _orig });
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

  // 并发钳制可见提示:maxConcurrency 把请求并发压低时,在【运行日志】显式告知(此前只 console.error 进服务端 stderr,
  //   控制台看不到→用户以为按填的并发在跑)。spawnEngine 内只算/发一次,避免 selenium/hybridArgs 重复打日志。
  try {
    const _reqC = Math.max(1, Number(payload.concurrency) || 1);
    const _clampedC = _clampConc(payload.concurrency, jobId);
    if (_clampedC < _reqC) {
      publish(jobId, 'log', `⚙ 并发已从 ${_reqC} 钳制到 ${_clampedC} 以保护 AdsPower(高级参数·并发硬上限 maxConcurrency)`
        + (engine === 'split' ? `;split 两引擎各 ${_clampedC} = 共 ${_clampedC * 2}` : ''));
    }
  } catch (_e) { /* 提示失败不影响起 job */ }

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
      const _c = _clampConc(payload.concurrency, jobId);   // 钳制后再算网格,保证窗口布局与实际 worker 数一致
      // 跨引擎衔接开 → 第一轮【秒关/快速失败】:Selenium 组撞新版取key向导即弃(转混合)、混合组绑卡撞图片九宫格即弃(转纯Sel)。
      // 引擎专属标志,互不误伤;第二轮(衔接重试)用 base env 不注 → 最终引擎全力尝试。
      const _ho = payload.crossHandoff !== false;
      const envA = { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: '0', ...(_ho ? { OPENROUTER_FAST_HANDOFF_KEY: '1' } : {}) };
      const envB = { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: String(_c), ...(_ho ? { OPENROUTER_FAST_HANDOFF_CARD: '1' } : {}) };
      specs = [
        { script: path.join(SELENIUM_DIR, 'run.py'), args: seleniumArgs(w.groupA.accFile, w.pxFile, payload, jobId), env: envA, label: '[引擎A·Selenium]', tag: '[A]', slotBase: 0 },
        { script: path.join(SELENIUM_DIR, 'hybrid_run.py'), args: hybridArgs(w.groupB.accFile, w.pxFile, payload, jobId), env: envB, label: '[引擎B·混合]', tag: '[B]', slotBase: _c },
      ];
      resultFiles = [RESULTS.selenium, RESULTS.hybrid];
      shared._splitPxFile = w.pxFile;   // 第二轮(跨引擎衔接)复用同一 proxies.txt(不重写代理)
      shared._splitClampC = _c;          // 第二轮沿用同一网格基数 GRID_TOTAL=2C
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
  let rows = [];
  if (engine === 'split' && payload.crossHandoff !== false) {
    // 跨引擎衔接:第一轮分别 harvest 两文件(用【来源文件】判定当前引擎),按规则分两桶,再跑唯一一轮第二轮,按 email 合并(第二轮覆盖)。
    const selRows = harvest(RESULTS.selenium, startLines.selenium);
    const hybRows = harvest(RESULTS.hybrid, startLines.hybrid);
    const toHybrid = new Set();    // selenium 新页面过不去 → 转混合
    const toSelenium = new Set();  // 混合 加卡人机验证过不去 → 转 selenium
    for (const r of selRows) if (r && r.email && handoffTarget(r, 'selenium') === 'hybrid') toHybrid.add(r.email);
    for (const r of hybRows) if (r && r.email && handoffTarget(r, 'hybrid') === 'selenium') toSelenium.add(r.email);
    const byEmail = new Map();      // 合并底图:第一轮每号一行
    for (const r of selRows) if (r && r.email) byEmail.set(r.email, r);
    for (const r of hybRows) if (r && r.email) byEmail.set(r.email, r);

    if (toHybrid.size === 0 && toSelenium.size === 0) {
      rows = [...byEmail.values()];   // 无可衔接 → 跳过第二轮(零额外开销)
    } else {
      publish(jobId, 'log', `衔接重试:${toHybrid.size} 个新页面失败转混合 / ${toSelenium.size} 个人机验证失败转Selenium`);
      // 实时计数清账(仅影响 LIVE UI):被转号第一轮已 account-failed 且 local-part 进了 seenResults,
      // 删掉让第二轮结果能重新 emit 并回退 fail 计数;最终 summary 由合并 rows 重算,与此无关(best-effort,local-part 跨域撞车只影响实时显示)。
      for (const em of toHybrid)   { const nm = String(em).split('@')[0]; if (shared.seenResults.delete(nm)) shared.counters.fail -= 1; }
      for (const em of toSelenium) { const nm = String(em).split('@')[0]; if (shared.seenResults.delete(nm)) shared.counters.fail -= 1; }
      const pxFile = shared._splitPxFile;                                   // 复用第一轮的 proxies.txt
      const _c = shared._splitClampC || _clampConc(payload.concurrency, jobId);
      const p2specs = [];
      if (toHybrid.size) {
        const w2 = tempInputs.writeSubset(jobId, payload.accounts, toHybrid, 'accounts.handoff-hybrid.txt');
        if (w2.count) p2specs.push({ script: path.join(SELENIUM_DIR, 'hybrid_run.py'), args: hybridArgs(w2.accFile, pxFile, payload, jobId), env: { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: '0' }, label: '[衔接·混合]', tag: '[H→混合]', slotBase: 0 });
      }
      if (toSelenium.size) {
        const w2 = tempInputs.writeSubset(jobId, payload.accounts, toSelenium, 'accounts.handoff-selenium.txt');
        if (w2.count) p2specs.push({ script: path.join(SELENIUM_DIR, 'run.py'), args: seleniumArgs(w2.accFile, pxFile, payload, jobId), env: { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: String(_c) }, label: '[衔接·Selenium]', tag: '[S→Sel]', slotBase: _c });
      }
      // 先记第二轮 startLines,再跑,只 harvest 第二轮新增行 → 与第一轮隔离
      const p2start = { selenium: countLines(RESULTS.selenium), hybrid: countLines(RESULTS.hybrid) };
      if (p2specs.length) await Promise.all(p2specs.map((s) => runSpec(jobId, s, publish, shared)));
      for (const r of harvest(RESULTS.selenium, p2start.selenium)) if (r && r.email) byEmail.set(r.email, r);  // 第二轮覆盖第一轮
      for (const r of harvest(RESULTS.hybrid, p2start.hybrid)) if (r && r.email) byEmail.set(r.email, r);
      rows = [...byEmail.values()];
    }
  } else if (engine === 'split') {
    harvest(RESULTS.selenium, startLines.selenium).forEach((r) => rows.push(r));
    harvest(RESULTS.hybrid, startLines.hybrid).forEach((r) => rows.push(r));
  } else {
    const key = engine === 'hybrid' ? 'hybrid' : 'selenium';
    harvest(RESULTS[key], startLines[key]).forEach((r) => rows.push(r));
  }
  // 续跑被跳过的号(已完成/被拒/冷却/坏邮箱)本 job 没有结果行 → 控制台「本次任务」详情/计数看不到「跑过的号」。
  //   用它们【历史最近一行】回填进本 job 视图,让这些号可见。★只读回填、按 email 取历史 latest、ok/steps 原样(banned→failed、
  //   已绑→success),【绝不伪造成功】;只进 per-job 快照(writeDetail/writeBatchResults),不写 append-only results.jsonl(不污染权威源)。
  try {
    const haveEmails = new Set(rows.map((r) => r && r.email).filter(Boolean));
    const wantAccts = (payload.accounts || []).filter((a) => a && a.email && !haveEmails.has(a.email));
    if (wantAccts.length) {
      const files = engine === 'split' ? [RESULTS.selenium, RESULTS.hybrid] : [engine === 'hybrid' ? RESULTS.hybrid : RESULTS.selenium];
      const latest = new Map();   // email → 历史最近一行(全文件扫,按 at 取更近者;跳过号的行在本 job startLine 之前)
      for (const f of files) {
        for (const r of readTail(f, 0, { dropped: 0 })) {
          if (!r || !r.email) continue;
          const prev = latest.get(r.email);
          if (!prev || String(r.at || '') >= String(prev.at || '')) latest.set(r.email, r);
        }
      }
      let _back = 0;
      for (const a of wantAccts) {
        const r = latest.get(a.email);
        if (r) { rows.push({ ...r, job_id: jobId, _resumed_skip: true }); _back += 1; }
      }
      if (_back) publish(jobId, 'log', `续跑:${_back} 个已完成/跳过的号用历史结果回填进本次视图(不重跑、不改判定、不污染结果源)`);
    }
  } catch (_e) { /* 回填失败不致命,仅本 job 视图少几个跳过号 */ }
  // 把输入账号的原密码 join 回结果(结果文件不含密码)→ 导出/重跑能拿到 email:原密码
  const accByEmail = new Map((payload.accounts || []).map((a) => [a.email, a.password || '']));
  const successRows = [];
  const failedRows = [];
  for (const r of rows) { const [k, v] = mapRow(r, accByEmail); (k === 'success' ? successRows : failedRows).push(v); }
  // 桥接进账号台账(账号页/续跑读它):注册/key/billing/充值/卡/拉黑都合并进去,修"账号页对 Python 引擎一片空白"。
  try { await bridgeToAccountStore(rows); } catch (_e) { /* 桥接失败不影响 job 收口 */ }
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
  // 结果对账(split 尤其需要):有结果但【不足总数】= 某分流组/子进程疑似中途退出、丢了那批账号的结果。
  //   不改判定(成败仍按真实结果),只【标记 + 告警】让运行日志/历史可见,提示可「续跑这批」补齐。
  const resultCount = success + failed;
  const completenessPct = Math.round((100 * resultCount) / Math.max(1, shared.total));
  const partial = resultCount > 0 && resultCount < shared.total;   // >0 且 <total:部分结果(区别于 crashError 的零结果整崩)
  const summary = { jobId, total: shared.total, success, failed, durationMs: Date.now() - startedAt, engine, resultFiles, completenessPct, ...(partial ? { partial: true } : {}), ...(crashError ? { error: crashError } : {}) };
  if (partial) publish(jobId, 'log', `⚠ 结果可能未完整:${resultCount}/${shared.total}(${completenessPct}%)—— 某分流组/子进程疑似中途退出丢了部分账号结果,可用「续跑这批」补齐`);
  if (crashError) publish(jobId, 'log', crashError);
  publish(jobId, 'job-done', summary);
  return summary;
  } finally {
    tempInputs.cleanup(jobId);   // ★ 不管 Promise.all/后处理是否抛错,临时输入文件都必清(rel-1)
  }
}

module.exports = { spawnEngine, RESULTS, isSuccessRow, readTail, countLines, readDetail, mapRow, renderTpl, handoffTarget, bridgeToAccountStore, isNotAllowed, pyFailReason, reasonFromLine };
