'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-browser-runtime
//
// 文件定位：shared-browser-runtime/create-browser-runtime.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 组合 fingerprint / resource-policy / window-runtime，
//            创建 Playwright browser + context + page 的完整 runtime 实例。
// ✅ 负责 —— 将 proxy / windowLayout / slowMo 等启动参数归一化为 Playwright launchOptions。
// ❌ 不负责 —— 指纹策略本身（由 fingerprint.js 持有）。
// ❌ 不负责 —— 资源拦截规则（由 resource-policy.js 持有）。
// ❌ 不负责 —— 窗口位置/尺寸计算（由 shared-window-layout 持有）。
// ❌ 不负责 —— 任何业务操作（不导航页面，不填写表单）。
//
// 调用方：Dreamina-register.js（每个 Worker 启动时调用一次）
// ═══════════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const { buildContextFingerprintOptions } = require('./fingerprint');
const { applyResourcePolicy } = require('./resource-policy');
const { applyWindowLayoutToLaunchOptions } = require('./window-runtime');

/**
 * 将运行配置归一化为 Playwright chromium.launch() 所需的 launchOptions 对象。
 *
 * 字段说明（options）：
 * - headed        {boolean}  — true 表示有头模式（显示浏览器窗口），false 表示无头
 * - slowMo        {number}   — 每个操作之间的固定延迟（毫秒），调试用
 * - windowLayout  {object}   — 窗口布局对象（由 shared-window-layout 计算得出）
 * - proxy         {object}   — 代理配置 { server, username?, password? }
 *
 * 返回字段说明（launchOptions）：
 * - headless      {boolean}  — Playwright 无头开关
 * - slowMo        {number}   — 操作延迟
 * - args          {string[]} — 传给 Chromium 的命令行参数（窗口位置/尺寸）
 * - proxy         {object}   — { server, username, password }（仅当 proxy.server 存在时）
 *
 * @param {object} [options={}]
 * @returns {object} launchOptions
 */
function buildLaunchOptions(options = {}) {
  const headed = Boolean(options?.headed);
  const slowMo = Number.isFinite(Number(options?.slowMo)) ? Number(options.slowMo) : 0;
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;
  const proxy = options?.proxy && typeof options.proxy === 'object' ? options.proxy : null;

  const launchOptions = {
    headless: !headed,
    slowMo,
  };

  // 将窗口布局（位置 / 尺寸）注入到 Chromium --window-position/--window-size 参数。
  const launchOptionsWithWindowLayout = applyWindowLayoutToLaunchOptions(launchOptions, {
    headed,
    windowLayout,
  });
  launchOptions.headless = launchOptionsWithWindowLayout.headless;
  launchOptions.slowMo = launchOptionsWithWindowLayout.slowMo;
  if (Array.isArray(launchOptionsWithWindowLayout.args)) {
    launchOptions.args = launchOptionsWithWindowLayout.args;
  }

  // 代理配置仅在 proxy.server 非空时注入，避免带空串代理启动浏览器。
  if (proxy?.server) {
    launchOptions.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  return launchOptions;
}

/**
 * 创建完整的 Playwright 浏览器运行时实例（browser + context + page）。
 *
 * 字段说明（options）：
 * - headed              {boolean}  — 有头/无头模式
 * - slowMo              {number}   — 操作减速（毫秒）
 * - windowLayout        {object}   — 窗口布局（来自 shared-window-layout）
 * - proxy               {object}   — 代理 { server, username, password }
 * - runtime             {object}   — 浏览器指纹配置（userAgent / locale 等）
 * - blockedResourceTypes {string[]} — 要拦截的资源类型（默认 image/media/font）
 *
 * 返回字段说明：
 * - browser        {Browser}  — Playwright Browser 实例
 * - context        {Context}  — Playwright BrowserContext 实例
 * - page           {Page}     — Playwright Page 实例（context 内第一个页面）
 * - fingerprint    {object}   — 本次使用的指纹配置摘要（userAgent / viewport / locale 等）
 * - launchOptions  {object}   — 实际传给 chromium.launch() 的参数
 * - contextOptions {object}   — 实际传给 browser.newContext() 的参数
 *
 * @param {object} [options={}]
 * @returns {Promise<{ browser, context, page, fingerprint, launchOptions, contextOptions }>}
 */
async function createBrowserRuntime(options = {}) {
  const runtime = options?.runtime && typeof options.runtime === 'object' ? options.runtime : {};
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;

  const launchOptions = buildLaunchOptions(options);
  const browser = await chromium.launch(launchOptions);

  // 随机指纹 + context 配置（viewport / locale / timezoneId / userAgent 等）
  const { fingerprint, contextOptions } = buildContextFingerprintOptions(runtime, { windowLayout });
  const context = await browser.newContext(contextOptions);

  // 按策略拦截图片/媒体/字体等资源，减少网络开销。
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
  buildLaunchOptions,
  createBrowserRuntime,
};
