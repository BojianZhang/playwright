'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / captcha-solver
//
// 文件定位：Openrouter/0.0.1/captcha-solver.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 调用第三方打码服务（CapSolver / 2Captcha）解 Cloudflare Turnstile，
//            输入 sitekey + pageURL（+ action/cdata），返回 token 字符串。
// ❌ 不负责 —— 浏览器操作、token 注入（由 S2 adapter 通过 turnstile.callback 注入）。
//
// 安全：apiKey 不写死在代码里，从 config.captcha.apiKey / 环境变量读取（见 job-runner）。
//        本文件不打印 apiKey。
// ═══════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解 Turnstile，返回 token。
 *
 * @param {object} opts
 * @param {'capsolver'|'2captcha'} [opts.provider='capsolver']
 * @param {string} opts.apiKey
 * @param {string} opts.sitekey
 * @param {string} opts.pageUrl
 * @param {string} [opts.action]      Cloudflare Challenge page: turnstile.render 的 action
 * @param {string} [opts.cdata]       Cloudflare Challenge page: cData
 * @param {string} [opts.pagedata]    Cloudflare Challenge page: chlPageData
 * @param {string} [opts.userAgent]   建议与浏览器一致
 * @param {number} [opts.timeoutMs=120000]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{ token: string|null, userAgent: string|null, error: string|null, provider: string, elapsedMs: number }>}
 */
async function solveTurnstile(opts = {}) {
  const {
    provider = 'capsolver',
    apiKey,
    sitekey,
    pageUrl,
    action,
    cdata,
    pagedata,
    userAgent,
    timeoutMs = 120000,
    log = () => {},
  } = opts;

  const startedAt = Date.now();
  if (!apiKey) return fail('CAPTCHA_API_KEY_MISSING');
  if (!sitekey) return fail('TURNSTILE_SITEKEY_MISSING');
  if (!pageUrl) return fail('TURNSTILE_PAGEURL_MISSING');

  try {
    const args = { apiKey, sitekey, pageUrl, action, cdata, pagedata, userAgent, timeoutMs, log };
    const result = provider === '2captcha'
      ? await solveWith2Captcha(args)
      : await solveWithCapSolver(args);
    const token = typeof result === 'string' ? result : result && result.token;
    if (!token) return fail('TURNSTILE_SOLVE_EMPTY_TOKEN');
    return { token, userAgent: (result && result.userAgent) || null, error: null, provider, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return fail(String(error && error.message || 'TURNSTILE_SOLVE_ERROR'));
  }

  function fail(error) {
    return { token: null, userAgent: null, error, provider, elapsedMs: Date.now() - startedAt };
  }
}

// ── CapSolver ───────────────────────────────────────────────────────────
async function solveWithCapSolver({ apiKey, sitekey, pageUrl, action, cdata, pagedata, userAgent, timeoutMs, log }) {
  const metadata = {};
  if (action) metadata.action = action;
  if (cdata) metadata.cdata = cdata;
  if (pagedata) metadata.chlPageData = pagedata;

  const createResp = await postJson('https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: pageUrl,
      websiteKey: sitekey,
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...(userAgent ? { userAgent } : {}),
    },
  });
  if (createResp.errorId) throw new Error(`capsolver:createTask:${createResp.errorCode || createResp.errorDescription}`);
  const taskId = createResp.taskId;
  log(`capsolver task ${taskId} 创建,等待求解…`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const res = await postJson('https://api.capsolver.com/getTaskResult', { clientKey: apiKey, taskId });
    if (res.errorId) throw new Error(`capsolver:getTaskResult:${res.errorCode || res.errorDescription}`);
    if (res.status === 'ready') return { token: res.solution && res.solution.token, userAgent: res.solution && res.solution.userAgent };
  }
  throw new Error('capsolver:timeout');
}

