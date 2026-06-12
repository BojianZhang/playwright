'use strict';

// 驱动 — Puppeteer（Node）。puppeteer-core.connect 接管 CDP 端点。需 `npm i puppeteer-core`(惰性 require，缺包只禁用本驱动)。
// endpoint = { ws?, debugPort? }。返回统一 handle { driver, browser, page, detach() }。
module.exports = {
  name: 'puppeteer',
  kind: 'node',
  attach: async (endpoint = {}) => {
    let pptr;
    try { pptr = require('puppeteer-core'); } catch (_e) { try { pptr = require('puppeteer'); } catch (_e2) { throw new Error('puppeteer:SDK_MISSING(npm i puppeteer-core)'); } }
    const opts = endpoint.ws
      ? { browserWSEndpoint: endpoint.ws }
      : (endpoint.debugPort ? { browserURL: `http://127.0.0.1:${endpoint.debugPort}` } : null);
    if (!opts) throw new Error('puppeteer:NO_ENDPOINT(需 ws 或 debugPort)');
    opts.defaultViewport = null;
    const browser = await pptr.connect(opts);
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    return { driver: 'puppeteer', browser, page, detach: async () => { await browser.disconnect().catch(() => {}); } };
  },
};
