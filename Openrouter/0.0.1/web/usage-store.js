'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 资源使用记录 — Openrouter / web / usage-store.js
//
// 打通"账号 ↔ 它这次用了哪个代理/环境/卡/卡在哪步"的关联(诊断/排查的前提)。
// 每账号每次跑追加一条:{at,jobId,engine,email,host,exitIp,proxyId,cardLast4,envId,endpoint,stage,ok,reason}。
// append-only JSONL(data/usage.jsonl),封顶 CAP 行自动轮转。零依赖、CommonJS。
// 诚实边界:Node 引擎能记全 proxy/envId;Python 引擎 envId 由自动建环境产生,常取不到→留空。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'usage.jsonl');
const CAP = 20000;
const ROTATE_EVERY = 500; // 惰性轮转:每追加 N 条才查一次是否超 CAP,避免每条 record 都全量读+重写文件(O(n)/条)
let _sinceRotate = 0;

// 解析后的行按【文件 mtime+size】memo 缓存:诊断页 5s 轮询每次对同一目标调 byEmail/byCard/byProxy/byEnv,
// 各自一次 _readAll = readFileSync+逐行 JSON.parse 整个 usage.jsonl(封顶 2 万行≈5MB)→ 一个请求就 4 次全量扫,
// ×5s 轮询持续烧。所有写路径(recordMany 的 appendFileSync / _rotate 的 writeFileSync+rename / clear)都改文件
// size,故 mtime+size 没变即可安全复用(append 必涨 size,比低精度 mtime 更可靠)。返回的数组调用方只 filter/slice
// 不就地改,可共享同一引用。
let _cache = null; // { mtimeMs, size, rows }
function _readAll() {
  try {
    const st = fs.statSync(FILE);
    if (_cache && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size) return _cache.rows;
    const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
    _cache = { mtimeMs: st.mtimeMs, size: st.size, rows };
    return rows;
  } catch (_e) { return []; }  // 无文件/读失败 → 空(不缓存,下次重试)
}
function recordMany(entries) {
  if (!entries || !entries.length) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const lines = entries.map((e) => JSON.stringify({ at: e.at || Date.now(), ...e })).join('\n') + '\n';
    fs.appendFileSync(FILE, lines);
    _sinceRotate += entries.length;
    if (_sinceRotate >= ROTATE_EVERY) { _rotate(); _sinceRotate = 0; } // 文件上限稳定在 ~CAP+ROTATE_EVERY 行
  } catch (e) { try { console.error('[usage-store] 记录写入失败(诊断关联数据丢失):', e && e.message); } catch (_e) { /* ignore */ } }   // REL-12:不再静默
}
function record(entry) { recordMany([entry]); }
function _rotate() {
  try {
    const all = _readAll();
    if (all.length > CAP) {
      const keep = all.slice(-CAP);
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fs.renameSync(tmp, FILE);
      _cache = null;   // 轮转后显式清缓存(别只依赖 mtime+size 检测,防个别文件系统 rename 后 mtime 不变误用旧缓存,CACHE-4)
    }
  } catch (_e) { /* ignore */ }
}
function list(limit) { const all = _readAll(); return limit ? all.slice(-Number(limit)) : all; }
function byEmail(email) { const e = String(email || '').toLowerCase(); return _readAll().filter((r) => String(r.email || '').toLowerCase() === e); }
function byCard(last4) { const v = String(last4 || ''); return _readAll().filter((r) => String(r.cardLast4 || '') === v); }
function byProxy(idOrHostOrIp) { const v = String(idOrHostOrIp || ''); return _readAll().filter((r) => r.proxyId === v || r.host === v || r.exitIp === v); }
function byEnv(envId) { const v = String(envId || ''); return _readAll().filter((r) => String(r.envId || '') === v); }
function clear() { try { fs.writeFileSync(FILE, ''); } catch (_e) { /* */ } return true; }

module.exports = { record, recordMany, list, byEmail, byCard, byProxy, byEnv, clear, _FILE: FILE };
