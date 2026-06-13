'use strict';

// ═══════════════════════════════════════════════════════════════════════
// AdsPower 环境编号池 — Openrouter / web / adspower-store.js
//
// 边界:**只管 AdsPower 环境编号(envId)池**——哪些指纹环境可被任务复用。
// 不管 AdsPower 端点(API 地址+密钥那是 config.local.json 的 adspower.* + config-rw)、
// 不管代理、不管账号。落盘 data/adspower.json。范式同 proxy-store。
// activeRaw() 回拼成 server.js 认的 adspowerEnvIdsRaw(空白/逗号分隔),供"从池选用"。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'adspower.json');
let _list = null;

function _load() {
  if (_list) return _list;
  try { const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); _list = Array.isArray(a) ? a : []; } catch (_e) { _list = []; }
  return _list;
}
function _persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_list, null, 2)); fs.renameSync(tmp, FILE); } catch (_e) { /* 落盘失败不致命 */ }
}
function list() { return _load(); }

// 批量添加 env 编号:空白/逗号分隔;id 即 envId,按 envId 去重。endpoint=所属 AdsPower 端点 id(可空)。
function add(raw, endpoint) {
  const lst = _load(); let added = 0, dup = 0;
  String(raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).forEach((envId) => {
    if (lst.some((x) => x.id === envId)) { dup++; return; }
    lst.push({ id: envId, label: '', endpoint: endpoint || '', status: 'active', addedAt: Date.now(), useCount: 0 });
    added++;
  });
  _persist();
  return { added, dup, total: lst.length };
}
function update(id, patch) {
  const it = _load().find((x) => x.id === id); if (!it) return null;
  if ('label' in patch) it.label = String(patch.label || '').slice(0, 60);
  if ('endpoint' in patch) it.endpoint = String(patch.endpoint || '');
  if ('status' in patch) it.status = patch.status === 'disabled' ? 'disabled' : 'active';
  _persist(); return it;
}
function remove(id) { _list = _load().filter((x) => x.id !== id); _persist(); return true; }
function clear() { _list = []; _persist(); return true; }
// 运行时"从池选用":active env 编号,空白分隔(server 用 /[\s,]+/ 再切)。
function activeRaw() { return _load().filter((x) => x.status === 'active').map((x) => x.id).join('\n'); }

module.exports = { list, add, update, remove, clear, activeRaw, _FILE: FILE };
