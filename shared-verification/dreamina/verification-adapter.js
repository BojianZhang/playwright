'use strict';

const fs = require('fs');
const path = require('path');

const DREAMINA_VERIFICATION_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-verification-profile.json');
let dreaminaVerificationProfileCache = null;

function loadDreaminaVerificationProfile(options = {}) {
  const forceReload = Boolean(options?.forceReload);
  if (!forceReload && dreaminaVerificationProfileCache) return dreaminaVerificationProfileCache;
  const raw = fs.readFileSync(DREAMINA_VERIFICATION_PROFILE_PATH, 'utf8');
  dreaminaVerificationProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  return dreaminaVerificationProfileCache;
}

async function isVisible(locator) {
  return await locator.isVisible().catch(() => false);
}

async function findFirstVisibleBySelectors(page, selectors = []) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) {
      return { ok: true, selector, locator };
    }
  }
  return { ok: false, selector: '', locator: null };
}

async function findFirstVisibleByTexts(page, texts = []) {
  for (const text of texts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    if (await isVisible(locator)) {
      return { ok: true, text, locator };
    }
  }
  return { ok: false, text: '', locator: null };
}

async function waitForDreaminaVerificationStageReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const profile = loadDreaminaVerificationProfile();
  const steps = [...new Set([0, Number(runtime?.verificationReadyPrimaryWaitMs || 300), Number(runtime?.verificationReadySecondaryWaitMs || 900)].filter(ms => Number(ms) >= 0))];

  let lastWaitStepMs = 0;
  for (const waitStepMs of steps) {
    lastWaitStepMs = waitStepMs;
    if (waitStepMs > 0) await page.waitForTimeout(waitStepMs);

    const selectorHit = await findFirstVisibleBySelectors(page, profile?.verificationReady?.selectors || []);
    if (selectorHit.ok) {
      if (typeof logInfo === 'function') logInfo(`dreamina.verification.waitForStageReady | selector=${selectorHit.selector} | waitStepMs=${waitStepMs}`);
      return { ok: true, state: 'VERIFICATION_STAGE_READY', source: 'selector', value: selectorHit.selector, strength: 'strong', waitStepMs };
    }

    const textHit = await findFirstVisibleByTexts(page, profile?.verificationReady?.texts || []);
    if (textHit.ok) {
      if (typeof logInfo === 'function') logInfo(`dreamina.verification.waitForStageReady | text=${textHit.text} | waitStepMs=${waitStepMs}`);
      return { ok: true, state: 'VERIFICATION_STAGE_READY', source: 'text', value: textHit.text, strength: 'weak', waitStepMs };
    }
  }

  return { ok: false, state: 'VERIFICATION_STAGE_NOT_READY', source: '', value: '', strength: '', waitStepMs: lastWaitStepMs };
}

async function fetchDreaminaVerificationCode(page, account, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'VERIFICATION_CODE_NOT_AVAILABLE',
    code: '',
    source: 'mail-provider',
    value: '',
    provider: String(runtime?.verificationCodeProvider || 'unconfigured'),
    attempt: 0,
  };
}

async function resolveDreaminaVerificationInput(page, runtime = {}, context = {}) {
  const profile = loadDreaminaVerificationProfile();
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.codeInput?.selectors || []);
  if (!selectorHit.ok) {
    return {
      ok: false,
      state: 'VERIFICATION_INPUT_NOT_FOUND',
      locator: null,
      source: '',
      selector: '',
      inputMeta: null,
      strength: '',
    };
  }

  const inputMeta = {
    tagName: await selectorHit.locator.evaluate(node => String(node?.tagName || '')).catch(() => ''),
    className: await selectorHit.locator.evaluate(node => String(node?.className || '')).catch(() => ''),
    type: await selectorHit.locator.getAttribute('type').catch(() => ''),
    maxLength: await selectorHit.locator.getAttribute('maxlength').catch(() => ''),
    autocomplete: await selectorHit.locator.getAttribute('autocomplete').catch(() => ''),
  };

  return {
    ok: true,
    state: 'VERIFICATION_INPUT_RESOLVED',
    locator: selectorHit.locator,
    source: 'verification-input',
    selector: selectorHit.selector,
    inputMeta,
    strength: 'strong',
  };
}

async function fillDreaminaVerificationCode(page, code, runtime = {}, context = {}) {
  const { codeInputResolution = null } = context;
  if (!codeInputResolution?.ok || !codeInputResolution?.locator) {
    return {
      ok: false,
      state: 'VERIFICATION_CODE_FILL_FAILED',
      mode: '',
      source: 'verification-input',
      value: 'NO_RESOLVED_INPUT',
      stateChanged: null,
    };
  }

  try {
    await codeInputResolution.locator.click().catch(() => {});
    await codeInputResolution.locator.fill(String(code || '')).catch(async () => {
      if (typeof codeInputResolution.locator.type === 'function') {
        await codeInputResolution.locator.type(String(code || ''), { delay: 60 }).catch(() => {});
      }
    });

    const currentValue = await codeInputResolution.locator.inputValue().catch(() => '');
    const stateChanged = Boolean(String(currentValue || '').trim());
    return {
      ok: Boolean(String(currentValue || '').trim()),
      state: String(currentValue || '').trim() ? 'VERIFICATION_CODE_FILLED' : 'VERIFICATION_CODE_FILL_FAILED',
      mode: 'direct-fill',
      source: 'verification-input',
      value: currentValue,
      stateChanged,
    };
  } catch (error) {
    return {
      ok: false,
      state: 'VERIFICATION_CODE_FILL_FAILED',
      mode: 'direct-fill',
      source: 'verification-input',
      value: error?.message || 'UNKNOWN',
      stateChanged: false,
    };
  }
}

