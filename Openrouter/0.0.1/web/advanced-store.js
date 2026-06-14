'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 高级参数 store — Openrouter / web / advanced-store.js
//
// 存用户对【全局/共用调优旋钮】的覆盖值(只存设了的那几个);落盘 data/advanced-params.json。
// 零依赖 CommonJS。内存真相源 + 同步原子写(tmp+rename)。
// envPatch:engine-runner.buildEnv 注入(只注非空覆盖值;空=Python 用内置默认)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const schema = require('./advanced-schema');

const FILE = path.join(__dirname, '..', 'data', 'advanced-params.json');
let _db = null;

function _load() {
  if (_db) return _db;
  try { const o = JSON.parse(fs.readFileSync(FILE, 'utf8')); _db = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
  catch (_e) { _db = {}; }
  return _db;
}
function _persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_e) { /* 落盘失败不致命:内存仍有 */ }
}

function get() { return { ..._load() }; }

// 保存覆盖值:只收白名单 key;空串=清除该覆盖(回落代码内置默认)。返回最新全量。
function save(patch) {
  const db = _load();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!schema.KEYS.has(k)) continue;                       // 过滤未知键防注入
    if (v === undefined || v === null || String(v).trim() === '') delete db[k];   // 空=清除覆盖
    else db[k] = String(v).trim();
  }
  _persist();
  return get();
}

function envPatch() { return schema.envPatch(_load()); }

module.exports = { get, save, envPatch, _FILE: FILE };
