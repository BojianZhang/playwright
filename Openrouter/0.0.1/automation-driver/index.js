'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 自动化驱动层 — 注册表（可切换驱动：Playwright / Puppeteer / Selenium / playwright-python）
//
// 文件定位：Openrouter/0.0.1/automation-driver/index.js
//
// 与 browser-provider 层对偶：provider 给你一个 CDP 端点(ws/debugPort)，driver 接管这个端点。
//   - Node 驱动(playwright/puppeteer)：attach(endpoint) → 活的 handle({driver,browser,page,detach})。
//   - Python 驱动(selenium/playwright-python)：run(endpoint, taskFile, input) → 子进程跑任务、回结果。
// 惰性注册：某驱动缺依赖(如未装 puppeteer/python)只禁用它自己。
//
// ⚠ 主业务流程 stages.js 仍用 Playwright(几千行 Playwright 专用调用，整条换驱动=重写、零增益)。
//   本层用于：① 写【新的/可移植】自动化(一段代码经 ops 在 playwright/puppeteer 上通用)；
//            ② 按步换驱动(填卡那步已能用 Selenium，见 billing/card-fill)。
// ═══════════════════════════════════════════════════════════════════════

const LOADERS = {
  playwright: () => require('./drivers/playwright'),
  puppeteer: () => require('./drivers/puppeteer'),
  selenium: () => require('./drivers/selenium'),
  'playwright-python': () => require('./drivers/playwright_python'),
};

function listDrivers() { return Object.keys(LOADERS); }

function getDriver(name) {
  const l = LOADERS[name];
  if (!l) return null;
  try { const m = l(); return (m && (m.attach || m.run)) ? m : null; } catch (_e) { return null; }
}

// Node 驱动：接管 CDP 端点 → 统一 handle。endpoint = { ws?, debugPort? }(来自 provider.start())。
async function attach(name, endpoint, opts = {}) {
  const d = getDriver(name);
  if (!d) { const e = new Error(`UNKNOWN_DRIVER:${name}`); e._driver = true; throw e; }
  if (d.kind !== 'node' || typeof d.attach !== 'function') throw new Error(`DRIVER_NOT_NODE:${name}(请用 run())`);
  return d.attach(endpoint, opts);
}

// Python 驱动：子进程跑任务脚本 → 结果对象。taskFile 不传则用驱动内置默认任务脚本。
async function run(name, endpoint, taskFile, input = {}, opts = {}) {
  const d = getDriver(name);
  if (!d) { const e = new Error(`UNKNOWN_DRIVER:${name}`); e._driver = true; throw e; }
  if (typeof d.run !== 'function') throw new Error(`DRIVER_NO_RUN:${name}(请用 attach())`);
  return d.run(endpoint, taskFile, input, opts);
}

module.exports = { listDrivers, getDriver, attach, run };
