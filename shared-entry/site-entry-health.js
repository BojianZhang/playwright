'use strict';

/**
 * site-entry-health.js
 *
 * 这个文件的唯一边界：
 * 负责“某个站点入口页/首页是否已经成功加载到可操作状态”的公共编排。
 *
 * 它做的事情：
 * 1. 打开首页
 * 2. reload / retry
 * 3. 判断白屏
 * 4. 判断死页
 * 5. 判断 ready 信号
 * 6. 处理入口页级别的 overlay
 * 7. 在 page/context 损坏时决定是否应该重建 page
 *
 * 它不做的事情：
 * 1. 不负责 browser / context 的创建
 * 2. 不负责代理池选择与淘汰
 * 3. 不负责登录后业务流
 * 4. 不负责注册后续动作（邮箱、验证码、生日、session 等）
 */

const path = require('path');
const dreaminaAdapter = require('./dreamina/adapter');

/**
 * 统一读取运行模式。
 * 作用：
 * - 让调用方只传 config，就能区分 run / test。
 * - 后续所有 timeout / grace wait 都可以基于它分叉。
 */
function resolveRunMode(config = {}) {
  return String(config.runMode || 'run').trim().toLowerCase();
}

/**
 * 判断当前是不是 test 模式。
 * 作用：
 * - 给 timeout / grace wait / retry 策略做 test 分支。
 */
function isTestMode(config = {}) {
  return resolveRunMode(config) === 'test';
}

/**
 * 安全执行截图。
 * 作用：
 * - 某些页面异常时截图也可能失败。
 * - 这里统一兜底，避免截图失败把主流程打断。
 */
async function safeCapture(capture, page, name, prefix, config) {
  if (typeof capture !== 'function') return null;
  try {
    return await capture(page, name, prefix, config);
  } catch (_) {
    return null;
  }
}

/**
 * 从 profile + config 里合成站点入口页最终运行时配置。
 *
 * 入参：
 * - siteProfile: 当前站点 profile（例如 Dreamina / OpenAI / Claude）
 * - config: 全局运行配置
 * - options.stage: 当前阶段，通常是 precheck / register / entry
 *
 * 返回：
 * - 统一的 homeUrl / timeout / readySignals / whiteScreen / deadPage 配置
 *
 * 作用：
 * - 把“站点差异”和“run/test 差异”都压平到一个 runtime 对象里
 * - 后面真正的 orchestrator 只读 runtime，不去散着读 config/profile
 */
function getSiteEntryRuntime(siteProfile = {}, config = {}, options = {}) {
  const stage = String(options.stage || 'entry').trim().toLowerCase();
  const mode = isTestMode(config) ? 'test' : 'run';

  const entry = siteProfile?.entry || {};
  const navigation = entry?.navigation || {};
  const firstLoad = entry?.firstLoad || {};
  const readySignals = entry?.readySignals || {};
  const whiteScreen = entry?.whiteScreen || {};
  const deadPage = entry?.deadPage || {};
  const overlays = entry?.overlays || {};

  const runNavigationTimeoutMs = Number(
    config.runEntryNavigationTimeoutMs
    ?? navigation.runTimeoutMs
    ?? config.runDreaminaNavigationTimeoutMs
    ?? config.dreaminaNavigationTimeoutMs
    ?? 120000
  );

  const testNavigationTimeoutMs = Number(
    config.testEntryNavigationTimeoutMs
    ?? navigation.testTimeoutMs
    ?? config.testDreaminaNavigationTimeoutMs
    ?? config.dreaminaNavigationTimeoutMs
    ?? 120000
  );

  const runGraceWaitMs = Number(
    config.runEntryFirstLoadGraceWaitMs
    ?? firstLoad.runGraceWaitMs
    ?? config.runDreaminaFirstLoadGraceWaitMs
    ?? 4000
  );

  const testGraceWaitMs = Number(
    config.testEntryFirstLoadGraceWaitMs
    ?? firstLoad.testGraceWaitMs
    ?? config.testDreaminaFirstLoadGraceWaitMs
    ?? 12000
  );

  return {
    stage,
    mode,
    siteName: String(siteProfile?.name || 'UnknownSite'),
    homeUrl: String(siteProfile?.homeUrl || entry?.homeUrl || config.siteEntryHomeUrl || ''),
    navigationTimeoutMs: mode === 'test' ? testNavigationTimeoutMs : runNavigationTimeoutMs,
    firstLoadGraceWaitMs: mode === 'test' ? testGraceWaitMs : runGraceWaitMs,
    retryAttempts: Number(entry?.navigation?.retryAttempts ?? 3),
    readyTextSignals: Array.isArray(readySignals.text) ? readySignals.text : [],
    readySelectors: Array.isArray(readySignals.selectors) ? readySignals.selectors : [],
    readyBodyPatterns: Array.isArray(readySignals.bodyPatterns) ? readySignals.bodyPatterns : [],
    whiteScreenBodyMinLength: Number(whiteScreen.bodyTextMinLength ?? 20),
    whiteScreenRecheckOnSuspected: Boolean(whiteScreen.recheckOnSuspected ?? true),
    whiteScreenRecheckWaitMinMs: Number(whiteScreen.precheckRecheckWaitMinMs ?? 1200),
    whiteScreenRecheckWaitMaxMs: Number(whiteScreen.precheckRecheckWaitMaxMs ?? 4000),
    deadPageBodyTextMinLength: Number(deadPage.bodyTextMinLength ?? firstLoad.deadPageBodyTextMinLength ?? 80),
    overlayEnabled: overlays.enabled !== false,
    overlayPatterns: Array.isArray(overlays.patterns) ? overlays.patterns : [],
  };
}

