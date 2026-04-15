'use strict';

function resolvePolicyByConcurrency(table = {}, concurrency = 1, fallback = {}) {
  const target = Math.max(1, Number(concurrency) || 1);
  const defaultPolicy = table.default && typeof table.default === 'object' ? table.default : fallback;
  const numericKeys = Object.keys(table)
    .filter(key => key !== 'default')
    .map(key => Number(key))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  let chosen = null;
  for (const value of numericKeys) {
    if (target >= value) chosen = value;
  }

  const picked = chosen !== null && table[String(chosen)] && typeof table[String(chosen)] === 'object'
    ? table[String(chosen)]
    : defaultPolicy;

  return {
    matchedConcurrency: chosen !== null ? chosen : 'default',
    ...defaultPolicy,
    ...picked,
  };
}

function resolveVerificationBudget(profile = null, concurrency = 1) {
  const table = profile?.verificationBudgetByConcurrency || {};
  const fallback = {
    firstmailApiMaxPollAttempts: 6,
    waitMailIntervalMs: 2500,
    verificationRetryMaxAttempts: 3,
    verificationResendWaitMs: 1800,
  };
  const picked = resolvePolicyByConcurrency(table, concurrency, fallback);
  return {
    matchedConcurrency: picked.matchedConcurrency,
    firstmailApiMaxPollAttempts: Number(picked.firstmailApiMaxPollAttempts || fallback.firstmailApiMaxPollAttempts || 6),
    waitMailIntervalMs: Number(picked.waitMailIntervalMs || fallback.waitMailIntervalMs || 2500),
    verificationRetryMaxAttempts: Number(picked.verificationRetryMaxAttempts || fallback.verificationRetryMaxAttempts || 3),
    verificationResendWaitMs: Number(picked.verificationResendWaitMs || fallback.verificationResendWaitMs || 1800),
  };
}

function resolveProxyPolicy(profile = null, concurrency = 1) {
  const table = profile?.proxyPolicyByConcurrency || {};
  const fallback = {
    workerStartStaggerMs: 0,
    connectivityTimeoutMs: 8000,
    primaryTargetTimeoutMs: 10000,
    secondaryTargetTimeoutMs: 8000,
    enableSecondaryTarget: true,
  };
  const picked = resolvePolicyByConcurrency(table, concurrency, fallback);
  return {
    matchedConcurrency: picked.matchedConcurrency,
    workerStartStaggerMs: Number(picked.workerStartStaggerMs || 0),
    connectivityTimeoutMs: Number(picked.connectivityTimeoutMs || fallback.connectivityTimeoutMs),
    primaryTargetTimeoutMs: Number(picked.primaryTargetTimeoutMs || fallback.primaryTargetTimeoutMs),
    secondaryTargetTimeoutMs: Number(picked.secondaryTargetTimeoutMs || fallback.secondaryTargetTimeoutMs),
    enableSecondaryTarget: Boolean(picked.enableSecondaryTarget),
  };
}

module.exports = {
  resolvePolicyByConcurrency,
  resolveVerificationBudget,
  resolveProxyPolicy,
};
