const { test, expect } = require('@playwright/test');

const {
  buildAdsPowerFingerprintPayload,
  buildFingerprintHardeningInitScript,
  buildFingerprintHardeningProfile,
  buildCdpUserAgentOverride,
  buildContextFingerprintOptions,
  createRandomFingerprint,
  resolveGeoProfile,
} = require('../shared-browser-runtime');

test('browser identity keeps the same proxy fingerprint stable inside TTL', () => {
  const proxy = {
    server: 'http://proxy.example:8080',
    username: 'user',
    password: 'secret',
    countryCode: 'US',
  };
  const runtime = {
    browserIdentity: {
      stableFingerprintTtlMs: 24 * 60 * 60 * 1000,
    },
  };

  const first = createRandomFingerprint(runtime, { proxy });
  const second = createRandomFingerprint(runtime, { proxy });

  expect(second.userAgent).toBe(first.userAgent);
  expect(second.viewport).toEqual(first.viewport);
  expect(second.colorScheme).toBe(first.colorScheme);
  expect(second.deviceScaleFactor).toBe(first.deviceScaleFactor);
  expect(second.summary.identityStable).toBe(true);
  expect(second.summary.identitySeed).toBe(first.summary.identitySeed);
  expect(second.summary.identityKey).toBe('proxy.example:8080');
  expect(second.summary.identityHash).toHaveLength(16);
  expect(second.hardening.seedHash).toBe(first.hardening.seedHash);
  expect(second.hardening.webgl.renderer).toBe(first.hardening.webgl.renderer);
  expect(second.hardening.canvas.noise).toEqual(first.hardening.canvas.noise);
});

test('browser identity changes seed when proxy identity changes', () => {
  const runtime = {
    browserIdentity: {
      stableFingerprintTtlMs: 24 * 60 * 60 * 1000,
    },
  };

  const first = createRandomFingerprint(runtime, {
    proxy: { server: 'http://proxy-a.example:8080', countryCode: 'US' },
  });
  const second = createRandomFingerprint(runtime, {
    proxy: { server: 'http://proxy-b.example:8080', countryCode: 'US' },
  });

  expect(second.summary.identityStable).toBe(true);
  expect(second.summary.identitySeed).not.toBe(first.summary.identitySeed);
  expect(second.hardening.seedHash).not.toBe(first.hardening.seedHash);
});

test('browser identity aligns locale timezone and language with proxy country', () => {
  const { fingerprint, contextOptions } = buildContextFingerprintOptions({}, {
    proxy: { server: 'http://sg-proxy.example:8080', countryCode: 'SG' },
  });

  expect(fingerprint.locale).toBe('en-SG');
  expect(fingerprint.timezoneId).toBe('Asia/Singapore');
  expect(fingerprint.acceptLanguage).toBe('en-SG,en;q=0.9');
  expect(contextOptions.extraHTTPHeaders['Accept-Language']).toBe('en-SG,en;q=0.9');
  expect(fingerprint.summary.countryCode).toBe('SG');
  expect(fingerprint.summary.geoSource).toBe('country-profile');
  expect(fingerprint.hardening.navigator.languages[0]).toBe('en-SG');
});

test('fingerprint hardening init script covers expected browser surfaces', () => {
  const fingerprint = createRandomFingerprint({}, {
    proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
  });
  const script = buildFingerprintHardeningInitScript(fingerprint.hardening);

  expect(script).toContain('HTMLCanvasElement');
  expect(script).toContain('toDataURL');
  expect(script).toContain('CanvasRenderingContext2D');
  expect(script).toContain('WebGLRenderingContext');
  expect(script).toContain('AudioBuffer');
  expect(script).toContain('hardwareConcurrency');
  expect(script).toContain("'webdriver', undefined");
  expect(script).toContain('measureText');
  expect(script).toContain('getClientRects');
  expect(script).toContain('enumerateDevices');
  expect(script).toContain('permissions');
  expect(script).toContain('userAgentData');
  expect(script).toContain('RTCPeerConnection');
});

