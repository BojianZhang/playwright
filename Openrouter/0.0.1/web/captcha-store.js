'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 验证码 key 池 — Openrouter / web / captcha-store.js
//
// 边界:**只管多个验证码求解服务的 API key**(2captcha/capsolver)的增删改 + 余额展示 + 选用。
// 不改求解逻辑、不碰反检测——只决定求解器用哪个 key。落盘 data/captcha-keys.json(含密钥,已 gitignore)。
// list() 脱敏(只回 apiKeySet,不回明文);getFull/pickActive 服务端内部用。范式同 adspower-endpoint-store。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'captcha-keys.json');
let _list = null;
let _seq = 0;
function _genId() { return 'cap' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_list) return _list;
  try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); _list = Array.isArray(a) ? a : []; } catch (_e) { _list = []; }
  return _list;
}
function _persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_list, null, 2)); fs.renameSync(tmp, FILE); } catch (_e) { /* */ }
}

// 单一可用性判据:status=active 且(余额未知 或 有限且>0)。list 的 usable 与 pickActive 共用,避免"显示可用却永不被选"的双源漂移。
const _usable = (e) => e.status === 'active' && (e.balance == null || (Number.isFinite(e.balance) && e.balance > 0));
function list() { return _load().map((e) => ({ id: e.id, label: e.label, provider: e.provider, status: e.status, usable: _usable(e), apiKeySet: !!(e.apiKey && String(e.apiKey).trim()), balance: e.balance, balanceAt: e.balanceAt, lastError: e.lastError, addedAt: e.addedAt })); }
function getFull(id) { return _load().find((e) => e.id === id) || null; }
// 失效转移:挑一个可用 key。无则 null。
function pickActive() { return _load().find(_usable) || null; }

function add({ label, provider, apiKey } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) { const e = new Error('NO_KEY'); e.code = 'NO_KEY'; throw e; }
  const prov = provider === 'capsolver' ? 'capsolver' : '2captcha';   // 缺省 2captcha(与 importRaw 一致;Python 引擎走 2captcha)
  const lst = _load();
  const e = { id: _genId(), label: String(label || '').slice(0, 60) || prov, provider: prov, apiKey: key, status: 'active', balance: null, balanceAt: null, lastError: '', addedAt: Date.now() };
  lst.push(e); _persist();
  return e;
}
// 批量导入:每行 `provider|apiKey|label`(分隔符 | 或逗号 或制表);单字段=裸 apiKey。
// provider 仅 2captcha / capsolver,缺省 2captcha(Python 引擎走 2captcha)。按 apiKey 去重(已存在则计 dup)。
function importRaw(raw) {
  const lst = _load();
  const seen = new Set(lst.map((e) => String(e.apiKey || '').trim()).filter(Boolean));
  let added = 0, dup = 0;
  String(raw || '').split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split(/\s*[|,\t]\s*/);
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();   // 容错:裸 key 带尾随分隔符 "key|" → 不再被当多字段而丢弃
    let provider, apiKey, label;
    if (parts.length <= 1) { apiKey = parts[0]; }
    else { [provider, apiKey, label] = parts; }
    apiKey = String(apiKey || '').trim();
    if (!apiKey) return;
    if (seen.has(apiKey)) { dup++; return; }
    const prov = provider === 'capsolver' ? 'capsolver' : '2captcha';
    lst.push({ id: _genId(), label: String(label || '').slice(0, 60) || prov, provider: prov, apiKey, status: 'active', balance: null, balanceAt: null, lastError: '', addedAt: Date.now() });
    seen.add(apiKey); added++;
  });
  _persist();
  return { added, dup };
}
function update(id, patch = {}) {
  const e = _load().find((x) => x.id === id); if (!e) return null;
  if ('label' in patch) e.label = String(patch.label || '').slice(0, 60);
  if ('provider' in patch) e.provider = patch.provider === 'capsolver' ? 'capsolver' : '2captcha';  // 默认 2captcha,与 importRaw/add 一致(原来反向默认 capsolver→改卡商误翻)
  if ('status' in patch) e.status = patch.status === 'disabled' ? 'disabled' : 'active';
  if ('apiKey' in patch && String(patch.apiKey || '').trim()) e.apiKey = String(patch.apiKey).trim(); // 空值不覆盖
  _persist(); return e;
}
function remove(id) { _list = _load().filter((x) => x.id !== id); _persist(); return true; }
function clear() { _list = []; _persist(); return true; }
function recordBalance(id, res) {
  const e = _load().find((x) => x.id === id); if (!e) return null;
  e.balanceAt = Date.now();
  // 非数字余额(provider 异常体里带非数字 balance 字段)→ Number() 得 NaN,会毒化 pickActive
  // (NaN!=null 为真、NaN>0 为假 → 该 active key 被永久跳过但 list 仍显示可用)。只接受有限数,否则当未知。
  const n = res && res.balance != null ? Number(res.balance) : NaN;
  // 余额耗尽(≤0)也是有限数,会落库;但 pickActive 永不选它 → 显式标注原因,避免"显示可用却永不被选"。
  if (Number.isFinite(n)) { e.balance = n; e.lastError = n > 0 ? '' : '余额耗尽(已暂停选用)'; }
  else { e.lastError = String((res && res.error) || 'balance-failed').slice(0, 120); }
  _persist(); return e;
}

module.exports = { list, getFull, pickActive, add, importRaw, update, remove, clear, recordBalance, _FILE: FILE };
