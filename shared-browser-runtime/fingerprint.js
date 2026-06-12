'use strict';

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
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
];

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
  const viewport = resolveViewport(runtime, windowLayout);

  const fingerprint = {
    // runtime.userAgent === null → 显式表示「不覆写 UA，用浏览器自身真实 UA」
    // （channel:'chrome' 时真实 Chrome 的 UA 与 Client Hints 一致，比覆写池里的固定版本更不易被识别）。
    userAgent: runtime?.userAgent === null
      ? null
      : String(runtime?.userAgent || (enabled ? pickOne(USER_AGENTS, USER_AGENTS[0]) : USER_AGENTS[0])),
    viewport,
    locale: String(runtime?.locale || (enabled ? pickOne(LOCALES, LOCALES[0]) : LOCALES[0])),
    timezoneId: String(runtime?.timezoneId || (enabled ? pickOne(TIMEZONES, TIMEZONES[0]) : TIMEZONES[0])),
    colorScheme: String(runtime?.colorScheme || (enabled ? pickOne(COLOR_SCHEMES, COLOR_SCHEMES[0]) : COLOR_SCHEMES[0])),
    deviceScaleFactor: Number(runtime?.deviceScaleFactor || (enabled ? pickOne(DEVICE_SCALE_FACTORS, DEVICE_SCALE_FACTORS[0]) : DEVICE_SCALE_FACTORS[0])),
  };

  return {
    ...fingerprint,
    summary: {
      userAgent: fingerprint.userAgent || '(browser-native)',
      viewport: `${fingerprint.viewport.width}x${fingerprint.viewport.height}`,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      randomEnabled: enabled,
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
      ignoreHTTPSErrors: true,
    },
  };
}

module.exports = {
  createRandomFingerprint,
  buildContextFingerprintOptions,
};
