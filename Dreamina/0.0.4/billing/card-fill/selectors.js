'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡字段选择器 —— 单一来源（Dreamina：pipopayment.us 收银台）
//
// 文件定位：Dreamina/0.0.4/billing/card-fill/selectors.js
//
// 与 OpenRouter(Stripe 跨域 iframe)不同：Dreamina 走 cashier.pipopayment.us
// 托管收银页——【普通页面，非 Stripe iframe】，字段在主框架即可命中。
// 采集字段：支付方式单选(信用卡/PayPal) + 卡号 + 安全码 + 有效期 + 持卡人姓名 +
// 「记住卡」勾选框 + Pay 按钮。无账单地址字段（故 postal 留空，引擎不使用）。
//
// 选择器一律「多候选 + 文本/属性优先」以抗第三方页面改版。改选择器只改这一处。
// ═══════════════════════════════════════════════════════════════════════

module.exports = {
  // —— 支付方式单选 ——
  methodCard: [
    'input[type="radio"][value*="card" i]',
    'label:has-text("Credit/debit card") input[type="radio"]',
    'label:has-text("Credit") input[type="radio"]',
    '[data-method*="card" i]',
    'label:has-text("Credit/debit card")',
  ],
  methodPaypal: [
    'input[type="radio"][value*="paypal" i]',
    'label:has-text("PayPal") input[type="radio"]',
    'label:has-text("PayPal")',
  ],

  // —— 卡字段 ——
  number: [
    'input[autocomplete="cc-number"]',
    'input[name*="card" i][name*="number" i]',
    'input[name="number"]',
    'input[id*="cardNumber" i]',
    'input[id*="card_number" i]',
    'input[placeholder*="Card number" i]',
    'input[placeholder*="1234" i]',
    'input[placeholder*="卡号"]',
  ],
  cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[name*="security" i]',
    'input[id*="cvv" i]',
    'input[id*="cvc" i]',
    'input[placeholder*="Security code" i]',
    'input[placeholder*="CVC" i]',
    'input[placeholder*="CVV" i]',
    'input[placeholder*="安全码"]',
  ],
  expiry: [
    'input[autocomplete="cc-exp"]',
    'input[name*="exp" i]',
    'input[id*="expiry" i]',
    'input[id*="expiration" i]',
    'input[placeholder*="MM/YY" i]',
    'input[placeholder*="MM / YY" i]',
    'input[placeholder*="Expiration" i]',
    'input[placeholder*="MM" i]',
  ],
  cardholder: [
    'input[autocomplete="cc-name"]',
    'input[name*="holder" i]',
    'input[name*="cardholder" i]',
    'input[name*="card_name" i]',
    'input[id*="cardholder" i]',
    'input[id*="holderName" i]',
    'input[placeholder*="Cardholder" i]',
    'input[placeholder*="name on card" i]',
    'input[placeholder*="Full name" i]',
    'input[placeholder*="持卡人"]',
  ],

  // —— 收银台控件 ——
  saveCard: [
    'input[type="checkbox"][name*="save" i]',
    'label:has-text("Save card") input[type="checkbox"]',
    'label:has-text("Remember") input[type="checkbox"]',
    'input[type="checkbox"][id*="save" i]',
  ],
  payButton: [
    'button:has-text("Pay $")',
    'button:has-text("Pay ")',
    'button:has-text("Pay")',
    'button[type="submit"]:has-text("Pay")',
    'button:has-text("立即支付")',
    'button:has-text("支付")',
  ],

  // 兼容键：Dreamina 收银台无账单邮编字段，留空数组（引擎不使用）。
  postal: [],
};
