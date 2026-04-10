const { loadDreaminaRegisterProfile } = require('./dreamina-register-profile-loader');

function resolveRunMode(config = {}) {
  return String(config.runMode || 'run').trim().toLowerCase();
}

function isTestMode(config = {}) {
  return resolveRunMode(config) === 'test';
}

function getDreaminaHealthConfig(config = {}) {
  const profile = loadDreaminaRegisterProfile();
  const firstLoadHealth = profile?.firstLoadHealth || {};

  return {
    firstLoadGraceWaitMs: isTestMode(config)
      ? Number(firstLoadHealth.testGraceWaitMs ?? firstLoadHealth.graceWaitMs ?? 12000)
      : Number(firstLoadHealth.runGraceWaitMs ?? firstLoadHealth.graceWaitMs ?? 6000),
    validTextSignals: Array.isArray(firstLoadHealth.validTextSignals) ? firstLoadHealth.validTextSignals : [],
    validSelectors: Array.isArray(firstLoadHealth.validSelectors) ? firstLoadHealth.validSelectors : [],
    deadPageBodyTextMinLength: Number(firstLoadHealth.deadPageBodyTextMinLength ?? 80),
  };
}

async function safeCapture(capture, page, name, prefix, config) {
  if (typeof capture !== 'function') return null;
  try {
    return await capture(page, name, prefix, config);
  } catch (_) {
    return null;
  }
}

function hasConsoleFailureEvidence(diagnostics = null) {
  if (!diagnostics?.consoleMessages?.length) return false;
  return diagnostics.consoleMessages.some(item => /chunk|failed|refused|blocked|cors|load|error/i.test(String(item || '')));
}

async function detectDreaminaWhiteScreen(page, options = {}) {
  const {
    account = null,
    proxy = null,
    prefix = '',
    config = {},
    capture = null,
    logTaskStage = null,
    logWarn = null,
  } = options;

  const loginSignals = await page.evaluate(() => {
    const bodyText = String(document.body?.innerText || '').trim();
    return /dreamina|capcut|create realistic talk|sign in|continue with email/i.test(bodyText);
  }).catch(() => false);

  if (loginSignals) {
    return {
      hit: false,
      reason: 'OK',
      bodyTextLength: null,
    };
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  const bodyTextLength = bodyText.length;

  if (bodyTextLength < 20) {
    if (typeof logTaskStage === 'function') {
      logTaskStage(1, account, proxy, 'Dreamina 页面疑似白屏', `bodyLen=${bodyTextLength}`);
    }
    if (typeof logWarn === 'function') {
      logWarn('Dreamina 页面疑似白屏/空白加载，判定为强失败');
    }
    await safeCapture(capture, page, 'dreamina-white-screen', prefix, config);
    return {
      hit: true,
      reason: 'DREAMINA_WHITE_SCREEN',
      bodyTextLength,
    };
  }

  return {
    hit: false,
    reason: 'OK',
    bodyTextLength,
  };
}

async function detectDreaminaFirstLoadDeadPage(page, options = {}) {
  const {
    prefix = '',
    config = {},
    diagnostics = null,
    capture = null,
  } = options;

  const healthConfig = getDreaminaHealthConfig(config);
  const graceWaitMs = Number(healthConfig.firstLoadGraceWaitMs || 0);
  if (graceWaitMs > 0) {
    await page.waitForTimeout(graceWaitMs);
  }

  for (const text of healthConfig.validTextSignals) {
    const locator = page.getByText(text, { exact: false }).first();
    if (await locator.isVisible().catch(() => false)) {
      return {
        hit: false,
        reason: 'OK',
        bodyTextLength: null,
        hasStrongFailureEvidence: false,
      };
    }
  }

  for (const selector of healthConfig.validSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return {
        hit: false,
        reason: 'OK',
        bodyTextLength: null,
        hasStrongFailureEvidence: false,
      };
    }
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  const bodyTextLength = bodyText.length;
  if (/dreamina|capcut|create realistic talk|sign in|continue with email/i.test(bodyText)) {
    return {
      hit: false,
      reason: 'OK',
      bodyTextLength,
      hasStrongFailureEvidence: false,
    };
  }

  const hasStrongFailureEvidence = Boolean(
    diagnostics?.requestFailures?.length
    || diagnostics?.pageErrors?.length
    || diagnostics?.responseErrors?.length
    || hasConsoleFailureEvidence(diagnostics)
  );

  const hit = hasStrongFailureEvidence || bodyTextLength < healthConfig.deadPageBodyTextMinLength;
  if (hit) {
    await safeCapture(capture, page, 'dreamina-first-load-dead-page', prefix, config);
  }

  return {
    hit,
    reason: hit ? 'DREAMINA_FIRST_LOAD_DEAD_PAGE' : 'OK',
    bodyTextLength,
    hasStrongFailureEvidence,
  };
}

module.exports = {
  getDreaminaHealthConfig,
  detectDreaminaWhiteScreen,
  detectDreaminaFirstLoadDeadPage,
};
