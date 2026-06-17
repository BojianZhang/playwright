'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 坏邮箱管理 store — Openrouter / web / bad-mailbox-store.js
//
// 读写 Python 所有的 selenium-e2e/state/ 下两份账本:
//   · bad_mailboxes.json        email|@domain → {reason, at}   (run.py/hybrid 据此永久跳过)
//   · mailbox_verify_fails.json email → {count, last_at, last_reason}  (软坏累计,未达阈值)
//
// ★写入用【与 Python common/base.py _FileLock 同款 <file>.lock / O_EXCL】跨进程锁,
//   防 run.py 正在登记坏邮箱时 web 这边写入互相覆盖。读用 try/catch 容错(对齐 Python load_*)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');   // 损坏先备份 .corrupt 再退默认(H4 模式),写路径用,绝不静默用 {} 覆盖

const SELENIUM_DIR = path.join(__dirname, '..', 'selenium-e2e');
const STATE_DIR = path.join(SELENIUM_DIR, 'state');
const BAD_FILE = path.join(STATE_DIR, 'bad_mailboxes.json');
const SOFT_FILE = path.join(STATE_DIR, 'mailbox_verify_fails.json');

// ── 容错读(文件缺失/损坏/空 → {},对齐 Python load_bad_mailboxes 的 except → {}) ──
function _readObj(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const o = txt ? JSON.parse(txt) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_e) {
    return {};
  }
}

// ── 跨进程文件锁(与 billing/card-pool.js / Python _FileLock 同款 <file>.lock·O_EXCL) ──
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function _acquireFileLock(lockFile, timeoutMs = 20000) {
  const staleMs = (Number(process.env.FILELOCK_STALE_SEC) || 30) * 1000;
  let end = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.openSync(lockFile, 'wx'); // O_CREAT|O_EXCL|O_WRONLY:存在即失败
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') return null;
      if (Date.now() > end) {
        let age = null;
        try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch (_e) { age = null; }
        if (age !== null && age > staleMs) {
          try { fs.unlinkSync(lockFile); } catch (_e2) { /* 别人已删 */ }
          end = Date.now() + Math.min(timeoutMs, 2000); await _sleep(20); continue;
        }
        if (age !== null) { end = Date.now() + Math.max(500, staleMs - age) + 500; await _sleep(50); continue; }
        return null;
      }
      await _sleep(25);
    }
  }
}
function _releaseFileLock(lockFile, fd) {
  if (fd == null) return;
  try { fs.closeSync(fd); } catch (_e) { /* */ }
  try { fs.unlinkSync(lockFile); } catch (_e) { /* */ }
}
async function _lockedWrite(file, fn) {
  const lockFile = file + '.lock';
  const fd = await _acquireFileLock(lockFile);
  if (fd == null) {
    // ★拿不到锁就【不写】:原先「无锁照写」会与 Python run.py 并发互相覆盖、丢坏邮箱登记 → 返回失败让上层上报、用户重试。
    try { console.error('[bad-mailbox] 文件锁获取超时 → 跳过本次写(避免与 Python 并发互相覆盖,请稍后重试):', path.basename(file)); } catch (_e) { /* */ }
    return { __lockFailed: true };
  }
  try {
    // 锁内重读最新盘(拿到 Python 刚写的增量)。用 readJsonOr:文件损坏先备份 .corrupt 再退默认,
    // 不再「静默返回 {} → 下一步把好数据(损坏前的)整盘覆盖成空」。锁保证此刻无并发写者(Python 同款 .lock),
    // 读到的一定是完整文件,不会误判 Python 半写为损坏。
    const o = readJsonOr(file, {}, 'bad-mailbox-store');
    const d = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    const r = fn(d);                   // 应用变更
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, file);          // 原子写回
    return { __ok: true, r };
  } finally {
    _releaseFileLock(lockFile, fd);
  }
}

// ── 归类 reason → 类型(给前端徽章/筛选) ──
function _reasonType(key, reason) {
  const r = String(reason || '').toLowerCase();
  if (String(key || '').startsWith('@')) return r.includes('domain-auto') ? 'domain-auto' : 'manual-domain';
  if (r.startsWith('no-verify-mail')) return 'soft';
  if (r.includes('domain-auto')) return 'domain-auto';
  if (r.includes('401') || r.includes('bad-credentials')) return 'hard401';
  if (r.includes('404') || r.includes('mailbox-404')) return 'hard404';
  if (r === 'manual' || r === '') return 'manual';
  return 'other';
}

function _domainOf(key) {
  const s = String(key || '');
  if (s.startsWith('@')) return s;
  if (s.includes('@')) return '@' + s.split('@', 2)[1];
  return '';
}

// ── 规范化输入:邮箱原样 / @域原样 / 裸域→补 @ ──
function _normEntry(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('@')) return s;
  if (s.includes('@')) return s;
  return '@' + s;                       // 裸域(无 @)→ 当整域
}
function _normDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@').pop();   // 'a@b.com' 或 '@b.com' → 'b.com'
  return '@' + s;
}