/**
 * 判断 diagnostics 里是否存在明显的控制台失败证据。
 *
 * 作用：
 * - 很多页面白屏不是 body 为空这么简单，
 *   而是前端 chunk / script / cors / blocked 直接报错。
 * - 这里给死页判定提供“强失败证据”。
 */
function hasConsoleFailureEvidence(diagnostics = null) {
  if (!diagnostics?.consoleMessages?.length) return false;
  return diagnostics.consoleMessages.some(item => /chunk|failed|refused|blocked|cors|load|error/i.test(String(item || '')));
}

/**
 * 根据站点名解析默认 adapter。
 *
 * 作用：
 * - 让公共层先具备“按站点接 adapter”的能力。
 * - 当前先接入 Dreamina。
 * - 后续如果有 OpenAI / Claude，可以继续在这里扩展映射，
 *   或者再进一步演进成独立 registry。
 */
function resolveSiteAdapter(siteProfile = {}, options = {}) {
  if (options.adapter) {
    return options.adapter;
  }

  const siteName = String(siteProfile?.name || '').trim().toLowerCase();
  if (siteName === 'dreamina') {
    return dreaminaAdapter;
  }

  return null;
}

/**
 * 判断当前页面是否已经出现“明确 ready”的正向信号。
 *
 * 作用：
 * - 防止“没判死就算成功”这种假阳性。
 * - 首页只有命中真正的 ready signal，才应该算 ready。
 */
async function detectPositiveReadySignals(page, runtime) {
  for (const text of runtime.readyTextSignals) {
    const locator = page.getByText(text, { exact: false }).first();
    if (await locator.isVisible().catch(() => false)) {
      return { ok: true, source: 'text', value: text };
    }
  }

  for (const selector of runtime.readySelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return { ok: true, source: 'selector', value: selector };
    }
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  for (const pattern of runtime.readyBodyPatterns) {
    const regex = new RegExp(String(pattern || ''), 'i');
    if (regex.test(bodyText)) {
      return { ok: true, source: 'bodyText', value: pattern };
    }
  }

  return { ok: false, source: '', value: '' };
}

/**
 * 白屏检测。
 *
 * 作用：
 * - 判断页面是不是“内容区几乎没起来”的状态。
 * - 在 precheck 阶段可以先给 suspected，避免过早误杀。
 * - 在 register 阶段更严格，直接把硬白屏打出来。
 */
