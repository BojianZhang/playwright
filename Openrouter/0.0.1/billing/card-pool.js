'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / billing / card-pool（持久化卡池）
//
// 文件定位：Openrouter/0.0.1/billing/card-pool.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 卡片行解析、卡池落盘/读取、并发安全地取卡(acquire)/回报(report)、
//            脱敏快照(snapshot)、手动禁用/启用。使用次数/状态/时间跨任务跨重启累计。
// ❌ 不负责 —— 页面操作(stages.billing)、表单解析编排(server)、SSE 推送(job-runner)。
//
// 安全：卡池文件 account-state/card-pool.json 含完整卡号/CVC，已在 .gitignore，绝不进 Git。
//       对外快照 snapshot() 一律脱敏(卡号→••last4，不含 CVC)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMutex } = require('../../../shared-batch-orchestration/mutex');

const POOL_FILE = path.join(__dirname, '..', 'account-state', 'card-pool.json');
const mutex = createMutex();

/** @type {Map<string, object>} id -> card */
let POOL = null;
let flushTimer = null;

// ── 持久化 ──────────────────────────────────────────────────────────────
function ensureLoaded() {
  if (POOL) return;
  POOL = new Map();
  try {
    const raw = fs.readFileSync(POOL_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const c of arr) {
        if (c && c.id) {
          c.inUse = false; // 重启后清除占用标记（进程内才有意义）
          POOL.set(c.id, c);
        }
      }
    }
  } catch (_e) { /* 文件不存在/损坏 → 空池 */ }
}

