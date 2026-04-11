'use strict';

const { chromium } = require('playwright');
const { loadLocalProxies, summarizeProxy } = require('./shared-proxy-precheck/local-proxy-loader');
const { runProxyPrecheckChain } = require('./shared-proxy-precheck/stages/proxy-precheck');
const dreaminaProxyPrecheckAdapter = require('./shared-proxy-precheck/dreamina/proxy-precheck-adapter');

function selectLocalProxy(proxies = [], options = {}) {
  const list = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
  const preferredIndex = Number.isFinite(Number(options.preferredIndex)) ? Number(options.preferredIndex) : 0;
  if (!list.length) return null;
  return list[Math.max(0, Math.min(preferredIndex, list.length - 1))] || null;
}

function toPlaywrightProxyServer(proxy = {}) {
  const protocol = String(proxy.protocol || 'http').trim() || 'http';
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  return `${protocol}://${host}:${port}`;
}

async function runDreaminaProxyPrecheck(options = {}) {
  const {
    preferredIndex = 0,
    headless = true,
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

  const browser = await chromium.launch({
    headless: Boolean(headless),
    proxy: {
      server: toPlaywrightProxyServer(proxy),
      username: String(proxy.username || ''),
      password: String(proxy.password || ''),
    },
  });

  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();

  try {
    const result = await runProxyPrecheckChain({
      page,
      proxy,
      adapter: dreaminaProxyPrecheckAdapter,
      runtime,
      context: {
        logInfo: typeof logInfo === 'function' ? logInfo : null,
        browser,
        browserContext,
        page,
        proxy,
        proxySummary: summarizeProxy(proxy),
      },
    });

    return {
      ...result,
      proxy,
      proxySummary: summarizeProxy(proxy),
    };
  } finally {
    await page.close().catch(() => {});
    await browserContext.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  const preferredIndex = Number(process.argv[2] || 0);
  runDreaminaProxyPrecheck({ preferredIndex, headless: true })
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
  toPlaywrightProxyServer,
  runDreaminaProxyPrecheck,
};
