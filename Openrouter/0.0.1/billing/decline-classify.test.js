// decline-classify 回归(零依赖,node:test)。跑: cd billing && node --test
// ★这些用例必须与 selenium-e2e/test_pipeline_logic.py:test_classify_decline_parity 逐值一致(Node↔Py 同口径)。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyDecline, isCardFaultDecline } = require('./decline-classify');

// [输入文案, 期望 code] —— 与 Python classify_decline 同序同码
const CASES = [
  ['Your card was declined. insufficient funds available', 'insufficient_funds'],
  ['Your card has insufficient funds', 'insufficient_funds'],
  ['security code is incorrect', 'incorrect_cvc'],
  ['Your card number is incorrect', 'incorrect_number'],
  ['Your card has expired', 'expired_card'],
  ['do not honor', 'do_not_honor'],
  ['your card is not supported', 'card_not_supported'],
  ['Your card was declined', 'generic_decline'],
  ['payment is processing', ''],
  ['', ''],
];

test('classifyDecline:页面文案 → decline_code(与 Python 同口径)', () => {
  for (const [text, code] of CASES) {
    assert.strictEqual(classifyDecline(text), code, `「${text}」→ ${code}`);
  }
});

test('isCardFaultDecline:卡本身问题(应换卡) vs 环境风控', () => {
  assert.strictEqual(isCardFaultDecline('insufficient_funds'), true);
  assert.strictEqual(isCardFaultDecline('expired_card'), true);
  assert.strictEqual(isCardFaultDecline('do_not_honor'), false, 'do_not_honor=银行/风控,非卡坏');
  assert.strictEqual(isCardFaultDecline('generic_decline'), false, 'generic=风控,换IP争取');
  assert.strictEqual(isCardFaultDecline(''), false);
});
