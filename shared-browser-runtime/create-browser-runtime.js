'use strict';

const { chromium } = require('playwright');
const { buildContextFingerprintOptions } = require('./fingerprint');

function normalizeBlockedResourceTypes(input = null) {
  return Array.isArray(input)
    ? input.map(item => String(item || '').trim().toLowerCase()).filter(Boolean)
    : ['image', 'media', 'font'];
}

function buildLaunchOptions(options = {}) {
  const headed = Boolean(options?.headed);
  const slowMo = Number.isFinite(Number(options?.slowMo)) ? Number(options.slowMo) : 0;
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;
  const proxy = options?.proxy && typeof options.proxy === 'object' ? options.proxy : null;

  const launchOptions = {
    headless: !headed,
    slowMo,
  };

  if (headed && windowLayout?.enabled) {
    launchOptions.args = [
      ...(Array.isArray(launchOptions.args) ? launchOptions.args : []),
      `--window-position=${Number(windowLayout.x || 0)},${Number(windowLayout.y || 0)}`,
      `--window-size=${Number(windowLayout.width || 1440)},${Number(windowLayout.height || 900)}`,
    ];
  }

  if (proxy?.server) {
    launchOptions.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  return launchOptions;
}

async function applyResourcePolicy(context, blockedResourceTypes = []) {
  const blocked = normalizeBlockedResourceTypes(blockedResourceTypes);
  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = String(request.resourceType() || '').trim().toLowerCase();
    if (blocked.includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}

async function createBrowserRuntime(options = {}) {
  const runtime = options?.runtime && typeof options.runtime === 'object' ? options.runtime : {};
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;
  const launchOptions = buildLaunchOptions(options);
  const browser = await chromium.launch(launchOptions);
  const { fingerprint, contextOptions } = buildContextFingerprintOptions(runtime, { windowLayout });
  const context = await browser.newContext(contextOptions);
  await applyResourcePolicy(context, options?.blockedResourceTypes);
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    fingerprint,
    launchOptions,
    contextOptions,
  };
}

module.exports = {
  normalizeBlockedResourceTypes,
  buildLaunchOptions,
  applyResourcePolicy,
  createBrowserRuntime,
};
