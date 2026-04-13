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

function padRight(value, width) {
  const text = String(value || '');
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function fitValue(value, width) {
  const text = String(value || '');
  if (text.length <= width) return padRight(text, width);
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function color(text, code) {
  return `${code}${text}[0m`;
}

function colorStatus(status, text) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'idle') return color(text, '[90m');
  if (normalized.includes('success')) return color(text, '[32m');
  if (normalized.includes('fail') || normalized.includes('exception')) return color(text, '[31m');
  if (normalized.includes('running')) return color(text, '[36m');
  return text;
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
  const header = color(`WORKER_OVERVIEW | total=${snapshot.length} | running=${running} | idle=${idle} | success=${success} | failed=${failed}`, '[1m[97m');
  const divider = color('-'.repeat(140), '[90m');
  const title = color([
    padRight('WK', 4),
    padRight('STATUS', 20),
    padRight('ACCOUNT', 28),
    padRight('STAGE', 28),
    padRight('STEP', 28),
    padRight('TRY', 6),
    padRight('STAGE_ELAPSED', 14),
    padRight('TOTAL', 10),
  ].join(' | '), '[1m');
  const lines = snapshot.map(item => {
    const workerText = fitValue(`#${item.workerId}`, 4);
    const statusText = colorStatus(item.status || 'idle', fitValue(item.status || 'idle', 20));
    const accountText = fitValue(item.account || '-', 28);
    const stageText = fitValue(item.stage || '-', 28);
    const stepText = fitValue(item.step || '-', 28);
    const tryText = fitValue(item.attempt ? String(item.attempt) : '0', 6);
    const stageElapsedText = fitValue(formatDurationMs(item.stageDurationMs), 14);
    const totalText = fitValue(formatDurationMs(item.totalDurationMs), 10);
    const base = [workerText, statusText, accountText, stageText, stepText, tryText, stageElapsedText, totalText].join(' | ');
    if (item.lastReason) {
      return `${base} | ${color(`reason=${fitValue(item.lastReason, 40)}`, '[90m')}`;
    }
    return base;
  });
  return [header, divider, title, divider, ...lines, divider];
}

module.exports = {
  updateWorkerStatus,
  markWorkerIdle,
  snapshotWorkerStatuses,
  buildWorkerStatusLines,
  buildWorkerOverviewPanel,
  formatDurationMs,
  padRight,
  fitValue,
};
