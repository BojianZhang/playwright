'use strict';

// 驱动 — Playwright（Node · 默认 · 已验证）。connectOverCDP 接管 provider 的 CDP 端点。
// endpoint = { ws?, debugPort? }。返回统一 handle { driver, browser, context, page, detach() }。
module.exports = {
  name: 'playwright',
  kind: 'node',
  attach: async (endpoint = {}) => {
    const { chromium } = require('playwright');
    const ws = endpoint.ws || (endpoint.debugPort && `http://127.0.0.1:${endpoint.debugPort}`);
    if (!ws) throw new Error('playwright:NO_ENDPOINT(需 ws 或 debugPort)');
    const browser = await chromium.connectOverCDP(ws, { timeout: 30000 });
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    return { driver: 'playwright', browser, context, page, detach: async () => { await browser.close().catch(() => {}); } };
  },
};