async function detectWhiteScreen(page, runtime, options = {}) {
  const {
    account = null,
    proxy = null,
    prefix = '',
    config = {},
    capture = null,
    logTaskStage = null,
    logWarn = null,
  } = options;

  const positiveSignals = await detectPositiveReadySignals(page, runtime);
  if (positiveSignals.ok) {
    return {
      hit: false,
      reason: 'OK',
      bodyTextLength: null,
      suspected: false,
      positiveSignals,
    };
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  const bodyTextLength = bodyText.length;

  if (bodyTextLength < runtime.whiteScreenBodyMinLength) {
    if (runtime.stage === 'precheck') {
      return {
        hit: false,
        reason: 'WHITE_SCREEN_SUSPECTED',
        bodyTextLength,
        suspected: true,
        positiveSignals,
      };
    }

    if (typeof logTaskStage === 'function') {
      logTaskStage(1, account, proxy, `${runtime.siteName} 页面疑似白屏`, `bodyLen=${bodyTextLength}`);
    }
    if (typeof logWarn === 'function') {
      logWarn(`${runtime.siteName} 页面疑似白屏/空白加载，判定为强失败`);
    }
    await safeCapture(capture, page, `${runtime.siteName.toLowerCase()}-white-screen`, prefix, config);
    return {
      hit: true,
      reason: 'WHITE_SCREEN',
      bodyTextLength,
      suspected: false,
      positiveSignals,
    };
  }

  return {
    hit: false,
    reason: 'OK',
    bodyTextLength,
    suspected: false,
    positiveSignals,
  };
}

/**
 * 死页检测。
 *
 * 作用：
 * - 页面不是瞬时白屏，但长时间没有 ready signal，
 *   且伴随资源/脚本失败证据时，把它判成 dead page。
 */
async function detectDeadPage(page, runtime, diagnostics = null, options = {}) {
  const {
    prefix = '',
    config = {},
    capture = null,
    graceWaitMsOverride = null,
  } = options;

  const graceWaitMs = Number((graceWaitMsOverride ?? runtime.firstLoadGraceWaitMs) || 0);
  if (graceWaitMs > 0) {
    await page.waitForTimeout(graceWaitMs);
  }

  const positiveSignals = await detectPositiveReadySignals(page, runtime);
  if (positiveSignals.ok) {
    return {
      hit: false,
      reason: 'OK',
      bodyTextLength: null,
      hasStrongFailureEvidence: false,
      positiveSignals,
    };
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  const bodyTextLength = bodyText.length;

  const hasStrongFailureEvidence = Boolean(
    diagnostics?.requestFailures?.length
    || diagnostics?.pageErrors?.length
    || diagnostics?.responseErrors?.length
    || hasConsoleFailureEvidence(diagnostics)
  );

  const hit = hasStrongFailureEvidence || bodyTextLength < runtime.deadPageBodyTextMinLength;
  if (hit) {
    await safeCapture(capture, page, `${runtime.siteName.toLowerCase()}-dead-page`, prefix, config);
  }

  return {
    hit,
    reason: hit ? 'DEAD_PAGE' : 'OK',
    bodyTextLength,
    hasStrongFailureEvidence,
    positiveSignals,
  };
}

/**
 * 单次打开站点首页尝试。
 *
 * 作用：
 * - 这是 retry orchestrator 里的“一次尝试”。
 * - 负责本次 goto/reload、截图、白屏/死页/ready 判断、overlay、ready wait。
 */
async function attemptOpenSiteEntry(options = {}) {
  const {
    page,
    runtime,
    attempt,
    maxAttempts,
    diagnostics = null,
    capture = null,
    dumpDiagnostics = null,
    preprocessOverlays = null,
    waitForReadySignals = null,
    classifyFailure = null,
    recoverEntry = null,
    logger = {},
    account = null,
    proxy = null,
    prefix = '',
    config = {},
    dynamicGraceWaitMs = null,
  } = options;

  const { log, logInfo, logWarn, logSuccess, logTaskStage } = logger;

  const attemptStartedAt = Date.now();
  if (typeof log === 'function') log(`${runtime.siteName} 打开尝试 ${attempt}/${maxAttempts}`);
  if (typeof logInfo === 'function') logInfo(`阶段 2.${attempt}：尝试进入 ${runtime.siteName} 首页：${runtime.homeUrl}`);
  if (typeof logTaskStage === 'function') logTaskStage(2, account, proxy, `打开 ${runtime.siteName}`, runtime.homeUrl);

  const navStartedAt = Date.now();
  if (attempt === 1) {
    await page.goto(runtime.homeUrl, { waitUntil: 'domcontentloaded', timeout: runtime.navigationTimeoutMs });
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: runtime.navigationTimeoutMs });
  }
  if (typeof logInfo === 'function') {
    logInfo(`openSiteEntry.navDone | site=${runtime.siteName} | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - navStartedAt}ms | mode=${attempt === 1 ? 'goto' : 'reload'} | url=${page.url()}`);
  }

  const captureStartedAt = Date.now();
  await safeCapture(capture, page, `${runtime.siteName.toLowerCase()}-entry-open-${attempt}`, prefix, config);
  if (typeof logInfo === 'function') {
    logInfo(`openSiteEntry.captureDone | site=${runtime.siteName} | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - captureStartedAt}ms`);
  }

  const whiteScreen = await detectWhiteScreen(page, runtime, {
    account,
    proxy,
    prefix,
    config,
    capture,
    logTaskStage,
    logWarn,
  });

  if (runtime.stage === 'precheck' && whiteScreen.suspected && runtime.whiteScreenRecheckOnSuspected) {
    const recheckWaitMs = Math.min(
      runtime.whiteScreenRecheckWaitMaxMs,
      Math.max(runtime.whiteScreenRecheckWaitMinMs, Number(dynamicGraceWaitMs || runtime.firstLoadGraceWaitMs || 0))
    );
    await page.waitForTimeout(recheckWaitMs);
    const rechecked = await detectWhiteScreen(page, { ...runtime, stage: 'register' }, {
      account,
      proxy,
      prefix,
      config,
      capture,
      logTaskStage,
      logWarn,
    });
    rechecked.recheckWaitMs = recheckWaitMs;
    if (rechecked.hit) {
      const diagnosticsPath = typeof dumpDiagnostics === 'function'
        ? await dumpDiagnostics(page, diagnostics, account, proxy, prefix, `${runtime.siteName.toUpperCase()}_WHITE_SCREEN`)
        : null;
      return {
        success: false,
        reason: 'WHITE_SCREEN',
        whiteScreen: rechecked,
        deadPage: null,
        readySignal: null,
        diagnosticsPath,
        elapsedMs: Date.now() - attemptStartedAt,
      };
    }
  } else if (whiteScreen.hit) {
    const diagnosticsPath = typeof dumpDiagnostics === 'function'
      ? await dumpDiagnostics(page, diagnostics, account, proxy, prefix, `${runtime.siteName.toUpperCase()}_WHITE_SCREEN`)
      : null;
    return {
      success: false,
      reason: 'WHITE_SCREEN',
      whiteScreen,
      deadPage: null,
      readySignal: null,
      diagnosticsPath,
      elapsedMs: Date.now() - attemptStartedAt,
    };
  }

  const deadPage = await detectDeadPage(page, runtime, diagnostics, {
    prefix,
    config,
    capture,
    graceWaitMsOverride: dynamicGraceWaitMs,
  });
  if (deadPage.hit) {
    const diagnosticsPath = typeof dumpDiagnostics === 'function'
      ? await dumpDiagnostics(page, diagnostics, account, proxy, prefix, `${runtime.siteName.toUpperCase()}_DEAD_PAGE`)
      : null;
    return {
      success: false,
      reason: 'DEAD_PAGE',
      whiteScreen,
      deadPage,
      readySignal: null,
      diagnosticsPath,
      elapsedMs: Date.now() - attemptStartedAt,
    };
  }

  if (runtime.overlayEnabled && typeof preprocessOverlays === 'function') {
    await preprocessOverlays(page, { log, logInfo, logWarn, logSuccess, logTaskStage, account, proxy, prefix, config, runtime });
  }

  const runReadyCheck = async () => {
    return typeof waitForReadySignals === 'function'
      ? await waitForReadySignals(page, runtime, { log, logInfo, logWarn, logSuccess, account, proxy, prefix, config })
      : await detectPositiveReadySignals(page, runtime);
  };

  const readySignal = await runReadyCheck();

  if (readySignal?.ok) {
    if (typeof logSuccess === 'function') {
      logSuccess(`${runtime.siteName} 首页已进入可操作状态`);
    }
    return {
      success: true,
      reason: 'OK',
      whiteScreen,
      deadPage,
      readySignal,
      diagnosticsPath: null,
      elapsedMs: Date.now() - attemptStartedAt,
    };
  }

  const failureInput = {
    reason: 'READY_SIGNAL_MISSING',
    runtime,
    readySignal,
    whiteScreen,
    deadPage,
    diagnostics,
  };

  const classifiedFailure = typeof classifyFailure === 'function'
    ? classifyFailure(failureInput)
    : { reason: failureInput.reason, siteReason: failureInput.reason, hardFailure: false, diagnostics };

  let recoveryResult = null;
  if (typeof recoverEntry === 'function') {
    recoveryResult = await recoverEntry(page, classifiedFailure, { log, logInfo, logWarn, logSuccess, logTaskStage, account, proxy, prefix, config, runtime });
  }

  const shouldRecheckReady = Boolean(
    recoveryResult
    && recoveryResult.action
    && recoveryResult.action !== 'skip-recovery'
  );

  if (shouldRecheckReady) {
    if (typeof logInfo === 'function') {
      logInfo(`openSiteEntry.recheckReadyAfterRecovery | site=${runtime.siteName} | action=${recoveryResult.action} | reason=${recoveryResult.reason || ''}`);
    }

    const recoveredReadySignal = await runReadyCheck();
    if (recoveredReadySignal?.ok) {
      if (typeof logSuccess === 'function') {
        logSuccess(`${runtime.siteName} 首页在恢复后进入可操作状态`);
      }
      return {
        success: true,
        reason: 'OK_AFTER_RECOVERY',
        whiteScreen,
        deadPage,
        readySignal: recoveredReadySignal,
        diagnosticsPath: null,
        elapsedMs: Date.now() - attemptStartedAt,
        recoveryResult,
      };
    }
  }

  return {
    success: false,
    reason: classifiedFailure.siteReason || classifiedFailure.reason || 'READY_SIGNAL_MISSING',
    whiteScreen,
    deadPage,
    readySignal,
    diagnosticsPath: null,
    elapsedMs: Date.now() - attemptStartedAt,
    classifiedFailure,
    recoveryResult,
  };
}

