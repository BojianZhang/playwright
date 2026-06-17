'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 改密「覆盖 + 存档」账本 — Openrouter / web / pw-changes-store.js
//
// 结果聚合页「更新邮箱密码 / 更新 OpenRouter 密码」用。按 email 记每种密码
// (mailbox / openrouter)的 original / current,并对每次操作留一条审计 log(存档)。
//
// ★滚动语义(用户定义):改成功后 → 新值=current,改前的值自动降级为 original。
//   首次改:original ← 本次 from(改前真实显示值);current ← 新值。
//   再次改:original ← 上一次的 current;current ← 新值。
//
// ★边界:完全独立,绝不碰 account-store 的 originalPassword / loginPassword
//   (那两个供「续跑/失败恢复」重建 accounts.txt,污染会导致登不回去/重复扣款)。
//   前端只把本账本的 {original,current} 叠加到展示四列,执行/续跑参数一概不取这里。
//
// 落盘 data/pw-changes.json。零依赖 CommonJS。内存真相源 + tmp+rename 原子写。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');

// 默认 data/pw-changes.json;OPENROUTER_PWCHANGES_FILE 可覆盖(仅测试用,绝不碰生产盘)。
const FILE = process.env.OPENROUTER_PWCHANGES_FILE || path.join(__dirname, '..', 'data', 'pw-changes.json');
const LOG_MAX = 20000;                       // 存档上限,超出保留最近(防无限增长)
const TYPES = new Set(['mailbox', 'openrouter']);

let _db = null;   // 内存缓存(真相源)

function _now() { return new Date().toISOString(); }

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, null, 'pw-changes-store');   // 解析失败先备份 .corrupt 再退默认,绝不被下次写入抹掉
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
    try { console.error('[pw-changes-store] 落盘失败(内存仍有,盘上可能滞后):', e && e.message); } catch (_e) { /* ignore */ }
  }
}

// 覆盖视图:{ "<email>": { mailbox:{original,current,updatedAt}, openrouter:{...} } } —— 前端叠加到四列。
function getOverrides() { return _load().accounts || {}; }

// 存档(最近 N 条,新→旧)。供「改密记录」查看。
function getLog(limit) {
  const db = _load();
  const n = Math.max(1, Math.min(Number(limit) || 200, LOG_MAX));
  return db.log.slice(-n).reverse();
}

// 记一次改密。ok=true 才滚动 original/current;无论成败都记 log(审计存档)。
function recordChange({ email, type, from, to, ok, by, reason } = {}) {
  const db = _load();
  email = String(email == null ? '' : email).trim();
  type = TYPES.has(type) ? type : 'mailbox';
  if (!email) return;
  if (ok) {
    if (!db.accounts[email]) db.accounts[email] = {};
    const prev = db.accounts[email][type];
    // 滚动降级:original ← 改前的 current(首次=本次 from = 改前真实显示值);current ← 新值
    const original = (prev && prev.current != null) ? prev.current : String(from == null ? '' : from);
    db.accounts[email][type] = { original, current: String(to == null ? '' : to), updatedAt: _now() };
  }
  db.log.push({
    at: _now(), email, type,
    from: String(from == null ? '' : from), to: String(to == null ? '' : to),
    ok: !!ok, by: by || '', reason: reason || '',
  });
  if (db.log.length > LOG_MAX) db.log = db.log.slice(-LOG_MAX);
  _persist();
}

function logCount() { return _load().log.length; }   // 存档总条数 → 前端「最近 N / 共 M」诚实标注截断(>limit 时)

function flushNow() { if (_db) _persist(); }   // graceful-shutdown 调

module.exports = { getOverrides, getLog, logCount, recordChange, flushNow, _FILE: FILE };
