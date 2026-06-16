#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const {
  buildContextFingerprintOptions,
  buildFingerprintHardeningInitScript,
  summarizeHardeningProfile,
} = require('../shared-browser-runtime');

function parseArgs(argv = []) {
  const args = { headed: false, json: false, url: 'about:blank' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--headed') args.headed = true;
    else if (item === '--json') args.json = true;
    else if (item === '--url') args.url = argv[++index] || args.url;
    else if (item === '--ua') args.userAgent = argv[++index] || '';
    else if (item === '--locale') args.locale = argv[++index] || '';
    else if (item === '--timezone') args.timezoneId = argv[++index] || '';
    else if (item === '--webrtc') args.webrtcMode = argv[++index] || '';
  }
  return args;
}

function buildRuntime(args = {}) {
  const runtime = {};
  if (args.userAgent) runtime.userAgent = args.userAgent;
  if (args.locale) runtime.locale = args.locale;
  if (args.timezoneId) runtime.timezoneId = args.timezoneId;
  if (args.webrtcMode) runtime.webrtcMode = args.webrtcMode;
  return runtime;
}

async function collectProbe(page) {
  await page.setContent('<div id="probe" style="width:10px;height:20px">abc</div><canvas id="canvas" width="12" height="12"></canvas>');
  return page.evaluate(async () => {
    const element = document.getElementById('probe');
    const canvas = document.getElementById('canvas');
    const rect = element.getBoundingClientRect();
    const rects = element.getClientRects();
    const ctx = canvas.getContext('2d');
    const metrics = ctx.measureText('abc');
    const permission = await navigator.permissions.query({ name: 'notifications' }).catch((error) => ({ error: String(error && error.message || error) }));
    const devices = navigator.mediaDevices && navigator.mediaDevices.enumerateDevices
      ? await navigator.mediaDevices.enumerateDevices().catch(() => [])
      : [];
    const uaData = navigator.userAgentData
      ? await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'platformVersion', 'uaFullVersion']).catch(() => null)
      : null;

    return {
      navigator: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: Array.from(navigator.languages || []),
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        webdriver: navigator.webdriver,
        userAgentData: uaData,
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
      },
      shapes: {
        rectCtor: rect.constructor && rect.constructor.name,
        rectTag: Object.prototype.toString.call(rect),
        rectsArray: Array.isArray(rects),
        rectsTag: Object.prototype.toString.call(rects),
        metricsCtor: metrics.constructor && metrics.constructor.name,
        metricsTag: Object.prototype.toString.call(metrics),
        permissionCtor: permission.constructor && permission.constructor.name,
        permissionTag: Object.prototype.toString.call(permission),
        mediaDevicePlainObjects: devices.some((device) => Object.prototype.toString.call(device) === '[object Object]'),
      },
      nativeStrings: {
        canvasToDataURL: HTMLCanvasElement.prototype.toDataURL.toString(),
        getBoundingClientRect: Element.prototype.getBoundingClientRect.toString(),
        permissionsQuery: navigator.permissions && navigator.permissions.query ? navigator.permissions.query.toString() : '',
      },
    };
  });
}

function renderText(report = {}) {
  const nav = report.probe.navigator;
  const shapes = report.probe.shapes;
  return [
    'Shared browser fingerprint probe',
    `UA: ${nav.userAgent}`,
    `UAData: ${nav.userAgentData ? JSON.stringify(nav.userAgentData.fullVersionList || []) : 'native/none'}`,
    `Locale: ${nav.language} / ${(nav.languages || []).join(', ')}`,
    `Platform: ${nav.platform}, cores=${nav.hardwareConcurrency}, memory=${nav.deviceMemory}`,
    `WebDriver: ${String(nav.webdriver)}`,
    `Screen: ${report.probe.screen.width}x${report.probe.screen.height}, avail=${report.probe.screen.availWidth}x${report.probe.screen.availHeight}`,
    `DOMRect: ${shapes.rectCtor} ${shapes.rectTag}; DOMRectList=${shapes.rectsTag}; TextMetrics=${shapes.metricsCtor}`,
    `PermissionStatus: ${shapes.permissionCtor} ${shapes.permissionTag}; media plain objects=${shapes.mediaDevicePlainObjects}`,
    `Hardening: ${JSON.stringify(report.hardening)}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = buildRuntime(args);
  const { fingerprint, contextOptions } = buildContextFingerprintOptions(runtime, {
    browserIdentity: {
      enabled: true,
      includeAcceptLanguageHeader: true,
      clearStorageOnStart: true,
    },
  });
  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const context = await browser.newContext(contextOptions);
    await context.addInitScript(buildFingerprintHardeningInitScript(fingerprint.hardening));
    const page = await context.newPage();
    if (args.url && args.url !== 'about:blank') {
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    await page.evaluate(buildFingerprintHardeningInitScript(fingerprint.hardening)).catch(() => {});
    const report = {
      summary: fingerprint.summary,
      hardening: summarizeHardeningProfile(fingerprint.hardening),
      probe: await collectProbe(page),
    };
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
