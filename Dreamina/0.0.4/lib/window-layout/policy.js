'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-window-layout
//
// 文件定位：shared-window-layout/policy.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 按并发数量计算不同的重试策略与代理轮换等 Policy。
// ❌ 不负责 —— 页面 UI 位置渲染计算等布局管理。
// ❌ 不负责 —— 实际的 API 请求处理和代理调度机制。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 按并发规模智能解析策略。如果找不到 exact key，将自动降级选用合适的范围策略或默认 fallback。
 *
 * @param {object} [table={}]
 * @param {number} [concurrency=1]
 * @param {object} [fallback={}]
 * @returns {object}
 */
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

/**
 * 解析并生成 Firstmail / API 操作预算与延时策略。
 *
 * @param {object|null} [profile=null]
 * @param {number} [concurrency=1]
 * @returns {object}
 */
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

/**
 * 解析并生成本地代理策略与探活阈值。
 *
 * @param {object|null} [profile=null]
 * @param {number} [concurrency=1]
 * @returns {object}
 */
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
