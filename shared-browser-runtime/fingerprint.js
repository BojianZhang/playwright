'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { buildFingerprintHardeningProfile } = require('./fingerprint-hardening');

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-browser-runtime
//
// 文件定位：shared-browser-runtime/fingerprint.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 统一维护浏览器指纹参数的默认池（UA / viewport / locale / timezone）。
// ✅ 负责 —— 根据 runtime 配置决策是否启用随机化，并从池中随机选取参数。
// ✅ 负责 —— 生成 Playwright newContext() 所需的 contextOptions 结构。
// ❌ 不负责 —— 浏览器启动（由 create-browser-runtime.js 负责）。
// ❌ 不负责 —— 窗口尺寸布局（由 shared-window-layout 计算后传入 windowLayout 参数）。
// ❌ 不负责 —— 任何业务逻辑。
//
// 调用方：create-browser-runtime.js → createBrowserRuntime()
// ═══════════════════════════════════════════════════════════════════════

/**
 * 内置 User-Agent 池（Windows + Chrome 最近 4 个主版本）。
 * 更新策略：每季度跟随 Chrome 大版本更新，移除最旧的一条。
 */
const FALLBACK_CHROME_MAJOR = 147;
let cachedUserAgents = null;

/**
 * 内置视口尺寸池（覆盖主流显示器分辨率）。
 * 视口优先级：windowLayout.viewport > runtime.viewportWidth/Height > 此池随机值。
 */
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

/** 内置 locale 池（仅保留 en-US / en-GB，避免触发平台语言检测规则）。 */
const LOCALES = ['en-US', 'en-GB'];

/** 内置时区池（覆盖常见目标市场时区）。 */
const TIMEZONES = ['Asia/Shanghai', 'Asia/Singapore', 'America/New_York'];

/** 内置色彩模式池。 */
const COLOR_SCHEMES = ['light', 'dark'];

/** 内置设备像素比池（保持保守，避免触发设备特征检测）。 */
const DEVICE_SCALE_FACTORS = [1, 1.25];

const DEFAULT_BROWSER_IDENTITY_POLICY = Object.freeze({
  enabled: true,
  stableByProxy: true,
  stableFingerprintTtlMs: 6 * 60 * 60 * 1000,
  alignGeoWithProxy: true,
  includeAcceptLanguageHeader: true,
  clearStorageOnStart: true,
});

