// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— S0 Dreamina
//
// 文件定位：Dreamina/0.0.3/S0-proxy-precheck/proxy-precheck-adapter.js
// 平台绑定：Dreamina（仅服务于 Dreamina 注册流程，非通用 adapter）
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 通过 HTTP/HTTPS/TLS 三协议探测代理可达性，输出 ProxyPrecheckResult。
// ✅ 负责 —— Dreamina 特有的 CSS 选择器、文案匹配、交互序列定义。
// ✅ 负责 —— 从 profiles/ 加载当前阶段的 Dreamina 配置（profile JSON）。
// ❌ 不负责 —— 阶段调度、重试策略、日志格式化（由框架层 shared-proxy-precheck/stages/proxy-precheck.js 负责）。
// ❌ 不负责 —— 跨阶段状态传递（由 Dreamina-register.js 主链持有并传入 options）。
// ❌ 不负责 —— 任何非 Dreamina 平台的逻辑（Platform-specific, not reusable）。
//
// 被调用方：shared-proxy-precheck/stages/proxy-precheck.js（框架层通过 options.proxy-precheck-adapter 或直接调用注入）
// profiles：Dreamina/0.0.3/S0-proxy-precheck/profiles/
// ═══════════════════════════════════════════════════════════════════════
'use strict';



const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

const DREAMINA_PROXY_PRECHECK_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-proxy-precheck-profile.json');
let dreaminaProxyPrecheckProfileCache = null;

// ==============================
// 基础工具层
// 负责 profile 读取、基础 header / body 解析。
// ==============================

function loadDreaminaProxyPrecheckProfile(options = {}) {
  const forceReload = Boolean(options?.forceReload);
  if (!forceReload && dreaminaProxyPrecheckProfileCache) return dreaminaProxyPrecheckProfileCache;
  const raw = fs.readFileSync(DREAMINA_PROXY_PRECHECK_PROFILE_PATH, 'utf8');
  dreaminaProxyPrecheckProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  return dreaminaProxyPrecheckProfileCache;
}

function buildBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function extractIpFromResponseBody(body) {
  const text = String(body || '').trim();
  if (!text) return '';
  const jsonMatch = text.match(/"ip"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) return jsonMatch[1].trim();
  const plainIpMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return plainIpMatch ? plainIpMatch[0].trim() : '';
}

function extractHtmlTitle(body) {
  const text = String(body || '');
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? String(match[1] || '').replace(/\s+/g, ' ').trim() : '';
}

