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

function formatProxyPrecheckSummary(result = {}, index = 0) {
  const proxyGrade = String(result?.proxyGrade || 'UNKNOWN').trim();
  const exitIp = String(result?.detail?.exitIp?.value || 'N/A').trim();
  const connectivityMs = Number(result?.detail?.connectivity?.elapsedMs || 0);
  const primaryMs = Number(result?.detail?.primaryTarget?.elapsedMs || 0);
  const secondaryMs = Number(result?.detail?.secondaryTarget?.elapsedMs || 0);
  const proxyId = String(result?.proxySummary?.id || `proxy-${index + 1}`).trim();
  return `[Proxy Precheck] #${index + 1} ${proxyId} | Grade=${proxyGrade} | ExitIP=${exitIp} | Connectivity=${connectivityMs}ms | Primary=${primaryMs}ms | Secondary=${secondaryMs}ms`;
}

async function runDreaminaProxyPrecheckForProxy(proxy, options = {}) {
  const {
    runtime = {},
    logInfo = console.log,
  } = options;

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

  return await runDreaminaProxyPrecheckForProxy(proxy, { runtime, logInfo });
}

async function runDreaminaProxyPrecheckAll(options = {}) {
  const {
    runtime = {},
    logInfo = console.log,
    concurrency = 3,
  } = options;

  const proxies = loadLocalProxies(options);
  const results = new Array(proxies.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= proxies.length) return;
      const proxy = proxies[currentIndex];
      const result = await runDreaminaProxyPrecheckForProxy(proxy, { runtime, logInfo });
      results[currentIndex] = result;
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, proxies.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

if (require.main === module) {
  const arg = String(process.argv[2] || '').trim();
  const isAllMode = arg === '--all';
  const concurrency = Number(process.argv[3] || 3);

  if (isAllMode) {
    runDreaminaProxyPrecheckAll({ concurrency })
      .then(results => {
        results.forEach((result, index) => {
          console.log(formatProxyPrecheckSummary(result, index));
        });
        console.log(JSON.stringify(results, null, 2));
        const allSuccess = results.every(item => item?.success);
        process.exit(allSuccess ? 0 : 1);
      })
      .catch(error => {
        console.error(error);
        process.exit(1);
      });
  } else {
    const preferredIndex = Number(arg || 0);
    runDreaminaProxyPrecheck({ preferredIndex })
      .then(result => {
        console.log(formatProxyPrecheckSummary(result, preferredIndex));
        console.log(JSON.stringify(result, null, 2));
        process.exit(result?.success ? 0 : 1);
      })
      .catch(error => {
        console.error(error);
        process.exit(1);
      });
  }
}

module.exports = {
  selectLocalProxy,
  formatProxyPrecheckSummary,
  runDreaminaProxyPrecheckForProxy,
  runDreaminaProxyPrecheck,
  runDreaminaProxyPrecheckAll,
};
