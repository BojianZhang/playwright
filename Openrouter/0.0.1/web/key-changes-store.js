'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 「获取新 Key」覆盖 + 存档账本 — Openrouter / web / key-changes-store.js
//
// 结果聚合页「获取新Key」用:个别号已 card-bound 但 API Key 空 → 登录后新建一把 Key。
// 按 email 记最新 Key(apiKey/apiKeyName),并对每次取 Key 留一条审计 log(存档)。
//
// ★边界:完全独立,不写 results.jsonl、不动聚合去重。前端只把本账本的 apiKey
//   叠加到结果页「API Key」列(keyView 覆盖优先)→ 原 card-bound 行的账单/卡末4/充值
//   信息完整保留。account-store 的 apiKey 由 server 另行同步(规范库,幂等),与本账本互补。
//
// 落盘 data/key-changes.json。零依赖 CommonJS。内存真相源 + tmp+rename 原子写。
// 仿 pw-changes-store.js(更简单:每号单值,无 mailbox/openrouter 两型)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');

// 默认 data/key-changes.json;OPENROUTER_KEYCHANGES_FILE 可覆盖(仅测试用,绝不碰生产盘)。
const FILE = process.env.OPENROUTER_KEYCHANGES_FILE || path.join(__dirname, '..', 'data', 'key-changes.json');
const LOG_MAX = 20000;                       // 存档上限,超出保留最近(防无限增长)

let _db = null;   // 内存缓存(真相源)

function _now() { return new Date().toISOString(); }

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, null, 'key-changes-store');   // 解析失败先备份 .corrupt 再退默认,绝不被下次写入抹掉
  _db = (o && typeof o === 'object' && o.accounts && typeof o.accounts === 'object')
    ? o
    : { version: 1, accounts: {}, log: [] };
  if (!Array.isArray(_db.log)) _db.log = [];
  return _db;
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;   // ★带 pid:多实例/并发写不会互相覆盖同一 .tmp(对齐 bad-mailbox-store)
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    // 落盘失败:内存仍是真相源,但盘上状态会滞后 → 不再静默(对齐 runs-store REL-6),给运维可见性。
    try { console.error('[key-changes-store] 落盘失败(内存仍有,盘上可能滞后):', e && e.message); } catch (_e) { /* ignore */ }
  }
}

// 覆盖视图:{ "<email>": { apiKey, apiKeyName, updatedAt, by } } —— 前端叠加到 API Key 列。
function getOverrides() { return _load().accounts || {}; }

// 存档(最近 N 条,新→旧)。供「获取Key存档」查看。
function getLog(limit) {
  const db = _load();
  const n = Math.max(1, Math.min(Number(limit) || 200, LOG_MAX));
  return db.log.slice(-n).reverse();
}

// 记一次取 Key。ok && key 才覆盖该号 apiKey;无论成败都记 log(审计存档)。
function recordKey({ email, key, name, ok, by, reason } = {}) {
  const db = _load();
  email = String(email == null ? '' : email).trim();
  if (!email) return;
  const keyStr = String(key == null ? '' : key);
  if (ok && keyStr) {
    db.accounts[email] = { apiKey: keyStr, apiKeyName: String(name == null ? '' : name), updatedAt: _now(), by: by || '' };
  }
  db.log.push({
    at: _now(), email, apiKey: keyStr, apiKeyName: String(name == null ? '' : name),
    ok: !!ok, by: by || '', reason: reason || '',
  });
  if (db.log.length > LOG_MAX) db.log = db.log.slice(-LOG_MAX);
  _persist();
}

function flushNow() { if (_db) _persist(); }   // graceful-shutdown 调

module.exports = { getOverrides, getLog, recordKey, flushNow, _FILE: FILE };
