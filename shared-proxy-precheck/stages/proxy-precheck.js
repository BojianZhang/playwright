'use strict';

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
    signalStrength,
    settleStage,
    detectionSource,
    stateChanged,
    retryCount,
    detail,
  };
}

async function runProxyPrecheckChain(options = {}) {
  const {
    proxy = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  const checkProxyConnectivity = resolveAdapterMethod(adapter, 'checkProxyConnectivity');
  const checkProxyExitIp = resolveAdapterMethod(adapter, 'checkProxyExitIp');
  const checkDreaminaPrimaryTarget = resolveAdapterMethod(adapter, 'checkDreaminaPrimaryTarget');
  const checkDreaminaSecondaryTarget = resolveAdapterMethod(adapter, 'checkDreaminaSecondaryTarget');
  const confirmProxyPrecheckResult = resolveAdapterMethod(adapter, 'confirmProxyPrecheckResult');
  const classifyProxyPrecheckFailure = resolveAdapterMethod(adapter, 'classifyProxyPrecheckFailure');

  const connectivity = checkProxyConnectivity ? await checkProxyConnectivity(proxy, runtime, context) : null;
  if (connectivity && connectivity.ok === false) {
    const classified = classifyProxyPrecheckFailure
      ? classifyProxyPrecheckFailure({ state: connectivity.state, source: connectivity.source, value: connectivity.value })
      : null;
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

  const exitIp = checkProxyExitIp ? await checkProxyExitIp(proxy, runtime, { ...context, connectivity }) : null;
  const primaryTarget = checkDreaminaPrimaryTarget ? await checkDreaminaPrimaryTarget(proxy, runtime, { ...context, connectivity, exitIp }) : null;
  const secondaryTarget = checkDreaminaSecondaryTarget ? await checkDreaminaSecondaryTarget(proxy, runtime, { ...context, connectivity, exitIp, primaryTarget }) : null;

  const resultConfirmation = confirmProxyPrecheckResult
    ? await confirmProxyPrecheckResult(proxy, runtime, { ...context, connectivity, exitIp, primaryTarget, secondaryTarget })
    : { ok: false, state: 'PROXY_PRECHECK_BAD', nextStage: '', proxyGrade: 'BAD', source: '', value: '', strength: '', settleStage: 'none' };

  if (resultConfirmation?.ok) {
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
