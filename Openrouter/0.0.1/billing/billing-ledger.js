'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / billing / billing-ledger（充值台账，按邮箱记账）
//
// 文件定位：Openrouter/0.0.1/billing/billing-ledger.js
//
// 用途：每个账号(邮箱)一次充值的终态都落一条台账，避免"糊涂账"——
//       清楚记录 哪个邮箱 / 用哪张卡(末4位) / 充了多少 / 成功还是被拒 / 何时。
//       落盘持久化，跨重启累计；提供汇总(总充值额/成功数/按卡/按结果)。
//
// 安全：只含邮箱+末4位+金额，不含完整卡号/CVC。仍作为运行态写入 gitignore 目录。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createMutex } = require('../../../shared-batch-orchestration/mutex');

const LEDGER_FILE = path.join(__dirname, '..', 'data', 'billing-ledger.json');
const mutex = createMutex();

/** @type {Array<object>|null} */
let ENTRIES = null;
let flushTimer = null;

function ensureLoaded() {
  if (ENTRIES) return;
  ENTRIES = [];
  try {
    const arr = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    if (Array.isArray(arr)) ENTRIES = arr;
  } catch (_e) { /* 无文件 → 空台账 */ }
}

function flushNow() {
  flushTimer = null;
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ENTRIES, null, 2), 'utf8');
  } catch (e) { try { console.error('[billing-ledger] 落盘失败(台账可能丢账):', e && e.message); } catch (_e) { /* ignore */ } }
}
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, 400);
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * 记录一条充值终态。
 * @param {object} e { email, result:'success'|'declined'|'no-card'|'no-address', charged, cardLast4, jobId, error, at }
 * @returns {Promise<object>} 写入的条目
 */
function record(e) {
  return mutex(() => {
    ensureLoaded();
    const entry = {
      at: e.at || new Date().toISOString(),
      email: e.email || '',
      result: e.result || 'unknown',
      charged: Number(e.charged) || 0,
      cardLast4: e.cardLast4 || '',
      jobId: e.jobId || '',
      error: e.error ? String(e.error).slice(0, 160) : '',
    };
    ENTRIES.push(entry);
    scheduleFlush();
    return entry;
  });
}

/**
 * 汇总台账。
 * @param {number} [recentN=200] 返回最近 N 条明细
 */
function summary(recentN = 200) {
  ensureLoaded();
  const byResult = {};
  const byCard = {};
  let totalCharged = 0;
  for (const e of ENTRIES) {
    byResult[e.result] = (byResult[e.result] || 0) + 1;
    if (e.result === 'success') {
      totalCharged += e.charged;
      const k = e.cardLast4 || '—';
      if (!byCard[k]) byCard[k] = { count: 0, charged: 0 };
      byCard[k].count += 1;
      byCard[k].charged += e.charged;
    }
  }
  const entries = ENTRIES.slice(-recentN).reverse(); // 最近的在前
  return {
    total: ENTRIES.length,
    success: byResult.success || 0,
    declined: byResult.declined || 0,
    totalCharged,
    byResult,
    byCard,
    entries,
  };
}

/** 清空台账。 */
function clear() {
  return mutex(() => {
    ENTRIES = [];
    scheduleFlush();
    return true;
  });
}

module.exports = { record, summary, clear, flushNow, _LEDGER_FILE: LEDGER_FILE };
