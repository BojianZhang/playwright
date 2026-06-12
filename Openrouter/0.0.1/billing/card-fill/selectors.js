'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡字段选择器 —— 单一来源
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/selectors.js
//
// 供 card-fill 各引擎 + stages.js 的 waitForCardForm/cardNumberFilled 共用。
// 内容原样来自重构前 stages.js addPaymentMethod 的 number/expiry/cvc/postal 内联数组，
// 以及 CARD_NUM_SELS 常量（与 number 完全一致）。改选择器只改这一处。
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  number: ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput" i]', 'input[placeholder*="1234" i]', 'input[placeholder*="卡号"]'],
  expiry: ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput" i]', 'input[placeholder*="MM" i]'],
  cvc: ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput" i]', 'input[placeholder*="CVC" i]', 'input[placeholder*="安全码"]'],
  postal: ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput" i]', 'input[placeholder*="邮政编码"]'],
};
