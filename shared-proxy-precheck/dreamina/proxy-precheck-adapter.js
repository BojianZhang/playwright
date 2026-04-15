'use strict';

/**
 * Dreamina proxy-precheck adapter
 *
 * 这是 shared-proxy-precheck 的 Dreamina 站点适配层。
 *
 * 它负责：
 * - 单次代理隧道请求
 * - 单项目标检查（connectivity / exit-ip / primary / secondary）
 * - 根据已有探测结果做业务级预检确认
 * - 将失败态归一到 Dreamina 语义
 *
 * 它不负责：
 * - shared stage orchestration
 * - 多轮 retry / 多轮探测
 * - 并发调度
 * - 日志编排
 */

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

  let healthScore = 0;
  if (transportOk) healthScore += 25;
  if (exitIpOk) healthScore += 10;
  if (primaryOk) healthScore += 20;
  if (secondaryOk) healthScore += 10;
  if (homepageShellOk) healthScore += 20;
  if (loginAffordanceOk) healthScore += 15;

  let capabilityGrade = 'DEAD';
  if (transportOk) capabilityGrade = 'TUNNEL_ONLY';
  if (primaryOk || exitIpOk) capabilityGrade = 'HTTP_REACHABLE';
  if (homepageShellOk) capabilityGrade = 'HOMEPAGE_USABLE';
  if (loginAffordanceOk) capabilityGrade = 'ENTRY_READY_CAPABLE';

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
    strength: ok ? 'strong' : 'strong',
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
    strength: ok ? 'medium' : 'medium',
    elapsedMs: response.elapsedMs,
    response,
  };
}

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
    strength: ok ? 'medium' : 'medium',
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
    strength: ok ? 'medium' : 'medium',
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

module.exports = {
  loadDreaminaProxyPrecheckProfile,
  buildBasicAuthHeader,
  extractIpFromResponseBody,
  requestViaHttpProxy,
  checkProxyConnectivity,
  checkProxyExitIp,
  checkDreaminaPrimaryTarget,
  checkDreaminaSecondaryTarget,
  checkDreaminaHomepageShell,
  checkDreaminaLoginAffordance,
  buildProxyBusinessHealthSummary,
  confirmProxyPrecheckResult,
  classifyProxyPrecheckFailure,
};
