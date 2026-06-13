'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 在跑子进程登记表 — Openrouter / web / proc-registry
//
// 记录 spawn 出来的 Python 引擎子进程,供「停止」杀进程树(Python 还会拉 Playwright/Selenium/浏览器,必须杀树)。
// 零依赖、CommonJS。
// ═══════════════════════════════════════════════════════════════════════

const { spawn, spawnSync } = require('child_process');

// jobId -> { pids:Set<number>, engine, startedAt }
const _jobs = new Map();

function register(jobId, pid, engine) {
  if (!jobId || !pid) return;
  const j = _jobs.get(jobId) || { pids: new Set(), engine, startedAt: Date.now() };
  j.pids.add(pid);
  j.engine = engine || j.engine;
  _jobs.set(jobId, j);
}

function unregister(jobId, pid) {
  const j = _jobs.get(jobId);
  if (!j) return;
  if (pid) j.pids.delete(pid);
  if (!pid || j.pids.size === 0) _jobs.delete(jobId);
}

function has(jobId) { return _jobs.has(jobId); }

function list() {
  return [..._jobs.entries()].map(([jobId, j]) => ({ jobId, engine: j.engine, startedAt: j.startedAt, pids: [...j.pids] }));
}

// 是否还活着(跨平台:signal 0 不杀进程只探测)。
function _alive(pid) {
  try { process.kill(pid, 0); return true; } catch (_e) { return false; }  // ESRCH=不存在→false
}

// 杀单个进程树(win32: taskkill /T /F;unix: 进程组 SIGKILL,需 spawn 时 detached)。返回 true=确认已杀干净。
// 【B2 修】win 上原来 fire-and-forget spawn(taskkill),失败被静默吞 → Python+浏览器僵尸泄漏、stop() 假成功。
//   改 spawnSync 同步执行并查 status;失败(且进程仍在)用 PowerShell 兜底再杀一次,仍不行就告警(可观测)。
function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      // status 0=杀成功;128/进程不存在 也视作已没;其它非0且进程仍在 → PowerShell 兜底
      if ((r.status === 0) || !_alive(pid)) return true;
      const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`], { stdio: 'ignore', windowsHide: true });
      if ((ps.status === 0) || !_alive(pid)) return true;
      try { console.error(`[proc-registry] killTree pid=${pid} 未确认杀掉(taskkill status=${r.status})——可能残留僵尸进程`); } catch (_e) { /* ignore */ }
      return false;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch (_e) { try { process.kill(pid, 'SIGKILL'); } catch (_e2) { /* gone */ } }
    return !_alive(pid);
  } catch (_e) {
    return !_alive(pid);
  }
}

// 停止某 job 的所有子进程树。返回杀掉的 pid 列表。
function stop(jobId) {
  const j = _jobs.get(jobId);
  if (!j) return [];
  const pids = [...j.pids];
  for (const pid of pids) killTree(pid);
  _jobs.delete(jobId);
  return pids;
}

module.exports = { register, unregister, has, list, stop, killTree };
