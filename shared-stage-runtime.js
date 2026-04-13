'use strict';

const { updateWorkerStatus } = require('./worker-status-tracker');

function syncStageStep(options = {}, patch = {}) {
  const context = options?.context || {};
  const workerId = context?.workerId ?? options?.runtime?.workerId ?? null;
  if (!workerId) return;
  updateWorkerStatus(workerId, {
    status: patch.status || 'running-register-stage',
    account: options?.account?.email || context?.account?.email || '',
    stage: patch.stage || '',
    step: patch.step || '',
    attempt: context?.attempt ?? options?.runtime?.attempt ?? 0,
    proxy: options?.proxy?.server || context?.proxy?.server || context?.proxySummary?.server || '',
    lastState: patch.lastState || '',
    lastReason: patch.lastReason || '',
  });
}

module.exports = {
  syncStageStep,
};
