'use strict';

const { loadLocalProxies, summarizeProxy } = require('./shared-proxy-precheck/local-proxy-loader');
const { runProxyPrecheckChain } = require('./shared-proxy-precheck/stages/proxy-precheck');
const dreaminaProxyPrecheckAdapter = require('./shared-proxy-precheck/dreamina/proxy-precheck-adapter');

function selectLocalProxy(proxies = [], options = {}) {
  const list = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
  const preferredIndex = Number.isFinite(Number(options.preferredIndex)) ? Number(options.preferredIndex) : 0;
  if (!list.length) return null;
  return list[Math.max(0, Math.min(preferredIndex, list.length - 1))] || null;
}

async function runDreaminaProxyPrecheck(options = {}) {
  const {
    preferredIndex = 0,
    runtime = {},
    logInfo = console.log,
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
      proxyGrade: 'BAD',
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
    proxy,
    adapter: dreaminaProxyPrecheckAdapter,
    runtime,
    context: {
      logInfo: typeof logInfo === 'function' ? logInfo : null,
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

if (require.main === module) {
  const preferredIndex = Number(process.argv[2] || 0);
  runDreaminaProxyPrecheck({ preferredIndex })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result?.success ? 0 : 1);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  selectLocalProxy,
  runDreaminaProxyPrecheck,
};
