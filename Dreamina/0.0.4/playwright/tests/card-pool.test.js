'use strict';

// 卡池解析 + 状态机回归（browser-free）。指向临时卡池文件，不污染生产数据。
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// ★必须在 require('card-pool') 之前设 env（POOL_FILE 在模块加载期读取）。
const TMP = path.join(os.tmpdir(), `dreamina-cardpool-test-${process.pid}-${Date.now()}.json`);
process.env.DREAMINA_CARD_POOL_FILE = TMP;
const cardPool = require('../../billing/card-pool');

test.after(() => { for (const f of [TMP, TMP + '.lock', TMP + '.tmp']) { try { fs.unlinkSync(f); } catch (_e) { /* */ } } });

test('parseCardLines: 合法行解析号/有效期/CVC，非法行带 _parseError', () => {
  const parsed = cardPool.parseCardLines('4242424242424242 04/30 123 5\nnot-a-card-line', 10);
  assert.equal(parsed.length, 2);
  const ok = parsed.find((c) => !c._parseError);
  assert.equal(ok.number, '4242424242424242');
  assert.equal(ok.expMonth, '04');
  assert.equal(ok.expYear, '30');
  assert.equal(ok.cvc, '123');
  assert.equal(ok.maxUses, 5);
  assert.ok(parsed.find((c) => c._parseError), '非法行应带 _parseError');
});

test('upsertMany + snapshot + acquire/report 状态机', async () => {
  const cards = cardPool.parseCardLines('4111111111111111 12/29 999 3', 3).filter((c) => !c._parseError);
  await cardPool.upsertMany(cards);
  const snap1 = await cardPool.snapshot();
  assert.equal(snap1.length, 1);
  assert.equal(snap1[0].status, 'active');

  const card = await cardPool.acquire();
  assert.ok(card && card.id, 'acquire 应返回一张卡');
  assert.equal(card.last4, '1111');

  // success → usedCount++
  await cardPool.report(card.id, { result: 'success' });
  let snap = await cardPool.snapshot();
  assert.equal(snap[0].usedCount, 1);
  assert.equal(snap[0].successCount, 1);

  // error → 不计用量、保持 active（环境/页面问题，卡可复用）
  const c2 = await cardPool.acquire();
  await cardPool.report(c2.id, { result: 'error', error: 'DRY_RUN' });
  snap = await cardPool.snapshot();
  assert.equal(snap[0].usedCount, 1, 'error 不应增加 usedCount');
  assert.equal(snap[0].status, 'active');
});

test('declined: 单次冷却不禁卡；累到阈值(默认2)禁用', async () => {
  // 用独立卡避免与上一用例状态耦合
  const cards = cardPool.parseCardLines('4000000000000002 11/28 321 9', 9).filter((c) => !c._parseError);
  await cardPool.upsertMany(cards);
  const all = await cardPool.snapshot();
  const target = all.find((c) => c.last4 === '0002');
  await cardPool.report(target.id, { result: 'declined' });
  let snap = (await cardPool.snapshot()).find((c) => c.last4 === '0002');
  assert.equal(snap.declineCount, 1);
  assert.equal(snap.status, 'active', '单次 declined 只冷却不禁卡');
  await cardPool.report(target.id, { result: 'declined' });
  snap = (await cardPool.snapshot()).find((c) => c.last4 === '0002');
  assert.equal(snap.status, 'disabled', '累计到阈值应禁用');
});
