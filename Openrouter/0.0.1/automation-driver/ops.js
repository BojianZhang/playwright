'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 统一操作包装 —— 让一段自动化在 Node 驱动(playwright / puppeteer)上【通用】
//
// 文件定位：Openrouter/0.0.1/automation-driver/ops.js
//
// 用法：const ops = makeOps(await driver.attach(endpoint)); await ops.goto(url); await ops.click(sel);
// 只覆盖常用操作(goto/click/type/waitFor/evaluate/frames/title/url/screenshot)——两驱动同名 API 直接转发，
//   差异处(如 fill vs type)在内部分支。需要更细操作时直接用 handle.page(原生 API)。
// ═══════════════════════════════════════════════════════════════════════

function makeOps(handle) {
  const page = handle.page;
  const isPw = handle.driver === 'playwright';
  return {
    handle,
    page,
    goto: (url, opts) => page.goto(url, Object.assign({ waitUntil: 'domcontentloaded', timeout: 30000 }, opts)),
    title: () => page.title(),
    url: () => page.url(),
    click: (sel) => page.click(sel),
    // 输入：先等元素出现(两驱动都支持 waitForSelector，避免 puppeteer 上元素晚到直接抛)，
    //   playwright 优先 fill(更稳)，否则两者都用 type。
    type: async (sel, val, ms = 15000) => {
      await page.waitForSelector(sel, { timeout: ms });
      await page.click(sel).catch(() => {});
      if (isPw) { try { await page.fill(sel, String(val)); return; } catch (_e) { /* 退回 type */ } }
      await page.type(sel, String(val));
    },
    waitFor: (sel, ms = 15000) => page.waitForSelector(sel, { timeout: ms }),
    evaluate: (fn, ...args) => page.evaluate(fn, ...args),
    frames: () => page.frames(),
    screenshot: (path) => page.screenshot({ path }),
  };
}

module.exports = { makeOps };