/**
 * 判断当前错误是不是 page/context 已经坏掉，需要重建 page。
 */
function shouldRecreatePage(error) {
  const message = String(error?.message || error || '');
  return /frame was detached|Target page, context or browser has been closed|page\.reload: Target page|page\.goto: net::ERR_ABORTED/i.test(message);
}

/**
 * 通用首页打开主 orchestrator。
 *
 * 作用：
 * - 外层统一负责 retry / reload / page recreate / 最终成功或失败归并。
 * - 这是整个模块最核心的主入口。
 */
async function openSiteEntryWithRetry(options = {}) {
  const {
    page,
    siteProfile,
    config = {},
    stage = 'entry',
    maxAttempts = null,
    diagnostics = null,
    capture = null,
    dumpDiagnostics = null,
    logger = {},
    contextHelpers = {},
    account = null,
    proxy = null,
    prefix = '',
    dynamicGraceWaitMs = null,
  } = options;

  const runtime = getSiteEntryRuntime(siteProfile, config, { stage });
  const adapter = resolveSiteAdapter(siteProfile, options);
  const attempts = Number(maxAttempts ?? runtime.retryAttempts ?? 3);
  const { log, logInfo, logWarn } = logger;
  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await attemptOpenSiteEntry({
        page,
        runtime,
        attempt,
        maxAttempts: attempts,
        diagnostics,
        capture,
        dumpDiagnostics,
        preprocessOverlays: contextHelpers.preprocessOverlays || adapter?.preprocessOverlays,
        waitForReadySignals: contextHelpers.waitForReadySignals || adapter?.waitForDreaminaReady,
        classifyFailure: contextHelpers.classifyFailure || adapter?.classifyDreaminaEntryFailure,
        recoverEntry: contextHelpers.recoverEntry || adapter?.recoverDreaminaEntry,
        logger,
        account,
        proxy,
        prefix,
        config,
        dynamicGraceWaitMs,
      });

      if (result.success) {
        return result;
      }

      lastError = result.reason;
      if (typeof logWarn === 'function') {
        logWarn(`${runtime.siteName} 首页打开失败，准备重试：${result.reason} | attempt=${attempt}/${attempts}`);
      }
    } catch (error) {
      lastError = String(error?.message || 'UNKNOWN');
      if (typeof log === 'function') log(`${runtime.siteName} 打开失败: ${lastError}`);
      if (shouldRecreatePage(error)) {
        if (typeof logWarn === 'function') {
          logWarn(`${runtime.siteName} 页面上下文异常，当前 page 不适合继续 reload：${lastError}`);
        }
        throw new Error(`SITE_ENTRY_PAGE_CONTEXT_INVALID|site=${runtime.siteName}|last=${lastError}`);
      }
      if (typeof logWarn === 'function') {
        logWarn(`${runtime.siteName} 首页打开异常，准备重试：${lastError}`);
      }
    }
  }

  throw new Error(`SITE_ENTRY_OPEN_RETRY_EXHAUSTED|site=${runtime.siteName}|last=${lastError || 'UNKNOWN'}`);
}

/**
 * 站点首页硬失败判定。
 *
 * 作用：
 * - 给上层 runner / 业务层统一判断哪些首页失败应当视作硬失败。
 */
function isSiteEntryHardFailure(reason = '') {
  const text = String(reason || '').trim().toUpperCase();
  return text === 'WHITE_SCREEN'
    || text.startsWith('WHITE_SCREEN|')
    || text === 'DEAD_PAGE'
    || text.startsWith('DEAD_PAGE|');
}

module.exports = {
  resolveRunMode,
  isTestMode,
  safeCapture,
  getSiteEntryRuntime,
  hasConsoleFailureEvidence,
  resolveSiteAdapter,
  detectPositiveReadySignals,
  detectWhiteScreen,
  detectDeadPage,
  attemptOpenSiteEntry,
  shouldRecreatePage,
  openSiteEntryWithRetry,
  isSiteEntryHardFailure,
};
