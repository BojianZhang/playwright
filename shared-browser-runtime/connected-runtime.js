'use strict';

const { createRandomFingerprint, normalizeBrowserIdentityPolicy } = require('./fingerprint');
const { clearContextStorageOnStart } = require('./create-browser-runtime');
const { applyFingerprintHardeningToContext, buildCdpUserAgentOverride } = require('./fingerprint-hardening');

async function applyConnectedRuntimeIdentity(context, page, opts = {}) {
  const runtime = opts?.runtime && typeof opts.runtime === 'object' ? opts.runtime : {};
  const explicitIdentity = Boolean(
    opts?.browserIdentity
    || opts?.identity
    || runtime?.browserIdentity
    || runtime?.identity
  );
  const connectedBrowserIdentity = explicitIdentity
    ? (opts?.browserIdentity || runtime?.browserIdentity || null)
    : {
        enabled: false,
        includeAcceptLanguageHeader: false,
        clearStorageOnStart: false,
      };
  const fingerprint = createRandomFingerprint(runtime, {
    proxy: opts?.proxy || null,
    account: opts?.account || null,
    browserIdentity: connectedBrowserIdentity,
    identity: opts?.identity || null,
    fingerprintHardening: opts?.fingerprintHardening || null,
    windowLayout: opts?.windowLayout || null,
  });
  const policy = normalizeBrowserIdentityPolicy(runtime, {
    browserIdentity: connectedBrowserIdentity,
  });

  if (policy.enabled && policy.includeAcceptLanguageHeader && fingerprint.acceptLanguage && context && typeof context.setExtraHTTPHeaders === 'function') {
    await context.setExtraHTTPHeaders({ 'Accept-Language': fingerprint.acceptLanguage }).catch(() => {});
  }

  const storageCleanup = policy.enabled && policy.clearStorageOnStart
    ? await clearContextStorageOnStart(context, page)
    : { cookiesCleared: false, storageCleared: false, error: null };

  const explicitHardening = Boolean(opts?.fingerprintHardening || runtime?.fingerprintHardening);
  const hardeningAllowed = Boolean(policy.enabled || explicitHardening);

  const shouldOverrideUserAgent = Boolean(
    policy.enabled
    || runtime?.userAgent
    || runtime?.userAgentData
    || runtime?.clientHints
    || opts?.forceCdpUserAgentOverride
  );
  const cdpUserAgentOverride = hardeningAllowed && shouldOverrideUserAgent
    ? buildCdpUserAgentOverride(fingerprint)
    : null;
  if (cdpUserAgentOverride && context && page && typeof context.newCDPSession === 'function') {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable').catch(() => {});
      await cdp.send('Network.setUserAgentOverride', cdpUserAgentOverride);
      fingerprint.summary.cdpUserAgentOverride = true;
    } catch (error) {
      fingerprint.summary.cdpUserAgentOverrideError = String(error?.message || error || 'CDP_UA_OVERRIDE_FAILED');
    }
  }
  const hardeningRuntime = hardeningAllowed
    ? await applyFingerprintHardeningToContext(context, fingerprint, { runtime })
      .catch((error) => ({
        injected: false,
        profile: fingerprint.hardening,
        summary: {},
        error: String(error?.message || error || 'FINGERPRINT_HARDENING_FAILED'),
      }))
    : {
        injected: false,
        profile: fingerprint.hardening,
        summary: {},
        error: null,
        skipped: 'identity-disabled',
      };
  fingerprint.hardeningRuntime = hardeningRuntime;
  fingerprint.summary.hardeningInjected = Boolean(hardeningRuntime.injected);
  fingerprint.summary.hardeningError = hardeningRuntime.error || null;
  fingerprint.summary.connectedIdentityMode = explicitIdentity ? 'explicit' : 'passive';

  if (hardeningRuntime.injected && hardeningRuntime.script && page && typeof page.evaluate === 'function') {
    try {
      await page.evaluate(hardeningRuntime.script);
      hardeningRuntime.appliedToCurrentPage = true;
    } catch (error) {
      hardeningRuntime.currentPageError = String(error?.message || error || 'CURRENT_PAGE_HARDENING_FAILED');
    }
  }

  return { fingerprint, storageCleanup };
}

function buildConnectedRuntimeIdentityError(error, storagePolicy = 'provider-context-identity-error') {
  const message = String(error?.message || error || 'PROVIDER_IDENTITY_APPLY_FAILED');
  return {
    fingerprint: {
      summary: {
        identityStable: false,
        storagePolicy,
        error: message,
      },
    },
    storageCleanup: {
      cookiesCleared: false,
      storageCleared: false,
      error: message,
    },
  };
}

module.exports = {
  applyConnectedRuntimeIdentity,
  buildConnectedRuntimeIdentityError,
};