function stripHtmlToText(body) {
  return String(body || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function findFirstMatchedPattern(text, patterns = []) {
  const haystack = String(text || '');
  for (const pattern of patterns) {
    const candidate = String(pattern || '').trim();
    if (!candidate) continue;
    if (new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(haystack)) {
      return candidate;
    }
  }
  return '';
}

function countMatchedPatterns(text, patterns = []) {
  const haystack = String(text || '');
  let count = 0;
  for (const pattern of patterns) {
    const candidate = String(pattern || '').trim();
    if (!candidate) continue;
    if (new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(haystack)) {
      count += 1;
    }
  }
  return count;
}

function buildProxyBusinessHealthSummary(input = {}) {
  const connectivity = input.connectivity || null;
  const exitIp = input.exitIp || null;
  const primaryTarget = input.primaryTarget || null;
  const secondaryTarget = input.secondaryTarget || null;
  const homepageShell = input.homepageShell || null;
  const loginAffordance = input.loginAffordance || null;

  const transportOk = Boolean(connectivity?.ok);
  const exitIpOk = Boolean(exitIp?.ok);
  const primaryOk = Boolean(primaryTarget?.ok);
  const secondaryOk = Boolean(secondaryTarget?.ok);
  const homepageShellOk = Boolean(homepageShell?.ok);
  const loginAffordanceOk = Boolean(loginAffordance?.ok);
  const primaryBodyLength = Number(primaryTarget?.response?.body || '' ? String(primaryTarget?.response?.body || '').trim().length : 0);
  const primaryBlankLike = Boolean(primaryTarget?.ok && primaryBodyLength < 120);

  let healthScore = 0;
  if (transportOk) healthScore += 25;
  if (exitIpOk) healthScore += 10;
  if (primaryOk) healthScore += 20;
  if (secondaryOk) healthScore += 10;
  if (homepageShellOk) healthScore += 20;
  if (loginAffordanceOk) healthScore += 15;
  if (primaryBlankLike) healthScore = Math.max(0, healthScore - 25);

  let capabilityGrade = 'DEAD';
  if (transportOk) capabilityGrade = 'TUNNEL_ONLY';
  if (primaryOk || exitIpOk) capabilityGrade = 'HTTP_REACHABLE';
  if (homepageShellOk) capabilityGrade = 'HOMEPAGE_USABLE';
  if (loginAffordanceOk) capabilityGrade = 'ENTRY_READY_CAPABLE';
  if (primaryBlankLike) capabilityGrade = 'HTTP_REACHABLE_BUT_BLANK';

  let businessGrade = 'BAD';
  if (healthScore >= 90) businessGrade = 'STRONG';
  else if (healthScore >= 75) businessGrade = 'OK';
  else if (healthScore >= 55) businessGrade = 'WEAK';

  return {
    transportOk,
    exitIpOk,
    primaryOk,
    secondaryOk,
    homepageShellOk,
    loginAffordanceOk,
    primaryBlankLike,
    primaryBodyLength,
    capabilityGrade,
    businessGrade,
    healthScore,
  };
}

// ==============================
// transport 层
// 负责一次性 HTTP CONNECT -> TLS -> HTTPS 请求，不负责业务结果判定。
// 不做 retry，不扩成多轮 fallback。
// ==============================

/**
 * 通过 HTTP CONNECT 代理发起一次 HTTPS 请求。
 *
 * 边界：
 * - 只负责单次传输，不负责业务级 ok/fail 判定
 * - 不负责 retry
 * - CONNECT / TLS / HTTPS 三层错误都在这里收敛成一次请求结果
 */
function requestViaHttpProxy(proxy = {}, url, method = 'GET', timeoutMs = 15000) {
  const targetUrl = new URL(url);
  const targetLabel = `${method} ${targetUrl.toString()}`;
  const proxyAuth = buildBasicAuthHeader(proxy.username, proxy.password);

  return new Promise((resolve) => {
    const connectReq = http.request({
      host: proxy.host,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        Host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        'Proxy-Authorization': proxyAuth,
      },
    });

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`)));

    connectReq.on('connect', (res, socket) => {
      if ((res.statusCode || 0) !== 200) {
        socket.destroy();
        finish({ success: false, reason: `PROXY_CONNECT_HTTP_${res.statusCode || 'NA'}`, status: res.statusCode || null, finalUrl: targetUrl.toString(), target: targetLabel, body: '', elapsedMs: 0 });
        return;
      }

      const startedAt = Date.now();
      const tlsSocket = tls.connect({ socket, servername: targetUrl.hostname, rejectUnauthorized: false }, () => {
        const req = https.request({
          host: targetUrl.hostname,
          port: Number(targetUrl.port || 443),
          path: `${targetUrl.pathname || '/'}${targetUrl.search || ''}`,
          method,
          createConnection: () => tlsSocket,
          agent: false,
          headers: {
            Host: targetUrl.host,
            'User-Agent': 'Mozilla/5.0',
            Accept: '*/*',
            Connection: 'close',
          },
        }, (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { raw += chunk; });
          response.on('end', () => {
            tlsSocket.end();
            finish({ success: true, reason: 'OK', status: response.statusCode || 0, finalUrl: targetUrl.toString(), target: targetLabel, body: raw, elapsedMs: Date.now() - startedAt });
          });
        });

        req.setTimeout(timeoutMs, () => req.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`)));
        req.on('error', (error) => {
          tlsSocket.destroy();
          finish({ success: false, reason: error.message || 'HTTPS_REQUEST_ERROR', status: null, finalUrl: targetUrl.toString(), target: targetLabel, body: '', elapsedMs: Date.now() - startedAt });
        });
        req.end();
      });

      tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`)));
      tlsSocket.on('error', (error) => finish({ success: false, reason: error.message || 'TLS_CONNECT_ERROR', status: null, finalUrl: targetUrl.toString(), target: targetLabel, body: '', elapsedMs: Date.now() - startedAt }));
    });

    connectReq.on('error', (error) => finish({ success: false, reason: error.message || 'PROXY_CONNECT_ERROR', status: null, finalUrl: targetUrl.toString(), target: targetLabel, body: '', elapsedMs: 0 }));
    connectReq.end();
  });
}

// ==============================
// 单项检查层
// 每个 check 只负责一次目标探测，不互相 fallback，不共享策略循环。
// ==============================

/**
 * 代理基础连通性检查。
 *
 * 边界：
 * - 只验证代理是否能完成基础隧道请求
 * - 不承担出口 IP 解析与目标站点可用性判断
 */
async function checkProxyConnectivity(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const exitIp = profile?.targets?.exitIp || {};
  const response = await requestViaHttpProxy(proxy, String(exitIp.url || ''), String(exitIp.method || 'GET').toUpperCase(), Number(runtime?.proxyConnectivityTimeoutMs || exitIp.timeoutMs || 10000));
  return {
    ok: Boolean(response.success),
    state: response.success ? 'PROXY_CONNECTIVITY_OK' : 'PROXY_CONNECTIVITY_FAILED',
    source: 'http-connect',
    value: String(response.reason || response.target || ''),
    strength: response.success ? 'medium' : 'strong',
    elapsedMs: response.elapsedMs,
    response,
  };
}

/**
 * 出口 IP 检查。
 *
 * 边界：
 * - 只负责读取出口 IP，不负责 Dreamina 目标可达性判断
 */
async function checkProxyExitIp(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const exitIp = profile?.targets?.exitIp || {};
  const response = await requestViaHttpProxy(proxy, String(exitIp.url || ''), String(exitIp.method || 'GET').toUpperCase(), Number(runtime?.proxyExitIpTimeoutMs || exitIp.timeoutMs || 15000));
  const ip = response.success ? extractIpFromResponseBody(response.body) : '';
  return {
    ok: Boolean(response.success && ip),
    state: response.success && ip ? 'PROXY_EXIT_IP_OK' : 'PROXY_EXIT_IP_FAILED',
    source: 'exit-ip',
    value: ip || String(response.reason || ''),
    strength: response.success && ip ? 'weak' : 'medium',
    elapsedMs: response.elapsedMs,
    ip,
    response,
  };
}

/**
 * Dreamina 主目标检查。
 *
 * 边界：
 * - 只负责 primary target 单次探测
 * - 不与 secondary / exit-ip 做交叉确认
 */
async function checkDreaminaPrimaryTarget(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const target = profile?.targets?.primary || {};
  const response = await requestViaHttpProxy(proxy, String(target.url || ''), String(target.method || 'GET').toUpperCase(), Number(runtime?.proxyPrimaryTargetTimeoutMs || target.timeoutMs || 15000));
  const ok = Boolean(response.success && response.status >= Number(target.okMinStatus || 200) && response.status <= Number(target.okMaxStatus || 399));
  return {
    ok,
    state: ok ? 'DREAMINA_PRIMARY_TARGET_OK' : 'DREAMINA_PRIMARY_TARGET_FAILED',
    source: 'primary-target',
    value: String(response.reason || response.target || ''),
    strength: ok ? 'strong' : 'medium', // ok=strong（HTTP 可达是强信号）；fail=medium（可能是临时性超时）
    elapsedMs: response.elapsedMs,
    response,
  };
}

/**
 * Dreamina 副目标检查。
 *
 * 边界：
 * - 只负责 secondary target 单次探测
 * - 不承担最终代理等级判断
 */
async function checkDreaminaSecondaryTarget(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const target = profile?.targets?.secondary || {};
  const response = await requestViaHttpProxy(proxy, String(target.url || ''), String(target.method || 'GET').toUpperCase(), Number(runtime?.proxySecondaryTargetTimeoutMs || target.timeoutMs || 15000));
  const ok = Boolean(response.success && response.status >= Number(target.okMinStatus || 200) && response.status <= Number(target.okMaxStatus || 399));
  return {
    ok,
    state: ok ? 'DREAMINA_SECONDARY_TARGET_OK' : 'DREAMINA_SECONDARY_TARGET_FAILED',
    source: 'secondary-target',
    value: String(response.reason || response.target || ''),
    strength: ok ? 'medium' : 'weak', // 副目标只作补充验证，强度低于主目标
    elapsedMs: response.elapsedMs,
    response,
  };
}


/**
 * Dreamina 首页 Shell 检查。
 *
 * 通过 HTTP 拉取 Dreamina 首页 HTML，根据标题 pattern 和 Shell 关键词判断页面框架是否正常渲染。
 * 与 checkDreaminaPrimaryTarget 的区别：后者只看 HTTP 状态码；此函数看页面内容质量。
 *
 * 边界：
 * - 复用主目标 URL，不额外发起新的目标请求（减少网络开销）
 * - 不判定代理整体等级，only 提供 homepageShell probe 结果
 * - errorTexts 匹配任意一项即判失败（优先级高于 shellTexts）
 */
async function checkDreaminaHomepageShell(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const shellProfile = profile?.homepageShell || {};
  const response = await requestViaHttpProxy(
    proxy,
    String(shellProfile.url || profile?.targets?.primary?.url || ''),
    String(shellProfile.method || 'GET').toUpperCase(),
    Number(runtime?.proxyHomepageShellTimeoutMs || shellProfile.timeoutMs || 15000)
  );

  const title = response.success ? extractHtmlTitle(response.body) : '';
  const bodyText = response.success ? stripHtmlToText(response.body) : '';
  const titleHit = findFirstMatchedPattern(title, shellProfile.titlePatterns || []);
  const shellTextHit = findFirstMatchedPattern(bodyText, shellProfile.shellTexts || []);
  const errorTextHit = findFirstMatchedPattern(bodyText, shellProfile.errorTexts || []);
  const bodyTextLength = bodyText.length;
  const ok = Boolean(
    response.success
    && response.status >= 200
    && response.status <= 399
    && bodyTextLength >= Number(shellProfile.minBodyTextLength || 120)
    && !errorTextHit
    && (titleHit || shellTextHit)
  );

  return {
    ok,
    state: ok ? 'DREAMINA_HOMEPAGE_SHELL_OK' : 'DREAMINA_HOMEPAGE_SHELL_FAILED',
    source: 'homepage-shell',
    value: shellTextHit || titleHit || String(response.reason || response.target || ''),
    strength: ok ? 'medium' : 'medium', // 内容质量型检查，成功/失败均为 medium；失败不证明代理完全不可用
    elapsedMs: response.elapsedMs,
    evidence: {
      title,
      titleHit,
      shellTextHit,
      errorTextHit,
      bodyTextLength,
      bodyPreview: bodyText.slice(0, 240),
    },
    response,
  };
}


/**
 * Dreamina 登录入口可见性检查。
 *
 * 在同一次 HTTP 拉取中，从页面 HTML 检测是否存在可点击的登录/注册入口。
 * 判定依据：texts（可见文案）和 selectorHints（class/data 属性片段）的命中数量 >= minAffordanceCount。
 *
 * 边界：
 * - 与 checkDreaminaHomepageShell 复用同一 URL 请求（homepageShell.url）
 * - 仅作为 confirmProxyPrecheckResult 的输入之一，不单独决定代理等级
 * - 若 selectorHints 字段在 profile 中为空，则退化为纯文案匹配
 */
async function checkDreaminaLoginAffordance(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const affordanceProfile = profile?.loginAffordance || {};
  const shellProfile = profile?.homepageShell || {};
  const response = await requestViaHttpProxy(
    proxy,
    String(shellProfile.url || profile?.targets?.primary?.url || ''),
    String(shellProfile.method || 'GET').toUpperCase(),
    Number(runtime?.proxyLoginAffordanceTimeoutMs || affordanceProfile.timeoutMs || shellProfile.timeoutMs || 15000)
  );

  const html = String(response.body || '');
  const bodyText = stripHtmlToText(html);
  const textHit = findFirstMatchedPattern(bodyText, affordanceProfile.texts || []);
  const selectorHintHit = findFirstMatchedPattern(html, affordanceProfile.selectorHints || []);
  const affordanceCount = countMatchedPatterns(`${bodyText} ${html}`, [
    ...(affordanceProfile.texts || []),
    ...(affordanceProfile.selectorHints || []),
  ]);
  const ok = Boolean(
    response.success
    && response.status >= 200
    && response.status <= 399
    && affordanceCount >= Number(affordanceProfile.minAffordanceCount || 1)
    && (textHit || selectorHintHit)
  );

  return {
    ok,
    state: ok ? 'DREAMINA_LOGIN_AFFORDANCE_OK' : 'DREAMINA_LOGIN_AFFORDANCE_MISSING',
    source: 'login-affordance',
    value: textHit || selectorHintHit || String(response.reason || response.target || ''),
    strength: ok ? 'medium' : 'medium', // 登录入口信号属于补充检查，成功/失败均为 medium；失败不单独决定代理等级
    elapsedMs: response.elapsedMs,
    evidence: {
      textHit,
      selectorHintHit,
      affordanceCount,
      bodyPreview: bodyText.slice(0, 240),
    },
    response,
  };
}

// ==============================
// 业务确认 / 分类层
// 负责消费已有 probe 结果并给出 Dreamina 代理预检结论。
// 不重新发请求，不做 retry。
// ==============================

/**
 * 业务级预检确认。
 *
 * 规则：
 * - connectivity 不通，直接 BAD
 * - primary + secondary 都通，判 OK
 * - primary 通或 exit-ip 可用，判 WEAK
 * - 否则判 BAD
 *
 * 边界：
 * - 只消费既有 probe 结果
 * - 不重新发请求，不做补探测
 */
async function confirmProxyPrecheckResult(proxy, runtime = {}, context = {}) {
  const {
    connectivity = null,
    exitIp = null,
    primaryTarget = null,
    secondaryTarget = null,
    homepageShell = null,
    loginAffordance = null,
  } = context;

  const healthSummary = buildProxyBusinessHealthSummary({
    connectivity,
    exitIp,
    primaryTarget,
    secondaryTarget,
    homepageShell,
    loginAffordance,
  });

  if (!connectivity?.ok) {
    return {
      ok: false,
      state: 'PROXY_PRECHECK_BAD',
      nextStage: '',
      proxyGrade: 'BAD',
      capabilityGrade: healthSummary.capabilityGrade,
      businessGrade: healthSummary.businessGrade,
      healthScore: healthSummary.healthScore,
      source: 'connectivity',
      value: String(connectivity?.state || ''),
      strength: 'strong',
      settleStage: 'connectivity',
      retryCount: 0,
    };
  }

  if (loginAffordance?.ok && homepageShell?.ok && primaryTarget?.ok) {
    return {
      ok: true,
      state: 'PROXY_PRECHECK_OK',
      nextStage: 'proxy-precheck-complete',
      proxyGrade: 'OK',
      capabilityGrade: healthSummary.capabilityGrade,
      businessGrade: healthSummary.businessGrade,
      healthScore: healthSummary.healthScore,
      source: 'business-target-checks',
      value: 'homepage+login-affordance',
      strength: 'strong',
      settleStage: 'result-confirmation',
      retryCount: 0,
    };
  }

  if (healthSummary.primaryBlankLike) {
    return {
      ok: false,
      state: 'PROXY_PRECHECK_BAD',
      nextStage: '',
      proxyGrade: 'BAD',
      capabilityGrade: healthSummary.capabilityGrade,
      businessGrade: healthSummary.businessGrade,
      healthScore: healthSummary.healthScore,
      source: 'primary-target-blank-like',
      value: `body-length=${healthSummary.primaryBodyLength}`,
      strength: 'medium',
      settleStage: 'result-confirmation',
      retryCount: 0,
    };
  }

  if (homepageShell?.ok && (primaryTarget?.ok || exitIp?.ok)) {
    return {
      ok: true,
      state: 'PROXY_PRECHECK_WEAK_OK',
      nextStage: 'proxy-precheck-complete',
      proxyGrade: 'WEAK',
      capabilityGrade: healthSummary.capabilityGrade,
      businessGrade: healthSummary.businessGrade,
      healthScore: healthSummary.healthScore,
      source: 'homepage-shell',
      value: loginAffordance?.ok ? 'homepage+entry-weak' : 'homepage-only',
      strength: 'weak',
      settleStage: 'result-confirmation',
      retryCount: 0,
    };
  }

  if (primaryTarget?.ok || exitIp?.ok) {
    return {
      ok: true,
      state: 'PROXY_PRECHECK_WEAK_OK',
      nextStage: 'proxy-precheck-complete',
      proxyGrade: 'WEAK',
      capabilityGrade: healthSummary.capabilityGrade,
      businessGrade: healthSummary.businessGrade,
      healthScore: healthSummary.healthScore,
      source: primaryTarget?.ok ? 'primary-target' : 'exit-ip',
      value: primaryTarget?.ok ? 'primary-only' : 'exit-ip-only',
      strength: 'weak',
      settleStage: 'result-confirmation',
      retryCount: 0,
    };
  }

  return {
    ok: false,
    state: 'PROXY_PRECHECK_BAD',
    nextStage: '',
    proxyGrade: 'BAD',
    capabilityGrade: healthSummary.capabilityGrade,
    businessGrade: healthSummary.businessGrade,
    healthScore: healthSummary.healthScore,
    source: 'target-checks',
    value: 'no-usable-signals',
    strength: 'medium',
    settleStage: 'result-confirmation',
    retryCount: 0,
  };
}

/**
 * 失败分类。
 *
 * 边界：
 * - 只做 reason -> Dreamina siteReason 映射
 * - 不负责重新确认 probe 结果
 */
function classifyProxyPrecheckFailure(input = {}) {
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  let siteReason = reason;
  if (reason === 'PROXY_CONNECTIVITY_FAILED') siteReason = 'DREAMINA_PROXY_CONNECTIVITY_FAILED';
  else if (reason === 'PROXY_EXIT_IP_FAILED') siteReason = 'DREAMINA_PROXY_EXIT_IP_FAILED';
  else if (reason === 'DREAMINA_PRIMARY_TARGET_FAILED') siteReason = 'DREAMINA_PRIMARY_TARGET_FAILED';
  else if (reason === 'DREAMINA_SECONDARY_TARGET_FAILED') siteReason = 'DREAMINA_SECONDARY_TARGET_FAILED';
  else if (reason === 'PROXY_PRECHECK_BAD') siteReason = 'DREAMINA_PROXY_PRECHECK_BAD';
  return {
    reason,
    siteReason,
    hardFailure: reason === 'PROXY_CONNECTIVITY_FAILED' || reason === 'PROXY_PRECHECK_BAD',
  };
}


/**
 * 浏览器 Smoke 检查（可选增强检测）。
 *
 * 使用已启动的 Playwright page 实际访问 Dreamina 首页，通过 DOM 内容判断页面是否正常渲染。
 * 比 HTTP 检查更准确（能发现 JS 首屏渲染失败、CDN 拦截等 HTTP 层看不到的问题），
 * 但代价是需要已有 browser context，仅在主流程阶段（S1 entry 之前）可用。
 *
 * 边界：
 * - 入参 page 必须是有效的 Playwright Page 对象；缺失时返回 UNAVAILABLE 而非抛异常
 * - 不负责创建或销毁 browser / page；调用方持有生命周期
 * - 只用于补充确认，不替代 HTTP 层的 checkDreaminaHomepageShell
 */
async function browserSmokeCheckDreaminaHomepage(page, runtime = {}, context = {}) {
  if (!page || typeof page.goto !== 'function') {
    return {
      ok: false,
      state: 'DREAMINA_BROWSER_SMOKE_UNAVAILABLE',
      source: 'browser-smoke-check',
      value: 'PAGE_MISSING',
      strength: 'weak',
      elapsedMs: 0,
      evidence: null,
    };
  }

  const profile = loadDreaminaProxyPrecheckProfile();
  const targetUrl = String(profile?.homepageShell?.url || profile?.targets?.primary?.url || '').trim();
  const timeoutMs = Number(runtime?.proxyBrowserSmokeTimeoutMs || 8000);
  const settleMs = Number(runtime?.proxyBrowserSmokeSettleMs || 3500);
  const startedAt = Date.now();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs).catch(() => null);
    }

    const evidence = await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const title = normalize(document.title || '');
      const bodyText = normalize(document.body?.innerText || '');
      const bodyHtml = String(document.body?.innerHTML || '');
      const rootChildCount = Number(document.body?.children?.length || 0);
      const readyState = String(document.readyState || '');
      return {
        url: String(window.location.href || ''),
        title,
        readyState,
        bodyTextLength: bodyText.length,
        bodyHtmlLength: bodyHtml.length,
        rootChildCount,
        bodyPreview: bodyText.slice(0, 240),
      };
    }).catch(() => ({
      url: String(page.url ? page.url() : ''),
      title: '',
      readyState: '',
      bodyTextLength: 0,
      bodyHtmlLength: 0,
      rootChildCount: 0,
      bodyPreview: '',
    }));

    const bodyText = String(evidence?.bodyPreview || '');
    const titleText = String(evidence?.title || '');
    const shellTexts = profile?.homepageShell?.shellTexts || [];
    const titlePatterns = profile?.homepageShell?.titlePatterns || [];
    const shellTextHit = findFirstMatchedPattern(bodyText, shellTexts);
    const titleHit = findFirstMatchedPattern(titleText, titlePatterns);
    const blankLike = Number(evidence?.bodyTextLength || 0) < Number(runtime?.proxyBrowserSmokeMinBodyTextLength || 80)
      && Number(evidence?.bodyHtmlLength || 0) < Number(runtime?.proxyBrowserSmokeMinBodyHtmlLength || 3000)
      && Number(evidence?.rootChildCount || 0) <= 2;
    const ok = !blankLike && (Boolean(shellTextHit) || Boolean(titleHit) || Number(evidence?.bodyTextLength || 0) >= 180);

    return {
      ok,
      state: ok ? 'DREAMINA_BROWSER_SMOKE_OK' : 'DREAMINA_BROWSER_SMOKE_BLANK_PAGE',
      source: 'browser-smoke-check',
      value: ok ? (shellTextHit || titleHit || 'BROWSER_SMOKE_OK') : 'BROWSER_SMOKE_BLANK_PAGE',
      strength: ok ? 'medium' : 'medium',
      elapsedMs: Date.now() - startedAt,
      evidence: {
        ...evidence,
        shellTextHit,
        titleHit,
        blankLike,
      },
    };
  } catch (error) {
    return {
      ok: false,
      state: 'DREAMINA_BROWSER_SMOKE_FAILED',
      source: 'browser-smoke-check',
      value: String(error?.message || 'BROWSER_SMOKE_FAILED'),
      strength: 'medium',
      elapsedMs: Date.now() - startedAt,
      evidence: null,
    };
  }
}

module.exports = {
  loadDreaminaProxyPrecheckProfile,
  checkProxyConnectivity,
  checkProxyExitIp,
  checkDreaminaPrimaryTarget,
  checkDreaminaSecondaryTarget,
  checkDreaminaHomepageShell,
  checkDreaminaLoginAffordance,
  browserSmokeCheckDreaminaHomepage,
  buildProxyBusinessHealthSummary,
  confirmProxyPrecheckResult,
  classifyProxyPrecheckFailure,
};

