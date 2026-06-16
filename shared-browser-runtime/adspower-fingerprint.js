'use strict';

const { createRandomFingerprint } = require('./fingerprint');
const { summarizeHardeningProfile } = require('./fingerprint-hardening');

const DEFAULT_ADSPOWER_IDENTITY = Object.freeze({
  enabled: true,
  stableByProxy: true,
  stableFingerprintTtlMs: 6 * 60 * 60 * 1000,
  alignGeoWithProxy: true,
  includeAcceptLanguageHeader: false,
  clearStorageOnStart: false,
});

function cleanString(value = '') {
  return String(value || '').trim();
}

function parseAcceptLanguage(acceptLanguage = '', locale = '') {
  const langs = cleanString(acceptLanguage)
    .split(',')
    .map((part) => part.trim().split(';')[0].trim())
    .filter(Boolean);
  if (locale && !langs.includes(locale)) langs.unshift(locale);
  if (!langs.length) langs.push('en-US', 'en');
  const out = [];
  for (const lang of langs) {
    if (!out.includes(lang)) out.push(lang);
    const base = lang.split('-')[0];
    if (base && base !== lang && !out.includes(base)) out.push(base);
  }
  return out.slice(0, 4);
}

function normalizeProxyForRuntime(proxy = null) {
  if (!proxy || typeof proxy !== 'object') return null;
  if (proxy.server) {
    return {
      server: cleanString(proxy.server),
      username: cleanString(proxy.username || proxy.user),
      password: cleanString(proxy.password || proxy.pass),
      countryCode: cleanString(proxy.countryCode || proxy.proxyCountryCode || proxy.country),
      identityKey: cleanString(proxy.identityKey || proxy.proxyKey),
    };
  }

  const host = cleanString(proxy.host || proxy.proxy_host);
  const port = cleanString(proxy.port || proxy.proxy_port);
  if (!host || !port) return null;
  let type = cleanString(proxy.type || proxy.proxy_type || 'socks5').toLowerCase();
  if (type === 'socks' || type === 'socks5h') type = 'socks5';
  return {
    server: `${type}://${host}:${port}`,
    username: cleanString(proxy.username || proxy.user || proxy.proxy_user),
    password: cleanString(proxy.password || proxy.pass || proxy.proxy_password),
    countryCode: cleanString(proxy.countryCode || proxy.proxyCountryCode || proxy.country),
    identityKey: cleanString(proxy.identityKey || proxy.proxyKey),
  };
}

function resolveScreenResolution(fingerprint = {}, options = {}) {
  const explicit = cleanString(options.screenResolution || options.screen_resolution);
  if (explicit) return explicit.replace(/x/i, '_');
  const hardening = fingerprint.hardening || {};
  const width = Number(hardening.screen?.width || fingerprint.viewport?.width || 1366);
  const height = Number(hardening.screen?.height || fingerprint.viewport?.height || 768);
  return `${width}_${height}`;
}

function buildAdsPowerFingerprintConfig(fingerprint = {}, options = {}) {
  const hardening = fingerprint.hardening || {};
  const languages = Array.isArray(options.languages) && options.languages.length
    ? options.languages.map(cleanString).filter(Boolean)
    : (
        Array.isArray(hardening.navigator?.languages) && hardening.navigator.languages.length
          ? hardening.navigator.languages
          : parseAcceptLanguage(fingerprint.acceptLanguage, fingerprint.locale)
      );
  const language = languages.length ? languages.slice(0, 4) : ['en-US', 'en'];
  const proxyEnabled = Boolean(options.proxyEnabled || options.proxy || options.hasProxy);
  const hardwareConcurrency = Number(hardening.navigator?.hardwareConcurrency || options.hardwareConcurrency || 8);
  const deviceMemory = Number(hardening.navigator?.deviceMemory || options.deviceMemory || 8);

  return {
    automatic_timezone: cleanString(options.automaticTimezone || options.automatic_timezone || '1'),
    language,
    language_switch: cleanString(options.languageSwitch || options.language_switch || '0'),
    ua: cleanString(options.userAgent || fingerprint.userAgent),
    screen_resolution: resolveScreenResolution(fingerprint, options),
    fonts: Array.isArray(options.fonts) && options.fonts.length
      ? options.fonts
      : (options.useSharedFonts === true && Array.isArray(hardening.fonts?.list) && hardening.fonts.list.length ? hardening.fonts.list : ['all']),
    canvas: hardening.canvas?.enabled === false ? '0' : '1',
    webgl_image: hardening.webgl?.enabled === false ? '0' : '1',
    webgl: cleanString(options.webgl || '0'),
    audio: hardening.audio?.enabled === false ? '0' : '1',
    media_devices: hardening.mediaDevices?.enabled === false ? '0' : '1',
    client_rects: hardening.clientRects?.enabled === false ? '0' : '1',
    hardware_concurrency: String(Math.max(2, hardwareConcurrency || 8)),
    device_memory: String(Math.max(2, Math.min(8, deviceMemory || 8))),
    webrtc: cleanString(options.webrtc || (proxyEnabled ? 'proxy' : 'disabled')),
    do_not_track: cleanString(options.doNotTrack || options.do_not_track || 'default'),
  };
}

function buildAdsPowerFingerprintPayload(runtime = {}, options = {}) {
  const proxy = normalizeProxyForRuntime(options.proxy || null);
  const browserIdentity = {
    ...DEFAULT_ADSPOWER_IDENTITY,
    ...(runtime.browserIdentity && typeof runtime.browserIdentity === 'object' ? runtime.browserIdentity : {}),
    ...(options.browserIdentity && typeof options.browserIdentity === 'object' ? options.browserIdentity : {}),
  };
  const identityKey = cleanString(
    options.identityKey
    || options.seed
    || options.identity?.identityKey
    || proxy?.identityKey
    || proxy?.server
  );
  const fingerprint = createRandomFingerprint({
    ...runtime,
    browserIdentity,
  }, {
    proxy,
    account: options.account || null,
    browserIdentity,
    identity: identityKey ? { ...(options.identity || {}), identityKey } : (options.identity || null),
    hardeningSeed: cleanString(options.hardeningSeed || options.seed || identityKey),
    windowLayout: options.windowLayout || null,
  });
  const config = buildAdsPowerFingerprintConfig(fingerprint, {
    ...(options.adspower && typeof options.adspower === 'object' ? options.adspower : {}),
    proxy,
    proxyEnabled: Boolean(proxy?.server),
  });

  return {
    fingerprint,
    config,
    summary: fingerprint.summary,
    hardening: summarizeHardeningProfile(fingerprint.hardening),
  };
}

module.exports = {
  DEFAULT_ADSPOWER_IDENTITY,
  buildAdsPowerFingerprintConfig,
  buildAdsPowerFingerprintPayload,
  normalizeProxyForRuntime,
};
