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
const { envInt, envFloat } = require('./env-tunables');

const POOL_FILE = path.join(__dirname, '..', 'data', 'card-pool.json');
const LOCK_FILE = POOL_FILE + '.lock';
const mutex = createMutex();

/** @type {Map<string, object>} id -> card */
let POOL = null;
let loadedMtimeMs = -1; // 上次读到的磁盘 mtime;变化 = 被外部(Python 流水线)改过 → 需重读

// ── 持久化（卡池文件同时被 Python selenium 流水线直接写盘，故读按 mtime 失效重读、写在跨进程锁内）──
function _diskMtime() {
  try { return fs.statSync(POOL_FILE).mtimeMs; } catch (_e) { return -1; }
}

/** 从磁盘读入 POOL。保留进程内 inUse 占用标记（acquire 设置、report 清除，盘上不持久），避免重读冲掉在途占用。 */
function _readFromDisk() {
  const prevInUse = new Set();
  if (POOL) for (const c of POOL.values()) if (c.inUse) prevInUse.add(c.id);
  const next = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      for (const c of arr) {
        if (!c) continue;
        const k = c.id || c.number;          // 缺 id 用卡号兜底当 key(否则该卡被静默丢弃 → 卡池数量莫名变少)
        if (!k) continue;                    // 既无 id 又无 number 才真的没法存
        if (!c.id) c.id = c.number;          // 就地补 id(随下次 _writeNow 落盘自愈)
        if (next.has(k)) {                   // 重复 key:不静默覆盖(否则两张折叠成一张),保留两张 + 告警
          try { console.warn(`[card-pool] 重复卡 key=${k}(••${String(c.last4 || c.number || '').slice(-4)})→ 用卡号区分,不折叠`); } catch (_e) { /* ignore */ }
          const alt = (c.number && c.number !== k) ? c.number : `${k}#dup`;
          c.inUse = prevInUse.has(alt); next.set(alt, c); continue;
        }
        c.inUse = prevInUse.has(c.id); next.set(k, c);
      }
    }
  } catch (_e) { /* 文件不存在/损坏 → 空池 */ }
  POOL = next;
  loadedMtimeMs = _diskMtime();
}

/** 读路径用：首次或磁盘被外部改过 → 重读;否则用内存缓存（避免每次读盘）。 */
function ensureLoaded() {
  if (POOL === null) { _readFromDisk(); return; }
  if (_diskMtime() !== loadedMtimeMs) _readFromDisk(); // Python 写过 → 实时刷新
}

