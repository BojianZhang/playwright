'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 失败恢复策略 命名预设 store — Openrouter / web / recovery-store.js
//
// 单一全局命名空间(recovery),可多套命名预设(如「默认/全力重试」「保守/只补注册」),运行时按"激活预设"取参数。
// 与 strategies-store / engine-config-store 同范式,只是顶层是单个 recovery(非 per-engine/per-stage)。
// 落盘 data/recovery-strategies.json。零依赖、CommonJS。内存真相源 + 同步原子写(tmp+rename),无 RMW 交错。
// 首次读取自动按 recovery-schema 默认 seed 一个 builtin「默认」预设(= 现状全重试,逐字节等价)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');
const { DEFAULTS, KEYS } = require('./recovery-schema');

// 默认落盘 data/recovery-strategies.json;OPENROUTER_RECOVERY_FILE 可覆盖(仅测试用,绝不碰生产盘)。
const FILE = process.env.OPENROUTER_RECOVERY_FILE || path.join(__dirname, '..', 'data', 'recovery-strategies.json');
const NAME_MAX = 40;

let _db = null;   // 内存缓存
let _seq = 0;     // 同毫秒内 id 去重

function _genId() { return 'r' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_db) return _db;
  const o = readJsonOr(FILE, null, 'recovery-store');   // 解析失败先备份 .corrupt 再退默认,绝不被下次写入抹掉
  _db = (o && typeof o === 'object' && o.recovery && Array.isArray(o.recovery.presets)) ? o : { version: 1, recovery: {} };
  _seed();
  return _db;
}

// 内置「恢复方案」(失败感知预设):retry.* 全继承默认(全重试,逐字节等价),只在【动作】字段上有别。
//   r_default 必须排第一且 activeId 默认指它(= 现状逐字节不变)。新增方案是给批量恢复弹窗按主因自动推荐 + 用户复用。
const BUILTIN_PRESETS = [
  { id: 'r_default', name: '默认(全部重试)', opts: { ...DEFAULTS } },
  { id: 'r_swap_env', name: '换环境(充值拒付)', opts: { ...DEFAULTS, zipRetry: '3', ipRounds: '2' } },
  { id: 'r_swap_card', name: '换卡(余额不足/人机)', opts: { ...DEFAULTS, cardStrategy: 'spread', swapOnHcaptcha: 'on', ipRounds: '1' } },
  { id: 'r_swap_ip', name: '换 IP(取Key/注册)', opts: { ...DEFAULTS, ipRounds: '3' } },
];

// 缺失/空 → seed 全部内置方案;已有 → 幂等补齐缺失的内置(按 id),绝不动 activeId / 已有预设的 opts。
function _seed() {
  const rec = _db.recovery;
  let changed = false;
  if (!rec.presets || !Array.isArray(rec.presets) || !rec.presets.length) {
    _db.recovery = { activeId: 'r_default', presets: BUILTIN_PRESETS.map((b) => ({ id: b.id, name: b.name, builtin: true, opts: { ...b.opts } })) };
    changed = true;
  } else {
    // 幂等迁移:老安装只有 r_default → 补齐新内置方案(不重排、不改 activeId、不碰已存在预设)
    for (const b of BUILTIN_PRESETS) {
      if (!rec.presets.find((p) => p.id === b.id)) {
        rec.presets.push({ id: b.id, name: b.name, builtin: true, opts: { ...b.opts } });
        changed = true;
      }
    }
    if (!rec.presets.find((p) => p.id === rec.activeId)) { rec.activeId = rec.presets[0].id; changed = true; }
  }
  if (changed) _persist();
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_e) { /* 落盘失败不致命:内存仍是真相源 */ }
}

function _cleanOpts(opts) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts || {})) { if (KEYS.has(k)) out[k] = v; }   // 只收白名单 key(手改 JSON 也注不进任意键)
  return out;
}

function _cleanName(name, fallback) {
  const n = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
  return n || fallback || '未命名';
}

function getAll() { return _load(); }

// 激活预设的合并 opts(默认兜底)→ buildEnv 取它生成 OPENROUTER_RECOVERY_JSON。
function activeOpts() {
  const rec = _load().recovery;
  const p = rec.presets.find((x) => x.id === rec.activeId) || rec.presets[0];
  return { ...DEFAULTS, ...(p ? p.opts : {}) };
}

function savePreset({ id, name, opts } = {}) {
  const rec = _load().recovery;
  const cleanOpts = _cleanOpts(opts);
  if (id) {
    const p = rec.presets.find((x) => x.id === id);
    if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
    p.opts = cleanOpts;
    if (!p.builtin) p.name = _cleanName(name, p.name);   // builtin「默认」不可改名,但可改 opts
  } else {
    const p = { id: _genId(), name: _cleanName(name, '新恢复策略'), builtin: false, opts: cleanOpts };
    rec.presets.push(p);
    rec.activeId = p.id;   // 新建即激活
  }
  _persist();
  return { config: rec };
}

function deletePreset(id) {
  const rec = _load().recovery;
  const p = rec.presets.find((x) => x.id === id);
  if (!p) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  if (p.builtin) { const e = new Error('BUILTIN_LOCKED'); e.code = 'BUILTIN_LOCKED'; throw e; }
  rec.presets = rec.presets.filter((x) => x.id !== id);
  if (!rec.presets.find((x) => x.id === rec.activeId)) rec.activeId = rec.presets[0].id;
  _persist();
  return { config: rec };
}

function setActive(id) {
  const rec = _load().recovery;
  if (!rec.presets.find((x) => x.id === id)) { const e = new Error('NO_PRESET'); e.code = 'NO_PRESET'; throw e; }
  rec.activeId = id;
  _persist();
  return { config: rec };
}

function flushNow() { if (_db) _persist(); }   // graceful-shutdown 调

module.exports = { getAll, activeOpts, savePreset, deletePreset, setActive, flushNow, _FILE: FILE };
