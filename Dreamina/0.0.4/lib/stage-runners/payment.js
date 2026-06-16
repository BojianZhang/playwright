// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— S8 payment（收银台加卡支付）
//
// 文件定位：Dreamina/0.0.4/lib/stage-runners/payment.js
//
// 边界（BOUNDARY）：
// ✅ 负责 —— S8 阶段调度：入参校验、调用 adapter.runPayment、耗时统计、日志、归一化 StageResult。
// ✅ 负责 —— 失败时调用 adapter.classifyPaymentFailure 做语义分类。
// ❌ 不负责 —— 收银台页面操作/选择器/卡池/台账（由 S8-payment/payment-adapter.js 注入，
//              其内部调用 billing/card-pool + billing/card-fill + billing/billing-ledger）。
//
// 调用方：Dreamina-register.js 主链（registry.payment.run）。
// 约定：adapter.runPayment(page, runtime, context) → { ok, state, reason, detail?, billing? }
//   billing = { result, plan, amount, last4, cardId } 写入 result.detail.billing，供 S6 交付载荷使用。
// ═══════════════════════════════════════════════════════════════════════
'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../utils/stage-logger');
const { syncStageStep } = require('../utils/stage-runtime');

function resolveAdapterMethod(adapter, name) {
  if (!adapter || typeof adapter !== 'object') return null;
  const m = adapter[name];
  return typeof m === 'function' ? m : null;
}

function normalizePaymentStageResult(input = {}) {
  const success = Boolean(input.success);
  const state = String(input.state || 'UNKNOWN').trim();
  const reason = String(input.reason || state).trim();
  return {
    success,
    stage: 'payment',
    state,
    reason,
    nextStage: success ? String(input.nextStage || 'account-delivery').trim() : '',
    source: String(input.detectionSource || '').trim(),
    signalStrength: String(input.signalStrength || '').trim(),
    settleStage: String(input.settleStage || 'none').trim(),
    detectionSource: String(input.detectionSource || '').trim(),
    stateChanged: typeof input.stateChanged === 'boolean' ? input.stateChanged : null,
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    detail: input.detail && typeof input.detail === 'object' ? input.detail : null,
  };
}

async function runPaymentStage(options = {}) {
  const { page, adapter = {}, runtime = {}, context = {} } = options;
  const stageTimer = createStageTimer();

  const runPayment = resolveAdapterMethod(adapter, 'runPayment');
  const classifyPaymentFailure = resolveAdapterMethod(adapter, 'classifyPaymentFailure');

  if (!runPayment) {
    syncStageStep(options, { stage: 'payment', step: 'stage-fail' });
    logStageFail('payment', 'adapter 必需方法缺失', {
      context: buildStageLogContext(options),
      extra: 'missing=runPayment',
    });
    return normalizePaymentStageResult({
      success: false,
      state: 'PAYMENT_ADAPTER_METHOD_MISSING',
      reason: 'PAYMENT_ADAPTER_METHOD_MISSING',
      detail: { missingMethod: 'runPayment' },
    });
  }

  syncStageStep(options, { stage: 'payment', step: 'run-payment' });
  logStageProgress('payment', '收银台选卡 → 填卡 → 支付', {
    context: buildStageLogContext(options),
  });

  let outcome;
  try {
    outcome = await runPayment(page, runtime, context);
  } catch (err) {
    outcome = { ok: false, state: 'PAYMENT_EXCEPTION', reason: 'PAYMENT_EXCEPTION', detail: { error: String((err && err.message) || err) } };
  }

  const durationMs = stageTimer.elapsedMs();
  const detail = { ...(outcome && outcome.detail ? outcome.detail : {}), billing: outcome && outcome.billing ? outcome.billing : null, durationMs };

  if (outcome && outcome.ok) {
    syncStageStep(options, { stage: 'payment', step: 'stage-success' });
    logStageSuccess('payment', '加卡支付完成', {
      context: buildStageLogContext(options),
      extra: [outcome.state ? `state=${outcome.state}` : '', outcome.billing && outcome.billing.last4 ? `last4=${outcome.billing.last4}` : '', `durationMs=${formatDurationMs(durationMs)}`].filter(Boolean).join(' | '),
    });
    return normalizePaymentStageResult({
      success: true,
      state: String(outcome.state || 'PAYMENT_SUCCESS'),
      reason: String(outcome.reason || outcome.state || 'PAYMENT_SUCCESS'),
      nextStage: String(outcome.nextStage || 'account-delivery'),
      detectionSource: String(outcome.source || ''),
      detail,
    });
  }

  const classified = classifyPaymentFailure
    ? classifyPaymentFailure({ state: (outcome && outcome.state) || 'PAYMENT_FAILED', reason: outcome && outcome.reason })
    : null;

  syncStageStep(options, { stage: 'payment', step: 'stage-fail' });
  logStageFail('payment', '加卡支付失败', {
    context: buildStageLogContext(options),
    extra: [(outcome && outcome.state) ? `state=${outcome.state}` : '', classified && classified.siteReason ? `classified=${classified.siteReason}` : '', `durationMs=${formatDurationMs(durationMs)}`].filter(Boolean).join(' | '),
  });
  return normalizePaymentStageResult({
    success: false,
    state: String((outcome && outcome.state) || 'PAYMENT_FAILED'),
    reason: String((classified && classified.siteReason) || (outcome && outcome.reason) || (outcome && outcome.state) || 'PAYMENT_FAILED'),
    detail: { ...detail, classified },
  });
}

module.exports = { runPaymentStage, normalizePaymentStageResult, resolveAdapterMethod };
