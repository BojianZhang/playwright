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

// ── 充值容量账本 + 原子预留(并发安全)─────────────────────────────────────
test('cardChargeCapacity:次数与金额双约束取 min(钱优先) / 未跟踪不限', () => {
  assert.strictEqual(cp.cardChargeCapacity({ chargeCap: 3, balance: 100 }, 5), 3, '次数3紧于钱20→min=3');
  assert.strictEqual(cp.cardChargeCapacity({ chargeCap: 10, balance: 30 }, 5), 6, '★钱优先:钱只够 floor(30/5)=6 紧于次数10→min=6');
  assert.strictEqual(cp.cardChargeCapacity({ balance: 20 }, 5), 4, '只填金额 floor(20/5)=4');
  assert.strictEqual(cp.cardChargeCapacity({ balance: 22 }, 5), 4, 'floor 向下取整');
  assert.strictEqual(cp.cardChargeCapacity({ chargeCap: 5 }, 5), 5, '只填次数=5');
  assert.strictEqual(cp.cardChargeCapacity({}, 5), Infinity, '都没填=不限(旧行为)');
});

test('cardChargeRemaining:扣已充后取 min(钱优先)', () => {
  assert.strictEqual(cp.cardChargeRemaining({ chargeCap: 10, chargedTotal: 0, balance: 30 }, 5), 6, '★钱优先:min(10, floor(30/5)=6)=6');
  assert.strictEqual(cp.cardChargeRemaining({ chargeCap: 10, chargedTotal: 4, balance: 30 }, 5), 6, '次数剩6 与 钱6 相等→6');
  assert.strictEqual(cp.cardChargeRemaining({ chargeCap: 10, chargedTotal: 8, balance: 30 }, 5), 2, '次数剩2紧于钱6→min=2');
  assert.strictEqual(cp.cardChargeRemaining({ chargeCap: 10, chargedTotal: 10, balance: 30 }, 5), 0, '次数用尽→0(即使还有钱)');
  assert.strictEqual(cp.cardChargeRemaining({}, 5), Infinity, '未跟踪=不限');
});

test('钱优先(min):次数松但钱紧 → 按钱卡(虽然次数还剩很多)', async () => {
  // chargeCap=10(次数松)但 balance=$10 @ $5 → 钱只够 2 次
  await cp.upsertMany([{ id: 'mix1', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 100, chargeCap: 10, balance: 10 }]);
  assert.strictEqual((await cp.reserveCharge('mix1', 5)).ok, true);   // 1
  assert.strictEqual((await cp.reserveCharge('mix1', 5)).ok, true);   // 2
  const r3 = await cp.reserveCharge('mix1', 5);
  assert.strictEqual(r3.ok, false); assert.strictEqual(r3.reason, 'capacity', '钱只够2次→第3拒(次数仍剩8)');
});

test('充值预留:容量闸 + commit 计真充 + release 还额', async () => {
  await cp.upsertMany([{ id: 'chg1', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 10, chargeCap: 2, chargeConcurrency: 0 }]);
  assert.strictEqual((await cp.reserveCharge('chg1', 5)).ok, true);   // 预留1(inflight1)
  assert.strictEqual((await cp.reserveCharge('chg1', 5)).ok, true);   // 预留2(inflight2)
  const r3 = await cp.reserveCharge('chg1', 5);
  assert.strictEqual(r3.ok, false); assert.strictEqual(r3.reason, 'capacity', '容量2用尽(2在飞)→拒');
  let c = await cp.commitCharge('chg1', 5);   // 真扣成功:charged1,inflight1
  assert.strictEqual(c.chargedTotal, 1); assert.strictEqual(c.chargeInflight, 1);
  c = await cp.releaseCharge('chg1');         // 另一个失败还额:inflight0
  assert.strictEqual(c.chargeInflight, 0);
  assert.strictEqual((await cp.reserveCharge('chg1', 5)).ok, true);   // 还剩1次(cap2-charged1)
  await cp.commitCharge('chg1', 5);           // charged2 = 用尽
  assert.strictEqual((await cp.reserveCharge('chg1', 5)).ok, false, 'cap 用尽再预留拒');
});

test('同卡并发闸:chargeConcurrency=2 第3个并发预留被拒', async () => {
  await cp.upsertMany([{ id: 'chg2', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 100, chargeCap: 100, chargeConcurrency: 2 }]);
  assert.strictEqual((await cp.reserveCharge('chg2', 5)).ok, true);
  assert.strictEqual((await cp.reserveCharge('chg2', 5)).ok, true);
  const c = await cp.reserveCharge('chg2', 5);
  assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'concurrency', '同卡并发满→拒');
  await cp.releaseCharge('chg2');
  assert.strictEqual((await cp.reserveCharge('chg2', 5)).ok, true, '释放后又能预留');
});

test('金额扣减:commit 按充值额扣 balance', async () => {
  await cp.upsertMany([{ id: 'chg3', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 100, balance: 20 }]);
  assert.strictEqual((await cp.reserveCharge('chg3', 5)).ok, true);
  const c = await cp.commitCharge('chg3', 5);
  assert.strictEqual(c.balance, 15, '20-5=15'); assert.strictEqual(c.chargedTotal, 1);
});

