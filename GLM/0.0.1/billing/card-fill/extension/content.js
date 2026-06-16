'use strict';

// ═══════════════════════════════════════════════════════════════════════
// OR Card Fill Helper — content script（注入 js.stripe.com 所有帧）
//
// 收到 window message { type:'OR_FILL', card:{number,expiry,cvc,postal} } →
//   用【原生 value setter + input 事件】逐字符填卡(让 Stripe 的 React 受控输入框真正接收)，
//   结果写 <html data-or-fill-result="{...}">，供自动化端(Node/Playwright)跨"隔离世界"读 DOM。
// content script 与页面共享 DOM(故 querySelector/setAttribute 可达)，但 JS window 变量隔离，
//   所以卡数据走 message 传入、结果走 DOM 属性传出。
// ═══════════════════════════════════════════════════════════════════════

(function () {
  var SELS = {
    number: ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput" i]'],
    expiry: ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput" i]'],
    cvc: ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput" i]'],
    postal: ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput" i]']
  };

  function find(list) {
    for (var i = 0; i < list.length; i++) {
      try { var el = document.querySelector(list[i]); if (el && el.offsetParent !== null) return el; } catch (e) { /* */ }
    }
    return null;
  }

  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  // 原生 value setter + input 事件：绕过 React 的受控 value，逐字符触发(Stripe 自动格式化)。
  function setVal(el, val) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    var s = String(val);
    var acc = '';
    for (var i = 0; i < s.length; i++) {
      acc += s[i];
      setter.call(el, acc);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function fillField(list, val) {
    if (!val) return undefined;
    var el = find(list);
    if (!el) return false;
    try { setVal(el, val); } catch (e) { return false; }
    return digits(el.value).length >= digits(val).length;
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'OR_FILL' || !d.card) return;
    var c = d.card;
    var res = {
      num: fillField(SELS.number, c.number),
      exp: fillField(SELS.expiry, c.expiry),
      cvc: fillField(SELS.cvc, c.cvc),
      zip: fillField(SELS.postal, c.postal)
    };
    try { document.documentElement.setAttribute('data-or-fill-result', JSON.stringify(res)); } catch (err) { /* */ }
  });
})();
