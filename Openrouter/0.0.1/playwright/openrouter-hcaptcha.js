'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / hcaptcha
//
// 文件定位：Openrouter/0.0.1/openrouter-hcaptcha.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 安装 hCaptcha 拦截（api.js route 注入 render 包装器，抓 sitekey + callback），
//            以及加卡/付款时弹出的 hCaptcha「I am human」的「求解 + 注入 token」整套逻辑。
// ❌ 不负责 —— 业务表单填写（由 stages.js 负责）。
//
// 与 Turnstile 的区别：
//   - 注册阶段是 Cloudflare Turnstile（challenges.cloudflare.com）。
//   - 加卡/付款阶段是 Stripe 风控弹的 hCaptcha（js.hcaptcha.com / *.hcaptcha.com）。
//   两者机制类似：都靠拦截各自的 api.js、包住 render 抓 callback，求解后 callback(token) 放行。
//
// 关键：addInitScript / context.route 会作用于 context 内**所有 frame**（含 Stripe 跨域 iframe），
//        所以即便 hCaptcha 是在 Stripe iframe 里 render 的，包装器也能装进去、callback 也能抓到。
// ═══════════════════════════════════════════════════════════════════════

const { solveHCaptcha } = require('./captcha-solver');

// 注入进 hCaptcha api.js 首尾的包装器：包住 hcaptcha.render，抓 sitekey + callback 到 window。
// hCaptcha 的 render(container, params) 里 params.sitekey / params.callback 即所需。
// 抓 render(sitekey/rqdata/size/callback) + execute(rqdata)。企业版 hCaptcha 的 rqdata 多在 execute 时传。
const HC_RENDER_WRAPPER = `;(function(){function g(p){try{if(!p)return;window.__hcParams=window.__hcParams||{};if(p.sitekey||p.siteKey)window.__hcParams.sitekey=p.sitekey||p.siteKey;if(p.rqdata)window.__hcParams.rqdata=p.rqdata;if(p.size)window.__hcParams.size=p.size;if(typeof p.callback==='function')window.hcCallback=p.callback;}catch(e){}}
function w(){try{if(!window.hcaptcha)return;if(window.hcaptcha.render&&!window.hcaptcha.__wr){var o=window.hcaptcha.render.bind(window.hcaptcha);window.hcaptcha.render=function(c,p){g(p);return o(c,p);};window.hcaptcha.__wr=true;}if(window.hcaptcha.execute&&!window.hcaptcha.__we){var oe=window.hcaptcha.execute.bind(window.hcaptcha);window.hcaptcha.execute=function(a,b){try{var opt=(a&&typeof a==='object')?a:b;if(opt&&opt.rqdata){window.__hcParams=window.__hcParams||{};window.__hcParams.rqdata=opt.rqdata;}}catch(e){}return oe(a,b);};window.hcaptcha.__we=true;}}catch(e){}}
w();var i=setInterval(w,5);setTimeout(function(){clearInterval(i);},60000);})();`;

/**
 * 在 context 上安装 hCaptcha 拦截。必须在导航到加卡页之前（建议与 Turnstile 同处）调用。
 * @param {import('playwright').BrowserContext} context
 */
async function installHCaptchaIntercept(context) {
  // 双保险：addInitScript 注入包装器（每页生效，与 api.js 是否走缓存/CDP 无关），
  // 这是 AdsPower(CDP 接管 + 磁盘缓存)下能钩到 hcaptcha.render/execute callback 的关键。
  await context.addInitScript(HC_RENDER_WRAPPER).catch(() => {});
  await context.route('**hcaptcha.com/**api.js*', async (route) => {
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      await route.fulfill({
        response: resp,
        body: `${HC_RENDER_WRAPPER}\n${body}\n${HC_RENDER_WRAPPER}`,
        headers: { ...resp.headers(), 'content-type': 'application/javascript; charset=utf-8' },
      });
    } catch (e) {
      await route.continue();
    }
  });
}

