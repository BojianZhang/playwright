'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / turnstile
//
// 文件定位：Openrouter/0.0.1/openrouter-turnstile.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 安装 Turnstile 拦截（api.js route 注入 render 包装器 + 隐藏 webdriver），
//            以及「求解 + 注入 token」的整套逻辑。
// ✅ 负责 —— 从页面/网络抓 sitekey，调 captcha-solver 求解，执行 window.tsCallback(token)。
// ❌ 不负责 —— 业务表单填写（由 S2 adapter 负责）。
//
// 关键（见记忆 openrouter-turnstile-solution）：
//   - 不能用 defineProperty trap（api.js 反篡改）；必须 route 拦截 api.js 注入包装器。
//   - 浏览器需 channel:'chrome' + --disable-blink-features=AutomationControlled。
//   - 2Captcha 账号需关 SandBox。
// ═══════════════════════════════════════════════════════════════════════

const { solveTurnstile } = require('./captcha-solver');

// 注入进 api.js 首尾的包装器：抓 callback + sitekey 到 window。
const RENDER_WRAPPER = `;(function(){function w(){try{if(window.turnstile&&window.turnstile.render&&!window.turnstile.__w){var o=window.turnstile.render.bind(window.turnstile);window.turnstile.render=function(c,p){try{window.__cfParams={sitekey:p.sitekey,cdata:p.cData,pagedata:p.chlPageData,action:p.action};window.tsCallback=p.callback;}catch(e){}return o(c,p);};window.turnstile.__w=true;}}catch(e){}}w();var i=setInterval(w,5);setTimeout(function(){clearInterval(i);},30000);})();`;

/**
 * 在 context 上安装 Turnstile 拦截。必须在导航到注册页之前调用。
 * @param {import('playwright').BrowserContext} context
 */
async function installTurnstileIntercept(context) {
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  });
  await context.route('**/turnstile/v0/**/api.js*', async (route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      await route.fulfill({
        response: resp,
        body: `${RENDER_WRAPPER}\n${body}\n${RENDER_WRAPPER}`,
        headers: { ...resp.headers(), 'content-type': 'application/javascript; charset=utf-8' },
      });
    } catch (e) {
      await route.continue();
    }
  });
}

/**
 * 求解当前页面的 Turnstile 并把 token 注入回 Clerk。
 * 前置：页面已触发 Turnstile（点过提交，widget 已加载）。
 *
 * @param {import('playwright').Page} page
 * @param {object} opts { provider, apiKey, pageUrl, cfRequestUrls?, timeoutMs?, log? }
 * @returns {Promise<{ ok: boolean, reason?: string, elapsedMs?: number }>}
 */
async function solveAndInject(page, opts = {}) {
  const { provider, apiKey, pageUrl, cfRequestUrls = [], timeoutMs = 180000, log = () => {} } = opts;

  // 1) 取 params：优先 hook 捕获，其次网络 URL 兜底。
  const params = await page.evaluate(() => window.__cfParams || null).catch(() => null);
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  let sitekey = params && params.sitekey;
  if (!sitekey && cfRequestUrls.length) {
    const m = cfRequestUrls.join('\n').match(/\/(0x4[0-9A-Za-z]{10,})\//);
    sitekey = m && m[1];
  }
  if (!sitekey) return { ok: false, reason: 'TURNSTILE_SITEKEY_NOT_FOUND' };
  log(`sitekey=${sitekey} params=${params ? 'hooked' : 'network-fallback'}`);

  // 2) 求解
  const solved = await solveTurnstile({
    provider, apiKey, sitekey, pageUrl,
    action: params && params.action, cdata: params && params.cdata, pagedata: params && params.pagedata, userAgent,
    timeoutMs, log,
  });
  if (!solved.token) return { ok: false, reason: solved.error || 'TURNSTILE_SOLVE_FAILED' };
  log(`token len=${solved.token.length}`);

  // 3) 注入：callback 优先（几乎必过），再写 response 字段兜底。返回是否拿到 callback。
  const hadCallback = await page.evaluate((tok) => {
    let cb = false;
    if (typeof window.tsCallback === 'function') { try { window.tsCallback(tok); cb = true; } catch (e) {} }
    document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[id$="_response"], textarea[id$="_response"]').forEach((el) => {
      el.value = tok;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return cb;
  }, solved.token).catch(() => false);

  return { ok: true, elapsedMs: solved.elapsedMs, hadCallback };
}

module.exports = { installTurnstileIntercept, solveAndInject, RENDER_WRAPPER };
