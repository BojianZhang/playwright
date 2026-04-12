const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, 'dreamina-register-profile.json');

function ensureString(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`DREAMINA_PROFILE_INVALID:${fieldName}:EMPTY`);
  }
  return text;
}

function ensureStringArray(value, fieldName, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`DREAMINA_PROFILE_INVALID:${fieldName}:NOT_ARRAY`);
  }
  const arr = value.map(item => String(item || '').trim()).filter(Boolean);
  if (!allowEmpty && !arr.length) {
    throw new Error(`DREAMINA_PROFILE_INVALID:${fieldName}:EMPTY_ARRAY`);
  }
  return arr;
}

function ensureRegexPattern(value, fieldName) {
  const text = ensureString(value, fieldName);
  try {
    new RegExp(text, 'i');
  } catch (error) {
    throw new Error(`DREAMINA_PROFILE_INVALID:${fieldName}:BAD_REGEX:${error.message}`);
  }
  return text;
}

function ensureNumber(value, fieldName, { min } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`DREAMINA_PROFILE_INVALID:${fieldName}:NOT_NUMBER`);
  }
  if (typeof min === 'number' && num < min) {
    throw new Error(`DREAMINA_PROFILE_INVALID:${fieldName}:LT_${min}`);
  }
  return num;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('DREAMINA_PROFILE_INVALID:ROOT:NOT_OBJECT');
  }

  const normalized = {
    homeUrl: ensureString(profile.homeUrl, 'homeUrl'),
    loginSignals: {
      emailInputRoleName: ensureString(profile?.loginSignals?.emailInputRoleName, 'loginSignals.emailInputRoleName'),
      continueWithEmailText: ensureString(profile?.loginSignals?.continueWithEmailText, 'loginSignals.continueWithEmailText'),
      entryTexts: ensureStringArray(profile?.loginSignals?.entryTexts, 'loginSignals.entryTexts'),
      entryRolePattern: ensureRegexPattern(profile?.loginSignals?.entryRolePattern, 'loginSignals.entryRolePattern'),
    },
    signupForm: {
      emailInputRoleName: ensureString(profile?.signupForm?.emailInputRoleName, 'signupForm.emailInputRoleName'),
      passwordInputRoleName: ensureString(profile?.signupForm?.passwordInputRoleName, 'signupForm.passwordInputRoleName'),
      continueButtonRoleName: ensureString(profile?.signupForm?.continueButtonRoleName, 'signupForm.continueButtonRoleName'),
      signUpText: ensureString(profile?.signupForm?.signUpText, 'signupForm.signUpText'),
    },
    verification: {
      countdownPatterns: ensureStringArray(profile?.verification?.countdownPatterns, 'verification.countdownPatterns'),
      countdownClassSelectors: ensureStringArray(profile?.verification?.countdownClassSelectors, 'verification.countdownClassSelectors'),
      inputSelectors: ensureStringArray(profile?.verification?.inputSelectors, 'verification.inputSelectors'),
      wrongCodePatterns: ensureStringArray(profile?.verification?.wrongCodePatterns, 'verification.wrongCodePatterns'),
    },
    birthday: {
      yearInputRoleName: ensureString(profile?.birthday?.yearInputRoleName, 'birthday.yearInputRoleName'),
      monthText: ensureString(profile?.birthday?.monthText, 'birthday.monthText'),
      dayText: ensureString(profile?.birthday?.dayText, 'birthday.dayText'),
      nextButtonSelector: ensureString(profile?.birthday?.nextButtonSelector, 'birthday.nextButtonSelector'),
    },
    overlays: {
      buttonNames: ensureStringArray(profile?.overlays?.buttonNames, 'overlays.buttonNames'),
      buttonNamePattern: ensureRegexPattern(profile?.overlays?.buttonNamePattern, 'overlays.buttonNamePattern'),
      extraSelectors: ensureStringArray(profile?.overlays?.extraSelectors, 'overlays.extraSelectors'),
    },
    postRegisterReady: {
      selectors: ensureStringArray(profile?.postRegisterReady?.selectors, 'postRegisterReady.selectors'),
      texts: ensureStringArray(profile?.postRegisterReady?.texts, 'postRegisterReady.texts'),
    },
    firstLoadHealth: {
      runGraceWaitMs: profile?.firstLoadHealth?.runGraceWaitMs === undefined ? undefined : ensureNumber(profile?.firstLoadHealth?.runGraceWaitMs, 'firstLoadHealth.runGraceWaitMs', { min: 0 }),
      testGraceWaitMs: profile?.firstLoadHealth?.testGraceWaitMs === undefined ? undefined : ensureNumber(profile?.firstLoadHealth?.testGraceWaitMs, 'firstLoadHealth.testGraceWaitMs', { min: 0 }),
      graceWaitMs: ensureNumber(profile?.firstLoadHealth?.graceWaitMs, 'firstLoadHealth.graceWaitMs', { min: 0 }),
      validTextSignals: ensureStringArray(profile?.firstLoadHealth?.validTextSignals, 'firstLoadHealth.validTextSignals'),
      validSelectors: ensureStringArray(profile?.firstLoadHealth?.validSelectors, 'firstLoadHealth.validSelectors'),
    },
    existingAccountSignals: {
      patterns: ensureStringArray(profile?.existingAccountSignals?.patterns, 'existingAccountSignals.patterns'),
      signInHints: ensureStringArray(profile?.existingAccountSignals?.signInHints, 'existingAccountSignals.signInHints'),
    },
    signupFailureRules: (() => {
      const rules = Array.isArray(profile?.signupFailureRules) ? profile.signupFailureRules : null;
      if (!rules) {
        throw new Error('DREAMINA_PROFILE_INVALID:signupFailureRules:NOT_ARRAY');
      }
      if (!rules.length) {
        throw new Error('DREAMINA_PROFILE_INVALID:signupFailureRules:EMPTY_ARRAY');
      }
      return rules.map((rule, index) => ({
        reason: ensureString(rule?.reason, `signupFailureRules[${index}].reason`),
        label: ensureString(rule?.label, `signupFailureRules[${index}].label`),
        pattern: ensureRegexPattern(rule?.pattern, `signupFailureRules[${index}].pattern`),
      }));
    })(),
  };

  normalized.verification.countdownPatterns.forEach((pattern, index) => ensureRegexPattern(pattern, `verification.countdownPatterns[${index}]`));
  normalized.verification.wrongCodePatterns.forEach((pattern, index) => ensureRegexPattern(pattern, `verification.wrongCodePatterns[${index}]`));

  return normalized;
}

