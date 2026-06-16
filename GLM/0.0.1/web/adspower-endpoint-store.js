'use strict';

// ═══════════════════════════════════════════════════════════════════════
// AdsPower 端点池 — Openrouter / web / adspower-endpoint-store.js
//
// 边界:**管多个 AdsPower 端点(每台机/每个实例一个:label + apiBase + apiKey)**。
// 不管环境编号(那是 adspower-store)、不管代理。落盘 data/adspower-endpoints.json(含密钥,已 gitignore)。
// list() 脱敏(只回 apiKeySet 布尔,不回明文);getFull/activeFull 给服务端 ping 与引擎选端点用(不经 HTTP 明文吐出)。
// 兼容:端点池为空时,运行时回退 config.local.json 的 adspower.apiBase/apiKey(单端点向后兼容)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');

const FILE = path.join(__dirname, '..', 'data', 'adspower-endpoints.json');
let _list = null;
let _seq = 0;
function _genId() { return 'ep' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_list) return _list;
  const a = readJsonOr(FILE, [], 'adspower-endpoint-store'); _list = Array.isArray(a) ? a : [];
  return _list;
}
function _persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_list, null, 2)); fs.renameSync(tmp, FILE); } catch (_e) { /* */ }
}
const _norm = (b) => String(b || '').trim().replace(/\/+$/, '');

// 脱敏列表(给 UI / HTTP)
function list() { return _load().map((e) => ({ id: e.id, label: e.label, apiBase: e.apiBase, status: e.status, apiKeySet: !!(e.apiKey && String(e.apiKey).trim()), lastOk: e.lastOk, latencyMs: e.latencyMs, lastTestedAt: e.lastTestedAt, addedAt: e.addedAt })); }
function getFull(id) { return _load().find((e) => e.id === id) || null; }
// 运行时可用端点(含密钥,服务端内部用):active 优先
function activeFull() { return _load().filter((e) => e.status === 'active'); }

function add({ label, apiBase, apiKey } = {}) {
  const base = _norm(apiBase);
  if (!base) { const e = new Error('NO_API_BASE'); e.code = 'NO_API_BASE'; throw e; }
  const lst = _load();
  const e = { id: _genId(), label: String(label || '').slice(0, 60) || base, apiBase: base, apiKey: String(apiKey || ''), status: 'active', addedAt: Date.now(), lastTestedAt: null, lastOk: null, latencyMs: null };
  lst.push(e); _persist();
  return e;
}
function update(id, patch = {}) {
  const e = _load().find((x) => x.id === id); if (!e) return null;
  if ('label' in patch) e.label = String(patch.label || '').slice(0, 60);
  if ('apiBase' in patch) e.apiBase = _norm(patch.apiBase) || e.apiBase;
  if ('status' in patch) e.status = patch.status === 'disabled' ? 'disabled' : 'active';
  if (patch.clearApiKey) e.apiKey = '';                                                              // 显式清除(本地端点无需密钥/擦掉自动填充的幽灵密钥)
  else if ('apiKey' in patch && String(patch.apiKey || '').trim()) e.apiKey = String(patch.apiKey).trim(); // 空值不覆盖(留空=不改)
  _persist(); return e;
}
function remove(id) { _list = _load().filter((x) => x.id !== id); _persist(); return true; }
function clear() { _list = []; _persist(); return true; }
function recordTest(id, res) {
  const e = _load().find((x) => x.id === id); if (!e) return null;
  e.lastTestedAt = Date.now(); e.lastOk = !!res.ok; e.latencyMs = res.latencyMs != null ? res.latencyMs : null;
  _persist(); return e;
}

module.exports = { list, getFull, activeFull, add, update, remove, clear, recordTest, _FILE: FILE };
