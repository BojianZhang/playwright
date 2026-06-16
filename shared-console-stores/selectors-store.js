'use strict';
// ⟦共享规范实现(工厂) · 改这里;各项目 web/selectors-store.js 是注入 dataDir 的 re-export shim,勿改⟧ 见 shared-console-stores/README.md

// ═══════════════════════════════════════════════════════════════════════
// 元素选择器 store — Openrouter / web / selectors-store.js
//
// 存用户对关键元素选择器的【覆盖值】(每步一个字符串,多个用 || 分隔);落盘 data/ui-selectors.json。
// 零依赖 CJS,内存真相源 + 原子写。envPatch:engine-runner.buildEnv 注成 ORSEL_*(common.selectors.sel 读)。
// 只存设了的;空=清除覆盖=回落 selectors-schema 的 builtin 内置默认。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('../shared-utils/json-safe');
const schema = require('../shared-utils/selectors-schema');

module.exports = function createSelectorsStore({ dataDir }) {
const FILE = path.join(dataDir, 'ui-selectors.json');
let _db = null;

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, {}, 'selectors-store'); _db = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};   // ★H4:解析失败先备份 .corrupt
  return _db;
}
function _persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_e) { /* 内存仍有 */ }
}

function get() { return { ..._load() }; }

// 保存覆盖:只收白名单步骤 id;空串=清除该覆盖(回落 builtin)。
function save(patch) {
  const db = _load();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!schema.KEYS.has(k)) continue;
    if (v === undefined || v === null || String(v).trim() === '') delete db[k];
    else db[k] = String(v).trim();
  }
  _persist();
  return get();
}

function envPatch() { return schema.envPatch(_load()); }

return { get, save, envPatch, _FILE: FILE };
};
