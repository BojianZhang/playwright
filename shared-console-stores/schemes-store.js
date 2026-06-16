'use strict';
// ⟦共享规范实现(工厂) · 改这里;各项目 web/schemes-store.js 是注入 dataDir 的 re-export shim,勿改⟧ 见 shared-console-stores/README.md

// ═══════════════════════════════════════════════════════════════════════
// 执行方案预设 — Openrouter / web / schemes-store.js
//
// 一个"执行方案"= 控制台【怎么跑】的整套配置快照(引擎+流程开关+并发+浏览器+资源池),
// 命名存多套,控制台下拉一键选→自动填好全部参数。落盘 data/schemes.json。
// ★只存"怎么跑",不存凭证/数据(account/proxy/card 文本)、不存统一密码、不存回显模板——
//   这些是每次手填/单独管理的;方案文件因此【无敏感数据】,可安全入库。
// 零依赖、CommonJS。内存真相源 + 同步原子写(tmp+rename),范式同 strategies-store。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('../shared-utils/json-safe');

module.exports = function createSchemesStore({ dataDir }) {
const FILE = path.join(dataDir, 'schemes.json');
const NAME_MAX = 40;
// cfg 白名单 = 控制台"怎么跑"的字段(对应 ConsolePage 各 setter / ConsoleStateContext)。
// 【不含】unifiedPwd(密码)、data(凭证文本)、dispatchTargets(随在线子机变,非可复用方案)、tplOk/tplFail(回显另管)。
const CFG_KEYS = ['engine', 'mode', 'conc', 'count', 'chk', 'stages', 'browserProvider', 'envIds',
  'useAdspowerPool', 'useProxyPool', 'useAddressPool', 'useDispatch', 'shipResources'];

let _db = null;
let _seq = 0;
function _genId() { return 's' + Date.now().toString(36) + (_seq++).toString(36); }

// 内置方案(builtin 不可删):覆盖三种已跑通的主跑法。conc 给保守值,凭证/池按需自行调。
const BUILTINS = [
  { id: 's_sel_full', name: '已验证·纯Selenium全流程', builtin: true, cfg: {
    engine: 'selenium', mode: 'auto', conc: '3', count: '0',
    chk: { headed: false, resume: true, humanLike: false },
    stages: { key: true, addr: false, card: true, charge: true, pwd: false },
    browserProvider: 'none', envIds: '',
    useAdspowerPool: true, useProxyPool: true, useAddressPool: false,
    useDispatch: false, shipResources: true } },
  { id: 's_hybrid_full', name: '已验证·混合全流程', builtin: true, cfg: {
    engine: 'hybrid', mode: 'auto', conc: '2', count: '0',
    chk: { headed: false, resume: true, humanLike: false },
    stages: { key: true, addr: true, card: true, charge: true, pwd: false },
    browserProvider: 'none', envIds: '',
    useAdspowerPool: true, useProxyPool: true, useAddressPool: false,
    useDispatch: false, shipResources: true } },
  { id: 's_split', name: '两套分流(衔接+秒关)', builtin: true, cfg: {
    engine: 'split', mode: 'auto', conc: '3', count: '0',
    chk: { headed: false, resume: true, humanLike: false },
    stages: { key: true, addr: true, card: true, charge: true, pwd: false },
    browserProvider: 'none', envIds: '',
    useAdspowerPool: true, useProxyPool: true, useAddressPool: false,
    useDispatch: false, shipResources: true } },
];

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, null, 'schemes-store');   // ★H4:解析失败先备份 .corrupt 再退 null,绝不被下次写入抹掉
  _db = (o && o.schemes && Array.isArray(o.schemes.presets)) ? o : null;
  if (!_db) _db = { version: 1, schemes: { activeId: BUILTINS[0].id, presets: [] } };
  _seed();
  return _db;
}

// 补齐缺失的 builtin(按 id);activeId 失效则落到首个。
function _seed() {
  let changed = false;
  const have = new Set(_db.schemes.presets.map((p) => p.id));
  for (const b of BUILTINS) {
    if (!have.has(b.id)) { _db.schemes.presets.push(JSON.parse(JSON.stringify(b))); changed = true; }
  }
  if (!_db.schemes.presets.find((p) => p.id === _db.schemes.activeId)) { _db.schemes.activeId = _db.schemes.presets[0].id; changed = true; }
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

function _cleanCfg(cfg) { const out = {}; for (const k of CFG_KEYS) { if (cfg && k in cfg) out[k] = cfg[k]; } return out; }
function _cleanName(name, fb) { const n = String(name == null ? '' : name).trim().slice(0, NAME_MAX); return n || fb || '未命名'; }

function getAll() { return _load(); }

// 新建(无 id)或更新(有 id)。builtin 只许改 cfg(name/builtin 保持)。
function savePreset({ id, name, cfg } = {}) {
  const db = _load(); const sc = db.schemes; const clean = _cleanCfg(cfg);
  if (id) {
    const p = sc.presets.find((x) => x.id === id);
    if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
    p.cfg = clean;
    if (!p.builtin) p.name = _cleanName(name, p.name);
  } else {
    const p = { id: _genId(), name: _cleanName(name, '新方案'), builtin: false, cfg: clean };
    sc.presets.push(p); sc.activeId = p.id;   // 新建即激活
  }
  _persist();
  return { schemes: sc };
}

function deletePreset(id) {
  const db = _load(); const sc = db.schemes;
  const p = sc.presets.find((x) => x.id === id);
  if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  if (p.builtin) { const e = new Error('BUILTIN_LOCKED'); e.code = 'BUILTIN_LOCKED'; throw e; }
  sc.presets = sc.presets.filter((x) => x.id !== id);
  if (!sc.presets.find((x) => x.id === sc.activeId)) sc.activeId = sc.presets[0].id;
  _persist();
  return { schemes: sc };
}

function setActive(id) {
  const db = _load(); const sc = db.schemes;
  if (!sc.presets.find((x) => x.id === id)) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  sc.activeId = id;
  _persist();
  return { schemes: sc };
}

return { getAll, savePreset, deletePreset, setActive, _FILE: FILE };
};
