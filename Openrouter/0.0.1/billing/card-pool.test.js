// card-pool 计数回归(零依赖,node:test)。跑: cd billing && node --test  或在 web 下 node --test ../billing
// 覆盖 M7:maxUses=【绑定数】语义 —— bound(仅加卡未扣款)与 success(扣款)都消耗一次容量,到 maxUses 即 exhausted;
// declined 单次只冷却不禁卡。用 OPENROUTER_CARD_POOL_FILE 指向临时卡池,绝不碰生产 data/card-pool.json。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ★必须在 require('./card-pool') 之前设好临时文件(POOL_FILE 在模块加载时求值)。
const TMP = path.join(os.tmpdir(), `cardpool-test-${process.pid}.json`);
fs.writeFileSync(TMP, JSON.stringify([
  { id: 'cA', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', zip: '10001', maxUses: 2, usedCount: 0, successCount: 0, declineCount: 0, errorCount: 0, status: 'active' },
  { id: 'cB', number: '4222222222222222', last4: '2222', expMonth: '12', expYear: '2030', cvc: '123', zip: '10001', maxUses: 5, usedCount: 0, successCount: 0, declineCount: 0, errorCount: 0, status: 'active' },
]));
process.env.OPENROUTER_CARD_POOL_FILE = TMP;
const cp = require('./card-pool');

test.after(() => {
  for (const f of [TMP, TMP + '.lock']) { try { fs.unlinkSync(f); } catch (_e) { /* */ } }
});

test('M7: bound(未扣款)消耗一次绑定容量,与 success 同;到 maxUses 即 exhausted', async () => {
  // 第一次 bound → usedCount 1 / successCount 1 / 仍 active
  let r = await cp.report('cA', { result: 'bound' });
  assert.strictEqual(r.usedCount, 1, 'bound 也消耗一次绑定');
  assert.strictEqual(r.successCount, 1, 'bound 计一次成功绑定');
  assert.strictEqual(r.status, 'active');
  // 第二次 success(扣款)→ usedCount 2 = maxUses → exhausted
  r = await cp.report('cA', { result: 'success' });
  assert.strictEqual(r.usedCount, 2);
  assert.strictEqual(r.status, 'exhausted', '到 maxUses 即用尽');
});

test('M7: declined 单次只冷却不禁卡、不消耗 usedCount', async () => {
  const r = await cp.report('cB', { result: 'declined' });
  assert.strictEqual(r.usedCount, 0, 'declined 不算一次绑定用量');
  assert.strictEqual(r.status, 'active', '单次 declined 不禁卡(只冷却)');
  assert.strictEqual(r.declineCount, 1);
});
