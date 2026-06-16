// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— S7 upgrade（升级/选套餐 → 跳收银台）
//
// 文件定位：Dreamina/0.0.4/lib/stage-runners/upgrade.js
//
// 边界（BOUNDARY）：
// ✅ 负责 —— S7 阶段调度：入参校验、调用 adapter.runUpgrade、耗时统计、日志、归一化 StageResult。
// ✅ 负责 —— 失败时调用 adapter.classifyUpgradeFailure 做站点语义分类。
// ❌ 不负责 —— 任何页面操作/选择器（由 S7-upgrade/upgrade-adapter.js 注入）。
// ❌ 不负责 —— 持有 adapter 引用（通过 options.adapter 注入）。
//
// 调用方：Dreamina-register.js 主链（registry.upgrade.run）。
// 约定：adapter.runUpgrade(page, runtime, context) → { ok, state, reason, detail?, cashierPage? }
//   成功后把 cashierPage 放进 result.detail.cashierPage，供 S8 payment 读取
//   （register 会把本阶段结果写入 stageResults.upgrade，S8 通过 context.stageResults.upgrade.detail.cashierPage 取用）。
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

function normalizeUpgradeStageResult(input = {}) {
  const success = Boolean(input.success);
  const state = String(input.state || 'UNKNOWN').trim();
  const reason = String(input.reason || state).trim();
  return {
    success,
    stage: 'upgrade',
    state,
    reason,
    nextStage: success ? String(input.nextStage || 'payment').trim() : '',
    source: String(input.detectionSource || '').trim(),
    signalStrength: String(input.signalStrength || '').trim(),
    settleStage: String(input.settleStage || 'none').trim(),
    detectionSource: String(input.detectionSource || '').trim(),
    stateChanged: typeof input.stateChanged === 'boolean' ? input.stateChanged : null,
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    detail: input.detail && typeof input.detail === 'object' ? input.detail : null,
  };
}

async function runUpgradeStage(options = {}) {
  const { page, adapter = {}, runtime = {}, context = {} } = options;
  const stageTimer = createStageTimer();

  const runUpgrade = resolveAdapterMethod(adapter, 'runUpgrade');
  const classifyUpgradeFailure = resolveAdapterMethod(adapter, 'classifyUpgradeFailure');

  if (!runUpgrade) {
    syncStageStep(options, { stage: 'upgrade', step: 'stage-fail' });
    logStageFail('upgrade', 'adapter 必需方法缺失', {
      context: buildStageLogContext(options),
      extra: 'missing=runUpgrade',
    });
    return normalizeUpgradeStageResult({
      success: false,
      state: 'UPGRADE_ADAPTER_METHOD_MISSING',
      reason: 'UPGRADE_ADAPTER_METHOD_MISSING',
      detail: { missingMethod: 'runUpgrade' },
    });
  }

  syncStageStep(options, { stage: 'upgrade', step: 'run-upgrade' });
  logStageProgress('upgrade', '关闭弹窗 → 点 Upgrade → 选套餐 → 跳收银台', {
    context: buildStageLogContext(options),
  });

  let outcome;
  try {
    outcome = await runUpgrade(page, runtime, context);
  } catch (err) {
    outcome = { ok: false, state: 'UPGRADE_EXCEPTION', reason: 'UPGRADE_EXCEPTION', detail: { error: String((err && err.message) || err) } };
  }

  const durationMs = stageTimer.elapsedMs();
  const detail = { ...(outcome && outcome.detail ? outcome.detail : {}), durationMs };

  if (outcome && outcome.ok) {
    syncStageStep(options, { stage: 'upgrade', step: 'stage-success' });
    logStageSuccess('upgrade', '升级/选套餐完成', {
      context: buildStageLogContext(options),
      extra: [outcome.state ? `state=${outcome.state}` : '', `durationMs=${formatDurationMs(durationMs)}`].filter(Boolean).join(' | '),
    });
    return normalizeUpgradeStageResult({
      success: true,
      state: String(outcome.state || 'UPGRADE_OK'),
      reason: String(outcome.reason || outcome.state || 'UPGRADE_OK'),
      nextStage: String(outcome.nextStage || 'payment'),
      detectionSource: String(outcome.source || ''),
      stateChanged: typeof outcome.stateChanged === 'boolean' ? outcome.stateChanged : null,
      detail,
    });
  }

  const classified = classifyUpgradeFailure
    ? classifyUpgradeFailure({ state: (outcome && outcome.state) || 'UPGRADE_FAILED', reason: outcome && outcome.reason })
    : null;

  syncStageStep(options, { stage: 'upgrade', step: 'stage-fail' });
  logStageFail('upgrade', '升级/选套餐失败', {
    context: buildStageLogContext(options),
    extra: [(outcome && outcome.state) ? `state=${outcome.state}` : '', classified && classified.siteReason ? `classified=${classified.siteReason}` : '', `durationMs=${formatDurationMs(durationMs)}`].filter(Boolean).join(' | '),
  });
  return normalizeUpgradeStageResult({
    success: false,
    state: String((outcome && outcome.state) || 'UPGRADE_FAILED'),
    reason: String((classified && classified.siteReason) || (outcome && outcome.reason) || (outcome && outcome.state) || 'UPGRADE_FAILED'),
    detail: { ...detail, classified },
  });
}

module.exports = { runUpgradeStage, normalizeUpgradeStageResult, resolveAdapterMethod };
