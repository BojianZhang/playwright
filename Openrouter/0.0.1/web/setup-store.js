'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 首次部署引导状态 — Openrouter / web / setup-store
//
// 文件定位:Openrouter/0.0.1/web/setup-store.js
//
// 只存一个标志:用户是否已走完(或主动跳过)部署引导。用来决定新用户首次进入是否
// 自动弹引导页。各步「是否已配」由 /api/setup/status 实时从配置/资源池算出,本 store
// 不缓存那些,只记 completed/dismissed。落盘 config/setup-state.json(已加进 .gitignore)。
// 零依赖、CommonJS、同步原子写(tmp+rename)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'config', 'setup-state.json');

let _state = null; // 内存缓存(首次访问时从盘加载)

function _load() {
  if (_state) return _state;
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    _state = (o && typeof o === 'object') ? o : {};
  } catch (_e) {
    _state = {};
  }
  return _state;
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_state, null, 2));
    fs.renameSync(tmp, STATE_FILE); // 原子替换,避免半写文件
  } catch (_e) { /* 落盘失败不致命:内存仍有,下次再写 */ }
}

function getState() {
  const s = _load();
  return { completed: !!s.completed, dismissed: !!s.dismissed, completedAt: s.completedAt || null };
}

// 走完引导:标记 completed(同时清掉 dismissed,因为已经真正配完了)。
function setCompleted() {
  const s = _load();
  s.completed = true;
  s.dismissed = false;
  s.completedAt = Date.now();
  _persist();
  return getState();
}

// 「以后再说」:本次不再自动弹,但不算完成(资源真配齐时仍显示已完成)。
function setDismissed() {
  const s = _load();
  s.dismissed = true;
  _persist();
  return getState();
}

function reset() {
  _state = {};
  _persist();
  return getState();
}

module.exports = { getState, setCompleted, setDismissed, reset, _STATE_FILE: STATE_FILE };
