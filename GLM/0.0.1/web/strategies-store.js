'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 环节命名策略预设 — Openrouter / web / strategies-store.js
//
// 每个环节(register/key/card/charge)可存多套命名预设,运行时按"激活预设"取参数。
// 落盘 data/strategies.json。零依赖、CommonJS。内存真相源 + 同步原子写(tmp+rename),无 RMW 交错。
// 首次读取自动按 strategy-schema 默认 seed 一个 builtin「默认」预设(等于重构前 useState 初值)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');
const { STAGES, DEFAULTS, KEYS } = require('./strategy-schema');

const FILE = path.join(__dirname, '..', 'data', 'strategies.json');
const NAME_MAX = 40;

let _db = null;   // 内存缓存
let _seq = 0;     // 同毫秒内 id 去重

function _genId() { return 'p' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, null, 'strategies-store');   // ★H4:解析失败先备份 .corrupt 再退默认,绝不被下次写入抹掉
  _db = (o && typeof o === 'object' && o.stages) ? o : { version: 1, stages: {} };
  _seed();
  return _db;
}

// 给缺失环节 seed 一个 builtin「默认」预设。
function _seed() {
  let changed = false;
  for (const stage of STAGES) {
    const st = _db.stages[stage];
    if (!st || !Array.isArray(st.presets) || !st.presets.length) {
      _db.stages[stage] = { activeId: 'p_default', presets: [{ id: 'p_default', name: '默认', builtin: true, opts: { ...DEFAULTS[stage] } }] };
      changed = true;
    } else if (!st.presets.find((p) => p.id === st.activeId)) {
      st.activeId = st.presets[0].id; // activeId 失效 → 落到首个
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

function _assertStage(stage) { if (!STAGES.includes(stage)) { const e = new Error('BAD_STAGE'); e.code = 'BAD_STAGE'; throw e; } }

// 把传入 opts 过滤到白名单键 + 用默认补齐缺失键。
function _cleanOpts(stage, opts) {
  const out = { ...DEFAULTS[stage] };
  const allow = KEYS[stage];
  for (const [k, v] of Object.entries(opts || {})) { if (allow.has(k)) out[k] = v; }
  return out;
}

function _cleanName(name, fallback) {
  const n = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
  return n || fallback || '未命名';
}

function getAll() { return _load(); }

// 新建(无 id)或更新(有 id)预设。builtin 只允许改 opts(name/builtin 保持)。返回该环节最新 strategy。
function savePreset(stage, { id, name, opts } = {}) {
  _assertStage(stage);
  const db = _load();
  const st = db.stages[stage];
  const cleanOpts = _cleanOpts(stage, opts);
  if (id) {
    const p = st.presets.find((x) => x.id === id);
    if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
    p.opts = cleanOpts;
    if (!p.builtin) p.name = _cleanName(name, p.name);
  } else {
    const p = { id: _genId(), name: _cleanName(name, '新策略'), builtin: false, opts: cleanOpts };
    st.presets.push(p);
    st.activeId = p.id; // 新建即激活
  }
  _persist();
  return { stage, strategy: st };
}

// 删除预设。builtin 拒删;删的是激活预设则自动回退到剩余首个。
function deletePreset(stage, id) {
  _assertStage(stage);
  const db = _load();
  const st = db.stages[stage];
  const p = st.presets.find((x) => x.id === id);
  if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  if (p.builtin) { const e = new Error('BUILTIN_LOCKED'); e.code = 'BUILTIN_LOCKED'; throw e; }
  st.presets = st.presets.filter((x) => x.id !== id);
  if (!st.presets.find((x) => x.id === st.activeId)) st.activeId = st.presets[0].id;
  _persist();
  return { stage, strategy: st };
}

// 设激活预设。
function setActive(stage, id) {
  _assertStage(stage);
  const db = _load();
  const st = db.stages[stage];
  if (!st.presets.find((x) => x.id === id)) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  st.activeId = id;
  _persist();
  return { stage, strategy: st };
}

module.exports = { getAll, savePreset, deletePreset, setActive, _FILE: FILE };
