'use strict';

/**
 * Shared browser fingerprint policy for staged architecture.
 *
 * Goal:
 * - provide one unified place for runtime/browser environment defaults
 * - allow low-risk randomization without leaking ad-hoc fingerprint logic into stages
 * - keep current policy intentionally conservative
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

const LOCALES = ['en-US', 'en-GB'];
const TIMEZONES = ['Asia/Shanghai', 'Asia/Singapore', 'America/New_York'];
const COLOR_SCHEMES = ['light', 'dark'];
const DEVICE_SCALE_FACTORS = [1, 1.25];

function pickOne(list = [], fallback = null) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return fallback;
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? fallback;
}

function resolveViewport(runtime = {}, windowLayout = null) {
  if (windowLayout?.viewport && Number(windowLayout.viewport.width) > 0 && Number(windowLayout.viewport.height) > 0) {
    return {
      width: Number(windowLayout.viewport.width),
      height: Number(windowLayout.viewport.height),
    };
  }

  if (Number(runtime?.viewportWidth) > 0 && Number(runtime?.viewportHeight) > 0) {
    return {
      width: Number(runtime.viewportWidth),
      height: Number(runtime.viewportHeight),
    };
  }

  return { ...pickOne(VIEWPORTS, VIEWPORTS[1]) };
}

function createRandomFingerprint(runtime = {}, options = {}) {
  const enabled = Boolean(runtime?.enableRandomFingerprint ?? true);
  const windowLayout = options?.windowLayout || null;

  const viewport = resolveViewport(runtime, windowLayout);
  const fingerprint = {
    userAgent: String(runtime?.userAgent || (enabled ? pickOne(USER_AGENTS, USER_AGENTS[0]) : USER_AGENTS[0])),
    viewport,
    locale: String(runtime?.locale || (enabled ? pickOne(LOCALES, LOCALES[0]) : LOCALES[0])),
    timezoneId: String(runtime?.timezoneId || (enabled ? pickOne(TIMEZONES, TIMEZONES[0]) : TIMEZONES[0])),
    colorScheme: String(runtime?.colorScheme || (enabled ? pickOne(COLOR_SCHEMES, COLOR_SCHEMES[0]) : COLOR_SCHEMES[0])),
    deviceScaleFactor: Number(runtime?.deviceScaleFactor || (enabled ? pickOne(DEVICE_SCALE_FACTORS, DEVICE_SCALE_FACTORS[0]) : DEVICE_SCALE_FACTORS[0])),
  };

  return {
    ...fingerprint,
    summary: {
      userAgent: fingerprint.userAgent,
      viewport: `${fingerprint.viewport.width}x${fingerprint.viewport.height}`,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      randomEnabled: enabled,
    },
  };
}

function buildContextFingerprintOptions(runtime = {}, options = {}) {
  const fingerprint = createRandomFingerprint(runtime, options);
  return {
    fingerprint,
    contextOptions: {
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      userAgent: fingerprint.userAgent,
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      ignoreHTTPSErrors: true,
    },
  };
}

module.exports = {
  createRandomFingerprint,
  buildContextFingerprintOptions,
};