// ── 2Captcha（新版 createTask API：api.2captcha.com）────────────────────────
// Standalone：TurnstileTaskProxyless + websiteURL + websiteKey。
// Cloudflare Challenge page：再带 action + data(cData) + pagedata(chlPageData)。
async function solveWith2Captcha({ apiKey, sitekey, pageUrl, action, cdata, pagedata, userAgent, timeoutMs, log }) {
  const task = { type: 'TurnstileTaskProxyless', websiteURL: pageUrl, websiteKey: sitekey };
  if (action) task.action = action;
  if (cdata) task.data = cdata;
  if (pagedata) task.pagedata = pagedata;
  if (userAgent) task.userAgent = userAgent;

  const createResp = await postJson('https://api.2captcha.com/createTask', { clientKey: apiKey, task });
  if (createResp.errorId) throw new Error(`2captcha:createTask:${createResp.errorCode || createResp.errorDescription}`);
  const taskId = createResp.taskId;
  log(`2captcha task ${taskId} 创建,等待求解…`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    const res = await postJson('https://api.2captcha.com/getTaskResult', { clientKey: apiKey, taskId });
    if (res.errorId) throw new Error(`2captcha:getTaskResult:${res.errorCode || res.errorDescription}`);
    if (res.status === 'ready') return { token: res.solution && (res.solution.token || res.solution.gRecaptchaResponse), userAgent: (res.solution && res.solution.userAgent) || userAgent || null };
  }
  throw new Error('2captcha:timeout');
}

/**
 * 解 hCaptcha（加卡/付款时 Stripe 风控弹的「I am human」），返回 token。
 * 目前只走 2Captcha（HCaptchaTaskProxyless）；CapSolver 亦支持，按需再加。
 *
 * @param {object} opts { provider?, apiKey, sitekey, pageUrl, userAgent?, timeoutMs?, log? }
 * @returns {Promise<{ token: string|null, error: string|null, elapsedMs: number }>}
 */
async function solveHCaptcha(opts = {}) {
  const { apiKey, sitekey, pageUrl, userAgent, rqdata, invisible, timeoutMs = 120000, log = () => {} } = opts;
  const startedAt = Date.now();
  const fail = (error) => ({ token: null, error, elapsedMs: Date.now() - startedAt });
  if (!apiKey) return fail('CAPTCHA_API_KEY_MISSING');
  if (!sitekey) return fail('HCAPTCHA_SITEKEY_MISSING');
  if (!pageUrl) return fail('HCAPTCHA_PAGEURL_MISSING');
  try {
    const task = { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: sitekey };
    if (userAgent) task.userAgent = userAgent;
    if (invisible) task.isInvisible = true;
    // 企业版 hCaptcha：必须带 rqdata，否则解出的 token 无效（站点后端认证失败 / Error 502）。
    if (rqdata) task.enterprisePayload = { rqdata };
    log(`hcaptcha 任务参数: invisible=${!!invisible} enterprise(rqdata)=${rqdata ? 'yes' : 'no'}`);
    const createResp = await postJson('https://api.2captcha.com/createTask', { clientKey: apiKey, task });
    if (createResp.errorId) return fail(`2captcha:createTask:${createResp.errorCode || createResp.errorDescription}`);
    const taskId = createResp.taskId;
    log(`2captcha hcaptcha task ${taskId} 创建,等待求解…`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(5000);
      const res = await postJson('https://api.2captcha.com/getTaskResult', { clientKey: apiKey, taskId });
      if (res.errorId) return fail(`2captcha:getTaskResult:${res.errorCode || res.errorDescription}`);
      if (res.status === 'ready') {
        const token = res.solution && (res.solution.token || res.solution.gRecaptchaResponse);
        return token ? { token, error: null, elapsedMs: Date.now() - startedAt } : fail('HCAPTCHA_SOLVE_EMPTY_TOKEN');
      }
    }
    return fail('2captcha:timeout');
  } catch (error) {
    return fail(String((error && error.message) || 'HCAPTCHA_SOLVE_ERROR'));
  }
}

// ── HTTP 小工具（Node 全局 fetch）─────────────────────────────────────────
// 必须显式 AbortSignal 超时:裸 fetch 在半开连接(对端接受 TCP 但久不回 header)上,
// undici 默认 headersTimeout 高达 300s,单次就能拖到 Python 360s 把整个 Node 进程强杀、
// 丢掉已建的 key。30s 上限把单次外部 HTTP 卡死压到可控。
function _timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch (_e) { return undefined; }   // 老 Node 没有则不加(不致命)
}
async function postJson(url, body) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: _timeoutSignal(30000) });
  return resp.json();
}
async function getJson(url) {
  const resp = await fetch(url, { signal: _timeoutSignal(30000) });
  return resp.json();
}

module.exports = { solveTurnstile, solveHCaptcha };
