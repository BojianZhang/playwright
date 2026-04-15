'use strict';

const fs = require('fs');
const path = require('path');

const PROXY_HEALTH_STORE_PATH = path.join(__dirname, 'proxy-health-store.json');

function ensureObject(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

function loadProxyHealthStore(options = {}) {
  const filePath = String(options.filePath || PROXY_HEALTH_STORE_PATH);
  try {
    if (!fs.existsSync(filePath)) {
      return {
        updatedAt: '',
        records: {},
      };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      updatedAt: String(raw?.updatedAt || '').trim(),
      records: ensureObject(raw?.records),
    };
  } catch (_) {
    return {
      updatedAt: '',
      records: {},
    };
  }
}

function saveProxyHealthStore(store = {}, options = {}) {
  const filePath = String(options.filePath || PROXY_HEALTH_STORE_PATH);
  const payload = {
    updatedAt: new Date().toISOString(),
    records: ensureObject(store?.records),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function buildProxyHealthKey(proxy = {}) {
  const host = String(proxy?.host || '').trim().toLowerCase();
  const port = String(proxy?.port || '').trim();
  const username = String(proxy?.username || '').trim();
  if (!host || !port || !username) {
    return String(proxy?.id || proxy?.raw || '').trim();
  }
  return `${host}:${port}:${username}`;
}

function normalizeProxyHealthRecord(record = {}, proxy = {}) {
  const normalized = ensureObject(record);
  return {
    proxyKey: String(normalized.proxyKey || buildProxyHealthKey(proxy) || '').trim(),
    proxyId: String(normalized.proxyId || proxy?.id || '').trim(),
    host: String(normalized.host || proxy?.host || '').trim(),
    port: Number(normalized.port || proxy?.port || 0),
    username: String(normalized.username || proxy?.username || '').trim(),
    provider: String(normalized.provider || proxy?.provider || '').trim(),
    countryCode: String(normalized.countryCode || proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
    countryName: String(normalized.countryName || proxy?.countryName || proxy?.proxyCountryName || '').trim(),
    capabilityGrade: String(normalized.capabilityGrade || '').trim(),
    businessGrade: String(normalized.businessGrade || '').trim(),
    proxyGrade: String(normalized.proxyGrade || '').trim(),
    healthScore: Number(normalized.healthScore || 0),
    recentSuccessCount: Number(normalized.recentSuccessCount || 0),
    recentFailureCount: Number(normalized.recentFailureCount || 0),
    consecutiveConnectivityFails: Number(normalized.consecutiveConnectivityFails || 0),
    consecutiveEntryFails: Number(normalized.consecutiveEntryFails || 0),
    consecutiveBusinessFails: Number(normalized.consecutiveBusinessFails || 0),
    lastProxyPrecheckSummary: normalized.lastProxyPrecheckSummary && typeof normalized.lastProxyPrecheckSummary === 'object'
      ? normalized.lastProxyPrecheckSummary
      : null,
    lastRuntimeOutcome: normalized.lastRuntimeOutcome && typeof normalized.lastRuntimeOutcome === 'object'
      ? normalized.lastRuntimeOutcome
      : null,
    updatedAt: String(normalized.updatedAt || '').trim(),
  };
}

function upsertProxyHealthFromPrecheck(store = {}, proxy = {}, proxyPrecheckSummary = null) {
  const records = ensureObject(store?.records);
  const proxyKey = buildProxyHealthKey(proxy);
  if (!proxyKey) return { updated: false, store: { ...store, records } };

  const previous = normalizeProxyHealthRecord(records[proxyKey], proxy);
  const summary = proxyPrecheckSummary && typeof proxyPrecheckSummary === 'object' ? proxyPrecheckSummary : null;
  const next = normalizeProxyHealthRecord({
    ...previous,
    proxyKey,
    proxyId: proxy?.id || previous.proxyId,
    host: proxy?.host || previous.host,
    port: proxy?.port || previous.port,
    username: proxy?.username || previous.username,
    provider: proxy?.provider || previous.provider,
    countryCode: proxy?.countryCode || proxy?.proxyCountryCode || previous.countryCode,
    countryName: proxy?.countryName || proxy?.proxyCountryName || previous.countryName,
    proxyGrade: summary?.proxyGrade || previous.proxyGrade,
    capabilityGrade: summary?.capabilityGrade || previous.capabilityGrade,
    businessGrade: summary?.businessGrade || previous.businessGrade,
    healthScore: Number(summary?.healthScore || previous.healthScore || 0),
    lastProxyPrecheckSummary: summary || previous.lastProxyPrecheckSummary,
    updatedAt: new Date().toISOString(),
  }, proxy);

  records[proxyKey] = next;
  return {
    updated: true,
    record: next,
    store: {
      updatedAt: new Date().toISOString(),
      records,
    },
  };
}

function upsertProxyHealthFromRuntime(store = {}, proxy = {}, runtimeOutcome = null) {
  const records = ensureObject(store?.records);
  const proxyKey = buildProxyHealthKey(proxy);
  if (!proxyKey) return { updated: false, store: { ...store, records } };

  const previous = normalizeProxyHealthRecord(records[proxyKey], proxy);
  const outcome = runtimeOutcome && typeof runtimeOutcome === 'object' ? runtimeOutcome : {};
  const finalReason = String(outcome?.finalReason || outcome?.finalState || '').trim().toUpperCase();
  const success = Boolean(outcome?.success);

  const next = normalizeProxyHealthRecord({
    ...previous,
    recentSuccessCount: success ? previous.recentSuccessCount + 1 : previous.recentSuccessCount,
    recentFailureCount: success ? previous.recentFailureCount : previous.recentFailureCount + 1,
    consecutiveConnectivityFails: /DREAMINA_PROXY_CONNECTIVITY_FAILED|PROXY_CONNECTIVITY_FAILED/.test(finalReason)
      ? previous.consecutiveConnectivityFails + 1
      : 0,
    consecutiveEntryFails: /DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY|DREAMINA_READY_SIGNAL_MISSING/.test(finalReason)
      ? previous.consecutiveEntryFails + 1
      : 0,
    consecutiveBusinessFails: /DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY|DREAMINA_READY_SIGNAL_MISSING|DREAMINA_SIGNUP_REJECTED/.test(finalReason)
      ? previous.consecutiveBusinessFails + 1
      : 0,
    lastRuntimeOutcome: {
      success,
      finalStage: String(outcome?.finalStage || '').trim(),
      finalState: String(outcome?.finalState || '').trim(),
      finalReason: String(outcome?.finalReason || outcome?.finalState || '').trim(),
      durationMs: Number(outcome?.meta?.durationMs || 0),
    },
    updatedAt: new Date().toISOString(),
  }, proxy);

  if (success) {
    next.consecutiveConnectivityFails = 0;
    next.consecutiveEntryFails = 0;
    next.consecutiveBusinessFails = 0;
    next.healthScore = Math.min(100, Math.max(Number(next.healthScore || 0), 75));
  } else if (/DREAMINA_PROXY_CONNECTIVITY_FAILED|PROXY_CONNECTIVITY_FAILED/.test(finalReason)) {
    next.healthScore = Math.max(0, Number(next.healthScore || 0) - 25);
  } else if (/DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY|DREAMINA_READY_SIGNAL_MISSING/.test(finalReason)) {
    next.healthScore = Math.max(0, Number(next.healthScore || 0) - 18);
  } else if (/DREAMINA_SIGNUP_REJECTED/.test(finalReason)) {
    next.healthScore = Math.max(0, Number(next.healthScore || 0) - 8);
  }

  records[proxyKey] = next;
  return {
    updated: true,
    record: next,
    store: {
      updatedAt: new Date().toISOString(),
      records,
    },
  };
}

function sortProxiesByHealth(proxies = [], store = {}) {
  const records = ensureObject(store?.records);
  return [...(Array.isArray(proxies) ? proxies : [])].sort((a, b) => {
    const aRecord = normalizeProxyHealthRecord(records[buildProxyHealthKey(a)], a);
    const bRecord = normalizeProxyHealthRecord(records[buildProxyHealthKey(b)], b);
    return Number(bRecord.healthScore || 0) - Number(aRecord.healthScore || 0);
  });
}

module.exports = {
  PROXY_HEALTH_STORE_PATH,
  buildProxyHealthKey,
  loadProxyHealthStore,
  saveProxyHealthStore,
  normalizeProxyHealthRecord,
  upsertProxyHealthFromPrecheck,
  upsertProxyHealthFromRuntime,
  sortProxiesByHealth,
};
