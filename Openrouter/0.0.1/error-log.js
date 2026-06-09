'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / error-log（错误事件日志）
//
// 文件定位：Openrouter/0.0.1/error-log.js
//
// 用途：把每次阶段失败的「错误事件」落盘，供页面查看 + 配置策略参考——
//       哪个邮箱 / 哪个阶段 / 报了什么错 / 被路由成什么动作 / 第几次尝试。
//
// 镜像 billing/billing-ledger.js 的范式（mutex + 延迟 flush）。总量封顶 2000 条。
// 安全：仅含邮箱/阶段/错误文本，无凭据。error-log.json 仍属节点本地运行态，gitignore。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createMutex } = require('../../shared-batch-orchestration/mutex');

const ERROR_LOG_FILE = path.join(__dirname, 'account-state', 'error-log.json');
const MAX_ENTRIES = 2000;
const mutex = createMutex();

/** @type {Array<object>|null} */
let ENTRIES = null;
let flushTimer = null;

function ensureLoaded() {
  if (ENTRIES) return;
  ENTRIES = [];
  try {
    const arr = JSON.parse(fs.readFileSync(ERROR_LOG_FILE, 'utf8'));
    if (Array.isArray(arr)) ENTRIES = arr;
  } catch (_e) { /* 无文件 → 空 */ }
}
function flushNow() {
  flushTimer = null;
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG_FILE), { recursive: true });
    const tmp = `${ERROR_LOG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ENTRIES, null, 2), 'utf8');
    fs.renameSync(tmp, ERROR_LOG_FILE);
  } catch (_e) { /* 落盘失败不致命 */ }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, 400);
  if (flushTimer.unref) flushTimer.unref();
}

/** 记录一条错误事件。 */
function record(e) {
  return mutex(() => {
    ensureLoaded();
    ENTRIES.push({
      at: e.at || new Date().toISOString(),
      email: e.email || '',
      stage: e.stage || '',
      reason: e.reason ? String(e.reason).slice(0, 160) : '',
      action: e.action || '',
      attempt: Number(e.attempt) || 0,
      jobId: e.jobId || '',
    });
    if (ENTRIES.length > MAX_ENTRIES) ENTRIES.splice(0, ENTRIES.length - MAX_ENTRIES);
    scheduleFlush();
    return true;
  });
}

// 把非「已知错误码」的原始报错文本归一到一个桶，避免 byReason 键爆炸。
const KNOWN_CODE = /^[A-Z][A-Z0-9_]{3,}$/;
function reasonKey(reason) {
  const r = String(reason || '').trim();
  return KNOWN_CODE.test(r) ? r : '(其它/兜底)';
}

/** 汇总（近 MAX_ENTRIES 条窗口内）。 */
function summary(recentN = 200) {
  ensureLoaded();
  const byReason = {};
  const byAction = {};
  for (const e of ENTRIES) {
    const k = reasonKey(e.reason);
    byReason[k] = (byReason[k] || 0) + 1;
    if (e.action) byAction[e.action] = (byAction[e.action] || 0) + 1;
  }
  return {
    total: ENTRIES.length,
    byReason,
    byAction,
    entries: ENTRIES.slice(-recentN).reverse(),
  };
}

/** 清空。 */
function clear() {
  return mutex(() => { ENTRIES = []; scheduleFlush(); return true; });
}

module.exports = { record, summary, clear, _ERROR_LOG_FILE: ERROR_LOG_FILE };
