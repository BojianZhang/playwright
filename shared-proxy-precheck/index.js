'use strict';

const { loadLocalProxies, summarizeProxy } = require('./local-proxy-loader');
const { runProxyPrecheckChain } = require('./stages/proxy-precheck');
const dreaminaProxyPrecheckAdapter = require('./dreamina/proxy-precheck-adapter');

function selectLocalProxy(proxies = [], options = {}) {
  const list = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
  const preferredIndex = Number.isFinite(Number(options.preferredIndex)) ? Number(options.preferredIndex) : 0;
  if (!list.length) return null;
  return list[Math.max(0, Math.min(preferredIndex, list.length - 1))] || null;
}

async function runDreaminaProxyPrecheckFromLocal(options = {}) {
  const {
    page = null,
    runtime = {},
    context = {},
    preferredIndex = 0,
    adapter = dreaminaProxyPrecheckAdapter,
  } = options;

  const proxies = loadLocalProxies(options);
  const proxy = selectLocalProxy(proxies, { preferredIndex });

  if (!proxy) {
    return {
      success: false,
      stage: 'proxy-precheck',
      state: 'LOCAL_PROXY_SOURCE_EMPTY',
      reason: 'LOCAL_PROXY_SOURCE_EMPTY',
      nextStage: '',
      signalStrength: '',
      settleStage: 'bootstrap',
      detectionSource: 'local-proxies.txt',
      stateChanged: null,
      retryCount: 0,
      proxy: null,
      proxySummary: null,
      detail: {
        source: 'local-proxies.txt',
        selectedIndex: preferredIndex,
      },
    };
  }

  const result = await runProxyPrecheckChain({
    page,
    proxy,
    adapter,
    runtime,
    context: {
      ...context,
      proxy,
      proxySummary: summarizeProxy(proxy),
    },
  });

  return {
    ...result,
    proxy,
    proxySummary: summarizeProxy(proxy),
  };
}

module.exports = {
  selectLocalProxy,
  runDreaminaProxyPrecheckFromLocal,
};
