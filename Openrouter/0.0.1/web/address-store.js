'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 账单地址池 — Openrouter / web / address-store.js
//
// 边界:**只管加卡用的账单地址**(name|line1|city|state|zip|line2)。不管代理、不管卡。
// 落盘 data/addresses.json(含真实姓名/地址,已 gitignore)。范式同 proxy-store。
// activeLines() 回拼成 server.js parseAddressLines 认的多行文本,供运行时"从池选用"。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'addresses.json');
let _list = null;
let _seq = 0;
function _genId() { return 'ad' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_list) return _list;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); _list = Array.isArray(a) ? a : [];
  } catch (_e) {
    _list = [];
    // 【C3 修】文件损坏(非不存在)→ 告警+备份,避免下次 _persist 用 [] 覆盖丢光地址
    if (fs.existsSync(FILE)) {
      try { console.error(`[address-store] ${FILE} 解析失败,已备份为 .corrupt 并以空表启动:`, _e.message); fs.copyFileSync(FILE, FILE + '.corrupt'); } catch (_e2) { /* ignore */ }
    }
  }
  return _list;
}
function _persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_list, null, 2)); fs.renameSync(tmp, FILE); } catch (_e) { /* 落盘失败不致命 */ }
}
// 一行 "name|line1|city|state|zip[|line2]"(分隔符 | 制表 或逗号),与 server.js parseAddressLines 同。
function _parseLine(line) {
  const parts = String(line).split(/\s*[|\t]\s*|\s*,\s*/).map((s) => s.trim());
  const [name, line1, city, state, zip, line2] = parts;
  if (!line1 || !zip) return null;
  return { name: name || '', line1, city: city || '', state: state || '', zip, line2: line2 || '', country: 'United States' };
}
// 去重 key 含 state(be-8):同一邮编可跨州/市,只用 line1+zip 会把不同州的同名街道误判重复跳过。
const _key = (x) => `${(x.line1 || '').toLowerCase()}|${(x.state || '').toLowerCase()}|${x.zip || ''}`;

function list() { return _load(); }
function get(id) { return _load().find((x) => x.id === id) || null; }

// 批量导入:多行;跳过 CSV 表头(含 street/city/state/zip 关键字的首行);按 line1+zip 去重。
function importRaw(raw) {
  const lst = _load(); let added = 0, dup = 0;
  String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    .filter((s) => !/^\s*(name|姓名)?\s*[|,\t].*(street|address|city|state|zip|城市|邮编)/i.test(s))
    .forEach((line) => {
      const a = _parseLine(line); if (!a) return;
      if (lst.some((x) => _key(x) === _key(a))) { dup++; return; }
      lst.push({ id: _genId(), ...a, status: 'active', addedAt: Date.now(), useCount: 0 });
      added++;
    });
  _persist();
  return { added, dup, total: lst.length };
}
function update(id, patch) {
  const it = _load().find((x) => x.id === id); if (!it) return null;
  // 字段不能含分隔符(| 制表 逗号):activeLines() 用 | 拼回、运行时 parseAddressLines 又按这些切 → 否则字段右移、错城市/州/邮编发给 Stripe。
  for (const k of ['name', 'line1', 'city', 'state', 'zip', 'line2']) if (k in patch) it[k] = String(patch[k] || '').replace(/[|\t,]/g, ' ').trim();
  if ('status' in patch) it.status = patch.status === 'disabled' ? 'disabled' : 'active';
  _persist(); return it;
}
function remove(id) { _list = _load().filter((x) => x.id !== id); _persist(); return true; }
function clear() { _list = []; _persist(); return true; }
// 运行时"从池选用":回拼成 parseAddressLines 认的多行文本(仅 active)。
function activeLines() {
  return _load().filter((x) => x.status === 'active')
    .map((x) => [x.name, x.line1, x.city, x.state, x.zip, x.line2].map((v) => v || '').join('|'))
    .join('\n');
}

module.exports = { list, get, add: importRaw, importRaw, update, remove, clear, activeLines, _FILE: FILE };
