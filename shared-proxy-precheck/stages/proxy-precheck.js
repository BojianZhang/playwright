'use strict';

/**
 * 从 adapter 上解析指定方法。
 */
function resolveAdapterMethod(adapter, methodName) {
  if (!adapter || typeof adapter !== 'object') return null;
  const method = adapter[methodName];
  return typeof method === 'function' ? method : null;
}

/**
 * 规范化代理预检主链输出结构。
 */
function normalizeProxyPrecheckResult(input = {}) {
  const success = Boolean(input.success);
  const stage = 'proxy-precheck';
  const state = String(input.state || 'UNKNOWN').trim();
  const reason = String(input.reason || state).trim();
  const nextStage = success ? String(input.nextStage || 'proxy-precheck-complete').trim() : '';
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
    signalStrength,
    settleStage,
    detectionSource,
    stateChanged,
    retryCount,
    detail,
  };
}

/**
 * 运行代理预检主链。
 *
 * 当前版本先把统一 orchestration 骨架钉死。
 */
async function runProxyPrecheckChain(options = {}) {
  const {
    page = null,
    proxy = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  const checkProxyConnectivity = resolveAdapterMethod(adapter, 'checkProxyConnectivity');
  const checkProxyNetworkHealth = resolveAdapterMethod(adapter, 'checkProxyNetworkHealth');
  const checkProxyEntryReachability = resolveAdapterMethod(adapter, 'checkProxyEntryReachability');
  const checkProxySiteReady = resolveAdapterMethod(adapter, 'checkProxySiteReady');
  const checkProxyBusinessReady = resolveAdapterMethod(adapter, 'checkProxyBusinessReady');
  const confirmProxyPrecheckResult = resolveAdapterMethod(adapter, 'confirmProxyPrecheckResult');
  const classifyProxyPrecheckFailure = resolveAdapterMethod(adapter, 'classifyProxyPrecheckFailure');

  const connectivity = checkProxyConnectivity ? await checkProxyConnectivity(page, proxy, runtime, context) : null;
  if (connectivity && connectivity.ok === false) {
    const classified = classifyProxyPrecheckFailure
      ? classifyProxyPrecheckFailure({ state: connectivity.state, source: connectivity.source, value: connectivity.value })
      : null;
    return normalizeProxyPrecheckResult({
      success: false,
      state: String(connectivity.state || 'PROXY_CONNECTIVITY_FAILED'),
      reason: classified?.siteReason || String(connectivity.state || 'PROXY_CONNECTIVITY_FAILED'),
      nextStage: '',
      signalStrength: String(connectivity.strength || ''),
      settleStage: 'primary-failure',
      detectionSource: String(connectivity.source || ''),
      detail: {
        connectivity,
        networkHealth: null,
        entryReachability: null,
        siteReady: null,
        businessReady: null,
        resultConfirmation: null,
        classified,
      },
    });
  }

  const networkHealth = checkProxyNetworkHealth ? await checkProxyNetworkHealth(page, proxy, runtime, { ...context, connectivity }) : null;
  const entryReachability = checkProxyEntryReachability ? await checkProxyEntryReachability(page, proxy, runtime, { ...context, connectivity, networkHealth }) : null;
  const siteReady = checkProxySiteReady ? await checkProxySiteReady(page, proxy, runtime, { ...context, connectivity, networkHealth, entryReachability }) : null;
  const businessReady = checkProxyBusinessReady ? await checkProxyBusinessReady(page, proxy, runtime, { ...context, connectivity, networkHealth, entryReachability, siteReady }) : null;

  const resultConfirmation = confirmProxyPrecheckResult
    ? await confirmProxyPrecheckResult(page, proxy, runtime, { ...context, connectivity, networkHealth, entryReachability, siteReady, businessReady })
    : { ok: false, state: 'PROXY_PRECHECK_RESULT_UNKNOWN', nextStage: '', source: '', value: '', strength: '', settleStage: 'none' };

  if (resultConfirmation?.ok) {
    return normalizeProxyPrecheckResult({
      success: true,
      state: String(resultConfirmation.state || 'PROXY_PRECHECK_COMPLETE'),
      reason: String(resultConfirmation.state || 'PROXY_PRECHECK_COMPLETE'),
      nextStage: String(resultConfirmation.nextStage || 'proxy-precheck-complete'),
      signalStrength: String(resultConfirmation.strength || ''),
      settleStage: String(resultConfirmation.settleStage || 'none'),
      detectionSource: String(resultConfirmation.source || ''),
      stateChanged: typeof resultConfirmation.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
      retryCount: Number.isFinite(Number(resultConfirmation.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
      detail: {
        connectivity,
        networkHealth,
        entryReachability,
        siteReady,
        businessReady,
        resultConfirmation,
        classified: null,
      },
    });
  }

  const classified = classifyProxyPrecheckFailure
    ? classifyProxyPrecheckFailure({ state: resultConfirmation?.state || 'PROXY_PRECHECK_RESULT_UNKNOWN', source: resultConfirmation?.source, value: resultConfirmation?.value })
    : null;

  return normalizeProxyPrecheckResult({
    success: false,
    state: String(resultConfirmation?.state || 'PROXY_PRECHECK_RESULT_UNKNOWN'),
    reason: classified?.siteReason || String(resultConfirmation?.state || 'PROXY_PRECHECK_RESULT_UNKNOWN'),
    nextStage: '',
    signalStrength: String(resultConfirmation?.strength || ''),
    settleStage: String(resultConfirmation?.settleStage || 'none'),
    detectionSource: String(resultConfirmation?.source || ''),
    stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
    retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
    detail: {
      connectivity,
      networkHealth,
      entryReachability,
      siteReady,
      businessReady,
      resultConfirmation,
      classified,
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeProxyPrecheckResult,
  runProxyPrecheckChain,
};