/**
 * 检测当前页面是否出现了 hCaptcha 挑战（任一 frame）。
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function hasHCaptcha(page) {
  // 只在「可见」的挑战 widget 上触发——避免把已通过/隐藏的 hCaptcha iframe 误判成"还在挑战"，
  // 否则会对已解的 widget 反复重复求解(白烧 2Captcha 次数)。
  for (const f of [page.mainFrame(), ...page.frames()]) {
    const hit = await f.evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 16 && r.height > 16 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      // 可见的 hCaptcha iframe（checkbox 或 challenge 弹层）
      const ifr = Array.from(document.querySelectorAll('iframe[src*="hcaptcha.com"]')).find(vis);
      if (ifr) {
        // 若已解，response textarea 会被填值 → 视为已通过，不再触发。
        const resp = document.querySelector('textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"]');
        if (resp && resp.value && resp.value.length > 20) return false;
        return true;
      }
      return false;
    }).catch(() => false);
    if (hit) return true;
  }
  return false;
}

/** 从所有 frame 里尽力提取 hCaptcha 参数 { sitekey, rqdata, invisible }（hook 优先，其次 iframe src / data 属性）。 */
async function extractHcParams(page) {
  const out = { sitekey: null, rqdata: null, invisible: false };
  for (const f of [page.mainFrame(), ...page.frames()]) {
    const p = await f.evaluate(() => {
      const r = {};
      if (window.__hcParams) { r.sitekey = window.__hcParams.sitekey; r.rqdata = window.__hcParams.rqdata; r.size = window.__hcParams.size; }
      if (!r.sitekey) {
        const el = document.querySelector('[data-sitekey],[data-hcaptcha-sitekey]');
        if (el) r.sitekey = el.getAttribute('data-sitekey') || el.getAttribute('data-hcaptcha-sitekey');
      }
      if (!r.sitekey) {
        const ifr = document.querySelector('iframe[src*="hcaptcha.com"]');
        if (ifr) { const m = (ifr.src || '').match(/sitekey=([0-9a-fA-F-]{20,})/); if (m) r.sitekey = m[1]; }
      }
      return r;
    }).catch(() => ({}));
    if (p && p.sitekey && !out.sitekey) out.sitekey = p.sitekey;
    if (p && p.rqdata && !out.rqdata) out.rqdata = p.rqdata;
    if (p && p.size === 'invisible') out.invisible = true;
  }
  if (!out.sitekey) {
    for (const f of page.frames()) {
      const m = (f.url() || '').match(/sitekey=([0-9a-fA-F-]{20,})/);
      if (m) { out.sitekey = m[1]; break; }
    }
  }
  return out;
}

/**
 * 求解当前页面的 hCaptcha 并注入 token。
 * 前置：页面已触发 hCaptcha（点过 Save，widget 已加载）。
 *
 * @param {import('playwright').Page} page
 * @param {object} opts { apiKey, pageUrl, timeoutMs?, log? }
 * @returns {Promise<{ ok: boolean, reason?: string, elapsedMs?: number }>}
 */
async function solveHCaptchaAndInject(page, opts = {}) {
  const { apiKey, pageUrl, timeoutMs = 120000, log = () => {} } = opts;
  const { sitekey, rqdata, invisible } = await extractHcParams(page);
  if (!sitekey) return { ok: false, reason: 'HCAPTCHA_SITEKEY_NOT_FOUND' };
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  log(`hcaptcha sitekey=${sitekey} rqdata=${rqdata ? '有(企业版)' : '无'} invisible=${invisible} 求解中…`);

  const solved = await solveHCaptcha({ apiKey, sitekey, pageUrl, userAgent, rqdata, invisible, timeoutMs, log });
  if (!solved.token) return { ok: false, reason: solved.error || 'HCAPTCHA_SOLVE_FAILED' };
  log(`hcaptcha token len=${solved.token.length} (${solved.elapsedMs}ms) → 注入`);

  // 注入：每个 frame 里都尝试 —— 调 hcCallback（最关键，等价用户过验证）+ 写响应 textarea 兜底。
  let hadCallback = false;
  for (const f of [page.mainFrame(), ...page.frames()]) {
    const cb = await f.evaluate((tok) => {
      let called = false;
      try { if (typeof window.hcCallback === 'function') { window.hcCallback(tok); called = true; } } catch (e) {}
      document.querySelectorAll('textarea[name="h-captcha-response"],textarea[name="g-recaptcha-response"],textarea[id^="h-captcha-response"],textarea[id^="g-recaptcha-response"]').forEach((el) => {
        el.value = tok;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return called;
    }, solved.token).catch(() => false);
    if (cb) hadCallback = true;
  }
  log(`hcaptcha 注入完成 hadCallback=${hadCallback}`);
  return { ok: true, elapsedMs: solved.elapsedMs, hadCallback };
}

module.exports = { installHCaptchaIntercept, solveHCaptchaAndInject, hasHCaptcha, HC_RENDER_WRAPPER };
