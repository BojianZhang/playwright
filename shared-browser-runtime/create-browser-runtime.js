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
// ✅ 负责 —— 浏览器启动后，通过临时 page 访问公网 IP 查询接口，返回 browserRuntimeIp。
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

// IP 查询接口列表（按优先级排序，逐一 fallback）。
// 注意：username/password 不拼入 URL，认证由 Playwright launchOptions.proxy 处理。
const IP_CHECK_ENDPOINTS = [
  { url: 'https://api.ipify.org?format=json', label: 'api.ipify.org' },
  { url: 'https://httpbin.org/ip', label: 'httpbin.org' },
  { url: 'https://ifconfig.me/all.json', label: 'ifconfig.me' },
];

/**
 * 从 IP 查询接口的响应体中提取 IP 字符串。
 *
 * 兼容格式：
 * - { "ip": "1.2.3.4" }      （ipify / ifconfig.me）
 * - { "origin": "1.2.3.4" }  （httpbin）
 * - 纯文本 "1.2.3.4"
 *
 * @param {string} text
 * @returns {string}
 */
function extractIpFromText(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  // JSON: "ip" 字段
  const ipMatch = s.match(/"ip"\s*:\s*"([^"]+)"/);
  if (ipMatch) return ipMatch[1].trim();
  // JSON: "origin" 字段（httpbin 格式）
  const originMatch = s.match(/"origin"\s*:\s*"([^"]+)"/);
  if (originMatch) return originMatch[1].split(',')[0].trim(); // 可能含 ", proxy_ip"
  // 纯文本 IPv4
  const plainMatch = s.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return plainMatch ? plainMatch[0].trim() : '';
}

/**
 * 通过 Playwright page 访问公网 IP 查询接口，获取浏览器实际出口 IP。
 *
 * 边界说明：
 * ✅ 负责 —— 用 Playwright page.goto + page.content() 发起浏览器级请求（走 chromium.launch proxy）。
 * ✅ 负责 —— 新开临时 page，检测完立即关闭，不污染业务 page。
 * ✅ 负责 —— 顺序尝试 IP_CHECK_ENDPOINTS，第一个成功立即返回。
 * ❌ 不负责 —— 失败时中断主流程（只记录错误，返回 ip: null）。
 *
 * @param {import('playwright').BrowserContext} context - 已创建的 BrowserContext
 * @param {object}  [options={}]
 * @param {number}  [options.timeoutMs=8000]  - 单接口超时（毫秒）
 * @returns {Promise<{ ip: string|null, source: string|null, error: string|null, checkedAt: string }>}
 */
async function getBrowserRuntimeIp(context, options = {}) {
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs)) ? Number(options.timeoutMs) : 8000;
  const checkedAt = new Date().toISOString();

  let tempPage = null;
  try {
    tempPage = await context.newPage();
    // 静默忽略资源加载错误（部分接口可能有 redirect 或 non-2xx）
    for (const endpoint of IP_CHECK_ENDPOINTS) {
      try {
        const response = await tempPage.goto(endpoint.url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        // 只接受 2xx
        if (!response || response.status() < 200 || response.status() > 299) continue;
        const body = await tempPage.content().catch(() => '');
        const ip = extractIpFromText(body);
        if (ip) {
          return {
            ip,
            source: endpoint.url,
            label: endpoint.label,
            error: null,
            checkedAt,
          };
        }
      } catch (_endpointError) {
        // 单接口失败，继续下一个
      }
    }
    // 所有接口都失败
    return { ip: null, source: null, label: null, error: 'ALL_IP_CHECK_ENDPOINTS_FAILED', checkedAt };
  } catch (error) {
    return { ip: null, source: null, label: null, error: String(error?.message || 'BROWSER_IP_CHECK_ERROR'), checkedAt };
  } finally {
    if (tempPage && !tempPage.isClosed()) {
      await tempPage.close().catch(() => {});
    }
  }
}

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

  // 可选：使用本机已安装的浏览器通道（如 'chrome' / 'msedge'）而非内置 Chromium。
  // 某些站点的反爬（如 Cloudflare Turnstile）对内置 Chromium 更敏感，真实 Chrome 通过率更高。
  if (options?.channel) {
    launchOptions.channel = options.channel;
  }
  // 可选：追加 Chromium 启动参数（如 --disable-blink-features=AutomationControlled）。
  if (Array.isArray(options?.extraArgs) && options.extraArgs.length) {
    launchOptions.args = [...(launchOptions.args || []), ...options.extraArgs];
  }
  // 可选：从默认启动参数里剔除自动化开关（如 --enable-automation），降低被检测（反爬/风控）。
  if (Array.isArray(options?.ignoreDefaultArgs) && options.ignoreDefaultArgs.length) {
    launchOptions.ignoreDefaultArgs = options.ignoreDefaultArgs;
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
 * - browser             {Browser}  — Playwright Browser 实例
 * - context             {Context}  — Playwright BrowserContext 实例
 * - page                {Page}     — Playwright Page 实例（context 内第一个页面）
 * - fingerprint         {object}   — 本次使用的指纹配置摘要（userAgent / viewport / locale 等）
 * - launchOptions       {object}   — 实际传给 chromium.launch() 的参数
 * - contextOptions      {object}   — 实际传给 browser.newContext() 的参数
 * - ipCheck             {object}   — 浏览器实际 IP 检测结果 { browserRuntimeIp, browserRuntimeIpSource, ipCheckError, checkedAt }
 *
 * @param {object} [options={}]
 * @returns {Promise<{ browser, context, page, fingerprint, launchOptions, contextOptions, ipCheck }>}
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

  // 浏览器实际 IP 检测：新开临时 page，访问 IP 查询接口，检测完立即关闭。
  // 这里的请求走的是 chromium.launch(launchOptions) 注入的 proxy，
  // 因此检测到的 IP 就是浏览器真实出口 IP。
  // 失败时不中断主流程，只在 ipCheck 字段记录 error。
  const _ipCheckResult = await getBrowserRuntimeIp(context, {
    timeoutMs: Number(options?.browserIpCheckTimeoutMs) || 8000,
  }).catch((error) => ({
    ip: null,
    source: null,
    label: null,
    error: String(error?.message || 'BROWSER_IP_CHECK_UNCAUGHT_ERROR'),
    checkedAt: new Date().toISOString(),
  }));

  const ipCheck = {
    browserRuntimeIp: _ipCheckResult.ip || null,
    browserRuntimeIpSource: _ipCheckResult.source || null,
    browserRuntimeIpSourceLabel: _ipCheckResult.label || null,
    ipCheckError: _ipCheckResult.error || null,
    checkedAt: _ipCheckResult.checkedAt,
  };

  return {
    browser,
    context,
    page,
    fingerprint,
    launchOptions,
    contextOptions,
    ipCheck,
  };
}

module.exports = {
  buildLaunchOptions,
  createBrowserRuntime,
  getBrowserRuntimeIp,
};
