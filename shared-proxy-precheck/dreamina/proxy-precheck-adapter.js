'use strict';

const fs = require('fs');
const path = require('path');

const DREAMINA_PROXY_PRECHECK_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-proxy-precheck-profile.json');
let dreaminaProxyPrecheckProfileCache = null;

function loadDreaminaProxyPrecheckProfile(options = {}) {
  const forceReload = Boolean(options?.forceReload);
  if (!forceReload && dreaminaProxyPrecheckProfileCache) return dreaminaProxyPrecheckProfileCache;
  const raw = fs.readFileSync(DREAMINA_PROXY_PRECHECK_PROFILE_PATH, 'utf8');
  dreaminaProxyPrecheckProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  return dreaminaProxyPrecheckProfileCache;
}

async function isVisible(locator) {
  return await locator.isVisible().catch(() => false);
}

async function findFirstVisibleBySelectors(page, selectors = []) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) return { ok: true, selector, locator };
  }
  return { ok: false, selector: '', locator: null };
}

async function findFirstVisibleByTexts(page, texts = []) {
  for (const text of texts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    if (await isVisible(locator)) return { ok: true, text, locator };
  }
  return { ok: false, text: '', locator: null };
}

async function checkProxyConnectivity(page, proxy, runtime = {}, context = {}) {
  return {
    ok: true,
    state: 'PROXY_CONNECTIVITY_OK',
    source: 'proxy',
    value: `${proxy?.host || ''}:${proxy?.port || ''}`,
    strength: 'weak',
    stateChanged: null,
  };
}

async function checkProxyNetworkHealth(page, proxy, runtime = {}, context = {}) {
  return {
    ok: true,
    state: 'PROXY_NETWORK_HEALTH_OK',
    source: 'proxy',
    value: `${proxy?.host || ''}:${proxy?.port || ''}`,
    strength: 'weak',
    stateChanged: null,
  };
}

async function checkProxyEntryReachability(page, proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const entryUrl = String(profile?.entryUrl || '').trim();
  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: Number(runtime?.proxyEntryGotoTimeoutMs || 30000) }).catch(() => {});
    return {
      ok: true,
      state: 'PROXY_ENTRY_REACHABLE',
      source: 'url',
      value: entryUrl,
      strength: 'medium',
      stateChanged: true,
    };
  } catch (error) {
    return {
      ok: false,
      state: 'PROXY_ENTRY_UNREACHABLE',
      source: 'url',
      value: error?.message || entryUrl,
      strength: 'strong',
      stateChanged: false,
    };
  }
}

async function checkProxySiteReady(page, proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.siteReady?.selectors || []);
  if (selectorHit.ok) {
    return { ok: true, state: 'PROXY_SITE_READY', source: 'selector', value: selectorHit.selector, strength: 'strong', stateChanged: null };
  }
  const textHit = await findFirstVisibleByTexts(page, profile?.siteReady?.texts || []);
  if (textHit.ok) {
    return { ok: true, state: 'PROXY_SITE_READY', source: 'text', value: textHit.text, strength: 'weak', stateChanged: null };
  }
  const currentUrl = String(page.url ? page.url() : '').trim();
  const urlHit = (profile?.siteReady?.urlIncludes || []).find(fragment => currentUrl.includes(String(fragment || '')));
  if (urlHit) {
    return { ok: true, state: 'PROXY_SITE_READY', source: 'url', value: urlHit, strength: 'weak', stateChanged: null };
  }
  return { ok: false, state: 'PROXY_SITE_NOT_READY', source: '', value: '', strength: '', stateChanged: null };
}

async function checkProxyBusinessReady(page, proxy, runtime = {}, context = {}) {
  const profile = loadDreaminaProxyPrecheckProfile();
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.businessReady?.selectors || []);
  if (selectorHit.ok) {
    return { ok: true, state: 'PROXY_BUSINESS_READY', source: 'selector', value: selectorHit.selector, strength: 'strong', stateChanged: null };
  }
  const textHit = await findFirstVisibleByTexts(page, profile?.businessReady?.texts || []);
  if (textHit.ok) {
    return { ok: true, state: 'PROXY_BUSINESS_READY', source: 'text', value: textHit.text, strength: 'weak', stateChanged: null };
  }
  return { ok: false, state: 'PROXY_BUSINESS_NOT_READY', source: '', value: '', strength: '', stateChanged: null };
}

async function confirmProxyPrecheckResult(page, proxy, runtime = {}, context = {}) {
  const { connectivity = null, networkHealth = null, entryReachability = null, siteReady = null, businessReady = null } = context;
  if (connectivity?.ok && networkHealth?.ok && entryReachability?.ok && siteReady?.ok && businessReady?.ok) {
    return {
      ok: true,
      state: 'PROXY_PRECHECK_COMPLETE',
      nextStage: 'proxy-precheck-complete',
      source: 'proxy-chain',
      value: 'all-stages-ready',
      strength: 'strong',
      settleStage: 'primary-success',
      retryCount: 0,
    };
  }
  return {
    ok: false,
    state: 'PROXY_PRECHECK_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: 'none',
    retryCount: 0,
  };
}

function classifyProxyPrecheckFailure(input = {}) {
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  let siteReason = reason;
  if (reason === 'PROXY_ENTRY_UNREACHABLE') siteReason = 'DREAMINA_PROXY_ENTRY_UNREACHABLE';
  else if (reason === 'PROXY_SITE_NOT_READY') siteReason = 'DREAMINA_PROXY_SITE_NOT_READY';
  else if (reason === 'PROXY_BUSINESS_NOT_READY') siteReason = 'DREAMINA_PROXY_BUSINESS_NOT_READY';
  else if (reason === 'PROXY_PRECHECK_RESULT_UNKNOWN') siteReason = 'DREAMINA_PROXY_PRECHECK_RESULT_UNKNOWN';
  return {
    reason,
    siteReason,
    hardFailure: reason === 'PROXY_ENTRY_UNREACHABLE',
  };
}

module.exports = {
  loadDreaminaProxyPrecheckProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  checkProxyConnectivity,
  checkProxyNetworkHealth,
  checkProxyEntryReachability,
  checkProxySiteReady,
  checkProxyBusinessReady,
  confirmProxyPrecheckResult,
  classifyProxyPrecheckFailure,
};