test('userAgentData follows explicit UA and can be disabled for native UA mode', () => {
  const explicit = createRandomFingerprint({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.61 Safari/537.36',
  });
  const uaData = explicit.hardening.navigator.userAgentData;

  expect(explicit.userAgent).toContain('Chrome/142.0.7444.61');
  expect(uaData.brands.some(item => item.version === '142')).toBe(true);
  expect(uaData.fullVersionList.some(item => item.version === '142.0.7444.61')).toBe(true);
  expect(uaData.uaFullVersion).toBe('142.0.7444.61');

  const native = createRandomFingerprint({ userAgent: null });
  expect(native.userAgent).toBeNull();
  expect(native.hardening.navigator.userAgentData).toBeNull();
});

test('runtime can override UAData version without hard-coded fallback drift', () => {
  const profile = buildFingerprintHardeningProfile({
    userAgent: null,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9',
    identity: { identitySeed: 'seed-a', identityHash: 'hash-a' },
  }, {
    runtime: {
      chromeFullVersion: '143.0.7499.40',
    },
  });

  expect(profile.navigator.userAgentData.uaFullVersion).toBe('143.0.7499.40');
  expect(profile.navigator.userAgentData.brands.some(item => item.version === '143')).toBe(true);
  expect(profile.navigator.userAgentData.fullVersionList.some(item => item.version === '143.0.7499.40')).toBe(true);
});

test('CDP UA override mirrors fingerprint UAData and language', () => {
  const fingerprint = createRandomFingerprint({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
  });
  const override = buildCdpUserAgentOverride(fingerprint);

  expect(override.userAgent).toBe(fingerprint.userAgent);
  expect(override.acceptLanguage).toBe('en-US,en;q=0.9');
  expect(override.userAgentMetadata.brands.some(item => item.version === '141')).toBe(true);
  expect(override.userAgentMetadata.fullVersionList.some(item => item.version === '141.0.7390.122')).toBe(true);
});

test('WebRTC hardening supports filter proxy and disabled modes', () => {
  const filterProfile = buildFingerprintHardeningProfile({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    identity: { identitySeed: 'seed-a', identityHash: 'hash-a' },
  });
  expect(filterProfile.webrtc.enabled).toBe(true);
  expect(filterProfile.webrtc.mode).toBe('filter-host-candidates');

  const proxyProfile = buildFingerprintHardeningProfile({
    userAgent: filterProfile.userAgent,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    identity: { identitySeed: 'seed-a', identityHash: 'hash-a' },
  }, {
    runtime: { webrtcMode: 'proxy' },
  });
  expect(proxyProfile.webrtc.enabled).toBe(true);
  expect(proxyProfile.webrtc.mode).toBe('proxy');
  expect(buildFingerprintHardeningInitScript(proxyProfile)).toContain("iceTransportPolicy = iceServers.length ? 'relay' : 'all'");

  const disabledProfile = buildFingerprintHardeningProfile({
    userAgent: filterProfile.userAgent,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    identity: { identitySeed: 'seed-a', identityHash: 'hash-a' },
  }, {
    runtime: { fingerprintHardening: { webrtc: 'disabled' } },
  });
  expect(disabledProfile.webrtc.enabled).toBe(false);
  expect(disabledProfile.webrtc.mode).toBe('disabled');
  expect(buildFingerprintHardeningInitScript(disabledProfile)).toContain('RTCPeerConnection is disabled');
});

test('fingerprint hardening profile can be disabled by runtime policy', () => {
  const profile = buildFingerprintHardeningProfile({
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9',
    identity: { identitySeed: 'seed-a', identityHash: 'hash-a' },
  }, {
    runtime: { fingerprintHardening: { enabled: false } },
  });

  expect(profile.enabled).toBe(false);
  expect(profile.canvas.enabled).toBe(false);
  expect(profile.webgl.enabled).toBe(false);
  expect(profile.fonts.enabled).toBe(false);
  expect(profile.clientRects.enabled).toBe(false);
  expect(profile.mediaDevices.enabled).toBe(false);
  expect(profile.permissions.enabled).toBe(false);
});

