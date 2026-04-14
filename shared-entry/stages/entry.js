'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../../shared-stage-logger');
const { syncStageStep } = require('../../shared-stage-runtime');

/**
 * 从 adapter 上解析指定方法。
 *
 * 作用：
 * - 统一阶段 1 公共层对 adapter 方法的取用方式
 * - 如果方法不存在，就回退到 null，而不是让主流程直接炸掉
 */
function resolveAdapterMethod(adapter, methodName) {
  // 如果 adapter 本身不存在，就直接返回 null。
  if (!adapter || typeof adapter !== 'object') return null;
  // 从 adapter 上读取目标方法。
  const method = adapter[methodName];
  // 只有当目标字段是函数时才返回，否则统一回退 null。
  return typeof method === 'function' ? method : null;
}

/**
 * 规范化阶段 1 输出结构。
 *
 * 作用：
 * - 保证外层无论 adapter 返回了什么，阶段 1 最终输出结构都稳定
 * - 把 success / stage / reason / detail 等字段统一收敛
 */
function pickEntrySignalTimeline(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && Object.keys(candidate).length) {
      return candidate;
    }
  }
  return null;
}

function extractConfirmTimingBreakdown(entryReadyResult = {}, confirmEntryReadyMs = 0) {
  const detail = entryReadyResult?.detail && typeof entryReadyResult.detail === 'object' ? entryReadyResult.detail : {};
  const readyTraceEnvelope = detail?.readyTrace && typeof detail.readyTrace === 'object' ? detail.readyTrace : {};
  const readyTrace = readyTraceEnvelope?.readyTrace && typeof readyTraceEnvelope.readyTrace === 'object'
    ? readyTraceEnvelope.readyTrace
    : readyTraceEnvelope;
  const timelineResult = readyTrace?.timelineResult && typeof readyTrace.timelineResult === 'object'
    ? readyTrace.timelineResult
    : {};
  const gateResult = readyTrace?.gateResult && typeof readyTrace.gateResult === 'object'
    ? readyTrace.gateResult
    : {};
  const confirmTrace = readyTrace?.confirmTrace || timelineResult?.detail?.confirmTrace || detail?.confirmTrace || {};
  const gateTrace = readyTrace?.gateTrace || gateResult?.detail?.gateTrace || detail?.gateTrace || {};
  const waitForEntryReadyPhaseTrace = readyTrace?.waitForEntryReadyPhaseTrace && typeof readyTrace.waitForEntryReadyPhaseTrace === 'object'
    ? readyTrace.waitForEntryReadyPhaseTrace
    : detail?.waitForEntryReadyPhaseTrace && typeof detail.waitForEntryReadyPhaseTrace === 'object'
      ? detail.waitForEntryReadyPhaseTrace
      : {};
  const outerConfirmMs = Number(confirmTrace?.resolvedAtMs || timelineResult?.waitStepMs || 0);
  const gateConfirmMs = Number(gateTrace?.resolvedAtMs || 0);
  const waitWrapperMs = Math.max(0,
    Number(waitForEntryReadyPhaseTrace?.timelineWaitMs || 0)
    + Number(waitForEntryReadyPhaseTrace?.ensureGateMs || 0)
    + Number(waitForEntryReadyPhaseTrace?.recoverSignalsMs || 0)
    + Number(waitForEntryReadyPhaseTrace?.reensureGateMs || 0)
    + Number(waitForEntryReadyPhaseTrace?.debugSnapshotMs || 0)
  );
  const totalMs = Number(confirmEntryReadyMs || 0);
  const wrapperOverheadMs = Math.max(0, totalMs - outerConfirmMs - gateConfirmMs);
  const wrapperResidualMs = Math.max(0, wrapperOverheadMs - waitWrapperMs);

  return {
    totalMs,
    outerConfirmMs,
    gateConfirmMs,
    wrapperOverheadMs,
    waitWrapperMs,
    wrapperResidualMs,
    waitForEntryReadyResolvedPath: String(waitForEntryReadyPhaseTrace?.resolvedPath || ''),
    waitForEntryReadyRecoveredSignals: Boolean(waitForEntryReadyPhaseTrace?.recoveredSignals),
    waitForEntryReadyPhaseTrace,
    outerConfirmResolvedBy: String(confirmTrace?.resolvedBy || ''),
    outerConfirmResolvedState: String(confirmTrace?.resolvedState || ''),
    outerConfirmResolvedReason: String(confirmTrace?.resolvedReason || ''),
    gateResolvedState: String(gateTrace?.resolvedState || ''),
    gateResolvedReason: String(gateTrace?.resolvedReason || ''),
  };
}

