'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / adspower
//
// 文件定位：Openrouter/0.0.1/openrouter-adspower.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 调 AdsPower 本地 API 启动/关闭指纹环境，并用 Playwright 经 CDP(connectOverCDP)
//            接管该浏览器，返回 { browser, context, page } 供业务流程使用。
// ✅ 负责 —— AdsPower 环境自带代理 + 反检测指纹，故本模式下不再由 Playwright 注入代理/指纹。
// ❌ 不负责 —— 业务表单/账单流程（stages.js）。
//
// AdsPower 本地 API 默认 http://local.adspower.net:50325（也可 127.0.0.1:50325）。
//   启动: GET /api/v1/browser/start?user_id=<envId>&headless=<0|1>
//        → data.ws.puppeteer = ws://127.0.0.1:xxxx/devtools/browser/...
//   关闭: GET /api/v1/browser/stop?user_id=<envId>
// 频控：官方建议两次启动间隔 ≥1s，本模块在启动前做最小间隔节流。
// ═══════════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');

const DEFAULT_API = process.env.OPENROUTER_ADSPOWER_API || 'http://local.adspower.net:50325';
let _lastStartAt = 0;

async function apiGet(apiBase, pathQ, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${apiBase}${pathQ}`, { signal: ctrl.signal });
    const json = await resp.json().catch(() => ({}));
    return json;
  } finally { clearTimeout(timer); }
}

/** 探测 AdsPower 本地 API 是否在线。 */
async function isApiUp(apiBase = DEFAULT_API) {
  try { const j = await apiGet(apiBase, '/status', 5000); return j && j.code === 0; } catch (e) { return false; }
}

/**
 * 启动 AdsPower 环境，返回 CDP ws 端点等。
 * @param {string} userId 环境 user_id（如 k1db9yk8）
 * @param {object} opts { apiBase?, headless?, log? }
 * @returns {Promise<{ ok:boolean, ws?:string, debugPort?:string, error?:string }>}
 */
// 纯数字 → 当作 serial_number；否则当作 user_id（兼容用户填 43762 或 k1db9yk8）。
function envParam(id) {
  const v = String(id || '').trim();
  return /^\d+$/.test(v) ? `serial_number=${encodeURIComponent(v)}` : `user_id=${encodeURIComponent(v)}`;
}

async function startEnv(userId, opts = {}) {
  const { apiBase = DEFAULT_API, headless = 0, log = () => {} } = opts;
  if (!userId) return { ok: false, error: 'ADSPOWER_ENV_ID_MISSING' };
  // 先确保该环境处于关闭状态再启动：worker 重试时上一次的环境可能还在关闭中，
  // 直接再启动会拿到"正在关闭"的失效端口 → connectOverCDP ECONNREFUSED。先 stop + 等待settle。
  try { await apiGet(apiBase, `/api/v1/browser/stop?${envParam(userId)}`, 10000); } catch (_e) {}
  await new Promise((r) => setTimeout(r, 1800));
  // 最小启动间隔节流（官方建议 ≥1s）
  const wait = 1200 - (Date.now() - _lastStartAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastStartAt = Date.now();
  try {
    const j = await apiGet(apiBase, `/api/v1/browser/start?${envParam(userId)}&headless=${headless ? 1 : 0}&open_tabs=1`, 90000);
    if (j.code !== 0) return { ok: false, error: `adspower:start:${j.msg || j.code}` };
    const ws = j.data && j.data.ws && j.data.ws.puppeteer;
    if (!ws) return { ok: false, error: 'ADSPOWER_NO_WS_ENDPOINT' };
    log(`AdsPower 环境 ${userId} 已启动 (debug_port=${(j.data && j.data.debug_port) || '?'})`);
    return { ok: true, ws, debugPort: j.data && j.data.debug_port };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || 'ADSPOWER_START_ERROR') };
  }
}

/** 关闭 AdsPower 环境。 */
async function stopEnv(userId, opts = {}) {
  const { apiBase = DEFAULT_API } = opts;
  if (!userId) return;
  try { await apiGet(apiBase, `/api/v1/browser/stop?${envParam(userId)}`, 15000); } catch (e) { /* ignore */ }
}

/**
 * 启动 AdsPower 环境并用 Playwright 接管，返回 runtime（形似 createBrowserRuntime）。
 * @param {string} userId
 * @param {object} opts { apiBase?, headless?, log?, ipCheckTimeoutMs? }
 * @returns {Promise<{ browser, context, page, ipCheck, adspower:{userId,ws} }>}
 */
async function createAdsPowerRuntime(userId, opts = {}) {
  const { apiBase = DEFAULT_API, headless = 0, log = () => {}, windowLayout = null } = opts;
  const started = await startEnv(userId, { apiBase, headless, log });
  if (!started.ok) { const err = new Error(started.error || 'ADSPOWER_START_FAILED'); err._adspower = true; throw err; }

  // start 返回后 debug 端口偶有就绪延迟（尤其多开时）→ 重试几次再放弃。
  let browser = null;
  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    try { browser = await chromium.connectOverCDP(started.ws, { timeout: 30000 }); break; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!browser) { await stopEnv(userId, { apiBase }).catch(() => {}); const err = new Error(`ADSPOWER_CDP_CONNECT_FAILED:${String((lastErr && lastErr.message) || '').slice(0, 100)}`); err._adspower = true; throw err; }
  // AdsPower 启动后已有一个默认 context + 一个 tab。
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  // 按网格摆放窗口（AdsPower 默认全堆左上角，用 CDP setWindowBounds 平铺，便于多开观察）。
  if (windowLayout && (windowLayout.width || windowLayout.height)) {
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: Number(windowLayout.x || 0), top: Number(windowLayout.y || 0),
          width: Number(windowLayout.width || 1280), height: Number(windowLayout.height || 800),
          windowState: 'normal',
        },
      });
    } catch (e) { log(`AdsPower 窗口摆位失败(忽略)：${e.message}`); }
  }

  return {
    browser,
    context,
    page,
    // IP 由 AdsPower 环境代理决定；这里不单独探测（fingerprintOverview 会展示真实出口IP）。
    ipCheck: { browserRuntimeIp: null, browserRuntimeIpSource: 'adspower', ipCheckError: null, checkedAt: new Date().toISOString() },
    adspower: { userId, ws: started.ws, debugPort: started.debugPort }, // debugPort 供 selenium 填卡引擎(debuggerAddress)用
  };
}

module.exports = { isApiUp, startEnv, stopEnv, createAdsPowerRuntime, DEFAULT_API };
