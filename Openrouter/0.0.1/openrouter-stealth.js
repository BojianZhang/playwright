'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / stealth
//
// 文件定位：Openrouter/0.0.1/openrouter-stealth.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 给「原生 Playwright 启动的 Chrome」打反检测补丁，降低被 Stripe Radar /
//            指纹站识别为自动化的概率（webdriver / chrome.runtime / plugins / languages /
//            WebGL 厂商 / permissions 等）。
// ❌ 不负责 —— AdsPower 接管模式（那套由 AdsPower 自身指纹处理，无需本补丁）。
//
// 说明：CDP 层面的 Runtime.enable 泄漏等无法从页面 JS 消除，本补丁覆盖的是 JS 可见特征；
//       真正强反检测请用 AdsPower 接管（openrouter-adspower.js）。
// ═══════════════════════════════════════════════════════════════════════

// 注入进每个页面/frame 的反检测脚本（addInitScript，文档脚本之前执行）。
function stealthInit() {
  // navigator.webdriver → undefined
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  // window.chrome / chrome.runtime（自动化 Chrome 常缺失，真人浏览器有）
  try { if (!window.chrome) window.chrome = {}; if (!window.chrome.runtime) window.chrome.runtime = {}; } catch (e) {}
  // permissions.query：notifications 与 Notification.permission 保持一致（headless 常露馅）
  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) {
      navigator.permissions.query = (p) => (p && p.name === 'notifications'
        ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default') })
        : orig(p));
    }
  } catch (e) {}
  // plugins / mimeTypes 非空
  try {
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [1, 2, 3] });
  } catch (e) {}
  // languages 固定 en-US（与美国 IP 一致）
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  // WebGL 厂商/渲染器伪装（去掉 SwiftShader/Google Inc. 这类无头特征）
  try {
    const patch = (proto) => {
      if (!proto) return;
      const gp = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return 'Intel Iris OpenGL Engine';   // UNMASKED_RENDERER_WEBGL
        return gp.call(this, p);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') patch(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patch(WebGL2RenderingContext.prototype);
  } catch (e) {}
  // 隐藏 headless 的 navigator.connection / hardwareConcurrency 异常（保守，不强改）
  try { if (navigator.hardwareConcurrency === 0) Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }); } catch (e) {}
}

/**
 * 在 context 上安装 stealth 补丁（每页生效）。仅用于原生 Playwright 模式。
 * @param {import('playwright').BrowserContext} context
 */
async function installStealth(context) {
  await context.addInitScript(stealthInit);
}

// 启动时建议从默认参数里移除的自动化开关（配合 chromium.launch 的 ignoreDefaultArgs）。
const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-blink-features=IdleDetection'];

module.exports = { installStealth, stealthInit, IGNORE_DEFAULT_ARGS };