function normalizeEntryStageResult(input = {}) {
  // 统一 success。
  const success = Boolean(input.success);
  // 阶段 1 stage 固定为 entry。
  const stage = 'entry';
  // 原始 state；没有则给 UNKNOWN。
  const state = String(input.state || 'UNKNOWN').trim();
  // reason 优先用输入值；没有则回退 state。
  const reason = String(input.reason || state).trim();
  // 只有 success=true 时才允许向 credential-submit 推进。
  const nextStage = success ? String(input.nextStage || 'credential-submit').trim() : '';
  // 信号强度，默认空字符串。
  const signalStrength = String(input.signalStrength || '').trim();
  // 收敛层级，默认 none。
  const settleStage = String(input.settleStage || 'none').trim();
  // 检测来源，默认空字符串。
  const detectionSource = String(input.detectionSource || '').trim();
  // 页面是否发生了有意义变化；没有则保留 null。
  const stateChanged = typeof input.stateChanged === 'boolean' ? input.stateChanged : null;
  // 阶段 1 内部轻量重试次数；默认 0。
  const retryCount = Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0;
  // detail 对象；没有则回退 null。
  const detail = input.detail && typeof input.detail === 'object' ? input.detail : null;

  // 返回统一结构。
  return {
    success,
    stage,
    state,
    reason,
    nextStage,
    source: detectionSource,
    detectionSource,
    signalStrength,
    settleStage,
    stateChanged,
    retryCount,
    detail,
  };
}

/**
 * 运行阶段 1：entry。
 *
 * 当前版本目标：
 * - 优先把阶段 1 的公共 runner 形态钉死
 * - 让 shared-entry 能和后面 2~6 阶段一样，被主链编排层统一调用
 * - 真正站点细节仍然交给 adapter
 */