function summarizeProfile(profile) {
  return {
    homeUrl: profile.homeUrl,
    loginEntryTexts: profile.loginSignals.entryTexts.length,
    overlayButtons: profile.overlays.buttonNames.length,
    signupFailureRules: profile.signupFailureRules.length,
    verificationCountdownPatterns: profile.verification.countdownPatterns.length,
    verificationInputSelectors: profile.verification.inputSelectors.length,
    postRegisterReadyTexts: profile.postRegisterReady.texts.length,
    firstLoadTextSignals: profile.firstLoadHealth.validTextSignals.length,
    firstLoadSelectors: profile.firstLoadHealth.validSelectors.length,
  };
}

function loadDreaminaRegisterProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error(`DREAMINA_REGISTER_PROFILE_MISSING:${PROFILE_PATH}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`DREAMINA_PROFILE_PARSE_FAILED:${error.message}`);
  }

  return validateProfile(parsed);
}

function runProfileSelfCheck() {
  const profile = loadDreaminaRegisterProfile();
  const summary = summarizeProfile(profile);
  console.log('Dreamina profile self-check: OK');
  console.log(`Profile path: ${PROFILE_PATH}`);
  console.log(`homeUrl: ${summary.homeUrl}`);
  console.log(`loginEntryTexts: ${summary.loginEntryTexts}`);
  console.log(`overlayButtons: ${summary.overlayButtons}`);
  console.log(`signupFailureRules: ${summary.signupFailureRules}`);
  console.log(`verificationCountdownPatterns: ${summary.verificationCountdownPatterns}`);
  console.log(`verificationInputSelectors: ${summary.verificationInputSelectors}`);
  console.log(`postRegisterReadyTexts: ${summary.postRegisterReadyTexts}`);
}

if (require.main === module) {
  try {
    runProfileSelfCheck();
  } catch (error) {
    console.error('Dreamina profile self-check: FAILED');
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  PROFILE_PATH,
  loadDreaminaRegisterProfile,
  validateProfile,
  summarizeProfile,
  runProfileSelfCheck,
};
