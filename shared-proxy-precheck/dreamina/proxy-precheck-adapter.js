'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

const DREAMINA_PROXY_PRECHECK_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-proxy-precheck-profile.json');
let dreaminaProxyPrecheckProfileCache = null;

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

async function checkProxyConnectivity(proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const primary = profile?.targets?.primary || {};
  const response = await requestViaHttpProxy(proxy, String(primary.url || ''), String(primary.method || 'GET').toUpperCase(), Number(runtime?.proxyConnectivityTimeoutMs || primary.timeoutMs || 15000));
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
