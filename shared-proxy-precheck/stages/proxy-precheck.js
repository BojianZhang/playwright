'use strict';

/**
 * proxy-precheck.js
 *
 * 这是 shared proxy-precheck stage 的编排层。
 *
 * 它负责：
 * - 解析 adapter hooks
 * - 编排一次性 proxy precheck 主链
 * - 记录阶段日志
 * - 归一化 shared stage 输出结果
 *
 * 它不负责：
 * - 具体网络请求实现
 * - 代理连通性探测细节
 * - 目标站点判定细节
 * - retry / 多轮探测 / 策略循环
 * - 站点专属失败分类细节
 */

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../../shared-stage-logger');

// ==============================
// 基础工具层
// 只负责 adapter hook 解析与 shared result 归一化。
// 不负责具体探测行为。
// ==============================

function resolveAdapterMethod(adapter, methodName) {
  if (!adapter || typeof adapter !== 'object') return null;
  const method = adapter[methodName];
  return typeof method === 'function' ? method : null;
}

function normalizeProxyPrecheckResult(input = {}) {
  const success = Boolean(input.success);
  const stage = 'proxy-precheck';
  const state = String(input.state || 'UNKNOWN').trim();
  const reason = String(input.reason || state).trim();
  const nextStage = success ? String(input.nextStage || 'proxy-precheck-complete').trim() : '';
  const proxyGrade = String(input.proxyGrade || (success ? 'OK' : 'BAD')).trim();
  const signalStrength = String(input.signalStrength || '').trim();
  const settleStage = String(input.settleStage || 'none').trim();
  const detectionSource = String(input.detectionSource || '').trim();
  const stateChanged = typeof input.stateChanged === 'boolean' ? input.stateChanged : null;
  const retryCount = Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0;
  const detail = input.detail && typeof input.detail === 'object' ? input.detail : null;

  return {
    success,
    stage,
    state,
    reason,
    nextStage,
    proxyGrade,
    source: detectionSource,
    detectionSource,
    signalStrength,
    settleStage,
    stateChanged,
    retryCount,
    detail,
  };
}

// ==============================
// stage orchestrator 层
// 负责按固定顺序执行 connectivity gate -> parallel targets -> result confirmation。
// 不负责 retry，也不扩成多轮策略链。
// ==============================

