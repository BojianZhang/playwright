'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 引擎配置(per-engine 命名预设)— Openrouter / web / engine-config-store.js
//
// 每个引擎(playwright/selenium/hybrid/split)各存各的配置,可多套命名预设,运行时按"激活预设"取参数。
// 与 strategies-store 同范式,只是顶层键从"环节"换成"引擎"。落盘 data/engine-configs.json。
// 零依赖、CommonJS。内存真相源 + 同步原子写(tmp+rename),无 RMW 交错。
// 首次读取自动按 engine-schema 默认 seed 一个 builtin「默认」预设(= 重构前各引擎默认参数)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');
const { ENGINES, DEFAULTS, KEYS } = require('./engine-schema');

const FILE = path.join(__dirname, '..', 'data', 'engine-configs.json');
const NAME_MAX = 40;

let _db = null;   // 内存缓存
let _seq = 0;     // 同毫秒内 id 去重

function _genId() { return 'e' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, null, 'engine-config-store');   // ★H4:解析失败先备份 .corrupt 再退默认,绝不被下次写入抹掉
  _db = (o && typeof o === 'object' && o.engines) ? o : { version: 1, engines: {} };
  _seed();
  return _db;
}

// 给缺失引擎 seed 一个 builtin「默认」预设。
function _seed() {
  let changed = false;
  for (const engine of ENGINES) {
    const en = _db.engines[engine];
    if (!en || !Array.isArray(en.presets) || !en.presets.length) {
      _db.engines[engine] = { activeId: 'e_default', presets: [{ id: 'e_default', name: '默认', builtin: true, opts: { ...DEFAULTS[engine] } }] };
      changed = true;
    } else if (!en.presets.find((p) => p.id === en.activeId)) {
      en.activeId = en.presets[0].id; // activeId 失效 → 落到首个
      changed = true;
    }
  }
  if (changed) _persist();
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_e) { /* 落盘失败不致命:内存仍有 */ }
}

function _assertEngine(engine) { if (!ENGINES.includes(engine)) { const e = new Error('BAD_ENGINE'); e.code = 'BAD_ENGINE'; throw e; } }

// 把传入 opts 过滤到白名单键 + 用默认补齐缺失键。
function _cleanOpts(engine, opts) {
  const out = { ...DEFAULTS[engine] };
  const allow = KEYS[engine];
  for (const [k, v] of Object.entries(opts || {})) { if (allow.has(k)) out[k] = v; }
  return out;
}

function _cleanName(name, fallback) {
  const n = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
  return n || fallback || '未命名';
}

function getAll() { return _load(); }

// 取某引擎"激活预设"的 opts(缺字段用默认补齐)。供服务端运行时取值(派发/兜底)。
function activeOpts(engine) {
  _assertEngine(engine);
  const en = _load().engines[engine];
  const p = en.presets.find((x) => x.id === en.activeId) || en.presets[0];
  return { ...DEFAULTS[engine], ...(p ? p.opts : {}) };
}

// 新建(无 id)或更新(有 id)预设。builtin 只允许改 opts(name/builtin 保持)。返回该引擎最新 config。
function savePreset(engine, { id, name, opts } = {}) {
  _assertEngine(engine);
  const db = _load();
  const en = db.engines[engine];
  const cleanOpts = _cleanOpts(engine, opts);
  if (id) {
    const p = en.presets.find((x) => x.id === id);
    if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
    p.opts = cleanOpts;
    if (!p.builtin) p.name = _cleanName(name, p.name);
  } else {
    const p = { id: _genId(), name: _cleanName(name, '新配置'), builtin: false, opts: cleanOpts };
    en.presets.push(p);
    en.activeId = p.id; // 新建即激活
  }
  _persist();
  return { engine, config: en };
}

// 删除预设。builtin 拒删;删的是激活预设则自动回退到剩余首个。
function deletePreset(engine, id) {
  _assertEngine(engine);
  const db = _load();
  const en = db.engines[engine];
  const p = en.presets.find((x) => x.id === id);
  if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  if (p.builtin) { const e = new Error('BUILTIN_LOCKED'); e.code = 'BUILTIN_LOCKED'; throw e; }
  en.presets = en.presets.filter((x) => x.id !== id);
  if (!en.presets.find((x) => x.id === en.activeId)) en.activeId = en.presets[0].id;
  _persist();
  return { engine, config: en };
}

// 设激活预设。
function setActive(engine, id) {
  _assertEngine(engine);
  const db = _load();
  const en = db.engines[engine];
  if (!en.presets.find((x) => x.id === id)) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  en.activeId = id;
  _persist();
  return { engine, config: en };
}

module.exports = { getAll, activeOpts, savePreset, deletePreset, setActive, _FILE: FILE };
