const { loadDreaminaRegisterProfile } = require('./dreamina-register-profile-loader');

function resolveRunMode(config = {}) {
  return String(config.runMode || 'run').trim().toLowerCase();
}

function isTestMode(config = {}) {
  return resolveRunMode(config) === 'test';
}

function resolveDreaminaHomeUrl(config = {}) {
  const profile = loadDreaminaRegisterProfile();
  return String(profile?.homeUrl || config.dreaminaHomeUrl || 'https://dreamina.capcut.com/ai-tool/home/');
}

function getDreaminaHealthConfig(config = {}, options = {}) {
  const profile = loadDreaminaRegisterProfile();
  const firstLoadHealth = profile?.firstLoadHealth || {};
  const stage = String(options.stage || 'register').trim().toLowerCase();
  const mode = isTestMode(config) ? 'test' : 'run';

  const registerGraceWaitMs = mode === 'test'
    ? Number(config.testDreaminaFirstLoadGraceWaitMs ?? firstLoadHealth.testGraceWaitMs ?? firstLoadHealth.graceWaitMs ?? 12000)
    : Number(config.runDreaminaFirstLoadGraceWaitMs ?? firstLoadHealth.runGraceWaitMs ?? firstLoadHealth.graceWaitMs ?? 6000);

  const precheckGraceWaitMs = mode === 'test'
    ? Number(config.testPrecheckDreaminaFirstLoadGraceWaitMs ?? config.precheckDreaminaFirstLoadGraceWaitMs ?? config.testDreaminaFirstLoadGraceWaitMs ?? registerGraceWaitMs)
    : Number(config.runPrecheckDreaminaFirstLoadGraceWaitMs ?? config.precheckDreaminaFirstLoadGraceWaitMs ?? config.runDreaminaFirstLoadGraceWaitMs ?? registerGraceWaitMs);

  const registerNavigationTimeoutMs = mode === 'test'
    ? Number(config.testDreaminaNavigationTimeoutMs ?? config.dreaminaNavigationTimeoutMs ?? 120000)
    : Number(config.runDreaminaNavigationTimeoutMs ?? config.dreaminaNavigationTimeoutMs ?? 120000);

  const precheckNavigationTimeoutMs = mode === 'test'
    ? Number(config.testPrecheckDreaminaNavigationTimeoutMs ?? config.precheckDreaminaNavigationTimeoutMs ?? config.testDreaminaNavigationTimeoutMs ?? registerNavigationTimeoutMs)
    : Number(config.runPrecheckDreaminaNavigationTimeoutMs ?? config.precheckDreaminaNavigationTimeoutMs ?? config.runDreaminaNavigationTimeoutMs ?? registerNavigationTimeoutMs);

  return {
    stage,
    mode,
    homeUrl: resolveDreaminaHomeUrl(config),
    firstLoadGraceWaitMs: stage === 'precheck' ? precheckGraceWaitMs : registerGraceWaitMs,
    navigationTimeoutMs: stage === 'precheck' ? precheckNavigationTimeoutMs : registerNavigationTimeoutMs,
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

async function hasDreaminaHomePositiveSignals(page, config = {}, stage = 'precheck') {
  const healthConfig = getDreaminaHealthConfig(config, { stage });
  for (const text of healthConfig.validTextSignals) {
    const locator = page.getByText(text, { exact: false }).first();
    if (await locator.isVisible().catch(() => false)) {
      return { ok: true, source: 'text', value: text };
    }
  }
  for (const selector of healthConfig.validSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return { ok: true, source: 'selector', value: selector };
    }
  }
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  if (/dreamina|capcut|create realistic talk|sign in|continue with email/i.test(bodyText)) {
    return { ok: true, source: 'bodyText', value: 'BODY_TEXT_SIGNAL' };
  }
  return { ok: false, source: '', value: '' };
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
    stage = 'register',
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
      suspected: false,
    };
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  const bodyTextLength = bodyText.length;

  if (bodyTextLength < 20) {
    if (stage === 'precheck') {
      return {
        hit: false,
        reason: 'DREAMINA_WHITE_SCREEN_SUSPECTED',
        bodyTextLength,
        suspected: true,
      };
    }
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
      suspected: false,
    };
  }

  return {
    hit: false,
    reason: 'OK',
    bodyTextLength,
    suspected: false,
  };
}

