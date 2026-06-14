'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / account-state / account-store（账号进度状态机）
//
// 文件定位：Openrouter/0.0.1/account-state/account-store.js
//
// 用途：持久化每个账号（邮箱）跑到哪一步——是否已注册 / 已取到的 Key /
//       账单状态 / 是否已改密 / 登录用的密码 等，支撑「幂等断点续跑」：
//       重跑时跳过已完成阶段，失败只补跑没做完的，避免重复建 Key / 重复扣费。
//
// 镜像 billing/billing-ledger.js 的落盘范式（mutex + 延迟 flush + tmp 原子写）。
// 安全：含登录密码/原密码/API Key → accounts.json 已在 .gitignore，绝不进 Git。
// 注意：状态为「节点本地」（与 card-pool/billing-ledger 一致），跨机不共享。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createMutex } = require('../../../shared-batch-orchestration/mutex');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const mutex = createMutex();

/** @type {Record<string, object>|null} email(小写) -> 状态记录 */
let STATE = null;
let flushTimer = null;

function ensureLoaded() {
  if (STATE) return;
  STATE = {};
  try {
    const obj = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) STATE = obj;
  } catch (_e) { /* 无文件 → 空状态 */ }
}

function flushNow() {
  flushTimer = null;
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    const tmp = `${ACCOUNTS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(STATE), 'utf8');   // 落盘是机器读(ensureLoaded JSON.parse),不缩进省一半序列化+写入字节;UI 的 list() 另行脱敏展示
    fs.renameSync(tmp, ACCOUNTS_FILE); // 原子替换，避免半写文件
  } catch (e) { try { console.error('[account-store] 落盘失败(账号进度可能丢):', e && e.message); } catch (_e) { /* ignore */ } }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, 400);
  if (flushTimer.unref) flushTimer.unref();
}

const norm = (email) => String(email || '').trim().toLowerCase();

/** 读取某账号状态（无则 null）。 */
function get(email) {
  ensureLoaded();
  return STATE[norm(email)] || null;
}

/** 合并写入某账号状态（mutex 内读-改-写）。只传要更新的字段。 */
function update(email, fields) {
  return mutex(() => {
    ensureLoaded();
    const k = norm(email);
    if (!k) return null;
    const prev = STATE[k] || { email: String(email).trim(), createdAt: new Date().toISOString() };
    const next = { ...prev, ...fields, email: prev.email || String(email).trim(), updatedAt: new Date().toISOString() };
    STATE[k] = next;
    scheduleFlush();
    return next;
  });
}

/** 删除某账号状态（让它下次从头跑）。 */
function reset(email) {
  return mutex(() => {
    ensureLoaded();
    delete STATE[norm(email)];
    scheduleFlush();
    return true;
  });
}

/** 清空全部状态。 */
function clear() {
  return mutex(() => { STATE = {}; scheduleFlush(); return true; });
}

function mask(s) {
  s = String(s || '');
  if (!s) return '';
  return s.length <= 2 ? '••' : `${s.slice(0, 1)}••${s.slice(-1)}`;
}

/** 列出全部状态（密码脱敏，供 UI 展示）。 */
function list() {
  ensureLoaded();
  return Object.values(STATE).map((r) => ({
    ...r,
    loginPassword: mask(r.loginPassword),
    mailboxPassword: mask(r.mailboxPassword),
    originalPassword: mask(r.originalPassword),
  }));
}

// ── 账单等级（防重复扣费 + 续跑判定）──────────────────────────────────────
// 已达成：declined/no-card/no-address 视为 0（未达标 → 换新卡重跑）。
const BILLING_LEVEL = { skipped: 0, 'address-bound': 1, 'card-bound': 2, success: 3 };
const REQUESTED_LEVEL = { none: 0, address: 1, card: 2, charge: 3 };
function attainedLevel(status) { return BILLING_LEVEL[status] != null ? BILLING_LEVEL[status] : 0; }
function requestedLevel(action) { return REQUESTED_LEVEL[action] != null ? REQUESTED_LEVEL[action] : 0; }
/** 账单是否已满足所选动作（满足则跳过 billing；charge×success → true，不复扣）。 */
function billingSatisfied(priorStatus, action) {
  return attainedLevel(priorStatus) >= requestedLevel(action);
}

module.exports = {
  get, update, reset, clear, list,
  attainedLevel, requestedLevel, billingSatisfied,
  flushNow,   // 供 server.js 优雅退出时同步刷盘(否则 setTimeout(400) 窗口内的写在退出时丢失)
  _ACCOUNTS_FILE: ACCOUNTS_FILE,
};
