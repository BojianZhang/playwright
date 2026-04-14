'use strict';

function createWorkerState(workerId, extra = {}) {
  return {
    workerId: Number(workerId) || 0,
    status: 'idle',
    stage: '',
    step: '',
    attempt: 0,
    account: null,
    proxy: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    totalElapsedMs: 0,
    stageElapsedMs: 0,
    detail: null,
    ...extra,
  };
}

function cloneWorkerState(state = {}) {
  return {
    ...state,
    account: state?.account || null,
    proxy: state?.proxy || null,
    detail: state?.detail || null,
  };
}

function updateWorkerState(state = {}, patch = {}) {
  const next = cloneWorkerState(state);
  Object.assign(next, patch || {});
  next.updatedAt = new Date().toISOString();
  return next;
}

function markWorkerRunning(state = {}, patch = {}) {
  const startedAt = patch?.startedAt || state?.startedAt || new Date().toISOString();
  return updateWorkerState(state, {
    status: 'running',
    startedAt,
    ...patch,
  });
}

function markWorkerIdle(state = {}, patch = {}) {
  return updateWorkerState(state, {
    status: 'idle',
    stage: '',
    step: '',
    account: null,
    proxy: null,
    stageElapsedMs: 0,
    detail: null,
    ...patch,
  });
}

function markWorkerDone(state = {}, patch = {}) {
  return updateWorkerState(state, {
    status: 'done',
    ...patch,
  });
}

function summarizeWorkerStates(states = []) {
  const list = Array.isArray(states) ? states : [];
  const summary = {
    total: list.length,
    idle: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const item of list) {
    const status = String(item?.status || '').trim().toLowerCase();
    if (status === 'running') summary.running += 1;
    else if (status === 'done') summary.done += 1;
    else if (status === 'failed') summary.failed += 1;
    else summary.idle += 1;
  }
  return summary;
}

module.exports = {
  createWorkerState,
  cloneWorkerState,
  updateWorkerState,
  markWorkerRunning,
  markWorkerIdle,
  markWorkerDone,
  summarizeWorkerStates,
};
