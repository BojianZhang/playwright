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
  const { connectivity = null, exitIp = null, primaryTarget = null, secondaryTarget = null } = context;

  if (!connectivity?.ok) {
    return {
      ok: false,
      state: 'PROXY_PRECHECK_BAD',
      nextStage: '',
      proxyGrade: 'BAD',
      source: 'connectivity',
      value: String(connectivity?.state || ''),
      strength: 'strong',
      settleStage: 'connectivity',
      retryCount: 0,
    };
  }

  if (primaryTarget?.ok && secondaryTarget?.ok) {
    return {
      ok: true,
      state: 'PROXY_PRECHECK_OK',
      nextStage: 'proxy-precheck-complete',
      proxyGrade: 'OK',
      source: 'target-checks',
      value: 'primary+secondary',
      strength: 'strong',
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
  confirmProxyPrecheckResult,
  classifyProxyPrecheckFailure,
};
