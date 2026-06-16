'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / account-state / policy-store（错误策略覆盖表）
//
// 文件定位：Openrouter/0.0.1/account-state/policy-store.js
//
// 用途：持久化用户对「错误→动作」策略的覆盖（覆盖 failure-policy 的内置默认）。
//       结构：{ ERROR_CODE: { action, maxRetries } }，落盘 failure-policy.json。
//
// 关键：getOverrides() 同步返回内存活对象——failure-policy.classify 在重试热路径
//       同步调用它，绝不能有 IO/await。setOverride 整对象一次性赋值，避免半写。
// 节点本地运行态，gitignore。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createMutex } = require('../../../shared-batch-orchestration/mutex');

const POLICY_FILE = path.join(__dirname, 'failure-policy.json');
const mutex = createMutex();

/** @type {Record<string, {action:string, maxRetries:number}>|null} */
let OVERRIDES = null;
let flushTimer = null;

function ensureLoaded() {
  if (OVERRIDES) return;
  OVERRIDES = {};
  let raw;
  try { raw = fs.readFileSync(POLICY_FILE, 'utf8'); } catch (_e) { return; }   // 无文件=正常首启,不备份
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) OVERRIDES = obj;
  } catch (e) {
    // ★文件存在却解析失败=损坏 → 备份 .corrupt 留底再以空起,杜绝下次 flush 用空对象原子覆盖、永久丢策略覆盖(DEFECT-1 类同款守卫)。
    try { fs.renameSync(POLICY_FILE, POLICY_FILE + '.corrupt-' + Date.now()); } catch (_e2) { /* */ }
    try { console.error('[policy-store] policy.json 解析失败 → 已备份 .corrupt,本次按空覆盖继续:', e && e.message); } catch (_e3) { /* */ }
  }
}
function flushNow() {
  flushTimer = null;
  try {
    fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
    const tmp = `${POLICY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(OVERRIDES, null, 2), 'utf8');
    fs.renameSync(tmp, POLICY_FILE);
  } catch (e) { try { console.error('[policy-store] 落盘失败:', e && e.message); } catch (_e) { /* ignore */ } }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, 400);
  if (flushTimer.unref) flushTimer.unref();
}

/** 同步返回覆盖表「活对象」（classify 每次取活引用，勿快照）。 */
function getOverrides() {
  ensureLoaded();
  return OVERRIDES;
}

/** 设置某错误码的覆盖（整对象一次性赋值，避免并发半写）。 */
function setOverride(code, val) {
  return mutex(() => {
    ensureLoaded();
    const c = String(code || '').trim();
    if (!c) return null;
    OVERRIDES[c] = { action: String(val.action), maxRetries: Number(val.maxRetries) || 0 };
    scheduleFlush();
    return OVERRIDES[c];
  });
}

/** 清除某错误码的覆盖（回到内置）。 */
function resetOverride(code) {
  return mutex(() => {
    ensureLoaded();
    delete OVERRIDES[String(code || '').trim()];
    scheduleFlush();
    return true;
  });
}

/** 清空全部覆盖。 */
function clear() {
  return mutex(() => { OVERRIDES = {}; scheduleFlush(); return true; });
}

module.exports = { getOverrides, setOverride, resetOverride, clear, flushNow, _POLICY_FILE: POLICY_FILE };