async function detectDreaminaFirstLoadDeadPage(page, options = {}) {
  const {
    prefix = '',
    config = {},
    diagnostics = null,
    capture = null,
    stage = 'register',
    graceWaitMsOverride = null,
  } = options;

  const healthConfig = getDreaminaHealthConfig(config, { stage });
  const graceWaitMs = Number((graceWaitMsOverride ?? healthConfig.firstLoadGraceWaitMs) || 0);
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

async function checkDreaminaHomeHealth(page, options = {}) {
  const {
    account = null,
    proxy = null,
    prefix = '',
    config = {},
    diagnostics = null,
    capture = null,
    log = null,
    stage = 'precheck',
    dynamicGraceWaitMs = null,
  } = options;

  const healthConfig = getDreaminaHealthConfig(config, { stage });
  const startedAt = Date.now();

  try {
    await page.goto(healthConfig.homeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: healthConfig.navigationTimeoutMs,
    });
    await safeCapture(capture, page, 'dreamina-home-health-open', prefix, config);

    let whiteScreen = await detectDreaminaWhiteScreen(page, {
      account,
      proxy,
      prefix,
      config,
      capture,
      stage,
    });

    if (stage === 'precheck' && whiteScreen.suspected) {
      const recheckWaitMs = Math.min(4000, Math.max(1200, Number(dynamicGraceWaitMs || healthConfig.firstLoadGraceWaitMs || 0)));
      await page.waitForTimeout(recheckWaitMs);
      whiteScreen = await detectDreaminaWhiteScreen(page, {
        account,
        proxy,
        prefix,
        config,
        capture,
        stage: 'register',
      });
      whiteScreen.recheckWaitMs = recheckWaitMs;
    }

    if (whiteScreen.hit) {
      if (typeof log === 'function') log(`Dreamina 首页健康检查失败：${whiteScreen.reason}`);
      return {
        success: false,
        reason: whiteScreen.reason,
        finalUrl: page.url(),
        elapsedMs: Date.now() - startedAt,
        whiteScreen,
        deadPage: null,
      };
    }

    const deadPage = await detectDreaminaFirstLoadDeadPage(page, {
      prefix,
      config,
      diagnostics,
      capture,
      stage,
      graceWaitMsOverride: dynamicGraceWaitMs,
    });
    if (deadPage.hit) {
      if (typeof log === 'function') log(`Dreamina 首页健康检查失败：${deadPage.reason}`);
      return {
        success: false,
        reason: deadPage.reason,
        finalUrl: page.url(),
        elapsedMs: Date.now() - startedAt,
        whiteScreen,
        deadPage,
      };
    }

    const positiveSignal = await hasDreaminaHomePositiveSignals(page, config, stage);
    if (!positiveSignal.ok && stage === 'precheck') {
      return {
        success: false,
        reason: 'DREAMINA_HOME_SIGNAL_MISSING',
        finalUrl: page.url(),
        elapsedMs: Date.now() - startedAt,
        whiteScreen,
        deadPage,
        positiveSignal,
      };
    }

    return {
      success: true,
      reason: 'OK',
      finalUrl: page.url(),
      elapsedMs: Date.now() - startedAt,
      whiteScreen,
      deadPage,
      positiveSignal,
    };
  } catch (error) {
    const message = String(error?.message || 'DREAMINA_NAV_ERROR');
    return {
      success: false,
      reason: /timeout/i.test(message) ? 'DREAMINA_OPEN_TIMEOUT' : 'DREAMINA_NAV_ERROR',
      finalUrl: typeof page?.url === 'function' ? page.url() : '',
      elapsedMs: Date.now() - startedAt,
      whiteScreen: null,
      deadPage: null,
      error: message,
    };
  }
}

function isDreaminaHomeHardFailure(reason = '') {
  const text = String(reason || '').trim();
  return text === 'DREAMINA_WHITE_SCREEN'
    || text.startsWith('DREAMINA_WHITE_SCREEN|')
    || text === 'DREAMINA_FIRST_LOAD_DEAD_PAGE'
    || text.startsWith('DREAMINA_FIRST_LOAD_DEAD_PAGE|');
}

module.exports = {
  resolveDreaminaHomeUrl,
  getDreaminaHealthConfig,
  detectDreaminaWhiteScreen,
  detectDreaminaFirstLoadDeadPage,
  checkDreaminaHomeHealth,
  isDreaminaHomeHardFailure,
};
