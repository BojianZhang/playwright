'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — playwright（默认 · 生产已验证）
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/engines/playwright.js
//
// 用 Playwright 经 CDP 接管的浏览器，逐字符 type()+回读 穿跨域 js.stripe.com iframe（实测 16/16）。
// 行为与重构前 stages.js addPaymentMethod 的 number/exp/cvc/zip 填法【逐字一致】：
//   number/exp/cvc 走 human(逐字符+回读重试)，字段间 humanPause；zip 走非 human（与原一致）。
// 只填字段，不碰弹窗导航/Save/验证码——那些留在 runBillingFlow。
// ═══════════════════════════════════════════════════════════════════════

const sels = require('../selectors');
const { fillAcross, humanPause } = require('../fill-primitive');

async function fillCard({ page, card, address, log }) {
  const exp = `${card.expMonth}${card.expYear}`; // Stripe 自动格式化 MM/YY
  // 拟人化输入卡号/有效期/CVC：逐字符带随机延迟 + 字段间随机停顿，降低 Stripe 行为遥测风控。
  const num = await fillAcross(page, sels.number, card.number, log, { human: true });
  await humanPause(page, 300, 800);
  const ex = await fillAcross(page, sels.expiry, exp, log, { human: true });
  await humanPause(page, 300, 800);
  const cvc = await fillAcross(page, sels.cvc, card.cvc, log, { human: true });
  await humanPause(page, 300, 700);
  // 卡片邮编(优先卡自带，否则用地址邮编)。注意：zip 走非 human，与重构前一致。
  const zip = card.zip || (address && address.zip) || '';
  let z;
  if (zip) z = await fillAcross(page, sels.postal, zip, log);
  const ok = num && ex && cvc;
  return { num, exp: ex, cvc, zip: zip ? !!z : undefined, engine: 'playwright', error: ok ? undefined : 'PLAYWRIGHT_FILL_INCOMPLETE' };
}

module.exports = { name: 'playwright', fillCard };
