'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 邮箱 key 池 — Openrouter / web / mailbox-store.js
//
// 边界:**只管多个邮箱服务(firstmail 等)的 API key + 地址**的增删改 + 选用。
// 不改收信逻辑——只决定收验证邮件用哪个 key。落盘 data/mailbox-keys.json(含密钥,已 gitignore)。
// list() 脱敏(只回 apiKeySet);getFull/pickActive 服务端内部用。范式同 captcha-store。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'mailbox-keys.json');
let _list = null;
let _seq = 0;
function _genId() { return 'mb' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_list) return _list;
  try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); _list = Array.isArray(a) ? a : []; } catch (_e) { _list = []; }
  return _list;
}
function _persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_list, null, 2)); fs.renameSync(tmp, FILE); } catch (_e) { /* */ }
}

function list() { return _load().map((e) => ({ id: e.id, label: e.label, provider: e.provider, apiBaseUrl: e.apiBaseUrl, status: e.status, apiKeySet: !!(e.apiKey && String(e.apiKey).trim()), addedAt: e.addedAt })); }
function getFull(id) { return _load().find((e) => e.id === id) || null; }
function pickActive() { return _load().find((e) => e.status === 'active') || null; }

function add({ label, provider, apiKey, apiBaseUrl } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('NO_KEY'); e.code = 'NO_KEY'; throw e; }
  const lst = _load();
  const e = { id: _genId(), label: String(label || '').slice(0, 60) || (provider || 'firstmail'), provider: String(provider || 'firstmail'), apiKey: key, apiBaseUrl: String(apiBaseUrl || 'https://firstmail.ltd').trim(), status: 'active', addedAt: Date.now() };
  lst.push(e); _persist();
  return e;
}
// 批量导入:每行 `provider|apiKey|apiBaseUrl|label`(分隔符 | 或逗号 或制表);单字段=裸 apiKey。
// 缺省 provider=firstmail、apiBaseUrl=https://firstmail.ltd。按 apiKey 去重(已存在则计 dup)。
function importRaw(raw) {
  const lst = _load();
  const seen = new Set(lst.map((e) => String(e.apiKey || '').trim()).filter(Boolean));
  let added = 0, dup = 0;
  String(raw || '').split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split(/\s*[|,\t]\s*/);
    let provider, apiKey, apiBaseUrl, label;
    if (parts.length <= 1) { apiKey = parts[0]; }
    else { [provider, apiKey, apiBaseUrl, label] = parts; }
    apiKey = String(apiKey || '').trim();
    if (!apiKey) return;
    if (seen.has(apiKey)) { dup++; return; }
    lst.push({ id: _genId(), label: String(label || '').slice(0, 60) || (provider || 'firstmail'), provider: String(provider || 'firstmail').trim() || 'firstmail', apiKey, apiBaseUrl: String(apiBaseUrl || 'https://firstmail.ltd').trim() || 'https://firstmail.ltd', status: 'active', addedAt: Date.now() });
    seen.add(apiKey); added++;
  });
  _persist();
  return { added, dup };
}
function update(id, patch = {}) {
  const e = _load().find((x) => x.id === id); if (!e) return null;
  if ('label' in patch) e.label = String(patch.label || '').slice(0, 60);
  if ('provider' in patch) e.provider = String(patch.provider || 'firstmail');
  if ('apiBaseUrl' in patch) e.apiBaseUrl = String(patch.apiBaseUrl || '').trim() || e.apiBaseUrl;
  if ('status' in patch) e.status = patch.status === 'disabled' ? 'disabled' : 'active';
  if ('apiKey' in patch && String(patch.apiKey || '').trim()) e.apiKey = String(patch.apiKey).trim();
  _persist(); return e;
}
function remove(id) { _list = _load().filter((x) => x.id !== id); _persist(); return true; }
function clear() { _list = []; _persist(); return true; }

module.exports = { list, getFull, pickActive, add, importRaw, update, remove, clear, _FILE: FILE };
