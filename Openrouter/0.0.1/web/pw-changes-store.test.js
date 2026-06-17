'use strict';
// pw-changes-store 测试:改密「覆盖+存档」账本的滚动降级语义 + 审计 log。
// 用 OPENROUTER_PWCHANGES_FILE 指向临时文件,绝不碰生产盘。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pwc-')), 'pw.json');
process.env.OPENROUTER_PWCHANGES_FILE = TMP;
const store = require('./pw-changes-store');

test('首次改:original ← 改前 from,current ← 新值', () => {
  store.recordChange({ email: 'a@x.com', type: 'mailbox', from: 'orig1', to: 'unified', ok: true, by: 'single' });
  const ov = store.getOverrides()['a@x.com'].mailbox;
  assert.strictEqual(ov.original, 'orig1');
  assert.strictEqual(ov.current, 'unified');
});

test('再次改:original ← 上次 current(滚动降级),current ← 新值', () => {
  store.recordChange({ email: 'a@x.com', type: 'mailbox', from: 'unified', to: 'new2', ok: true, by: 'batch' });
  const ov = store.getOverrides()['a@x.com'].mailbox;
  assert.strictEqual(ov.original, 'unified');
  assert.strictEqual(ov.current, 'new2');
});

test('失败不滚动覆盖,但仍记入存档', () => {
  store.recordChange({ email: 'a@x.com', type: 'mailbox', from: 'new2', to: 'bad3', ok: false, reason: 'rejected' });
  const ov = store.getOverrides()['a@x.com'].mailbox;
  assert.strictEqual(ov.current, 'new2', '失败不应改变 current');
  assert.ok(store.getLog(50).some((e) => e.ok === false && e.reason === 'rejected'), '失败必须进存档');
});

test('mailbox / openrouter 两类相互独立', () => {
  store.recordChange({ email: 'a@x.com', type: 'openrouter', from: 'orpw', to: 'ornew', ok: true });
  const acc = store.getOverrides()['a@x.com'];
  assert.strictEqual(acc.openrouter.current, 'ornew');
  assert.strictEqual(acc.mailbox.current, 'new2', '改 OR 不应动 mailbox');
});

test('未知 type 归一化为 mailbox(不写进任意键)', () => {
  store.recordChange({ email: 'b@x.com', type: 'evil', from: 'p', to: 'q', ok: true });
  const acc = store.getOverrides()['b@x.com'];
  assert.ok(acc.mailbox && !acc.evil, 'evil 应被归一化为 mailbox');
});

test('空 email 被忽略(不建空键)', () => {
  const before = Object.keys(store.getOverrides()).length;
  store.recordChange({ email: '   ', type: 'mailbox', from: 'p', to: 'q', ok: true });
  assert.strictEqual(Object.keys(store.getOverrides()).length, before);
});

test('存档最新在前(reverse)', () => {
  const log = store.getLog(100);
  assert.strictEqual(log[0].to, 'q'); // 最后一条成功是 b@x.com p→q(空 email 那条被忽略)
});

test('落盘后另起读取仍在(持久化)', () => {
  store.flushNow();
  const raw = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.strictEqual(raw.accounts['a@x.com'].mailbox.current, 'new2');
  assert.ok(Array.isArray(raw.log) && raw.log.length >= 5);
});
