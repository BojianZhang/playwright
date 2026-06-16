'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — extension（替代 · 浏览器内）
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/engines/extension.js
//
// 思路：一个【预装进 AdsPower 环境】的 MV3 扩展，content script 注入 js.stripe.com 所有帧。
//   Node 经 Playwright 在 Stripe 帧里 window.postMessage(OR_FILL + card)；content script 用
//   原生 value setter + input 事件逐字符填卡(在帧源内，免跨域)，结果写 <html data-or-fill-result>。
//   Node 轮询读该 DOM 属性(跨"隔离世界"靠共享 DOM) + 再用 Playwright 回读输入框双重校验。
//
// ⚠ 扩展【必须手动预装进每个 AdsPower 环境】——CDP 接管的运行中浏览器无法 --load-extension。
//   见 billing/card-fill/extension/README.md。未装/无响应 → 本引擎优雅落链(返回未填)。
// ═══════════════════════════════════════════════════════════════════════

const sels = require('../selectors');

// 找含卡号框的那个帧(content script 在其中跑)。
async function findCardFrame(page) {
  for (const f of [page.mainFrame(), ...page.frames()]) {
    for (const sel of sels.number) {
      try {
        const loc = f.locator(sel).first();
        if ((await loc.count().catch(() => 0)) && (await loc.isVisible().catch(() => false))) return f;
      } catch (_e) { /* next */ }
    }
  }
  return null;
}

// 用 Playwright 回读某帧里的字段，校验位数是否够。
async function readback(frame, selectors, want) {
  const w = String(want || '').replace(/\D/g, '');
  if (!w) return undefined;
  for (const sel of selectors) {
    try {
      const loc = frame.locator(sel).first();
      if (!(await loc.count().catch(() => 0))) continue;
      const v = ((await loc.inputValue().catch(() => '')) || '').replace(/\D/g, '');
      if (v.length >= w.length) return true;
    } catch (_e) { /* next */ }
  }
  return false;
}

async function fillCard({ page, card, address, log }) {
  const frame = await findCardFrame(page);
  if (!frame) return { num: false, exp: false, cvc: false, engine: 'extension', error: 'NO_CARD_FRAME' };
  const exp = `${card.expMonth}${card.expYear}`;
  const zip = card.zip || (address && address.zip) || '';

  // 清旧结果 + 给 content script 发卡(postMessage 跨隔离世界可达)。
  await frame.evaluate((payload) => {
    try { document.documentElement.removeAttribute('data-or-fill-result'); } catch (e) { /* */ }
    window.postMessage({ type: 'OR_FILL', card: payload }, '*');
  }, { number: card.number, expiry: exp, cvc: card.cvc, postal: zip }).catch(() => {});

  // 轮询 content script 回写的结果属性(最多 ~4s)；无 → 扩展没装/没响应。
  let acked = false;
  for (let i = 0; i < 20; i += 1) {
    const r = await frame.evaluate(() => document.documentElement.getAttribute('data-or-fill-result')).catch(() => null);
    if (r) { acked = true; break; }
    await page.waitForTimeout(200);
  }
  if (!acked) log && log('extension 引擎：content script 无响应(扩展未预装进该环境?) → 落链');
  await page.waitForTimeout(300);

  // 无论是否 ack，都用 Playwright 回读真实输入框(扩展真填了就过；没填→false→链上 playwright 接管)。
  const num = await readback(frame, sels.number, card.number);
  const ex = await readback(frame, sels.expiry, exp);
  const cvc = await readback(frame, sels.cvc, card.cvc);
  let z;
  if (zip) z = await readback(frame, sels.postal, zip);
  return { num: !!num, exp: !!ex, cvc: !!cvc, zip: zip ? !!z : undefined, engine: 'extension', error: acked ? undefined : 'EXT_NO_ACK' };
}

module.exports = { name: 'extension', fillCard };