async function runEntryStage(options = {}) {
  // 从统一 options 中解构阶段 1 常用输入。
  const {
    page,
    account = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  const stageTimer = createStageTimer();
  const timingBreakdown = {};
  const entryPhaseTrace = {
    openStartedAtMs: 0,
    openFinishedAtMs: null,
    healthStartedAtMs: null,
    healthFinishedAtMs: null,
    confirmStartedAtMs: null,
    confirmFinishedAtMs: null,
  };

  // 取日志函数；没有则保持 null。
  const { logInfo = null } = context;

  // 解析阶段 1 各步骤所需 adapter 方法。
  const openEntryPage = resolveAdapterMethod(adapter, 'openEntryPage');
  const checkEntryHealth = resolveAdapterMethod(adapter, 'checkEntryHealth');
  const waitForEntryReady = resolveAdapterMethod(adapter, 'waitForEntryReady');
  const confirmEntryReadyWithRecovery = resolveAdapterMethod(adapter, 'confirmEntryReadyWithRecovery');
  const classifyEntryFailure = resolveAdapterMethod(adapter, 'classifyEntryFailure');

  // 第一步：如果存在 openEntryPage，就先执行入口页打开或校正。
  syncStageStep(options, { stage: 'entry', step: 'open-entry-page' });
  logStageProgress('entry', '打开入口页 / 校正入口上下文', {
    context: buildStageLogContext(options),
  });
  const openStartMs = stageTimer.elapsedMs();
  entryPhaseTrace.openStartedAtMs = openStartMs;
  const entryOpenResult = openEntryPage
    ? await openEntryPage(page, runtime, context)
    : {
        ok: true,
        state: 'ENTRY_OPEN_SKIPPED',
        source: '',
        value: '',
        strength: '',
      };
  timingBreakdown.openEntryPageMs = Math.max(0, stageTimer.elapsedMs() - openStartMs);
  entryPhaseTrace.openFinishedAtMs = stageTimer.elapsedMs();

  // 如果入口页打开就已经明确失败，则直接收口。
  if (entryOpenResult && entryOpenResult.ok === false) {
    const classified = classifyEntryFailure
      ? classifyEntryFailure({ state: entryOpenResult.state || 'ENTRY_OPEN_FAILED', source: entryOpenResult.source, value: entryOpenResult.value })
      : null;

    syncStageStep(options, { stage: 'entry', step: 'stage-fail' });
    logStageFail('entry', '入口页打开失败', {
      context: buildStageLogContext(options),
      extra: [
        entryOpenResult?.state ? `state=${entryOpenResult.state}` : '',
        entryOpenResult?.source ? `source=${entryOpenResult.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    return normalizeEntryStageResult({
      success: false,
      state: String(entryOpenResult.state || 'ENTRY_OPEN_FAILED'),
      reason: classified?.siteReason || String(entryOpenResult.state || 'ENTRY_OPEN_FAILED'),
      nextStage: '',
      signalStrength: String(entryOpenResult.strength || ''),
      settleStage: 'primary-failure',
      detectionSource: String(entryOpenResult.source || ''),
      stateChanged: typeof entryOpenResult.stateChanged === 'boolean' ? entryOpenResult.stateChanged : null,
      retryCount: 0,
      detail: {
        entryHealth: null,
        healthTrace: null,
        overlayHandled: false,
        loginSignal: null,
        readyTrace: null,
        recoveryTrace: null,
        entryOpenResult,
        entryReadyResult: null,
        classified,
        timingBreakdown,
        entryPhaseTrace,
      },
    });
  }

  // 第二步：如果存在健康检查方法，就执行健康检查；否则给一个跳过占位结果。
  syncStageStep(options, { stage: 'entry', step: 'check-entry-health' });
  logStageProgress('entry', '检查入口页健康状态', {
    context: buildStageLogContext(options),
  });
  const healthStartMs = stageTimer.elapsedMs();
  entryPhaseTrace.healthStartedAtMs = healthStartMs;
  const entryHealthResult = checkEntryHealth
    ? await checkEntryHealth(page, runtime, context)
    : {
        ok: true,
        state: 'ENTRY_HEALTH_SKIPPED',
        source: '',
        value: '',
        strength: '',
      };
  timingBreakdown.checkEntryHealthMs = Math.max(0, stageTimer.elapsedMs() - healthStartMs);
  entryPhaseTrace.healthFinishedAtMs = stageTimer.elapsedMs();

  // 如果健康检查明确失败，则直接收口。
  if (entryHealthResult && entryHealthResult.ok === false) {
    const classified = classifyEntryFailure
      ? classifyEntryFailure({ state: entryHealthResult.state || 'ENTRY_HEALTH_FAILED', source: entryHealthResult.source, value: entryHealthResult.value })
      : null;

    syncStageStep(options, { stage: 'entry', step: 'stage-fail' });
    logStageFail('entry', '入口页健康检查失败', {
      context: buildStageLogContext(options),
      extra: [
        entryHealthResult?.state ? `state=${entryHealthResult.state}` : '',
        entryHealthResult?.source ? `source=${entryHealthResult.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });

    return normalizeEntryStageResult({
      success: false,
      state: String(entryHealthResult.state || 'ENTRY_HEALTH_FAILED'),
      reason: classified?.siteReason || String(entryHealthResult.state || 'ENTRY_HEALTH_FAILED'),
      nextStage: '',
      signalStrength: String(entryHealthResult.strength || ''),
      settleStage: 'health-check',
      detectionSource: String(entryHealthResult.source || 'health-check'),
      stateChanged: typeof entryHealthResult.stateChanged === 'boolean' ? entryHealthResult.stateChanged : null,
      retryCount: 0,
      detail: {
        entryHealth: entryHealthResult,
        healthTrace: entryHealthResult?.healthTrace || null,
        overlayHandled: Boolean(entryHealthResult?.overlayHandled),
        loginSignal: entryHealthResult?.loginSignal || null,
        readyTrace: null,
        recoveryTrace: null,
        entryOpenResult,
        entryHealthResult,
        entryReadyResult: null,
        classified,
        timingBreakdown,
        entryPhaseTrace,
      },
    });
  }

  // 第三步：如果没有 waitForEntryReady 方法，则返回结构化失败。
  if (!confirmEntryReadyWithRecovery && !waitForEntryReady) {
    return normalizeEntryStageResult({
      success: false,
      state: 'ENTRY_ADAPTER_METHOD_MISSING',
      reason: 'ENTRY_ADAPTER_METHOD_MISSING',
      nextStage: '',
      signalStrength: '',
      settleStage: 'none',
      detectionSource: '',
      stateChanged: null,
      retryCount: 0,
      detail: {
        missingMethod: 'confirmEntryReadyWithRecovery|waitForEntryReady',
        entryHealth: entryHealthResult,
        healthTrace: entryHealthResult?.healthTrace || null,
        overlayHandled: Boolean(entryHealthResult?.overlayHandled),
        loginSignal: entryHealthResult?.loginSignal || null,
        readyTrace: null,
        recoveryTrace: null,
        entryOpenResult,
        entryHealthResult,
        timingBreakdown,
        entryPhaseTrace,
      },
    });
  }

  // 第四步：执行入口 ready 判断；优先使用带 recover 的主链确认。
  syncStageStep(options, { stage: 'entry', step: 'confirm-entry-ready' });
  logStageProgress('entry', '等待入口 ready / 恢复入口信号', {
    context: buildStageLogContext(options),
  });
  const readyStartMs = stageTimer.elapsedMs();
  entryPhaseTrace.confirmStartedAtMs = readyStartMs;
  const entryReadyContext = {
    ...context,
    openEntryPageResult: entryPageResult,
  };

  const entryReadyResult = confirmEntryReadyWithRecovery
    ? await confirmEntryReadyWithRecovery(page, runtime, entryReadyContext)
    : await waitForEntryReady(page, runtime, entryReadyContext);
  timingBreakdown.confirmEntryReadyMs = Math.max(0, stageTimer.elapsedMs() - readyStartMs);
  timingBreakdown.confirmTimingBreakdown = extractConfirmTimingBreakdown(entryReadyResult, timingBreakdown.confirmEntryReadyMs);
  entryPhaseTrace.confirmFinishedAtMs = stageTimer.elapsedMs();
  timingBreakdown.totalBeforeSettleMs = Math.max(0, stageTimer.elapsedMs());

  // 如果入口 ready 成功，就直接返回成功结构。
  if (entryReadyResult?.ok) {
    syncStageStep(options, { stage: 'entry', step: 'stage-success' });
    logStageSuccess('entry', '入口阶段成功', {
      context: buildStageLogContext(options),
      extra: [
        entryReadyResult?.state ? `state=${entryReadyResult.state}` : '',
        entryReadyResult?.source ? `source=${entryReadyResult.source}` : '',
        entryReadyResult?.recoveryResult?.recovered ? 'recovered=true' : '',
      ].filter(Boolean).join(' | '),
    });
    if (typeof logInfo === 'function') {
      logInfo(`entry.stage.success | state=${entryReadyResult.state || 'ENTRY_READY'} | source=${entryReadyResult.source || ''} | value=${entryReadyResult.value || ''}`);
    }

    return normalizeEntryStageResult({
      success: true,
      state: String(entryReadyResult.state || 'ENTRY_READY'),
      reason: String(entryReadyResult.state || 'ENTRY_READY'),
      nextStage: 'credential-submit',
      signalStrength: String(entryReadyResult.strength || ''),
      settleStage: String(entryReadyResult.settleStage || (entryReadyResult?.recoveryResult?.recovered ? 'recovery-success' : 'primary-success')), 
      detectionSource: String(entryReadyResult.source || ''),
      stateChanged: typeof entryReadyResult.stateChanged === 'boolean' ? entryReadyResult.stateChanged : null,
      retryCount: Number.isFinite(Number(entryReadyResult.retryCount)) ? Number(entryReadyResult.retryCount) : 0,
      detail: {
        entryHealth: entryHealthResult,
        healthTrace: entryHealthResult?.healthTrace || null,
        overlayHandled: Boolean(entryHealthResult?.overlayHandled),
        loginSignal: entryHealthResult?.loginSignal || entryReadyResult?.detail?.loginSignal || null,
        signalTimeline: pickEntrySignalTimeline(
          entryReadyResult?.detail?.signalTimeline,
          entryReadyResult?.detail?.loginSignal?.detail?.signalTimeline,
          entryReadyResult?.detail?.readyTrace?.gateResult?.detail?.signalTimeline,
          entryReadyResult?.detail?.readyTrace?.gateResult?.gateState?.detail?.signalTimeline,
          entryReadyResult?.detail?.readyTrace?.signalTimeline,
          entryReadyResult?.detail?.gateResult?.detail?.signalTimeline,
          entryReadyResult?.detail?.gateResult?.gateState?.detail?.signalTimeline
        ),
        readyTrace: entryReadyResult?.detail || null,
        recoveryTrace: entryReadyResult?.recoveryResult || null,
        entryOpenResult,
        entryHealthResult,
        entryReadyResult,
        recoveryResult: entryReadyResult?.recoveryResult || null,
        classified: null,
        timingBreakdown,
        entryPhaseTrace,
      },
    });
  }

  // 第五步：ready 失败时做失败分类。
  const classified = classifyEntryFailure
    ? classifyEntryFailure({
        state: entryReadyResult?.state || 'ENTRY_NOT_READY',
        source: entryReadyResult?.source,
        value: entryReadyResult?.value,
        detail: entryReadyResult?.detail || null,
      })
    : null;

  // 返回统一失败结构。
  syncStageStep(options, { stage: 'entry', step: 'stage-fail' });
    logStageFail('entry', '入口阶段失败', {
    context: buildStageLogContext(options),
    extra: [
      entryReadyResult?.state ? `state=${entryReadyResult.state}` : '',
      entryReadyResult?.source ? `source=${entryReadyResult.source}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
  });
  return normalizeEntryStageResult({
    success: false,
    state: String(entryReadyResult?.state || 'ENTRY_NOT_READY'),
    reason: classified?.siteReason || String(entryReadyResult?.state || 'ENTRY_NOT_READY'),
    nextStage: '',
    signalStrength: String(entryReadyResult?.strength || ''),
    settleStage: String(entryReadyResult?.settleStage || (entryReadyResult?.recoveryResult?.recovered ? 'recovery-failure' : 'primary-failure')), 
    detectionSource: String(entryReadyResult?.source || ''),
    stateChanged: typeof entryReadyResult?.stateChanged === 'boolean' ? entryReadyResult.stateChanged : null,
    retryCount: Number.isFinite(Number(entryReadyResult?.retryCount)) ? Number(entryReadyResult.retryCount) : 0,
    detail: {
      entryHealth: entryHealthResult,
      healthTrace: entryHealthResult?.healthTrace || null,
      overlayHandled: Boolean(entryHealthResult?.overlayHandled),
      loginSignal: entryHealthResult?.loginSignal || entryReadyResult?.detail?.loginSignal || null,
      signalTimeline: pickEntrySignalTimeline(
        entryReadyResult?.detail?.signalTimeline,
        entryReadyResult?.detail?.loginSignal?.detail?.signalTimeline,
        entryReadyResult?.detail?.readyTrace?.gateResult?.detail?.signalTimeline,
        entryReadyResult?.detail?.readyTrace?.gateResult?.gateState?.detail?.signalTimeline,
        entryReadyResult?.detail?.readyTrace?.signalTimeline,
        entryReadyResult?.detail?.gateResult?.detail?.signalTimeline,
        entryReadyResult?.detail?.gateResult?.gateState?.detail?.signalTimeline
      ),
      readyTrace: entryReadyResult?.detail || null,
      recoveryTrace: entryReadyResult?.recoveryResult || null,
      entryOpenResult,
      entryHealthResult,
      entryReadyResult,
      recoveryResult: entryReadyResult?.recoveryResult || null,
      classified,
      timingBreakdown,
      entryPhaseTrace,
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeEntryStageResult,
  runEntryStage,
};