test.describe('Chromium hardening shape probes', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'shape probe targets Chromium runtime objects');

  test('fingerprint hardening keeps native-like browser object shapes', async ({ page }) => {
    const fingerprint = createRandomFingerprint({}, {
      proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
    });
    const script = buildFingerprintHardeningInitScript(fingerprint.hardening);
    await page.addInitScript(script);
    await page.setContent('<div id="probe" style="width:10px;height:20px">abc</div><canvas id="c" width="10" height="10"></canvas>');
    await page.evaluate(script);

    const shape = await page.evaluate(async () => {
      const element = document.getElementById('probe');
      const rect = element.getBoundingClientRect();
      const rects = element.getClientRects();
      const permission = await navigator.permissions.query({ name: 'notifications' });
      const context = document.getElementById('c').getContext('2d');
      const metrics = context.measureText('abc');
      const devices = await navigator.mediaDevices.enumerateDevices();

      return {
        rectCtor: rect.constructor && rect.constructor.name,
        rectInstance: typeof DOMRect !== 'undefined' && rect instanceof DOMRect,
        rectTag: Object.prototype.toString.call(rect),
        rectsArray: Array.isArray(rects),
        rectsTag: Object.prototype.toString.call(rects),
        permissionCtor: permission.constructor && permission.constructor.name,
        permissionTag: Object.prototype.toString.call(permission),
        metricsCtor: metrics.constructor && metrics.constructor.name,
        metricsInstance: typeof TextMetrics !== 'undefined' && metrics instanceof TextMetrics,
        devicePlainObjects: devices.some((device) => Object.prototype.toString.call(device) === '[object Object]'),
        canvasToString: HTMLCanvasElement.prototype.toDataURL.toString(),
        rectToString: Element.prototype.getBoundingClientRect.toString(),
      };
    });

    expect(shape.rectCtor).toBe('DOMRect');
    expect(shape.rectInstance).toBe(true);
    expect(shape.rectTag).toBe('[object DOMRect]');
    expect(shape.rectsArray).toBe(false);
    expect(shape.rectsTag).toBe('[object DOMRectList]');
    expect(shape.permissionCtor).toBe('PermissionStatus');
    expect(shape.permissionTag).toBe('[object PermissionStatus]');
    expect(shape.metricsCtor).toBe('TextMetrics');
    expect(shape.metricsInstance).toBe(true);
    expect(shape.devicePlainObjects).toBe(false);
    expect(shape.canvasToString).toContain('[native code]');
    expect(shape.rectToString).toContain('[native code]');
  });
});

test('runtime overrides win over browser identity geo alignment', () => {
  const { fingerprint, contextOptions } = buildContextFingerprintOptions({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    acceptLanguage: 'en-US,en;q=0.8',
  }, {
    proxy: { server: 'http://jp-proxy.example:8080', countryCode: 'JP' },
  });

  expect(fingerprint.locale).toBe('en-US');
  expect(fingerprint.timezoneId).toBe('America/Los_Angeles');
  expect(contextOptions.extraHTTPHeaders['Accept-Language']).toBe('en-US,en;q=0.8');
});

test('geo profile resolver reports country fallback for unknown country codes', () => {
  const geo = resolveGeoProfile({}, {
    proxy: { countryCode: 'ZZ' },
  });

  expect(geo.countryCode).toBe('ZZ');
  expect(geo.profile).toBeNull();
  expect(geo.source).toBe('country-fallback');
});

test('Dreamina 0.0.4 browser runtime forwards to shared browser runtime', () => {
  const sharedRuntime = require('../shared-browser-runtime');
  const dreaminaRuntime = require('../Dreamina/0.0.4/lib/browser-runtime');
  const dreaminaFingerprint = require('../Dreamina/0.0.4/lib/browser-runtime/fingerprint');
  const dreaminaCreateRuntime = require('../Dreamina/0.0.4/lib/browser-runtime/create-browser-runtime');

  expect(dreaminaRuntime.createBrowserRuntime).toBe(sharedRuntime.createBrowserRuntime);
  expect(dreaminaRuntime.buildContextFingerprintOptions).toBe(sharedRuntime.buildContextFingerprintOptions);
  expect(dreaminaFingerprint.createRandomFingerprint).toBe(sharedRuntime.createRandomFingerprint);
  expect(dreaminaCreateRuntime.createBrowserRuntime).toBe(sharedRuntime.createBrowserRuntime);
});