// ── 公开 API ──
function list() {
  const bad = _readObj(BAD_FILE);
  return Object.keys(bad).map((k) => {
    const info = bad[k] || {};
    return {
      key: k,
      email: k.startsWith('@') ? '' : k,
      domain: _domainOf(k),
      kind: k.startsWith('@') ? 'domain' : 'email',
      reason: info.reason || '',
      reasonType: _reasonType(k, info.reason),
      at: info.at || '',
    };
  });
}

function softfails() {
  const soft = _readObj(SOFT_FILE);
  const bad = _readObj(BAD_FILE);
  // 已升级成坏邮箱的不再算「即将拉黑」(理论上 Python 升级时不清 soft,故这里过滤掉已在 bad 的)
  return Object.keys(soft)
    .filter((em) => !(em in bad))
    .map((em) => {
      const r = soft[em] || {};
      return { email: em, domain: _domainOf(em), count: Number(r.count) || 0, lastAt: r.last_at || '', lastReason: r.last_reason || '' };
    });
}

function domainRollup() {
  const bad = _readObj(BAD_FILE);
  const soft = _readObj(SOFT_FILE);
  const map = new Map(); // domain → {domain, badCount, softCount, blocked}
  const get = (dom) => { if (!map.has(dom)) map.set(dom, { domain: dom, badCount: 0, softCount: 0, blocked: false }); return map.get(dom); };
  for (const k of Object.keys(bad)) {
    if (k.startsWith('@')) { get(k).blocked = true; continue; }       // 整域条目 → 标该域已拉黑
    const dom = _domainOf(k); if (dom) get(dom).badCount += 1;
  }
  for (const em of Object.keys(soft)) { if (em in bad) continue; const dom = _domainOf(em); if (dom) get(dom).softCount += 1; }
  return Array.from(map.values()).sort((a, b) => (b.badCount - a.badCount) || (b.softCount - a.softCount));
}

function stats() {
  const rows = list();
  const by = { hard404: 0, hard401: 0, soft: 0, manual: 0, 'manual-domain': 0, 'domain-auto': 0, other: 0 };
  for (const r of rows) by[r.reasonType] = (by[r.reasonType] || 0) + 1;
  const domains = domainRollup();
  return {
    total: rows.length,
    hard: by.hard404 + by.hard401,
    soft: by.soft,
    manual: by.manual + by['manual-domain'],
    domainsBlocked: rows.filter((r) => r.kind === 'domain').length,
    domainsAffected: domains.filter((d) => !d.blocked && d.badCount > 0).length,
    byType: by,
  };
}

async function add(rawEmailOrDomain, reason) {
  const key = _normEntry(rawEmailOrDomain);
  if (!key) return { ok: false, error: 'EMPTY' };
  const isDom = key.startsWith('@');
  const reasonFinal = reason || (isDom ? 'manual-domain' : 'manual');
  const w = await _lockedWrite(BAD_FILE, (d) => {
    if (!(key in d)) d[key] = { reason: reasonFinal, at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  });
  if (w && w.__lockFailed) return { ok: false, error: 'LOCK_TIMEOUT', key };
  return { ok: true, key };
}

async function remove(rawKey) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) return { ok: false, error: 'EMPTY' };
  const w = await _lockedWrite(BAD_FILE, (d) => { if (key in d) delete d[key]; });
  if (w && w.__lockFailed) return { ok: false, error: 'LOCK_TIMEOUT', key };
  return { ok: true, key };
}

async function blockDomain(rawDomain) {
  const dom = _normDomain(rawDomain);
  if (!dom || dom === '@') return { ok: false, error: 'EMPTY' };
  const w = await _lockedWrite(BAD_FILE, (d) => {
    if (!(dom in d)) d[dom] = { reason: 'manual-domain', at: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  });
  if (w && w.__lockFailed) return { ok: false, error: 'LOCK_TIMEOUT', key: dom };
  return { ok: true, key: dom };
}

async function unblockDomain(rawDomain) {
  const dom = _normDomain(rawDomain);
  if (!dom || dom === '@') return { ok: false, error: 'EMPTY' };
  const w = await _lockedWrite(BAD_FILE, (d) => { if (dom in d) delete d[dom]; });
  if (w && w.__lockFailed) return { ok: false, error: 'LOCK_TIMEOUT', key: dom };
  return { ok: true, key: dom };
}

async function clearSoftfail(rawEmail) {
  const em = String(rawEmail || '').trim().toLowerCase();
  if (!em) return { ok: false, error: 'EMPTY' };
  const w = await _lockedWrite(SOFT_FILE, (d) => { if (em in d) delete d[em]; });
  if (w && w.__lockFailed) return { ok: false, error: 'LOCK_TIMEOUT', email: em };
  return { ok: true, email: em };
}

function snapshot() {
  return { items: list(), softfails: softfails(), stats: stats(), domains: domainRollup() };
}

module.exports = {
  list, softfails, domainRollup, stats, snapshot,
  add, remove, blockDomain, unblockDomain, clearSoftfail,
  _paths: { BAD_FILE, SOFT_FILE, STATE_DIR },
};
