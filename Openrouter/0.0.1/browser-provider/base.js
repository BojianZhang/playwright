'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 指纹浏览器 Provider — 厂商无关的 CDP 连接层
//
// 文件定位：Openrouter/0.0.1/browser-provider/base.js
//
// 所有指纹浏览器(AdsPower/BitBrowser/Dolphin/GoLogin…)的本地 API 启动后都返回一个 CDP ws 端点，
// 之后"用 Playwright connectOverCDP 接管 + 复用已有 tab + 摆窗口 + 返回 runtime"这一段对每家都一样。
// 本模块即从 openrouter-adspower.js 的 createAdsPowerRuntime 抽出的这段厂商无关逻辑，供各 provider 共用。
// ═══════════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');

/**
 * 经 CDP ws 端点接管浏览器，返回 { browser, context, page, ipCheck }。
 * @param {string} ws  CDP websocket(各 provider 的 start() 返回)
 * @param {object} opts { windowLayout?, log?, ipSource? }
 */
async function connectRuntime(ws, opts = {}) {
  const { windowLayout = null, log = () => {}, ipSource = 'provider' } = opts;

  // start 返回后 debug 端口偶有就绪延迟(尤其多开)→ 重试几次再放弃。
  let browser = null;
  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    try { browser = await chromium.connectOverCDP(ws, { timeout: 30000 }); break; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!browser) throw new Error(`CDP_CONNECT_FAILED:${String((lastErr && lastErr.message) || '').slice(0, 100)}`);

  // 指纹浏览器启动后已有一个默认 context + 一个 tab。
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  // 按网格摆放窗口(默认全堆左上角，用 CDP setWindowBounds 平铺，便于多开观察)。
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
    } catch (e) { log(`窗口摆位失败(忽略)：${e.message}`); }
  }

  return {
    browser,
    context,
    page,
    // IP 由指纹浏览器的代理决定；这里不单独探测(fingerprintOverview 会展示真实出口IP)。
    ipCheck: { browserRuntimeIp: null, browserRuntimeIpSource: ipSource, ipCheckError: null, checkedAt: new Date().toISOString() },
  };
}

module.exports = { connectRuntime };