const COUNTRY_GEO_PROFILES = Object.freeze({
  US: { locale: 'en-US', timezoneId: 'America/New_York', acceptLanguage: 'en-US,en;q=0.9' },
  GB: { locale: 'en-GB', timezoneId: 'Europe/London', acceptLanguage: 'en-GB,en;q=0.9' },
  UK: { locale: 'en-GB', timezoneId: 'Europe/London', acceptLanguage: 'en-GB,en;q=0.9' },
  CA: { locale: 'en-CA', timezoneId: 'America/Toronto', acceptLanguage: 'en-CA,en;q=0.9' },
  AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney', acceptLanguage: 'en-AU,en;q=0.9' },
  NZ: { locale: 'en-NZ', timezoneId: 'Pacific/Auckland', acceptLanguage: 'en-NZ,en;q=0.9' },
  SG: { locale: 'en-SG', timezoneId: 'Asia/Singapore', acceptLanguage: 'en-SG,en;q=0.9' },
  HK: { locale: 'en-HK', timezoneId: 'Asia/Hong_Kong', acceptLanguage: 'en-HK,en;q=0.9' },
  JP: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptLanguage: 'ja-JP,ja;q=0.9,en;q=0.7' },
  KR: { locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptLanguage: 'ko-KR,ko;q=0.9,en;q=0.7' },
  DE: { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en;q=0.7' },
  FR: { locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.7' },
  NL: { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.7' },
  ES: { locale: 'es-ES', timezoneId: 'Europe/Madrid', acceptLanguage: 'es-ES,es;q=0.9,en;q=0.7' },
  IT: { locale: 'it-IT', timezoneId: 'Europe/Rome', acceptLanguage: 'it-IT,it;q=0.9,en;q=0.7' },
  BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.7' },
  MX: { locale: 'es-MX', timezoneId: 'America/Mexico_City', acceptLanguage: 'es-MX,es;q=0.9,en;q=0.7' },
  IN: { locale: 'en-IN', timezoneId: 'Asia/Kolkata', acceptLanguage: 'en-IN,en;q=0.9' },
  ID: { locale: 'id-ID', timezoneId: 'Asia/Jakarta', acceptLanguage: 'id-ID,id;q=0.9,en;q=0.7' },
  TH: { locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptLanguage: 'th-TH,th;q=0.9,en;q=0.7' },
  VN: { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', acceptLanguage: 'vi-VN,vi;q=0.9,en;q=0.7' },
  PH: { locale: 'en-PH', timezoneId: 'Asia/Manila', acceptLanguage: 'en-PH,en;q=0.9' },
  MY: { locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur', acceptLanguage: 'en-MY,en;q=0.9' },
  TW: { locale: 'zh-TW', timezoneId: 'Asia/Taipei', acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.7' },
  CN: { locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.7' },
});

/**
 * 从列表中随机选取一项。
 *
 * 边界：列表为空或 undefined 时返回 fallback，不抛异常。
 *
 * @param {Array} list
 * @param {any} [fallback=null]
 * @returns {any}
 */
function pickOne(list = [], fallback = null) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return fallback;
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? fallback;
}

function resolveBundledChromiumMajor() {
  try {
    const browsersJsonPath = require.resolve('playwright-core/browsers.json');
    const payload = JSON.parse(fs.readFileSync(browsersJsonPath, 'utf8'));
    const chromium = (payload.browsers || []).find((item) => item && item.name === 'chromium');
    const version = String(chromium?.browserVersion || '').trim();
    const major = Number.parseInt(version.split('.')[0], 10);
    return Number.isFinite(major) && major > 0 ? major : FALLBACK_CHROME_MAJOR;
  } catch (_error) {
    return FALLBACK_CHROME_MAJOR;
  }
}

function buildUserAgentPool(runtime = {}) {
  if (Array.isArray(runtime?.userAgents) && runtime.userAgents.length) {
    return runtime.userAgents.map(String).filter(Boolean);
  }
  if (Array.isArray(runtime?.userAgentPool) && runtime.userAgentPool.length) {
    return runtime.userAgentPool.map(String).filter(Boolean);
  }
  if (cachedUserAgents) return cachedUserAgents;
  const currentMajor = resolveBundledChromiumMajor();
  cachedUserAgents = [0, 1, 2, 3]
    .map((offset) => Math.max(1, currentMajor - offset))
    .map((major) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`);
  return cachedUserAgents;
}

function normalizeBrowserIdentityPolicy(runtime = {}, options = {}) {
  const input = (
    options?.browserIdentity
    || options?.identity
    || runtime?.browserIdentity
    || runtime?.identity
    || {}
  );
  const policy = {
    ...DEFAULT_BROWSER_IDENTITY_POLICY,
    ...(input && typeof input === 'object' ? input : {}),
  };
  policy.enabled = Boolean(policy.enabled);
  policy.stableByProxy = Boolean(policy.stableByProxy);
  policy.stableFingerprintTtlMs = Math.max(0, Number(policy.stableFingerprintTtlMs || 0));
  policy.alignGeoWithProxy = Boolean(policy.alignGeoWithProxy);
  policy.includeAcceptLanguageHeader = Boolean(policy.includeAcceptLanguageHeader);
  policy.clearStorageOnStart = Boolean(policy.clearStorageOnStart);
  return policy;
}

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function pickStable(list = [], seed = '', offset = 0, fallback = null) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return fallback;
  const hash = hashText(`${seed}:${offset}`);
  const chunk = hash.slice(0, 12);
  const index = Number.parseInt(chunk, 16) % items.length;
  return items[index] ?? fallback;
}

function normalizeCountryCode(value = '') {
  const code = String(value || '').trim().toUpperCase();
  if (!code) return '';
  return code === 'UK' ? 'GB' : code;
}

function resolveCountryCode(runtime = {}, options = {}) {
  const proxy = options?.proxy && typeof options.proxy === 'object' ? options.proxy : null;
  const account = options?.account && typeof options.account === 'object' ? options.account : null;
  const candidates = [
    runtime?.countryCode,
    runtime?.proxyCountryCode,
    runtime?.geoCountryCode,
    account?.countryCode,
    account?.proxyCountryCode,
    proxy?.countryCode,
    proxy?.proxyCountryCode,
    proxy?.geoCountryCode,
    proxy?.country,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCountryCode(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function resolveGeoProfile(runtime = {}, options = {}) {
  const countryCode = resolveCountryCode(runtime, options);
  const profile = countryCode ? COUNTRY_GEO_PROFILES[countryCode] || null : null;
  return {
    countryCode,
    profile,
    source: profile ? 'country-profile' : (countryCode ? 'country-fallback' : 'default-pool'),
  };
}

function normalizeProxyServer(value = '') {
  return String(value || '')
    .trim()
    .replace(/\/\/[^:@/]+:[^@/]+@/i, '//***:***@');
}

function sanitizeIdentityKey(value = '') {
  const text = normalizeProxyServer(value);
  if (!text) return '';
  const hostPortMatch = text.match(/^(?:https?:\/\/)?([^:/\s]+):(\d+)/i);
  if (hostPortMatch) return `${hostPortMatch[1]}:${hostPortMatch[2]}`;
  const ipv4Match = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (ipv4Match) return ipv4Match[0];
  return text.length > 64 ? `${text.slice(0, 32)}...${text.slice(-16)}` : text;
}

function resolveProxyIdentityKey(proxy = null, runtime = {}, options = {}) {
  const identity = options?.identity && typeof options.identity === 'object' ? options.identity : {};
  const candidates = [
    identity.identityKey,
    runtime?.identityKey,
    runtime?.proxyIdentityKey,
    proxy?.identityKey,
    proxy?.proxyKey,
    proxy?.exitIp,
    proxy?.resolvedExitIp,
    proxy?.browserRuntimeIp,
    proxy?.server,
    proxy?.raw,
    proxy?.host && proxy?.port ? `${proxy.host}:${proxy.port}` : '',
  ];
  for (const candidate of candidates) {
    const text = normalizeProxyServer(candidate);
    if (text) return text;
  }
  return '';
}

function createIdentityContext(runtime = {}, options = {}) {
  const policy = normalizeBrowserIdentityPolicy(runtime, options);
  const proxy = options?.proxy && typeof options.proxy === 'object' ? options.proxy : null;
  const geo = resolveGeoProfile(runtime, options);
  const identityKey = resolveProxyIdentityKey(proxy, runtime, options);
  const identityHash = identityKey ? hashText(identityKey).slice(0, 16) : '';
  const identityLabel = sanitizeIdentityKey(identityKey);
  const ttlBucket = policy.stableFingerprintTtlMs > 0
    ? Math.floor(Date.now() / policy.stableFingerprintTtlMs)
    : null;
  const seedParts = [
    identityKey || 'no-proxy',
    geo.countryCode || 'no-country',
    ttlBucket === null ? 'no-ttl' : `ttl-${ttlBucket}`,
  ];
  const seed = hashText(seedParts.join('|'));
  const stable = Boolean(policy.enabled && policy.stableByProxy && identityKey);
  return {
    policy,
    proxy,
    geo,
    identityKey,
    identityHash,
    identityLabel,
    ttlBucket,
    identitySeed: seed.slice(0, 16),
    stable,
    seed,
  };
}

function pickFingerprintValue(identityContext, list = [], fallback = null, offset = 0, enabled = true) {
  if (!enabled) return fallback;
  if (identityContext?.stable) {
    return pickStable(list, identityContext.seed, offset, fallback);
  }
  return pickOne(list, fallback);
}

function resolveLocale(runtime = {}, identityContext = null, enabled = true) {
  if (runtime?.locale) return String(runtime.locale);
  const profileLocale = identityContext?.policy?.alignGeoWithProxy
    ? identityContext?.geo?.profile?.locale
    : '';
  if (profileLocale) return profileLocale;
  return String(pickFingerprintValue(identityContext, LOCALES, LOCALES[0], 20, enabled));
}

function resolveTimezoneId(runtime = {}, identityContext = null, enabled = true) {
  if (runtime?.timezoneId) return String(runtime.timezoneId);
  const profileTimezone = identityContext?.policy?.alignGeoWithProxy
    ? identityContext?.geo?.profile?.timezoneId
    : '';
  if (profileTimezone) return profileTimezone;
  return String(pickFingerprintValue(identityContext, TIMEZONES, TIMEZONES[0], 30, enabled));
}

function resolveAcceptLanguage(runtime = {}, fingerprint = {}, identityContext = null) {
  if (runtime?.acceptLanguage) return String(runtime.acceptLanguage);
  if (runtime?.extraHTTPHeaders?.['Accept-Language']) {
    return String(runtime.extraHTTPHeaders['Accept-Language']);
  }
  if (runtime?.extraHTTPHeaders?.['accept-language']) {
    return String(runtime.extraHTTPHeaders['accept-language']);
  }
  const profileAcceptLanguage = identityContext?.policy?.alignGeoWithProxy
    ? identityContext?.geo?.profile?.acceptLanguage
    : '';
  if (profileAcceptLanguage) return profileAcceptLanguage;
  const locale = String(fingerprint?.locale || LOCALES[0]).trim();
  return locale ? `${locale},en;q=0.9` : '';
}

/**
 * 解析最终使用的视口尺寸，优先级：windowLayout.viewport > runtime > 随机池。
 *
 * 字段说明（返回值）：
 * - width  {number} — 视口宽度（px）
 * - height {number} — 视口高度（px）
 *
 * @param {object} [runtime={}]
 * @param {object|null} [windowLayout=null]
 * @returns {{ width: number, height: number }}
 */
function resolveViewport(runtime = {}, windowLayout = null) {
  // 优先使用 windowLayout 提供的视口（由 shared-window-layout 计算得出）。
  if (windowLayout?.viewport && Number(windowLayout.viewport.width) > 0 && Number(windowLayout.viewport.height) > 0) {
    return {
      width: Number(windowLayout.viewport.width),
      height: Number(windowLayout.viewport.height),
    };
  }
  // 次优先：runtime 显式指定的视口。
  if (Number(runtime?.viewportWidth) > 0 && Number(runtime?.viewportHeight) > 0) {
    return {
      width: Number(runtime.viewportWidth),
      height: Number(runtime.viewportHeight),
    };
  }
  // Fallback：从内置视口池随机选取。
  return { ...pickOne(VIEWPORTS, VIEWPORTS[1]) };
}

function resolveViewportWithIdentity(runtime = {}, windowLayout = null, identityContext = null, enabled = true) {
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
  return { ...pickFingerprintValue(identityContext, VIEWPORTS, VIEWPORTS[1], 10, enabled) };
}

/**
 * 生成随机或固定的浏览器指纹参数。
 *
 * 字段说明（runtime）：
 * - enableRandomFingerprint {boolean}  — 是否启用随机化，默认 true
 * - userAgent               {string}   — 覆写 UA（优先于随机池）
 * - viewportWidth           {number}   — 覆写视口宽度
 * - viewportHeight          {number}   — 覆写视口高度
 * - locale                  {string}   — 覆写 locale
 * - timezoneId              {string}   — 覆写时区
 * - colorScheme             {string}   — 覆写色彩模式 ('light'|'dark')
 * - deviceScaleFactor       {number}   — 覆写像素比
 *
 * 返回字段说明（fingerprint）：
 * - userAgent       {string}        — 最终使用的 UA
 * - viewport        {{ width, height }} — 最终使用的视口尺寸
 * - locale          {string}        — 最终使用的 locale
 * - timezoneId      {string}        — 最终使用的时区
 * - colorScheme     {string}        — 最终使用的色彩模式
 * - deviceScaleFactor {number}      — 最终使用的像素比
 * - summary         {object}        — 以上字段的可读摘要（+ randomEnabled 开关状态）
 *
 * @param {object} [runtime={}]
 * @param {{ windowLayout?: object }} [options={}]
 * @returns {object} fingerprint
 */
function createRandomFingerprint(runtime = {}, options = {}) {
  const enabled = Boolean(runtime?.enableRandomFingerprint ?? true);
  const windowLayout = options?.windowLayout || null;
  const identityContext = createIdentityContext(runtime, options);
  const viewport = resolveViewportWithIdentity(runtime, windowLayout, identityContext, enabled);
  const userAgentPool = buildUserAgentPool(runtime);

  const fingerprint = {
    // runtime.userAgent === null → 显式表示「不覆写 UA，用浏览器自身真实 UA」
    // （channel:'chrome' 时真实 Chrome 的 UA 与 Client Hints 一致，比覆写池里的固定版本更不易被识别）。
    userAgent: runtime?.userAgent === null
      ? null
      : String(runtime?.userAgent || pickFingerprintValue(identityContext, userAgentPool, userAgentPool[0], 0, enabled)),
    viewport,
    locale: resolveLocale(runtime, identityContext, enabled),
    timezoneId: resolveTimezoneId(runtime, identityContext, enabled),
    colorScheme: String(runtime?.colorScheme || pickFingerprintValue(identityContext, COLOR_SCHEMES, COLOR_SCHEMES[0], 40, enabled)),
    deviceScaleFactor: Number(runtime?.deviceScaleFactor || pickFingerprintValue(identityContext, DEVICE_SCALE_FACTORS, DEVICE_SCALE_FACTORS[0], 50, enabled)),
  };
  const acceptLanguage = resolveAcceptLanguage(runtime, fingerprint, identityContext);
  const hardeningSeed = identityContext.stable
    ? identityContext.identitySeed
    : (options?.hardeningSeed || crypto.randomBytes(8).toString('hex'));
  const hardening = buildFingerprintHardeningProfile({
    ...fingerprint,
    acceptLanguage,
    identity: {
      identityHash: identityContext.identityHash,
      identitySeed: identityContext.identitySeed,
    },
  }, {
    runtime,
    seed: hardeningSeed,
    fingerprintHardening: options?.fingerprintHardening || runtime?.fingerprintHardening,
  });

  return {
    ...fingerprint,
    acceptLanguage,
    hardening,
    identity: {
      enabled: identityContext.policy.enabled,
      stableByProxy: identityContext.policy.stableByProxy,
      stable: identityContext.stable,
      identityKey: identityContext.identityLabel,
      identityHash: identityContext.identityHash,
      identitySeed: identityContext.identitySeed,
      ttlBucket: identityContext.ttlBucket,
      stableFingerprintTtlMs: identityContext.policy.stableFingerprintTtlMs,
      countryCode: identityContext.geo.countryCode,
      geoSource: identityContext.geo.source,
      alignGeoWithProxy: identityContext.policy.alignGeoWithProxy,
      includeAcceptLanguageHeader: identityContext.policy.includeAcceptLanguageHeader,
      clearStorageOnStart: identityContext.policy.clearStorageOnStart,
    },
    summary: {
      userAgent: fingerprint.userAgent || '(browser-native)',
      viewport: `${fingerprint.viewport.width}x${fingerprint.viewport.height}`,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      acceptLanguage,
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      hardeningEnabled: hardening.enabled,
      hardeningSeedHash: hardening.seedHash,
      webgl: hardening.webgl?.enabled ? `${hardening.webgl.vendor} / ${hardening.webgl.renderer}` : 'off',
      navigatorHardwareConcurrency: hardening.navigator?.hardwareConcurrency,
      navigatorDeviceMemory: hardening.navigator?.deviceMemory,
      randomEnabled: enabled,
      identityStable: identityContext.stable,
      identityKey: identityContext.identityLabel,
      identityHash: identityContext.identityHash,
      identitySeed: identityContext.identitySeed,
      identityTtlBucket: identityContext.ttlBucket,
      countryCode: identityContext.geo.countryCode,
      geoSource: identityContext.geo.source,
      storagePolicy: identityContext.policy.clearStorageOnStart ? 'fresh-context-clear-on-start' : 'fresh-context',
    },
  };
}

/**
 * 生成 Playwright browser.newContext() 所需的 contextOptions 结构。
 *
 * 返回字段说明：
 * - fingerprint    {object} — createRandomFingerprint() 的完整返回值
 * - contextOptions {object} — 可直接传入 browser.newContext() 的参数对象
 *   - viewport         {{ width, height }}
 *   - locale           {string}
 *   - timezoneId       {string}
 *   - userAgent        {string}
 *   - colorScheme      {string}
 *   - deviceScaleFactor {number}
 *   - ignoreHTTPSErrors {boolean} — 始终为 true（代理场景下证书可能无效）
 *
 * @param {object} [runtime={}]
 * @param {{ windowLayout?: object }} [options={}]
 * @returns {{ fingerprint: object, contextOptions: object }}
 */
function buildContextFingerprintOptions(runtime = {}, options = {}) {
  const fingerprint = createRandomFingerprint(runtime, options);
  const extraHTTPHeaders = {
    ...(runtime?.extraHTTPHeaders && typeof runtime.extraHTTPHeaders === 'object' ? runtime.extraHTTPHeaders : {}),
  };
  if (fingerprint?.identity?.includeAcceptLanguageHeader && fingerprint.acceptLanguage) {
    extraHTTPHeaders['Accept-Language'] = fingerprint.acceptLanguage;
  }
  return {
    fingerprint,
    contextOptions: {
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      // userAgent 为 null 时不传 → Playwright 使用浏览器自身真实 UA（与 Client Hints 一致）。
      ...(fingerprint.userAgent ? { userAgent: fingerprint.userAgent } : {}),
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      // 代理场景下目标站点的证书可能不受系统信任，统一忽略 HTTPS 错误。
      ...(Object.keys(extraHTTPHeaders).length ? { extraHTTPHeaders } : {}),
      ignoreHTTPSErrors: true,
    },
  };
}

module.exports = {
  COUNTRY_GEO_PROFILES,
  DEFAULT_BROWSER_IDENTITY_POLICY,
  createRandomFingerprint,
  createIdentityContext,
  normalizeBrowserIdentityPolicy,
  resolveGeoProfile,
  resolveViewport,
  buildContextFingerprintOptions,
};
