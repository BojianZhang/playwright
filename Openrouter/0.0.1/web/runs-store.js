'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 运行历史台账 — Openrouter / web / runs-store
//
// 文件定位：Openrouter/0.0.1/web/runs-store.js
//
// 补「无 job 级汇总」的洞:每次提交任务记一条 running,job 跑完(runJob 返回 summary)更新为 finished。
// 落盘 data/runs.json(节点本地运行态,与 accounts.json 等同处理,已加进 .gitignore)。
// 零依赖、CommonJS。单进程内用内存数组做真相源 + 同步原子写(tmp+rename),无 read-modify-write 交错。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { readJsonOr } = require('./json-safe');

const RUNS_FILE = path.join(__dirname, '..', 'data', 'runs.json');
const CAP = Number(process.env.OPENROUTER_RUNS_CAP) || 500; // 最多保留多少条(超出丢最旧)

let _runs = null; // 内存缓存(首次访问时从盘加载)

function _load() {
  if (_runs) return _runs;
  const arr = readJsonOr(RUNS_FILE, [], 'runs-store');   // ★H4:解析失败先备份 .corrupt 再退空,绝不被下次写入抹掉
  _runs = Array.isArray(arr) ? arr : [];
  return _runs;
}

function _persist() {
  try {
    fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
    const tmp = RUNS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_runs));
    fs.renameSync(tmp, RUNS_FILE); // 原子替换,避免半写文件
  } catch (e) { try { console.error('[runs-store] 落盘失败(内存仍有,盘上状态可能短暂滞后):', e && e.message); } catch (_e) { /* ignore */ } }   // REL-6:不再静默
}

// 提交任务时登记一条 running。
function start(rec) {
  const runs = _load();
  const row = {
    jobId: rec.jobId,
    nodeId: rec.nodeId || '',
    engine: rec.engine || 'playwright',
    status: 'running',
    startedAt: rec.startedAt || Date.now(),
    finishedAt: null,
    durationMs: null,
    total: rec.total || 0,
    success: 0,
    failed: 0,
    resumedFrom: rec.resumedFrom || null, // 续跑来源 jobId(普通提交为 null)
    params: rec.params || {},
    failureStats: null,
    error: null,
  };
  runs.unshift(row); // 最新在前
  if (runs.length > CAP) {
    // 优先淘汰最旧的"已终态"行,保留仍 running 的:否则长跑 job 被挤出数组后,
    // finish/fail 找不到行 → 该次运行永远停在 'running' 不落终态。
    for (let i = runs.length - 1; i >= 0 && runs.length > CAP; i--) {
      if (runs[i].status !== 'running') runs.splice(i, 1);
    }
    if (runs.length > CAP) runs.length = CAP; // 极端:running 行就超 CAP(罕见),只能硬截
  }
  _persist();
  return row;
}

// runJob 返回 summary={jobId,total,success,failed,failureStats,durationMs} → 更新为 finished。
function finish(jobId, summary) {
  const runs = _load();
  const row = runs.find((r) => r.jobId === jobId);
  if (!row) return null;
  const s = summary || {};
  row.status = 'finished';
  row.finishedAt = Date.now();
  row.durationMs = s.durationMs != null ? s.durationMs : (row.startedAt ? row.finishedAt - row.startedAt : null);
  if (s.total != null) row.total = s.total;
  row.success = s.success || 0;
  row.failed = s.failed || 0;
  row.failureStats = s.failureStats || null;
  // 结果对账(split 尤其):有结果但不足总数→标 partial,历史页显「⚠ 未完整 N%」,提示可续跑补齐。
  if (s.completenessPct != null) row.completenessPct = s.completenessPct;
  if (s.partial) row.partial = true;
  _persist();
  return row;
}

// job 抛异常终止 → 标 error(尽量保留已知计数)。
function fail(jobId, err) {
  const runs = _load();
  const row = runs.find((r) => r.jobId === jobId);
  if (!row) return null;
  row.status = 'error';
  row.finishedAt = Date.now();
  row.durationMs = row.startedAt ? row.finishedAt - row.startedAt : null;
  row.error = String((err && err.message) || err || 'unknown').slice(0, 200);
  _persist();
  return row;
}

// 启动时回收僵尸 running:跑任务的子进程由 server 派生,server 一旦重启/崩过,
// 这些子进程必然已死 —— 残留的 running 行不可能还在跑,标成 interrupted(中断),
// 否则控制台「运行历史/总览」会永远显示假「运行中」,且让人误以为数据还在跑。
function reapStale() {
  const runs = _load();
  let n = 0;
  for (const r of runs) {
    if (r.status === 'running') {
      r.status = 'interrupted';
      r.finishedAt = Date.now();
      r.durationMs = r.startedAt ? r.finishedAt - r.startedAt : null;
      r.error = '进程中断(服务重启/崩溃),未跑完 —— 重新提交同一批账号即可断点续跑';
      n++;
    }
  }
  if (n) _persist();
  return n;
}

function list(limit) {
  const runs = _load();
  const n = Number(limit) || 50;
  return runs.slice(0, n);
}

function get(jobId) {
  return _load().find((r) => r.jobId === jobId) || null;
}

function clear() {
  _runs = [];
  _persist();
  return true;
}

module.exports = { start, finish, fail, reapStale, list, get, clear, _RUNS_FILE: RUNS_FILE };
