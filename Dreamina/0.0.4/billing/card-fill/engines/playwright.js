'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — playwright（默认 · Dreamina pipopayment 收银台）
//
// 文件定位：Dreamina/0.0.4/billing/card-fill/engines/playwright.js
//
// 改自 OpenRouter 同名引擎。差异（pipopayment 是普通托管页，非 Stripe 跨域 iframe）：
//   · 去掉 zip 段（收银台无账单邮编字段）。
//   · 新增 cardholder（持卡人姓名）段——卡池无姓名字段，故用 address.name（来自 address-gen）兜底。
//   · 卡号/有效期/CVC 仍走 human(逐字符+回读重试)，字段间 humanPause（收银台亦可能有行为遥测，成本可忽略）。
// 只填字段，不点 Pay/不选支付方式——那些由 S8 payment-adapter 编排。
// ═══════════════════════════════════════════════════════════════════════

const sels = require('../selectors');
const { fillAcross, humanPause } = require('../fill-primitive');

async function fillCard({ page, card, address, log }) {
  // 有效期：默认敲 MMYY，依赖收银台自动插斜杠（与 OpenRouter 一致）。
  // 若 card.expFormatSlash 为真则敲 MM/YY 字面值（某些不自动格式化的字段）。
  const exp = card && card.expFormatSlash
    ? `${card.expMonth}/${card.expYear}`
    : `${card.expMonth}${card.expYear}`;

  const num = await fillAcross(page, sels.number, card.number, log, { human: true });
  await humanPause(page, 300, 800);
  const ex = await fillAcross(page, sels.expiry, exp, log, { human: true });
  await humanPause(page, 300, 800);
  const cvc = await fillAcross(page, sels.cvc, card.cvc, log, { human: true });
  await humanPause(page, 300, 700);

  // 持卡人姓名：卡池无姓名字段 → 用 card.holderName，否则地址簿姓名(address-gen 生成)。
  const holderName = (card && (card.holderName || card.name)) || (address && address.name) || '';
  let nameOk;
  if (holderName) {
    nameOk = await fillAcross(page, sels.cardholder, holderName, log);
  }

  const ok = num && ex && cvc;
  return {
    num,
    exp: ex,
    cvc,
    cardholder: holderName ? !!nameOk : undefined,
    engine: 'playwright',
    error: ok ? undefined : 'PLAYWRIGHT_FILL_INCOMPLETE',
  };
}

module.exports = { name: 'playwright', fillCard };
