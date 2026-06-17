'use strict';
// key-changes-store 测试:「获取新Key」覆盖+存档账本。ok&&key 才写覆盖;成败都进审计 log。
// 用 OPENROUTER_KEYCHANGES_FILE 指向临时文件,绝不碰生产盘。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keyc-')), 'key.json');
process.env.OPENROUTER_KEYCHANGES_FILE = TMP;
const store = require('./key-changes-store');

test('成功取Key:写覆盖 apiKey + 记 log', () => {
  store.recordKey({ email: 'a@x.com', key: 'sk-or-v1-aaa', name: 'auto-1', ok: true, by: 'single' });
  const ov = store.getOverrides()['a@x.com'];
  assert.strictEqual(ov.apiKey, 'sk-or-v1-aaa');
  assert.strictEqual(ov.apiKeyName, 'auto-1');
  assert.ok(ov.updatedAt, '应有 updatedAt');
  assert.ok(store.getLog(50).some((e) => e.email === 'a@x.com' && e.ok === true && e.apiKey === 'sk-or-v1-aaa'));
});

test('再次取Key:覆盖为最新 key(单值,无滚动)', () => {
  store.recordKey({ email: 'a@x.com', key: 'sk-or-v1-bbb', name: 'auto-2', ok: true, by: 'batch' });
  assert.strictEqual(store.getOverrides()['a@x.com'].apiKey, 'sk-or-v1-bbb');
});

test('失败不写覆盖(保留上次成功值),但仍记 log', () => {
  store.recordKey({ email: 'a@x.com', key: '', ok: false, reason: 'login-failed' });
  assert.strictEqual(store.getOverrides()['a@x.com'].apiKey, 'sk-or-v1-bbb', '失败不应抹掉已有 Key');
  assert.ok(store.getLog(50).some((e) => e.ok === false && e.reason === 'login-failed'), '失败必须进存档');
});

test('ok 但 key 为空:不写覆盖(无可用 Key)', () => {
  store.recordKey({ email: 'c@x.com', key: '', ok: true, reason: 'no-key' });
  assert.ok(!store.getOverrides()['c@x.com'], 'ok 但空 key 不建覆盖');
  assert.ok(store.getLog(50).some((e) => e.email === 'c@x.com'), '仍记 log');
});

test('空 email 被忽略(不建空键)', () => {
  const before = Object.keys(store.getOverrides()).length;
  store.recordKey({ email: '   ', key: 'sk-or-v1-zzz', ok: true });
  assert.strictEqual(Object.keys(store.getOverrides()).length, before);
});

test('存档最新在前(reverse)', () => {
  store.recordKey({ email: 'd@x.com', key: 'sk-or-v1-ddd', ok: true });
  assert.strictEqual(store.getLog(100)[0].email, 'd@x.com');
});

test('落盘后另起读取仍在(持久化)', () => {
  store.flushNow();
  const raw = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  assert.strictEqual(raw.accounts['a@x.com'].apiKey, 'sk-or-v1-bbb');
  assert.ok(Array.isArray(raw.log) && raw.log.length >= 5);
});