test('connected runtime identity can stay passive for attach-only engines', async () => {
  const { applyConnectedRuntimeIdentity } = require('../shared-browser-runtime/connected-runtime');
  const calls = [];
  const context = {
    setExtraHTTPHeaders: async (headers) => calls.push(['headers', headers]),
    clearCookies: async () => calls.push(['cookies']),
    addInitScript: async () => calls.push(['init']),
  };
  const page = {
    evaluate: async () => calls.push(['storage']),
  };

  const result = await applyConnectedRuntimeIdentity(context, page, {
    browserIdentity: {
      enabled: false,
      includeAcceptLanguageHeader: true,
      clearStorageOnStart: true,
    },
    proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
  });

  expect(result.fingerprint.summary.identityStable).toBe(false);
  expect(result.storageCleanup.cookiesCleared).toBe(false);
  expect(result.fingerprint.summary.connectedIdentityMode).toBe('explicit');
  expect(calls).toEqual([]);
});

test('connected runtime defaults to passive attach mode when identity is omitted', async () => {
  const { applyConnectedRuntimeIdentity } = require('../shared-browser-runtime/connected-runtime');
  const calls = [];
  const context = {
    setExtraHTTPHeaders: async (headers) => calls.push(['headers', headers]),
    clearCookies: async () => calls.push(['cookies']),
    addInitScript: async () => calls.push(['init']),
  };
  const page = {
    evaluate: async () => calls.push(['storage']),
  };

  const result = await applyConnectedRuntimeIdentity(context, page, {
    proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
  });

  expect(result.fingerprint.summary.connectedIdentityMode).toBe('passive');
  expect(result.storageCleanup.cookiesCleared).toBe(false);
  expect(result.fingerprint.summary.hardeningInjected).toBe(false);
  expect(calls).toEqual([]);
});

test('connected runtime can explicitly inject hardening for attach-only engines', async () => {
  const { applyConnectedRuntimeIdentity } = require('../shared-browser-runtime/connected-runtime');
  const calls = [];
  const context = {
    addInitScript: async () => calls.push(['init']),
    newCDPSession: async () => ({
      send: async (method, payload) => calls.push(['cdp', method, payload]),
    }),
  };
  const page = {
    evaluate: async () => calls.push(['current']),
  };

  const result = await applyConnectedRuntimeIdentity(context, page, {
    runtime: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.61 Safari/537.36',
      fingerprintHardening: { enabled: true },
    },
    proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
  });

  expect(result.fingerprint.summary.connectedIdentityMode).toBe('passive');
  expect(result.fingerprint.summary.hardeningInjected).toBe(true);
  expect(result.fingerprint.hardeningRuntime.appliedToCurrentPage).toBe(true);
  expect(result.fingerprint.summary.cdpUserAgentOverride).toBe(true);
  expect(calls.map(item => item[0])).toEqual(['cdp', 'cdp', 'init', 'current']);
  expect(calls[1][1]).toBe('Network.setUserAgentOverride');
  expect(calls[1][2].userAgentMetadata.fullVersionList.some(item => item.version === '142.0.7444.61')).toBe(true);
});

test('connected runtime hardening alone does not override provider UA', async () => {
  const { applyConnectedRuntimeIdentity } = require('../shared-browser-runtime/connected-runtime');
  const calls = [];
  const context = {
    addInitScript: async () => calls.push(['init']),
    newCDPSession: async () => ({
      send: async (method, payload) => calls.push(['cdp', method, payload]),
    }),
  };
  const page = {
    evaluate: async () => calls.push(['current']),
  };

  const result = await applyConnectedRuntimeIdentity(context, page, {
    fingerprintHardening: { enabled: true },
    proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
  });

  expect(result.fingerprint.summary.hardeningInjected).toBe(true);
  expect(result.fingerprint.summary.cdpUserAgentOverride).toBeUndefined();
  expect(calls.map(item => item[0])).toEqual(['init', 'current']);
});