async function runProxyPrecheckChain(options = {}) {
  const {
    proxy = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  const stageTimer = createStageTimer();

  const checkProxyConnectivity = resolveAdapterMethod(adapter, 'checkProxyConnectivity');
  const checkProxyExitIp = resolveAdapterMethod(adapter, 'checkProxyExitIp');
  const checkDreaminaPrimaryTarget = resolveAdapterMethod(adapter, 'checkDreaminaPrimaryTarget');
  const checkDreaminaSecondaryTarget = resolveAdapterMethod(adapter, 'checkDreaminaSecondaryTarget');
  const confirmProxyPrecheckResult = resolveAdapterMethod(adapter, 'confirmProxyPrecheckResult');
  const classifyProxyPrecheckFailure = resolveAdapterMethod(adapter, 'classifyProxyPrecheckFailure');

  // Step 1: connectivity gate
  // 先做最外层 fail-fast，避免坏代理继续浪费后续目标检查。
  logStageProgress('proxy-precheck', '检查代理连通性', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const connectivity = checkProxyConnectivity ? await checkProxyConnectivity(proxy, runtime, context) : null;
  if (connectivity && connectivity.ok === false) {
    const classified = classifyProxyPrecheckFailure
      ? classifyProxyPrecheckFailure({ state: connectivity.state, source: connectivity.source, value: connectivity.value })
      : null;
    logStageFail('proxy-precheck', '代理连通性失败', {
      context: buildStageLogContext({ proxy, runtime, context }),
      extra: [
        connectivity?.state ? `state=${connectivity.state}` : '',
        connectivity?.source ? `source=${connectivity.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    // connectivity fail-fast 出口
    return normalizeProxyPrecheckResult({
      success: false,
      state: String(connectivity.state || 'PROXY_CONNECTIVITY_FAILED'),
      reason: classified?.siteReason || String(connectivity.state || 'PROXY_CONNECTIVITY_FAILED'),
      nextStage: '',
      proxyGrade: 'BAD',
      signalStrength: String(connectivity.strength || ''),
      settleStage: 'connectivity',
      detectionSource: String(connectivity.source || ''),
      detail: {
        exitIpCheck: connectivity,
        primaryTargetCheck: null,
        secondaryTargetCheck: null,
        connectivity,
        exitIp: null,
        primaryTarget: null,
        secondaryTarget: null,
        resultConfirmation: null,
        classified,
        proxySummary: context?.proxySummary || null,
      },
    });
  }

  // Step 2: parallel target probes
  // exitIp / primary / secondary 明确并行执行，避免串行探测放大耗时。
  logStageProgress('proxy-precheck', '并行检查代理出口 IP / Dreamina 主目标 / Dreamina 副目标', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const enableSecondaryTarget = Boolean(runtime?.proxyEnableSecondaryTarget ?? true);
  const [exitIp, primaryTarget, secondaryTarget] = await Promise.all([
    checkProxyExitIp ? checkProxyExitIp(proxy, runtime, { ...context, connectivity }) : Promise.resolve(null),
    checkDreaminaPrimaryTarget ? checkDreaminaPrimaryTarget(proxy, runtime, { ...context, connectivity }) : Promise.resolve(null),
    enableSecondaryTarget && checkDreaminaSecondaryTarget
      ? checkDreaminaSecondaryTarget(proxy, runtime, { ...context, connectivity })
      : Promise.resolve({
          ok: false,
          skipped: true,
          state: 'DREAMINA_SECONDARY_TARGET_SKIPPED',
          source: 'secondary-target-disabled',
          value: 'disabled-by-runtime-policy',
          strength: 'weak',
          elapsedMs: 0,
          response: null,
        }),
  ]);

  // Step 3: result confirmation
  // 由 adapter 统一综合 connectivity + targets 结果，shared 层只负责承接与收口。
  logStageProgress('proxy-precheck', '确认代理预检结果', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const resultConfirmation = confirmProxyPrecheckResult
    ? await confirmProxyPrecheckResult(proxy, runtime, { ...context, connectivity, exitIp, primaryTarget, secondaryTarget })
    : { ok: false, state: 'PROXY_PRECHECK_BAD', nextStage: '', proxyGrade: 'BAD', source: '', value: '', strength: '', settleStage: 'none' };

  if (resultConfirmation?.ok) {
    logStageSuccess('proxy-precheck', '代理预检成功', {
      context: buildStageLogContext({ proxy, runtime, context }),
      extra: [
        resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
        resultConfirmation?.proxyGrade ? `proxyGrade=${resultConfirmation.proxyGrade}` : '',
        resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    // success 出口
    return normalizeProxyPrecheckResult({
      success: true,
      state: String(resultConfirmation.state || 'PROXY_PRECHECK_OK'),
      reason: String(resultConfirmation.state || 'PROXY_PRECHECK_OK'),
      nextStage: String(resultConfirmation.nextStage || 'proxy-precheck-complete'),
      proxyGrade: String(resultConfirmation.proxyGrade || 'OK'),
      signalStrength: String(resultConfirmation.strength || ''),
      settleStage: String(resultConfirmation.settleStage || 'none'),
      detectionSource: String(resultConfirmation.source || ''),
      stateChanged: typeof resultConfirmation.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
      retryCount: Number.isFinite(Number(resultConfirmation.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
      detail: {
        exitIpCheck: exitIp,
        primaryTargetCheck: primaryTarget,
        secondaryTargetCheck: secondaryTarget,
        connectivity,
        exitIp,
        primaryTarget,
        secondaryTarget,
        resultConfirmation,
        classified: null,
        proxySummary: context?.proxySummary || null,
      },
    });
  }

  const classified = classifyProxyPrecheckFailure
    ? classifyProxyPrecheckFailure({ state: resultConfirmation?.state || 'PROXY_PRECHECK_BAD', source: resultConfirmation?.source, value: resultConfirmation?.value })
    : null;

  logStageFail('proxy-precheck', '代理预检失败', {
    context: buildStageLogContext({ proxy, runtime, context }),
    extra: [
      resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
      resultConfirmation?.proxyGrade ? `proxyGrade=${resultConfirmation.proxyGrade}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).join(' | '),
  });

  // confirmation failure 出口
  return normalizeProxyPrecheckResult({
    success: false,
    state: String(resultConfirmation?.state || 'PROXY_PRECHECK_BAD'),
    reason: classified?.siteReason || String(resultConfirmation?.state || 'PROXY_PRECHECK_BAD'),
    nextStage: '',
    proxyGrade: String(resultConfirmation?.proxyGrade || 'BAD'),
    signalStrength: String(resultConfirmation?.strength || ''),
    settleStage: String(resultConfirmation?.settleStage || 'none'),
    detectionSource: String(resultConfirmation?.source || ''),
    stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
    retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
    detail: {
      exitIpCheck: exitIp,
      primaryTargetCheck: primaryTarget,
      secondaryTargetCheck: secondaryTarget,
      connectivity,
      exitIp,
      primaryTarget,
      secondaryTarget,
      resultConfirmation,
      classified,
      proxySummary: context?.proxySummary || null,
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeProxyPrecheckResult,
  runProxyPrecheckChain,
};