/** 原子写回（tmp + rename），并记录我们写入后的 mtime（免得自己的写被下次 ensureLoaded 误判为外部改动）。 */
function _writeNow() {
  fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
  const arr = Array.from(POOL.values()).map(({ inUse, ...rest }) => rest); // 不落 inUse
  const tmp = `${POOL_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
  fs.renameSync(tmp, POOL_FILE);
  loadedMtimeMs = _diskMtime();
}

// ── 跨进程文件锁（与 Python common/base.py _FileLock 同款 <file>.lock / O_EXCL）────────────
//    让 Node 的卡池读-改-写不覆盖 Python 并发写入。退化策略【对齐 Python】:锁还新(活持有者)=继续等到它变陈旧
//    (绝不退化无锁,否则会丢 Python 刚写的禁卡/计数增量);锁陈旧才清掉重抢;连锁龄都判不了才退化无锁(不阻塞)。
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function _acquireFileLock(timeoutMs = 20000) {
  const staleMs = (Number(process.env.FILELOCK_STALE_SEC) || 30) * 1000;
  let end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.openSync(LOCK_FILE, 'wx'); // O_CREAT|O_EXCL|O_WRONLY:存在即失败
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') return null; // 异常 → 退化无锁
      if (Date.now() > end) {
        let age = null;
        try { age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs; } catch (_e) { age = null; }
        if (age !== null && age > staleMs) {
          try { fs.unlinkSync(LOCK_FILE); } catch (_e2) { /* 别人已删 */ }   // 真·陈旧锁(mtime 校验过)→ 清掉
          end = Date.now() + Math.min(timeoutMs, 2000); await _sleep(20); continue;   // 给窗口重抢
        }
        if (age !== null) {
          // 锁还新=活持有者:不退化无锁(会丢禁卡/计数增量),把 deadline 延到它变陈旧那刻继续等(对齐 Python base.py)。
          // lockfile mtime 不变、age 只增 → 必在 stale 处收敛,不会无限等;正常 RMW 是毫秒级。
          end = Date.now() + Math.max(500, staleMs - age) + 500; await _sleep(50); continue;
        }
        return null; // 连 mtime 都取不到(lockfile 恰被别进程删)→ 退化无锁(不阻塞主流程)
      }
      await _sleep(25);
    }
  }
}
function _releaseFileLock(fd) {
  if (fd == null) return;
  try { fs.closeSync(fd); } catch (_e) { /* */ }
  try { fs.unlinkSync(LOCK_FILE); } catch (_e) { /* */ }
}
/** 写操作统一入口：跨进程锁内【重读最新盘 → 应用变更 fn() → 原子写回】，杜绝覆盖 Python 的并发写。 */
async function lockedWrite(fn) {
  const fd = await _acquireFileLock();
  // REL-9:拿不到锁会退化【无锁】读-改-写(不阻塞主流程是有意的),但与 Python 并发时可能丢 usedCount/successCount 增量
  // → 至少告警让运维可见(锁长期拿不到多半是有进程卡死占锁)。
  if (fd == null) { try { console.warn('[card-pool] 文件锁获取失败 → 本次卡池写入【无锁】进行(与 Python 并发时有丢计数风险)'); } catch (_e) { /* ignore */ } }
  try {
    _readFromDisk();      // 锁内拿到 Python 的最新状态(禁卡/冷却/用量)
    const r = fn();       // 在最新数据上应用本次变更
    _writeNow();          // 锁内立即原子落盘
    return r;
  } finally {
    _releaseFileLock(fd);
  }
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
 *   4111 1111 1111 1111  02/29  093
 *   4111111111111111|05/30|130
 *   4111111111111111,04/31,164          （可选尾部 |次数|邮编）
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
    usedCount: 0, successCount: 0, declineCount: 0, errorCount: 0, captchaCount: 0,
    status: 'active', firstUsedAt: '', lastUsedAt: '', lastResult: '', lastError: '',
  };
}

/**
 * 合并导入：新卡入池，已存在(同指纹)的保留历史计数，仅更新 maxUses/zip/密文。
 * @returns {Promise<{added:number, updated:number, errors:Array}>}
 */
function upsertMany(cards) {
  return mutex(() => lockedWrite(() => {
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
    return { added, updated, errors };
  }));
}

/**
 * 取一张可用卡（active 且 usedCount<maxUses 且未被占用），置 inUse 返回完整密文；无则 null。
 * @returns {Promise<object|null>}
 */
function acquire() {
  return mutex(() => {
    ensureLoaded();
    const nowIso = new Date().toISOString();
    const _cooled = (c) => !!(c.cooldownUntil && c.cooldownUntil > nowIso); // ISO 带 Z,字典序可比(对齐 Selenium common.py _cooled)
    const usable = (c) => c.status === 'active' && c.usedCount < c.maxUses && !c.inUse;
    const _take = (c) => { c.inUse = true; return { id: c.id, last4: c.last4, number: c.number, expMonth: c.expMonth, expYear: c.expYear, cvc: c.cvc, zip: c.zip, maxUses: c.maxUses, usedCount: c.usedCount }; };
    // ① 优先没在冷却的可用卡
    for (const c of POOL.values()) { if (usable(c) && !_cooled(c)) return _take(c); }
    // ② 全在冷却 → 退回挑 cooldownUntil 最早到期的(别因都在冷却就阻塞;对齐 Selenium load_card 兜底)
    const cooled = Array.from(POOL.values()).filter(usable).sort((a, b) => String(a.cooldownUntil || '').localeCompare(String(b.cooldownUntil || '')));
    if (cooled.length) return _take(cooled[0]);
    return null;
  });
}

/**
 * 按 id 取某张卡的完整密文（供「手动选卡填入」：用户已显式点选，不受 active/inUse 约束）。
 * 标记 inUse=true，结果由 report() 回报后清除。
 * @param {string} id
 * @returns {Promise<object|null>}
 */
function getFull(id) {
  return mutex(() => {
    ensureLoaded();
    const c = POOL.get(id);
    if (!c) return null;
    c.inUse = true;
    return { id: c.id, last4: c.last4, number: c.number, expMonth: c.expMonth, expYear: c.expYear, cvc: c.cvc, zip: c.zip, maxUses: c.maxUses, usedCount: c.usedCount };
  });
}

/**
 * 回报一次使用结果，更新计数/状态/时间并落盘。
 * @param {string} id
 * @param {{result:'success'|'declined'|'error', error?:string}} outcome
 */
function report(id, outcome) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    // 锁内重读后卡不在池(被另一进程删/换 id)→ 本次 success/declined 计数会丢(卡可能被超额复用、坏卡不被禁)→ 必须可观测
    if (!c) { try { console.error(`[card-pool] report: 卡 ${id} 锁内重读后已不在池中 → 本次结果(${(outcome && outcome.result) || 'error'})未计入`); } catch (_e) { /* */ } return null; }
    const now = new Date().toISOString();
    c.inUse = false;
    c.lastUsedAt = now;
    if (!c.firstUsedAt) c.firstUsedAt = now;
    const result = outcome && outcome.result;
    c.lastResult = result || 'error';
    c.lastError = (outcome && outcome.error) ? String(outcome.error).slice(0, 200) : '';
    if (result === 'success') {
      c.usedCount += 1; c.successCount += 1;
      c.declineCount = 0; c.errorCount = 0; delete c.cooldownUntil; // 绑成清账(好卡不被环境declined误累计;对齐 common.py:655-662)
      if (c.usedCount >= c.maxUses) c.status = 'exhausted';
    } else if (result === 'bound') {
      // 仅加卡(未扣费)：不消耗付款次数，保持可用，仅更新时间/结果。绑成同样清 declined 账。
      c.lastResult = 'bound';
      c.declineCount = 0; c.errorCount = 0; delete c.cooldownUntil;
    } else if (result === 'declined') {
      // declined 多是环境因素(AVS/ZIP·IP)→ 单次只【冷却不禁卡】;累到阈值(多会话都拒=真坏卡)才禁。对齐 common.py:663-679。
      c.declineCount += 1;
      if (c.declineCount >= envInt('CARD_DECLINE_DISABLE_AT', 2)) {
        c.status = 'disabled'; c.disabledReason = 'declined'; c.disabledAt = now; // ★禁用写 'disabled'(不是 'declined'),与 Selenium 一致
      } else {
        const mins = envFloat('CARD_DECLINE_COOLDOWN_MIN', 30);
        c.cooldownUntil = new Date(Date.now() + mins * 60000).toISOString(); // status 保持 'active',只冷却
      }
    } else {
      // error / 超时(BILLING_FLOW_TIMEOUT) / 页面关闭 / 没出现账单弹窗：
      // 卡并未真正提交给 Stripe 判定（流程没走到付款，或页面中途断了），
      // 不算一次用量、保持 active，下次还能用这张卡再试。
      // （只更新 lastResult/lastError——已在上面设置——计数与状态不变）
    }
    return sanitize(c);
  }));
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
    cooldownUntil: c.cooldownUntil || '',
    disabledReason: c.disabledReason || '',
    inUse: !!c.inUse,
  };
}

/** 脱敏快照（供 UI / SSE）。 */
function snapshot() {
  ensureLoaded();
  return Array.from(POOL.values()).map(sanitize);
}

function setStatus(id, status) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    if (!c) return null;
    c.status = status;
    return sanitize(c);
  }));
}

/** 手动禁用（从可用池剔除）。 */
function disable(id) { return setStatus(id, 'disabled'); }

/** 跨节点派发：把卡下发给子机后,在中心机冻结为 'dispatched'（不被 acquire/availableCount 选中,
 *  也不会下次再发);手动 enable() 可解冻回 active/exhausted。状态机里非 'active' 即视为不可用,
 *  故无需改 acquire/availableCount。 */
function markDispatched(id, toNode) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    if (!c) return null;
    c.status = 'dispatched';
    // ★下发成功=把这张卡的剩余额度整笔交给子机刷,本机视作"已用满":日后手动 enable() 只会回到
    //   'exhausted'(非 active),杜绝"中心机 enable 回来又本机重刷同一张已在子机刷的卡"=同卡多机重复扣款。
    //   失败下发的卡走 releaseDispatch() 解冻、usedCount 原样不动(没在任何机器上刷过 → 全额可用)。
    c.usedCount = c.maxUses;
    c.disabledReason = toNode ? `dispatched→${String(toNode).slice(0, 40)}` : 'dispatched';
    c.dispatchedAt = new Date().toISOString();
    c.inUse = false;
    return sanitize(c);
  }));
}

/** 跨节点派发【原子预留】:在单次文件锁内挑出最多 n 张可用卡并【就地冻结为 dispatched】,返回 [{id,line}]。
 *  挑选与冻结原子完成(同一把锁)→ 杜绝旧"exportActiveLines 快照 → 网络下发 → markDispatched 冻结"之间的窗口里
 *  被本机 acquire()/另一次并发派发重复选中(同卡多机刷 = 重复扣款)。usedCount 此刻【不动】(还没真正下发成功);
 *  下发成功由 markDispatched() 计满,下发失败由 releaseDispatch() 解冻还原。n<=0 视为不限(取全部可用)。 */
function reserveForDispatch(n) {
  const lim = n > 0 ? n : Infinity;
  return mutex(() => lockedWrite(() => {
    const out = [];
    for (const c of POOL.values()) {
      if (out.length >= lim) break;
      if (c.status === 'active' && c.usedCount < c.maxUses && !c.inUse) {
        c.status = 'dispatched';
        c.disabledReason = 'dispatched(reserved)';
        c.dispatchedAt = new Date().toISOString();
        c.inUse = false;
        out.push({ id: c.id, line: `${c.number}|${c.expMonth}/${c.expYear}|${c.cvc}` + (c.zip ? `|${c.zip}` : '') });
      }
    }
    return out;
  }));
}

/** 解冻一张【预留但未成功下发】的卡:仅当它仍是 'dispatched'(没被别处禁用/重置)才还原为 active/exhausted。
 *  usedCount 不动 → 没在任何机器刷过的卡全额回到可用池,不丢卡也不误计。 */
function releaseDispatch(id) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    if (!c) return null;
    if (c.status !== 'dispatched') return sanitize(c);   // 已被别处改了状态 → 不擅自动它
    c.status = c.usedCount >= c.maxUses ? 'exhausted' : 'active';
    c.disabledReason = '';
    delete c.dispatchedAt;
    return sanitize(c);
  }));
}

/** 手动启用（恢复 active；若已用满则恢复为 exhausted）。 */
function enable(id) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    if (!c) return null;
    c.status = c.usedCount >= c.maxUses ? 'exhausted' : 'active';
    return sanitize(c);
  }));
}

/** 调整某张卡的最大可用次数（按实际情况动态调，不写死）。 */
function setMaxUses(id, n) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    if (!c) return null;
    c.maxUses = Math.max(1, Number(n) || 1);
    if (c.status === 'exhausted' && c.usedCount < c.maxUses) c.status = 'active';
    else if (c.status === 'active' && c.usedCount >= c.maxUses) c.status = 'exhausted';
    return sanitize(c);
  }));
}

/** 重置某张卡的使用计数/状态（重新可用）。 */
function resetCounters(id) {
  return mutex(() => lockedWrite(() => {
    const c = POOL.get(id);
    if (!c) return null;
    Object.assign(c, freshCounters(), { inUse: false });
    return sanitize(c);
  }));
}

/** 从卡池删除某张卡。 */
function remove(id) {
  return mutex(() => lockedWrite(() => {
    const existed = POOL.delete(id);
    return existed;
  }));
}

/** 清空整个卡池。 */
function clear() {
  return mutex(() => lockedWrite(() => {
    POOL.clear();
    return true;
  }));
}

/** 跨节点派发用:导出所有"可用"卡(active 且有剩余次数)的完整可导入行 + id。
 *  只读,不改 inUse/状态(派发失败时不会把卡误锁;真正下发成功后由 markDispatched 冻结)。 */
function exportActiveLines() {
  ensureLoaded();
  const out = [];
  for (const c of POOL.values()) {
    if (c.status === 'active' && c.usedCount < c.maxUses && !c.inUse) {
      out.push({ id: c.id, line: `${c.number}|${c.expMonth}/${c.expYear}|${c.cvc}` + (c.zip ? `|${c.zip}` : '') });
    }
  }
  return out;
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
  getFull,
  report,
  snapshot,
  exportActiveLines,
  reserveForDispatch,
  releaseDispatch,
  disable,
  markDispatched,
  enable,
  setMaxUses,
  resetCounters,
  remove,
  clear,
  availableCount,
  _POOL_FILE: POOL_FILE,
};