test('未跟踪卡预留永远 ok(默认逐字节不变)', async () => {
  await cp.upsertMany([{ id: 'chg4', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 10 }]);
  for (let i = 0; i < 20; i++) assert.strictEqual((await cp.reserveCharge('chg4', 5)).ok, true, '未跟踪永远 ok');
});

test('reapStaleInflight:回收超时在飞预留(防崩溃泄漏)', async () => {
  await cp.upsertMany([{ id: 'chg5', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 10, chargeCap: 5 }]);
  await cp.reserveCharge('chg5', 5);
  const r = await cp.reapStaleInflight(0);   // 0ms 阈值 → 全部超时回收
  assert.ok(r.reaped >= 1, '回收了在飞预留');
  assert.strictEqual((await cp.reserveCharge('chg5', 5)).ok, true);
});

test('setCardCharge:改容量重置 chargedTotal(新预算可重新充满)', async () => {
  await cp.upsertMany([{ id: 'chg6', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 100, chargeCap: 1 }]);
  await cp.reserveCharge('chg6', 5); await cp.commitCharge('chg6', 5);   // 充满(charged1=cap1)
  assert.strictEqual((await cp.reserveCharge('chg6', 5)).ok, false, '用尽');
  const c = await cp.setCardCharge('chg6', { chargeCap: 3 });            // 重设容量 → chargedTotal 清零
  assert.strictEqual(c.chargeCap, 3); assert.strictEqual(c.chargedTotal, 0);
  assert.strictEqual((await cp.reserveCharge('chg6', 5)).ok, true, '新预算可再充');
});

test('setMany:批量设值(留空不改 + 改容量重置已充 + 一次写)', async () => {
  await cp.upsertMany([
    { id: 'bm1', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 5, chargeCap: 2 },
    { id: 'bm2', number: '4222222222222222', last4: '2222', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 5 },
  ]);
  // bm1 先充一次 → chargedTotal=1
  await cp.reserveCharge('bm1', 5); await cp.commitCharge('bm1', 5);
  const r = await cp.setMany(['bm1', 'bm2'], { balance: 30, chargeConcurrency: 2 });   // 只改金额+并发,不传 maxUses/chargeCap
  assert.strictEqual(r.updated, 2, '两张都改到');
  const snap = cp.snapshot();
  const a = snap.find((x) => x.id === 'bm1'); const b = snap.find((x) => x.id === 'bm2');
  assert.strictEqual(a.balance, 30); assert.strictEqual(a.chargeConcurrency, 2);
  assert.strictEqual(a.maxUses, 5, 'maxUses 留空 → 不改');
  assert.strictEqual(a.chargedTotal, 0, '改了金额(新预算)→ 已充清零');
  assert.strictEqual(b.balance, 30);
  // 只改 maxUses 不动充值字段:不重置 chargedTotal
  await cp.reserveCharge('bm1', 5); await cp.commitCharge('bm1', 5);   // chargedTotal=1
  await cp.setMany(['bm1'], { maxUses: 8 });
  const a2 = cp.snapshot().find((x) => x.id === 'bm1');
  assert.strictEqual(a2.maxUses, 8); assert.strictEqual(a2.chargedTotal, 1, '没动充值字段 → 已充不清零');
  // 不在 ids 里的卡不动
  await cp.setMany(['bm1'], { balance: 99 });
  assert.strictEqual(cp.snapshot().find((x) => x.id === 'bm2').balance, 30, 'bm2 不在 ids → 不动');
});

test('状态自愈:usedCount≥maxUses 的 active 卡读盘归一为 exhausted(KPI 可用 与 表 可用 一致)', () => {
  // 注入一张「绑满却仍 active」的历史脏数据(直接写盘),强制 mtime 前进保证 ensureLoaded 重读 → 应被归一为 exhausted。
  const cur = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  cur.push({ id: 'stuck1', number: '4111111111111111', last4: '1111', expMonth: '12', expYear: '2030', cvc: '123', maxUses: 10, usedCount: 10, successCount: 10, declineCount: 0, errorCount: 0, status: 'active' });
  fs.writeFileSync(TMP, JSON.stringify(cur));
  fs.utimesSync(TMP, new Date(), new Date(Date.now() + 5000));   // mtime 前进 → ensureLoaded 必重读
  const c = cp.snapshot().find((x) => x.id === 'stuck1');
  assert.ok(c, 'stuck1 在池中(不被丢弃)');
  assert.strictEqual(c.status, 'exhausted', 'usedCount≥maxUses 的 active 卡读盘后应为 exhausted');
  // availableCount(active&usedCount<maxUses) 不含它 → 与按状态计的"可用"口径一致(都不算它)
  assert.strictEqual(cp.snapshot().filter((x) => x.status === 'active' && x.id === 'stuck1').length, 0, '不再被按状态计成可用');
});