function flushNow() {
  flushTimer = null;
  try {
    fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
    const arr = Array.from(POOL.values()).map(({ inUse, ...rest }) => rest); // 不落 inUse
    fs.writeFileSync(POOL_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (_e) { /* 落盘失败不致命 */ }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, 400);
  if (flushTimer.unref) flushTimer.unref();
}

// ── 解析 ────────────────────────────────────────────────────────────────
function luhnOk(num) {
  let sum = 0; let alt = false;
  for (let i = num.length - 1; i >= 0; i -= 1) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

function fingerprint(number, expMonth, expYear) {
  const h = crypto.createHash('sha1').update(`${number}|${expMonth}|${expYear}`).digest('hex').slice(0, 12);
  return `card-${h}`;
}

/**
 * 解析多行卡片文本，自动识别多种格式：
 *   4361 2080 0908 8695  02/29  093
 *   4737023115115911|05/30|130
 *   4565991001389302,04/31,164          （可选尾部 |次数|邮编）
 * 无法解析的行返回 { raw, _parseError } 供 UI 反馈。
 *
 * @param {string} text
 * @param {number} defaultMaxUses
 * @returns {Array<object>}
 */
function parseCardLines(text, defaultMaxUses) {
  const out = [];
  const dflt = Math.max(1, Number(defaultMaxUses) || 10);
  const lines = String(text || '').split(/\r?\n/);
  for (const line0 of lines) {
    const line = line0.trim();
    if (!line || line.startsWith('#')) continue;

    // 1) 抽有效期 MM/YY 或 MM/YYYY
    const expM = line.match(/(\d{1,2})\s*[/\-]\s*(\d{2,4})/);
    if (!expM) { out.push({ raw: line, _parseError: '未识别有效期(MM/YY)' }); continue; }
    const expMonth = String(expM[1]).padStart(2, '0');
    const expYearRaw = expM[2];
    const expYear = expYearRaw.length >= 4 ? expYearRaw.slice(-2) : expYearRaw.padStart(2, '0');

    // 移除有效期片段，余下用于找卡号 + CVC + 可选尾部字段
    const rest = line.replace(expM[0], ' ');

    // 2) 卡号：13–19 位连续数字（容许中间空格）。取最长的数字串。
    const digitRuns = rest.match(/(?:\d[ \t]?){13,19}/g) || [];
    let number = '';
    for (const run of digitRuns) {
      const d = run.replace(/\D/g, '');
      if (d.length >= 13 && d.length <= 19 && d.length > number.length) number = d;
    }
    if (!number) { out.push({ raw: line, _parseError: '未识别卡号(13-19位)' }); continue; }

    // 3) 余下短数字串：CVC(3-4) / 次数 / 邮编(5)。先扣掉卡号片段，再收集短数字 token。
    const shortTokens = (rest.replace(/(?:\d[ \t]?){13,19}/g, ' ').match(/\d+/g) || []);
    let cvc = '';
    let maxUses = dflt;
    let zip = '';
    for (const t of shortTokens) {
      if (!cvc && (t.length === 3 || t.length === 4)) { cvc = t; continue; }
      if (t.length === 5 && !zip) { zip = t; continue; }
      if (!Number.isNaN(Number(t)) && Number(t) >= 1 && Number(t) <= 1000 && t.length <= 4) { maxUses = Number(t); continue; }
    }
    if (!cvc) { out.push({ raw: line, _parseError: '未识别CVC(3-4位)' }); continue; }

    const card = {
      id: fingerprint(number, expMonth, expYear),
      last4: number.slice(-4),
      number,
      expMonth,
      expYear,
      cvc,
      zip,
      maxUses,
      _luhn: luhnOk(number),
    };
    out.push(card);
  }
  return out;
}

// ── 池操作（全部经 mutex 串行，保证并发安全）─────────────────────────────
function freshCounters() {
  return {
    usedCount: 0, successCount: 0, declineCount: 0,
    status: 'active', firstUsedAt: '', lastUsedAt: '', lastResult: '', lastError: '',
  };
}

/**
 * 合并导入：新卡入池，已存在(同指纹)的保留历史计数，仅更新 maxUses/zip/密文。
 * @returns {Promise<{added:number, updated:number, errors:Array}>}
 */
function upsertMany(cards) {
  return mutex(() => {
    ensureLoaded();
    let added = 0; let updated = 0; const errors = [];
    for (const c of cards || []) {
      if (c._parseError) { errors.push({ raw: c.raw, error: c._parseError }); continue; }
      const existing = POOL.get(c.id);
      if (existing) {
        existing.maxUses = c.maxUses;
        existing.zip = c.zip || existing.zip;
        existing.number = c.number; existing.cvc = c.cvc;
        existing.expMonth = c.expMonth; existing.expYear = c.expYear;
        // exhausted 但用户调高了次数 → 恢复 active
        if (existing.status === 'exhausted' && existing.usedCount < existing.maxUses) existing.status = 'active';
        updated += 1;
      } else {
        POOL.set(c.id, {
          id: c.id, last4: c.last4, number: c.number, expMonth: c.expMonth, expYear: c.expYear,
          cvc: c.cvc, zip: c.zip || '', maxUses: c.maxUses, inUse: false, ...freshCounters(),
        });
        added += 1;
      }
    }
    scheduleFlush();
    return { added, updated, errors };
  });
}

/**
 * 取一张可用卡（active 且 usedCount<maxUses 且未被占用），置 inUse 返回完整密文；无则 null。
 * @returns {Promise<object|null>}
 */
function acquire() {
  return mutex(() => {
    ensureLoaded();
    for (const c of POOL.values()) {
      if (c.status === 'active' && c.usedCount < c.maxUses && !c.inUse) {
        c.inUse = true;
        return { id: c.id, last4: c.last4, number: c.number, expMonth: c.expMonth, expYear: c.expYear, cvc: c.cvc, zip: c.zip, maxUses: c.maxUses, usedCount: c.usedCount };
      }
    }
    return null;
  });
}

/**
 * 回报一次使用结果，更新计数/状态/时间并落盘。
 * @param {string} id
 * @param {{result:'success'|'declined'|'error', error?:string}} outcome
 */
function report(id, outcome) {
  return mutex(() => {
    ensureLoaded();
    const c = POOL.get(id);
    if (!c) return null;
    const now = new Date().toISOString();
    c.inUse = false;
    c.lastUsedAt = now;
    if (!c.firstUsedAt) c.firstUsedAt = now;
    const result = outcome && outcome.result;
    c.lastResult = result || 'error';
    c.lastError = (outcome && outcome.error) ? String(outcome.error).slice(0, 200) : '';
    if (result === 'success') {
      c.usedCount += 1; c.successCount += 1;
      if (c.usedCount >= c.maxUses) c.status = 'exhausted';
    } else if (result === 'bound') {
      // 仅加卡(未扣费)：不消耗付款次数，保持可用，仅更新时间/结果。
      c.lastResult = 'bound';
    } else if (result === 'declined') {
      c.declineCount += 1;
      c.status = 'declined'; // 被拒 → 直接踢出可用池
    } else {
      // error：算一次使用但不强制踢出（页面/网络问题，下次还能试）
      c.usedCount += 1;
      if (c.usedCount >= c.maxUses) c.status = 'exhausted';
    }
    scheduleFlush();
    return sanitize(c);
  });
}

function sanitize(c) {
  return {
    id: c.id,
    masked: `••••${c.last4}`,
    last4: c.last4,
    exp: `${c.expMonth}/${c.expYear}`,
    status: c.status,
    maxUses: c.maxUses,
    usedCount: c.usedCount,
    remaining: Math.max(0, c.maxUses - c.usedCount),
    successCount: c.successCount,
    declineCount: c.declineCount,
    firstUsedAt: c.firstUsedAt || '',
    lastUsedAt: c.lastUsedAt || '',
    lastResult: c.lastResult || '',
    lastError: c.lastError || '',
    inUse: !!c.inUse,
  };
}

/** 脱敏快照（供 UI / SSE）。 */
function snapshot() {
  ensureLoaded();
  return Array.from(POOL.values()).map(sanitize);
}

function setStatus(id, status) {
  return mutex(() => {
    ensureLoaded();
    const c = POOL.get(id);
    if (!c) return null;
    c.status = status;
    scheduleFlush();
    return sanitize(c);
  });
}

/** 手动禁用（从可用池剔除）。 */
function disable(id) { return setStatus(id, 'disabled'); }

/** 手动启用（恢复 active；若已用满则恢复为 exhausted）。 */
function enable(id) {
  return mutex(() => {
    ensureLoaded();
    const c = POOL.get(id);
    if (!c) return null;
    c.status = c.usedCount >= c.maxUses ? 'exhausted' : 'active';
    scheduleFlush();
    return sanitize(c);
  });
}

/** 调整某张卡的最大可用次数（按实际情况动态调，不写死）。 */
function setMaxUses(id, n) {
  return mutex(() => {
    ensureLoaded();
    const c = POOL.get(id);
    if (!c) return null;
    c.maxUses = Math.max(1, Number(n) || 1);
    if (c.status === 'exhausted' && c.usedCount < c.maxUses) c.status = 'active';
    else if (c.status === 'active' && c.usedCount >= c.maxUses) c.status = 'exhausted';
    scheduleFlush();
    return sanitize(c);
  });
}

/** 重置某张卡的使用计数/状态（重新可用）。 */
function resetCounters(id) {
  return mutex(() => {
    ensureLoaded();
    const c = POOL.get(id);
    if (!c) return null;
    Object.assign(c, freshCounters(), { inUse: false });
    scheduleFlush();
    return sanitize(c);
  });
}

/** 从卡池删除某张卡。 */
function remove(id) {
  return mutex(() => {
    ensureLoaded();
    const existed = POOL.delete(id);
    scheduleFlush();
    return existed;
  });
}

/** 清空整个卡池。 */
function clear() {
  return mutex(() => {
    ensureLoaded();
    POOL.clear();
    scheduleFlush();
    return true;
  });
}

/** 当前可用卡数（active 且有剩余次数）。 */
function availableCount() {
  ensureLoaded();
  let n = 0;
  for (const c of POOL.values()) if (c.status === 'active' && c.usedCount < c.maxUses) n += 1;
  return n;
}

module.exports = {
  parseCardLines,
  upsertMany,
  acquire,
  report,
  snapshot,
  disable,
  enable,
  setMaxUses,
  resetCounters,
  remove,
  clear,
  availableCount,
  _POOL_FILE: POOL_FILE,
};