test('connected runtime can force CDP UA override when requested', async () => {
  const { applyConnectedRuntimeIdentity } = require('../shared-browser-runtime/connected-runtime');
  const calls = [];
  const context = {
    addInitScript: async () => calls.push(['init']),
    newCDPSession: async () => ({
      send: async (method, payload) => calls.push(['cdp', method, payload]),
    }),
  };
  const page = {
    evaluate: async () => calls.push(['current']),
  };

  const result = await applyConnectedRuntimeIdentity(context, page, {
    fingerprintHardening: { enabled: true },
    forceCdpUserAgentOverride: true,
    proxy: { server: 'http://proxy.example:8080', countryCode: 'US' },
  });

  expect(result.fingerprint.summary.cdpUserAgentOverride).toBe(true);
  expect(calls.map(item => item[0])).toEqual(['cdp', 'cdp', 'init', 'current']);
});

test('connected runtime identity applies headers and cleanup when enabled', async () => {
  const { applyConnectedRuntimeIdentity } = require('../shared-browser-runtime/connected-runtime');
  const calls = [];
  const context = {
    setExtraHTTPHeaders: async (headers) => calls.push(['headers', headers]),
    clearCookies: async () => calls.push(['cookies']),
  };
  const page = {
    evaluate: async () => calls.push(['storage']),
  };

  const result = await applyConnectedRuntimeIdentity(context, page, {
    browserIdentity: {
      enabled: true,
      includeAcceptLanguageHeader: true,
      clearStorageOnStart: true,
    },
    proxy: { server: 'http://sg-proxy.example:8080', countryCode: 'SG' },
  });

  expect(result.fingerprint.acceptLanguage).toBe('en-SG,en;q=0.9');
  expect(result.storageCleanup.cookiesCleared).toBe(true);
  expect(result.storageCleanup.storageCleared).toBe(true);
  expect(calls[0]).toEqual(['headers', { 'Accept-Language': 'en-SG,en;q=0.9' }]);
  expect(calls.map(item => item[0])).toEqual(['headers', 'cookies', 'storage']);
});

test('AdsPower fingerprint payload reuses shared browser identity surfaces', () => {
  const payload = buildAdsPowerFingerprintPayload({}, {
    proxy: { type: 'socks5', host: 'proxy.example', port: '1080', countryCode: 'SG' },
    seed: 'proxy.example:1080',
    adspower: { screenResolution: '1920_1080' },
  });

  expect(payload.config.ua).toBe(payload.fingerprint.userAgent);
  expect(payload.config.screen_resolution).toBe('1920_1080');
  expect(payload.config.language[0]).toBe('en-SG');
  expect(payload.config.fonts).toEqual(['all']);
  expect(payload.config.client_rects).toBe('1');
  expect(payload.config.media_devices).toBe('1');
  expect(payload.config.hardware_concurrency).toBe(String(payload.fingerprint.hardening.navigator.hardwareConcurrency));
  expect(payload.config.device_memory).toBe(String(Math.min(8, payload.fingerprint.hardening.navigator.deviceMemory)));
  expect(payload.config.webrtc).toBe('proxy');
  expect(payload.summary.identityStable).toBe(true);
});

test('AdsPower fingerprint payload can opt into shared font list', () => {
  const payload = buildAdsPowerFingerprintPayload({}, {
    proxy: { type: 'socks5', host: 'proxy.example', port: '1080', countryCode: 'SG' },
    seed: 'proxy.example:1080',
    adspower: { useSharedFonts: true },
  });

  expect(payload.config.fonts).toEqual(payload.fingerprint.hardening.fonts.list);
});