async function confirmDreaminaVerificationSubmitResult(page, runtime = {}, context = {}) {
  const profile = loadDreaminaVerificationProfile();

  const nextStageSelector = await findFirstVisibleBySelectors(page, profile?.nextStageSignals?.profileCompletion?.selectors || []);
  if (nextStageSelector.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_SUBMIT_OK',
      nextStage: 'profile-completion',
      source: 'selector',
      value: nextStageSelector.selector,
      strength: 'strong',
      settleStage: 'primary-success',
    };
  }

  const nextStageText = await findFirstVisibleByTexts(page, profile?.nextStageSignals?.profileCompletion?.texts || []);
  if (nextStageText.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_SUBMIT_OK',
      nextStage: 'profile-completion',
      source: 'text',
      value: nextStageText.text,
      strength: 'weak',
      settleStage: 'primary-success',
    };
  }

  const wrongCode = await findFirstVisibleByTexts(page, profile?.failureSignals?.wrongCode || []);
  if (wrongCode.ok) {
    return {
      ok: false,
      state: 'WRONG_VERIFICATION_CODE',
      nextStage: '',
      source: 'text',
      value: wrongCode.text,
      strength: 'strong',
      settleStage: 'primary-failure',
    };
  }

  const rateLimited = await findFirstVisibleByTexts(page, profile?.failureSignals?.rateLimited || []);
  if (rateLimited.ok) {
    return {
      ok: false,
      state: 'VERIFICATION_CODE_RATE_LIMITED',
      nextStage: '',
      source: 'text',
      value: rateLimited.text,
      strength: 'strong',
      settleStage: 'primary-failure',
    };
  }

  const rejected = await findFirstVisibleByTexts(page, profile?.failureSignals?.rejected || []);
  if (rejected.ok) {
    return {
      ok: false,
      state: 'SIGNUP_REJECTED',
      nextStage: '',
      source: 'text',
      value: rejected.text,
      strength: 'strong',
      settleStage: 'primary-failure',
    };
  }

  const existingAccount = await findFirstVisibleByTexts(page, profile?.failureSignals?.existingAccount || []);
  if (existingAccount.ok) {
    return {
      ok: false,
      state: 'ACCOUNT_ALREADY_EXISTS',
      nextStage: '',
      source: 'text',
      value: existingAccount.text,
      strength: 'strong',
      settleStage: 'primary-failure',
    };
  }

  return {
    ok: false,
    state: 'VERIFICATION_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: 'none',
  };
}

function classifyDreaminaVerificationFailure(input = {}) {
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  let siteReason = reason;

  if (reason === 'VERIFICATION_STAGE_NOT_READY') siteReason = 'DREAMINA_VERIFICATION_STAGE_NOT_READY';
  else if (reason === 'VERIFICATION_CODE_NOT_AVAILABLE') siteReason = 'DREAMINA_VERIFICATION_CODE_NOT_AVAILABLE';
  else if (reason === 'VERIFICATION_INPUT_NOT_FOUND') siteReason = 'DREAMINA_VERIFICATION_INPUT_NOT_FOUND';
  else if (reason === 'VERIFICATION_CODE_FILL_FAILED') siteReason = 'DREAMINA_VERIFICATION_CODE_FILL_FAILED';
  else if (reason === 'WRONG_VERIFICATION_CODE') siteReason = 'DREAMINA_WRONG_VERIFICATION_CODE';
  else if (reason === 'VERIFICATION_CODE_RATE_LIMITED') siteReason = 'DREAMINA_VERIFICATION_RATE_LIMITED';
  else if (reason === 'SIGNUP_REJECTED') siteReason = 'DREAMINA_SIGNUP_REJECTED';
  else if (reason === 'ACCOUNT_ALREADY_EXISTS') siteReason = 'DREAMINA_ACCOUNT_ALREADY_EXISTS';
  else if (reason === 'VERIFICATION_RESULT_UNKNOWN') siteReason = 'DREAMINA_VERIFICATION_RESULT_UNKNOWN';

  return {
    reason,
    siteReason,
    hardFailure: reason === 'SIGNUP_REJECTED',
  };
}

module.exports = {
  loadDreaminaVerificationProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  waitForDreaminaVerificationStageReady,
  fetchDreaminaVerificationCode,
  resolveDreaminaVerificationInput,
  fillDreaminaVerificationCode,
  confirmDreaminaVerificationSubmitResult,
  classifyDreaminaVerificationFailure,
};
