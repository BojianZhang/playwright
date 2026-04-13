'use strict';

const state = {
  workers: new Map(),
  startedAt: Date.now(),
};

function nowMs() {
  return Date.now();
}

function ensureWorker(workerId) {
  const key = Number(workerId || 0);
  if (!state.workers.has(key)) {
    state.workers.set(key, {
      workerId: key,
      status: 'idle',
      account: '',
      stage: '',
      step: '',
      attempt: 0,
      startedAt: nowMs(),
      updatedAt: nowMs(),
      stageStartedAt: 0,
      stageDurationMs: 0,
      totalDurationMs: 0,
      proxy: '',
      lastReason: '',
      lastState: '',
    });
  }
  return state.workers.get(key);
}

function updateWorkerStatus(workerId, patch = {}) {
  const worker = ensureWorker(workerId);
  const currentNow = nowMs();
  const nextStage = Object.prototype.hasOwnProperty.call(patch, 'stage') ? String(patch.stage || '').trim() : worker.stage;
  if (nextStage && nextStage !== worker.stage) {
    worker.stageStartedAt = currentNow;
    worker.stageDurationMs = 0;
  }
  Object.assign(worker, patch, { updatedAt: currentNow });
  worker.stage = nextStage;
  worker.totalDurationMs = worker.startedAt ? Math.max(0, currentNow - worker.startedAt) : 0;
  worker.stageDurationMs = worker.stageStartedAt ? Math.max(0, currentNow - worker.stageStartedAt) : 0;
  return { ...worker };
}

function markWorkerIdle(workerId) {
  return updateWorkerStatus(workerId, {
    status: 'idle',
    stage: '',
    step: '',
    account: '',
    attempt: 0,
    proxy: '',
  });
}

function snapshotWorkerStatuses() {
  const currentNow = nowMs();
  return Array.from(state.workers.values())
    .sort((a, b) => a.workerId - b.workerId)
    .map(worker => ({
      ...worker,
      totalDurationMs: worker.startedAt ? Math.max(0, currentNow - worker.startedAt) : 0,
      stageDurationMs: worker.stageStartedAt ? Math.max(0, currentNow - worker.stageStartedAt) : 0,
    }));
}

function formatDurationMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms)) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = (ms / 1000).toFixed(ms >= 10000 ? 0 : 1);
  return `${sec}s`;
}

function buildWorkerStatusLines() {
  const snapshot = snapshotWorkerStatuses();
  if (!snapshot.length) return ['[worker-status] no workers'];
  return snapshot.map(item => {
    return [
      `[worker=${item.workerId}]`,
      `status=${item.status || 'idle'}`,
      item.account ? `account=${item.account}` : '',
      item.stage ? `stage=${item.stage}` : '',
      item.step ? `step=${item.step}` : '',
      item.attempt ? `attempt=${item.attempt}` : '',
      item.proxy ? `proxy=${item.proxy}` : '',
      `stageElapsed=${formatDurationMs(item.stageDurationMs)}`,
      `totalElapsed=${formatDurationMs(item.totalDurationMs)}`,
      item.lastState ? `lastState=${item.lastState}` : '',
      item.lastReason ? `lastReason=${item.lastReason}` : '',
    ].filter(Boolean).join(' | ');
  });
}

function buildWorkerOverviewPanel() {
  const snapshot = snapshotWorkerStatuses();
  const running = snapshot.filter(item => String(item.status || '').includes('running')).length;
  const idle = snapshot.filter(item => String(item.status || '') === 'idle').length;
  const success = snapshot.filter(item => String(item.status || '') === 'success').length;
  const failed = snapshot.filter(item => /fail|exception/.test(String(item.status || ''))).length;
  const header = `WORKER_OVERVIEW | total=${snapshot.length} | running=${running} | idle=${idle} | success=${success} | failed=${failed}`;
  const lines = snapshot.map(item => {
    return [
      `#${item.workerId}`,
      item.status || 'idle',
      item.account ? item.account : '-',
      item.stage ? `stage=${item.stage}` : 'stage=-',
      item.step ? `step=${item.step}` : 'step=-',
      item.attempt ? `attempt=${item.attempt}` : 'attempt=0',
      `stage=${formatDurationMs(item.stageDurationMs)}`,
      `total=${formatDurationMs(item.totalDurationMs)}`,
      item.lastReason ? `reason=${item.lastReason}` : '',
    ].filter(Boolean).join(' | ');
  });
  return [header, ...lines];
}

module.exports = {
  updateWorkerStatus,
  markWorkerIdle,
  snapshotWorkerStatuses,
  buildWorkerStatusLines,
  buildWorkerOverviewPanel,
  formatDurationMs,
};
