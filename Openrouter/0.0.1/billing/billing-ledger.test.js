// billing-ledger 回归(零依赖,node:test)。跑: cd billing && node --test
// 覆盖:record 字段(含 declineCode)、recent(不聚合)、summary byDeclineCode、CAP 封顶+归档(DEFECT-2)。
// 用 OPENROUTER_BILLING_LEDGER_FILE + OPENROUTER_BILLING_CAP 指向临时文件/小帽,绝不碰生产 data/billing-ledger.json。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `billing-test-${process.pid}.json`);
process.env.OPENROUTER_BILLING_LEDGER_FILE = TMP;
process.env.OPENROUTER_BILLING_CAP = '1000';   // CAP 下限被钳到 1000(Math.max(1000,...)),用它测封顶
const bl = require('./billing-ledger');

test.after(() => {
  for (const f of [TMP, TMP + '.tmp', TMP.replace(/\.json$/, '') + '.archive.jsonl']) { try { fs.unlinkSync(f); } catch (_e) { /* */ } }
});

test('record + summary:declineCode 进账本 + byDeclineCode 分布', async () => {
  await bl.clear();
  await bl.record({ email: 'a@x.com', result: 'success', charged: 5, cardLast4: '1111' });
  await bl.record({ email: 'b@x.com', result: 'declined', declineCode: 'insufficient_funds', cardLast4: '2222' });
  await bl.record({ email: 'c@x.com', result: 'declined', declineCode: 'generic_decline', cardLast4: '3333' });
  await bl.record({ email: 'd@x.com', result: 'declined', declineCode: 'insufficient_funds', cardLast4: '4444' });
  const s = bl.summary(200);
  assert.strictEqual(s.success, 1);
  assert.strictEqual(s.declined, 3);
  assert.strictEqual(s.totalCharged, 5);
  assert.strictEqual(s.byDeclineCode.insufficient_funds, 2, '余额不足 2 笔');
  assert.strictEqual(s.byDeclineCode.generic_decline, 1);
});

test('recent:返回最近 N 条(最近在前),不做聚合', async () => {
  await bl.clear();
  for (let i = 0; i < 10; i++) await bl.record({ email: `e${i}@x.com`, result: 'success', charged: 1 });
  const r = bl.recent(3);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].email, 'e9@x.com', '最近的在前');
  assert.strictEqual(r[2].email, 'e7@x.com');
});

test('CAP 封顶:超 CAP 的最旧条目移出内存(归档到 .archive.jsonl)防无界膨胀', async () => {
  await bl.clear();
  for (let i = 0; i < 1010; i++) await bl.record({ email: `f${i}@x.com`, result: 'success', charged: 1 });
  const s = bl.summary(5);
  assert.strictEqual(s.total, 1000, '内存只留最近 CAP=1000 条(其余已归档)');
  const newest = bl.recent(1)[0];
  assert.strictEqual(newest.email, 'f1009@x.com', '最新仍在');
});
