'use strict';

// ═══════════════════════════════════════════════════════════════════════
// playwright / diag-utils — 诊断/探针公共工具
//
// 文件定位：Openrouter/0.0.1/playwright/diag-utils.js
//
// 用途：把散在各 `_*.js` 诊断/探针脚本里重复的「连AdsPower / 读config / 截图 / dumpDOM / 跨帧填读」
//       抽成一处复用。写新探针时 `const { connectAds, dumpDom, shot } = require('./diag-utils')` 即可。
//
// 边界(BOUNDARY)：
//   ✅ 负责 —— 只放【通用、无副作用、无敏感】的诊断辅助;AdsPower 接管直接薄封装生产 `./openrouter-adspower`(不重造)。
//   ❌ 不负责 —— 业务流程(引擎①各阶段)、不内置任何【真实卡号/代理凭证/账号】(那些留在各 gitignore 的 _*.js 里)。
//   截图/输出统一落 ../logs/(见 logs/README.md)。
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');            // 0.0.1/
const LOG_DIR = path.join(ROOT, 'logs');

// config.json + config.local.json(密钥)合并 —— 替掉各 scratch 各写一遍的合并样板。
function loadConfig() {
  let cfg = {};
  try { cfg = require('../config/config.json'); } catch (_e) { /* none */ }
  try { cfg = Object.assign({}, cfg, require('../config/config.local.json')); } catch (_e) { /* optional */ }
  return cfg;
}

// 连/接管 AdsPower 环境 —— 薄封装,内部直接用生产 ./openrouter-adspower 的 createAdsPowerRuntime,不重造。
// 返回 { browser, context, page, ... }(同 createAdsPowerRuntime);日志走 stderr 不污染 stdout。
async function connectAds(envId, opts = {}) {
  const { createAdsPowerRuntime } = require('./openrouter-adspower');
  return createAdsPowerRuntime(envId, Object.assign({ headless: 0, log: (m) => console.error('[ads]', m) }, opts));
}

// 截图 → ../logs/screenshots/<tag>.png(统一日志目录)。
async function shot(page, tag) {
  const dir = path.join(LOG_DIR, 'screenshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* */ }
  const p = path.join(dir, `${String(tag).replace(/[^\w.-]+/g, '_')}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  return p;
}

// dump 当前页关键状态(url/弹窗标题/iframe数/输入框/按钮/报错)——各探针 dump 的公因子。
async function dumpDom(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return {
      url: location.href,
      title: dlg
        ? (((dlg.querySelector('h1,h2,[role="heading"]') || {}).innerText) || '').slice(0, 60)
        : (((document.querySelector('h1') || {}).innerText) || '').slice(0, 60),
      iframeCount: document.querySelectorAll('iframe').length,
      inputs: Array.from(document.querySelectorAll('input')).map((i) => ({ t: i.type, id: i.id, name: i.name })).slice(0, 20),
      buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 16),
      errors: Array.from(document.querySelectorAll('[role="alert"], .cl-formFieldErrorText')).map((e) => (e.innerText || '').trim()).filter(Boolean),
    };
  }).catch((e) => ({ err: String(e) }));
}

// 跨主框架 + 所有 iframe:填值(诊断 Stripe 跨域表单用)。
async function fillAcross(page, sels, value) {
  if (!value) return false;
  for (const f of [page.mainFrame(), ...page.frames()]) {
    for (const sel of sels) {
      try {
        const loc = f.locator(sel).first();
        if (!(await loc.count().catch(() => 0)) || !(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 1500 }).catch(() => {});
        await loc.fill('').catch(() => {});
        await loc.type(String(value), { delay: 45 }).catch(() => {});
        return true;
      } catch (_e) { /* next */ }
    }
  }
  return false;
}

// 跨帧查找首个可见元素,返回 { f, loc, sel, host }。
async function findAcross(page, sels) {
  for (const f of [page.mainFrame(), ...page.frames()]) {
    for (const sel of sels) {
      try {
        const loc = f.locator(sel).first();
        if ((await loc.count().catch(() => 0)) && (await loc.isVisible().catch(() => false))) {
          return { f, loc, sel, host: (() => { try { return new URL(f.url()).host; } catch (_e) { return ''; } })() };
        }
      } catch (_e) { /* next */ }
    }
  }
  return null;
}

module.exports = { loadConfig, connectAds, shot, dumpDom, fillAcross, findAcross, LOG_DIR };
