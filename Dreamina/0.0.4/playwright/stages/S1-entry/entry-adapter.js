// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— S1 Dreamina
//
// 文件定位：Dreamina/0.0.3/S1-entry/entry-adapter.js
// 平台绑定：Dreamina（仅服务于 Dreamina 注册流程，非通用 adapter）
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 识别 Dreamina 入口页信号（ready / login-btn / error）并输出页面状态 timeline。
// ✅ 负责 —— Dreamina 特有的 CSS 选择器、文案匹配、交互序列定义。
// ✅ 负责 —— 从 profiles/ 加载当前阶段的 Dreamina 配置（profile JSON）。
// ❌ 不负责 —— 阶段调度、重试策略、日志格式化（由框架层 shared-entry/stages/entry.js 负责）。
// ❌ 不负责 —— 跨阶段状态传递（由 Dreamina-register.js 主链持有并传入 options）。
// ❌ 不负责 —— 任何非 Dreamina 平台的逻辑（Platform-specific, not reusable）。
//
// 被调用方：shared-entry/stages/entry.js（框架层通过 options.entry-timeline-adapter 或直接调用注入）
// profiles：Dreamina/0.0.3/S1-entry/profiles/
// ═══════════════════════════════════════════════════════════════════════
'use strict';

// 引入文件系统模块，用来读取 Dreamina 阶段 1 profile JSON 配置文件。
const fs = require('fs');
// 引入 path 模块，用来安全拼接当前目录下的 profile 文件路径。
const path = require('path');
const { until } = require('../../../lib/utils/until');
const { isVisible, findFirstVisibleBySelectors, findFirstVisibleByTexts } = require('../../../lib/utils/locator');
const { loadJsonProfileWithCache } = require('../../../lib/utils/profile');

// 当前 Dreamina 阶段 1 profile 的固定文件路径。
const DREAMINA_ENTRY_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-entry-profile.json');

// profile 缓存引用，由 shared-utils/profile.js 的 loadJsonProfileWithCache 统一管理，
// 避免本文件直接持有 fs.readFileSync + JSON.parse 的重复逻辑。
const _entryProfileCacheRef = { value: null };

/**
 * 读取 Dreamina 阶段 1 profile。
 *
 * 作用：
 * - 从 JSON 文件加载静态规则
 * - 默认走内存缓存（通过 _entryProfileCacheRef 持有）
 * - 在需要时允许 forceReload 强制重新读取
 */
function loadDreaminaEntryProfile(options = {}) {
  // 委托给 shared-utils/profile.js 处理缓存逻辑和 BOM 清理，本层只维护 profile 路径。
  return loadJsonProfileWithCache(DREAMINA_ENTRY_PROFILE_PATH, _entryProfileCacheRef, options);
}

function resolveDreaminaAcceleratedLoginSignalStages(runtime = {}, profile = {}) {
  const runtimeStages = Array.isArray(runtime?.acceleratedLoginSignalStages)
    ? runtime.acceleratedLoginSignalStages
    : null;
  const profileStages = Array.isArray(profile?.acceleratedLoginSignalStages)
    ? profile.acceleratedLoginSignalStages
    : null;
  const source = runtimeStages && runtimeStages.length ? runtimeStages : profileStages;
  if (!source || !source.length) return [];
  return source
    .map((item = {}) => ({
      seconds: Math.max(0, Number(item?.seconds || 0)),
      intervalMs: Math.max(0, Number(item?.intervalMs || 0)),
    }))
    .filter(item => item.seconds > 0 || item.intervalMs > 0);
}

function resolveDreaminaAcceleratedLoginReadyTexts(runtime = {}, profile = {}) {
  const runtimeTexts = Array.isArray(runtime?.acceleratedLoginReadyTexts)
    ? runtime.acceleratedLoginReadyTexts
    : null;
  const profileTexts = Array.isArray(profile?.acceleratedLoginReadyTexts)
    ? profile.acceleratedLoginReadyTexts
    : null;
  const source = runtimeTexts && runtimeTexts.length ? runtimeTexts : profileTexts;
  return Array.isArray(source)
    ? source.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

// isVisible / findFirstVisibleBySelectors / findFirstVisibleByTexts
// 已迁移至 shared-utils/locator.js，通过顶部 require 引入，此处不再重复定义。

/**
 * 打开或校正 Dreamina 入口页。
 *
 * 当前草案实现：
 * - 如果当前 URL 已在 Dreamina 域内，则不强制 goto
 * - 否则执行 goto 到 entryUrl
 */
async function openEntryPage(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const profile = loadDreaminaEntryProfile();
  const entryUrl = String(profile?.entryUrl || '').trim();
  const currentUrl = String(page.url ? page.url() : '').trim();
  const gotoTimeoutMs = Number(runtime?.entryGotoTimeoutMs || 30000);
  const whiteScreenObserveMs = Number(runtime?.entryWhiteScreenObserveMs || 2500);
  const whiteScreenRecoveryAttempts = Math.max(0, Number(runtime?.entryWhiteScreenRecoveryAttempts || 1));

  const openTrace = {
    observerVersion: 'shared-until-v1',
    entryUrl,
    currentUrl,
    finalUrl: currentUrl,
    title: '',
    waitUntil: 'domcontentloaded',
    timeoutMs: gotoTimeoutMs,
    navigationOk: false,
    navigationErrorName: '',
    navigationErrorMessage: '',
    bodyTextLength: 0,
    bodyHtmlLength: 0,
    rootChildCount: 0,
    whiteScreenObserveMs,
    whiteScreenRecoveryAttempts,
    whiteScreenDetected: false,
    whiteScreenRecovered: false,
    whiteScreenRecoveryUsed: 0,
    whiteScreenReason: '',
  };

  async function captureWhiteScreenState() {
    return await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const title = normalize(document.title || '');
      const bodyText = normalize(document.body?.innerText || '');
      const bodyHtml = String(document.body?.innerHTML || '');
      const rootChildCount = Number(document.body?.children?.length || 0);
      return {
        title,
        bodyTextLength: bodyText.length,
        bodyHtmlLength: bodyHtml.length,
        rootChildCount,
        bodyPreview: bodyText.slice(0, 240),
        whiteScreenLike: bodyText.length === 0 && bodyHtml.length < 2500 && rootChildCount <= 2,
        deadPageLike: !title && bodyText.length === 0 && rootChildCount <= 1,
      };
    }).catch(() => ({
      title: '',
      bodyTextLength: 0,
      bodyHtmlLength: 0,
      rootChildCount: 0,
      bodyPreview: '',
      whiteScreenLike: false,
      deadPageLike: false,
    }));
  }

  async function assessWhiteScreenAfterOpen(attempt = 0) {
    const observeResult = await until({
      timeoutMs: Math.max(0, whiteScreenObserveMs),
      intervalMs: 250,
      probe: async ({ round, elapsedMs }) => {
        const state = await captureWhiteScreenState();
        return {
          round,
          elapsedMs,
          state,
          healthy: !state?.whiteScreenLike && !state?.deadPageLike,
          failureReason: state?.deadPageLike ? 'DREAMINA_FIRST_LOAD_DEAD_PAGE' : 'DREAMINA_WHITE_SCREEN',
        };
      },
      isDone: (result = {}) => Boolean(result?.healthy),
      abortWhen: () => false,
    });

    const finalProbe = observeResult?.result || { state: await captureWhiteScreenState() };
    const state = finalProbe?.state || {};
    openTrace.title = String(state?.title || '').trim();
    openTrace.bodyTextLength = Number(state?.bodyTextLength || 0);
    openTrace.bodyHtmlLength = Number(state?.bodyHtmlLength || 0);
    openTrace.rootChildCount = Number(state?.rootChildCount || 0);
    openTrace.finalUrl = String(page.url ? page.url() : '').trim();

    if (observeResult?.ok && finalProbe?.healthy) {
      if (attempt > 0) {
        openTrace.whiteScreenRecovered = true;
        openTrace.whiteScreenRecoveryUsed = attempt;
      }
      return {
        ok: true,
        state,
        observeTrace: {
          rounds: Number(observeResult?.round || 0),
          elapsedMs: Number(observeResult?.elapsedMs || 0),
          timeout: false,
        },
      };
    }

    openTrace.whiteScreenDetected = true;
    openTrace.whiteScreenReason = String(finalProbe?.failureReason || (state?.deadPageLike ? 'DREAMINA_FIRST_LOAD_DEAD_PAGE' : 'DREAMINA_WHITE_SCREEN'));

    if (attempt < whiteScreenRecoveryAttempts) {
      openTrace.whiteScreenRecoveryUsed = attempt + 1;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs }).catch(() => {});
      return await assessWhiteScreenAfterOpen(attempt + 1);
    }

    return {
      ok: false,
      state,
      reason: openTrace.whiteScreenReason,
      observeTrace: {
        rounds: Number(observeResult?.round || 0),
        elapsedMs: Number(observeResult?.elapsedMs || 0),
        timeout: Boolean(observeResult?.timeout),
      },
    };
  }

  if (currentUrl && currentUrl.includes('dreamina.com')) {
    if (typeof logInfo === 'function') logInfo(`dreamina.entry.open | source=url | value=${currentUrl} | strength=weak`);
    return {
      ok: true,
      state: 'ENTRY_PAGE_OPENED',
      source: 'url',
      value: currentUrl,
      strength: 'weak',
      stateChanged: false,
      detail: {
        openTrace,
      },
    };
  }

  try {
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: openTrace.timeoutMs });
    openTrace.navigationOk = true;
    const whiteScreenAssessment = await assessWhiteScreenAfterOpen(0);
    if (!whiteScreenAssessment?.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.entry.open.fail-fast | source=goto | value=${entryUrl} | reason=${whiteScreenAssessment?.reason || 'DREAMINA_WHITE_SCREEN'} | finalUrl=${openTrace.finalUrl} | title=${openTrace.title || '-'} | bodyTextLength=${openTrace.bodyTextLength} | bodyHtmlLength=${openTrace.bodyHtmlLength} | rootChildCount=${openTrace.rootChildCount} | recoveryUsed=${openTrace.whiteScreenRecoveryUsed}`);
      }
      return {
        ok: false,
        state: 'ENTRY_PAGE_OPEN_FAILED',
        source: 'goto-login-entry',
        value: String(whiteScreenAssessment?.reason || 'DREAMINA_WHITE_SCREEN'),
        strength: 'strong',
        stateChanged: false,
        detail: {
          openTrace,
          deadPageSnapshot: whiteScreenAssessment?.state || null,
          whiteScreenObserveTrace: whiteScreenAssessment?.observeTrace || null,
        },
      };
    }

    if (typeof logInfo === 'function') {
      logInfo(`dreamina.entry.open | source=goto | value=${entryUrl} | finalUrl=${openTrace.finalUrl} | title=${openTrace.title || '-'} | bodyTextLength=${openTrace.bodyTextLength} | bodyHtmlLength=${openTrace.bodyHtmlLength} | rootChildCount=${openTrace.rootChildCount} | whiteRecovered=${openTrace.whiteScreenRecovered ? 'Y' : 'N'} | strength=strong`);
    }
    return {
      ok: true,
      state: 'ENTRY_PAGE_OPENED',
      source: 'goto',
      value: entryUrl,
      strength: 'strong',
      stateChanged: true,
      detail: {
        openTrace,
        whiteScreenObserveTrace: whiteScreenAssessment?.observeTrace || null,
      },
    };
  } catch (error) {
    openTrace.navigationOk = false;
    openTrace.navigationErrorName = String(error?.name || '').trim();
    openTrace.navigationErrorMessage = String(error?.message || entryUrl).trim();
    openTrace.finalUrl = String(page.url ? page.url() : '').trim();
    openTrace.title = String(await page.title().catch(() => '') || '').trim();
    openTrace.bodyTextLength = Number(await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0) || 0);
    openTrace.bodyHtmlLength = Number(await page.evaluate(() => String(document.body?.innerHTML || '').length).catch(() => 0) || 0);
    openTrace.rootChildCount = Number(await page.evaluate(() => Number(document.body?.children?.length || 0)).catch(() => 0) || 0);
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.entry.open.fail | source=goto | value=${entryUrl} | finalUrl=${openTrace.finalUrl} | errorName=${openTrace.navigationErrorName || '-'} | error=${openTrace.navigationErrorMessage} | title=${openTrace.title || '-'} | bodyTextLength=${openTrace.bodyTextLength} | bodyHtmlLength=${openTrace.bodyHtmlLength} | rootChildCount=${openTrace.rootChildCount}`);
    }
    return {
      ok: false,
      state: 'ENTRY_PAGE_OPEN_FAILED',
      source: 'goto-login-entry',
      value: error?.message || entryUrl,
      strength: 'strong',
      stateChanged: false,
      detail: {
        openTrace,
      },
    };
  }
}

/**
 * 检查 Dreamina 入口页健康状态。
 *
 * 当前草案实现：
 * - 检查常见错误文本
 * - 检查 body 文本是否接近白屏
 */
async function checkEntryHealth(page, runtime = {}, context = {}) {
  // 读取 profile。
  const profile = loadDreaminaEntryProfile();
  // 读取错误文本规则。
  const errorTexts = profile?.healthSignals?.errorTexts || [];

  const healthTrace = {
    overlayHandled: false,
    errorTextHit: null,
    loginSignalFound: false,
    loginSignalLabel: '',
    loginSignalSource: '',
    loginSignalValue: '',
    bodyTextLength: 0,
    whiteScreenThreshold: Number(profile?.healthSignals?.whiteScreenMinTextLength || 0),
    bodyLooksTooShort: false,
    decision: '',
  };

  // 先做一次 overlay 预处理，避免 cookie 弹层/引导层把健康页误拖进后续长轮询。
  const overlayResult = await preprocessDreaminaEntryOverlays(page, runtime, context).catch(() => ({ handled: false }));
  healthTrace.overlayHandled = Boolean(overlayResult?.handled);

  // 优先检测错误文本。
  const errorTextHit = await findFirstVisibleByTexts(page, errorTexts);
  if (errorTextHit.ok) {
    healthTrace.errorTextHit = String(errorTextHit.text || '');
    healthTrace.decision = 'error-text';
    return {
      ok: false,
      state: 'ENTRY_ERROR_PAGE',
      source: 'text',
      value: errorTextHit.text,
      strength: 'strong',
      stateChanged: null,
      overlayHandled: Boolean(overlayResult?.handled),
      healthTrace,
    };
  }

  // 如果登录入口信号已经出现，直接判健康，不必再把可用页面当成“仅 body 文本检查通过”。
  const loginSignal = await detectDreaminaLoginEntrySignals(page, runtime, context).catch(() => ({ found: false }));
  healthTrace.loginSignalFound = Boolean(loginSignal?.found);
  healthTrace.loginSignalLabel = String(loginSignal?.label || '');
  healthTrace.loginSignalSource = String(loginSignal?.source || '');
  healthTrace.loginSignalValue = String(loginSignal?.value || '');
  if (loginSignal?.found) {
    healthTrace.decision = 'login-signal';
    return {
      ok: true,
      state: 'ENTRY_HEALTH_OK',
      source: loginSignal.source || 'login-signal',
      value: loginSignal.value || loginSignal.label || 'LOGIN_SIGNAL_READY',
      strength: loginSignal.label === 'email-input' ? 'strong' : 'medium',
      stateChanged: Boolean(overlayResult?.handled),
      overlayHandled: Boolean(overlayResult?.handled),
      loginSignal,
      observerVersion: String(loginSignal?.detail?.observerVersion || ''),
      observeTrace: loginSignal?.detail?.observeTrace || null,
      healthTrace,
    };
  }

  // 读取页面 body 文本。
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');
  healthTrace.bodyTextLength = String(bodyText || '').length;
  healthTrace.bodyLooksTooShort = healthTrace.bodyTextLength <= healthTrace.whiteScreenThreshold;
  // 当文本长度极短时，按接近白屏处理。
  if (healthTrace.bodyLooksTooShort) {
    healthTrace.decision = 'white-screen';
    return {
      ok: false,
      state: 'ENTRY_WHITE_SCREEN',
      source: 'health-check',
      value: 'BODY_TEXT_TOO_SHORT',
      strength: 'weak',
      stateChanged: null,
      overlayHandled: Boolean(overlayResult?.handled),
      observerVersion: 'dreamina-health-v1',
      observeTrace: {
        observerVersion: 'dreamina-health-v1',
        decision: 'white-screen',
        overlayHandled: Boolean(overlayResult?.handled),
        bodyTextLength: Number(healthTrace.bodyTextLength || 0),
        whiteScreenThreshold: Number(healthTrace.whiteScreenThreshold || 0),
      },
      healthTrace,
    };
  }

  // 健康检查通过。
  healthTrace.decision = 'body-text-ok';
  return {
    ok: true,
    state: 'ENTRY_HEALTH_OK',
    source: 'health-check',
    value: 'HEALTH_OK',
    strength: 'weak',
    stateChanged: Boolean(overlayResult?.handled),
    overlayHandled: Boolean(overlayResult?.handled),
    observerVersion: 'dreamina-health-v1',
    observeTrace: {
      observerVersion: 'dreamina-health-v1',
      decision: 'body-text-ok',
      overlayHandled: Boolean(overlayResult?.handled),
      bodyTextLength: Number(healthTrace.bodyTextLength || 0),
      whiteScreenThreshold: Number(healthTrace.whiteScreenThreshold || 0),
    },
    healthTrace,
  };
}


/**
 * Dreamina entry overlay 预处理。
 *
 * 第一轮最小版：
 * - 支持 buttonNames
 * - 支持 buttonNamePattern
 * - 支持 extraSelectors
 * - 返回结构化 overlay 处理结果
 */
async function preprocessDreaminaEntryOverlays(page, runtime = {}, context = {}) {
  const { logInfo = null, prefix = '', config = {}, capture = null } = context;
  const profile = loadDreaminaEntryProfile();
  const overlays = profile?.overlays || {};

  if (overlays.enabled === false) {
    return { handled: false, matchedType: '', matchedValue: '', postWaitMs: 0 };
  }

  const buttonNames = Array.isArray(overlays.buttonNames) ? overlays.buttonNames : [];
  const buttonNamePattern = String(overlays.buttonNamePattern || '').trim();
  const extraSelectors = Array.isArray(overlays.extraSelectors) ? overlays.extraSelectors : [];
  const postOverlayWaitMs = Number(runtime?.entryPostOverlayWaitMs ?? overlays.postOverlayWaitMs ?? 800);

  async function handleOverlay(locator, matchedType, matchedValue) {
    if (typeof capture === 'function') {
      await capture(page, 'dreamina-entry-overlay-before', prefix, config).catch(() => {});
    }
    await locator.click().catch(() => {});
    if (postOverlayWaitMs > 0) {
      await page.waitForTimeout(postOverlayWaitMs).catch(() => {});
    }
    if (typeof capture === 'function') {
      await capture(page, 'dreamina-entry-overlay-after', prefix, config).catch(() => {});
    }
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.entry.overlay | matchedType=${matchedType} | matchedValue=${matchedValue} | postWaitMs=${postOverlayWaitMs}`);
    }
    return { handled: true, matchedType, matchedValue, postWaitMs: postOverlayWaitMs };
  }

  for (const name of buttonNames) {
    const locator = page.getByRole('button', { name: String(name || '') }).first();
    if (await isVisible(locator)) {
      return await handleOverlay(locator, 'button-name', name);
    }
  }

  if (buttonNamePattern) {
    const locator = page.getByRole('button', { name: new RegExp(buttonNamePattern, 'i') }).first();
    if (await isVisible(locator)) {
      return await handleOverlay(locator, 'button-pattern', buttonNamePattern);
    }
  }

  for (const selector of extraSelectors) {
    const locator = page.locator(String(selector || '')).first();
    if (await isVisible(locator)) {
      return await handleOverlay(locator, 'selector', selector);
    }
  }

  return { handled: false, matchedType: '', matchedValue: '', postWaitMs: 0 };
}

/**
 * 解析 Dreamina 登录入口 staged wait 配置。
 */
function resolveDreaminaLoginSignalStages(runtime = {}, profile = {}) {
  const fromRuntime = Array.isArray(runtime?.entryLoginSignalStages) ? runtime.entryLoginSignalStages : null;
  const fromProfile = Array.isArray(profile?.loginSignalStages) ? profile.loginSignalStages : null;
  const fallback = [
    { seconds: 6, intervalMs: 500 },
    { seconds: 6, intervalMs: 1000 },
    { seconds: 4, intervalMs: 1500 },
  ];

  const stages = fromRuntime && fromRuntime.length
    ? fromRuntime
    : (fromProfile && fromProfile.length ? fromProfile : fallback);

  return stages
    .map(item => ({
      seconds: Number(item?.seconds || 0),
      intervalMs: Number(item?.intervalMs || 0),
    }))
    .filter(item => item.seconds > 0 && item.intervalMs > 0);
}

/**
 * 检测 Dreamina 登录入口信号。
 */
async function detectDreaminaHomeLoginAffordance(page, entryRolePattern = 'sign in|log in|login|sign up') {
  const matchedTexts = [];
  const matchedSelectors = [];
  const timelineSignals = {};

  const directSelectors = [
    '#SiderMenuLogin',
    '[id*="SiderMenuLogin"]',
    '[class*="sider"] [role="menuitem"]',
    '[class*="sider"] button',
    'aside [role="menuitem"]',
    'aside button',
    'nav [role="menuitem"]',
    'nav button',
  ];

  for (const selector of directSelectors) {
    const locator = page.locator(selector).first();
    const visible = await isVisible(locator);
    timelineSignals[`home:${selector}`] = visible;
    if (!visible) continue;
    const text = String(await locator.textContent().catch(() => '') || '').trim();
    if (/sign in|log in|login|sign up/i.test(text)) {
      matchedSelectors.push(selector);
      matchedTexts.push(text);
      return {
        found: true,
        clickable: true,
        locator,
        label: 'home-login-affordance',
        source: 'selector',
        value: text || selector,
        matchedTexts,
        matchedSelectors,
        timelineSignals,
      };
    }
  }

  const roleCandidates = [
    page.getByRole('menuitem', { name: new RegExp(entryRolePattern, 'i') }).first(),
    page.getByRole('button', { name: new RegExp(entryRolePattern, 'i') }).first(),
    page.locator('#SiderMenuLogin').first(),
  ];

  for (const locator of roleCandidates) {
    const visible = await isVisible(locator);
    const key = `home-role:${matchedSelectors.length}`;
    timelineSignals[key] = visible;
    if (!visible) continue;
    const text = String(await locator.textContent().catch(() => '') || '').trim();
    matchedTexts.push(text || 'home-login-affordance');
    return {
      found: true,
      clickable: true,
      locator,
      label: 'home-login-affordance',
      source: 'role',
      value: text || 'home-login-affordance',
      matchedTexts,
      matchedSelectors,
      timelineSignals,
    };
  }

  return { found: false, clickable: false, label: '', source: '', value: '', matchedTexts, matchedSelectors, timelineSignals };
}

async function detectDreaminaLoginEntrySignals(page, runtime = {}, context = {}) {
  const profile = loadDreaminaEntryProfile();
  const loginSignals = profile?.loginSignals || {};

  const entryTexts = Array.isArray(loginSignals?.entryTexts) ? loginSignals.entryTexts : [];
  const readyTexts = Array.isArray(loginSignals?.readyTexts) ? loginSignals.readyTexts : [];
  const entryRolePattern = String(loginSignals?.entryRolePattern || 'sign in|log in|login|sign up').trim();
  const emailInputRoleName = String(loginSignals?.emailInputRoleName || 'Enter email').trim();
  const continueWithEmailText = String(loginSignals?.continueWithEmailText || 'Continue with email').trim();

  const matchedTexts = [];
  const matchedSelectors = [];
  const timelineSignals = {};

  const emailInput = page.getByRole('textbox', { name: emailInputRoleName }).first();
  const emailInputVisible = await isVisible(emailInput);
  timelineSignals.emailInputVisible = emailInputVisible;
  if (emailInputVisible) {
    matchedSelectors.push(`role=textbox[name=${emailInputRoleName}]`);
    return { found: true, clickable: false, label: 'email-input', source: 'role', value: emailInputRoleName, matchedTexts, matchedSelectors, timelineSignals };
  }

  const continueWithEmail = page.getByText(continueWithEmailText, { exact: false }).first();
  const continueWithEmailVisible = await isVisible(continueWithEmail);
  timelineSignals.continueWithEmailVisible = continueWithEmailVisible;
  if (continueWithEmailVisible) {
    matchedTexts.push(continueWithEmailText);
    return { found: true, clickable: true, locator: continueWithEmail, label: 'continue-with-email', source: 'text', value: continueWithEmailText, matchedTexts, matchedSelectors, timelineSignals };
  }

  const continueWithEmailInModal = page.locator('.lv-modal-wrapper').filter({ hasText: continueWithEmailText }).first();
  const continueWithEmailModalVisible = await isVisible(continueWithEmailInModal);
  timelineSignals.continueWithEmailModalVisible = continueWithEmailModalVisible;
  if (continueWithEmailModalVisible) {
    const modalContinueWithEmail = continueWithEmailInModal.getByText(continueWithEmailText, { exact: false }).first();
    const modalContinueWithEmailVisible = await isVisible(modalContinueWithEmail);
    timelineSignals.continueWithEmailModalButtonVisible = modalContinueWithEmailVisible;
    matchedSelectors.push('.lv-modal-wrapper');
    matchedTexts.push(continueWithEmailText);
    return {
      found: true,
      clickable: modalContinueWithEmailVisible,
      locator: modalContinueWithEmailVisible ? modalContinueWithEmail : continueWithEmailInModal,
      label: modalContinueWithEmailVisible ? 'continue-with-email-modal-button' : 'continue-with-email-modal',
      source: 'modal',
      value: continueWithEmailText,
      matchedTexts,
      matchedSelectors,
      timelineSignals,
    };
  }

  const homeLoginAffordance = await detectDreaminaHomeLoginAffordance(page, entryRolePattern).catch(() => ({ found: false }));
  Object.assign(timelineSignals, homeLoginAffordance?.timelineSignals || {});
  if (homeLoginAffordance?.found) {
    return {
      found: true,
      clickable: true,
      locator: homeLoginAffordance.locator,
      label: homeLoginAffordance.label || 'home-login-affordance',
      source: homeLoginAffordance.source || 'selector',
      value: homeLoginAffordance.value || 'home-login-affordance',
      matchedTexts: [...matchedTexts, ...(homeLoginAffordance.matchedTexts || [])],
      matchedSelectors: [...matchedSelectors, ...(homeLoginAffordance.matchedSelectors || [])],
      timelineSignals,
    };
  }

  for (const text of entryTexts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    const visible = await isVisible(locator);
    timelineSignals[`text:${String(text || '')}`] = visible;
    if (visible) {
      matchedTexts.push(String(text || ''));
      return { found: true, clickable: true, locator, label: 'entry-text', source: 'text', value: text, matchedTexts, matchedSelectors, timelineSignals };
    }
  }

  const roleLocator = page.getByRole('button', { name: new RegExp(entryRolePattern || 'sign in|log in|login|sign up', 'i') }).first();
  const roleVisible = await isVisible(roleLocator);
  timelineSignals.entryRoleVisible = roleVisible;
  if (roleVisible) {
    matchedSelectors.push(`role=button[name~=${entryRolePattern}]`);
    return { found: true, clickable: true, locator: roleLocator, label: 'entry-role', source: 'role', value: entryRolePattern, matchedTexts, matchedSelectors, timelineSignals };
  }

  const siderMenuLoginById = page.locator('#SiderMenuLogin').first();
  const siderMenuLoginByIdVisible = await isVisible(siderMenuLoginById);
  timelineSignals.siderMenuLoginVisible = siderMenuLoginByIdVisible;
  if (siderMenuLoginByIdVisible) {
    const siderMenuLoginText = String(await siderMenuLoginById.textContent().catch(() => '') || '').trim();
    timelineSignals.siderMenuLoginTextVisible = Boolean(siderMenuLoginText);
    matchedSelectors.push('#SiderMenuLogin');
    if (siderMenuLoginText) {
      matchedTexts.push(siderMenuLoginText);
    }
    return {
      found: true,
      clickable: true,
      locator: siderMenuLoginById,
      label: 'entry-menuitem',
      source: 'selector',
      value: siderMenuLoginText || 'SiderMenuLogin',
      matchedTexts,
      matchedSelectors,
      timelineSignals,
    };
  }

  const menuitemRoleLocator = page.getByRole('menuitem', { name: new RegExp(entryRolePattern || 'sign in|log in|login|sign up', 'i') }).first();
  const menuitemRoleVisible = await isVisible(menuitemRoleLocator);
  timelineSignals.entryMenuitemRoleVisible = menuitemRoleVisible;
  if (menuitemRoleVisible) {
    matchedSelectors.push(`role=menuitem[name~=${entryRolePattern}]`);
    return {
      found: true,
      clickable: true,
      locator: menuitemRoleLocator,
      label: 'entry-menuitem-role',
      source: 'role',
      value: entryRolePattern,
      matchedTexts,
      matchedSelectors,
      timelineSignals,
    };
  }

  for (const text of readyTexts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    const visible = await isVisible(locator);
    timelineSignals[`text:${String(text || '')}`] = visible;
    if (visible) {
      matchedTexts.push(String(text || ''));
      return { found: true, clickable: false, locator, label: 'ready-text', source: 'text', value: text, matchedTexts, matchedSelectors, timelineSignals };
    }
  }

  return { found: false, clickable: false, label: '', source: '', value: '', matchedTexts, matchedSelectors, timelineSignals };
}

/**
 * Dreamina 登录入口 staged wait。
 *
 * legacy compatibility path:
 * - 这是旧的混合 wait 实现
 * - 当前保留仅用于兼容/回退/对照
 * - Dreamina 主路径已迁到 runDreaminaEntryFlow(...)
 */
async function waitForDreaminaLoginEntryReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const profile = loadDreaminaEntryProfile();
  const stages = resolveDreaminaLoginSignalStages(runtime, profile);
  const acceleratedStages = resolveDreaminaAcceleratedLoginSignalStages(runtime, profile);
  const acceleratedReadyTexts = resolveDreaminaAcceleratedLoginReadyTexts(runtime, profile);

  const wallClockStartedAt = Date.now();
  let elapsedMs = 0;
  let round = 0;
  const signalTimeline = {};
  const confirmTrace = {
    stages: stages.map(item => ({ seconds: Number(item?.seconds || 0), intervalMs: Number(item?.intervalMs || 0) })),
    acceleratedStages: acceleratedStages.map(item => ({ seconds: Number(item?.seconds || 0), intervalMs: Number(item?.intervalMs || 0) })),
    acceleratedReadyTexts: [...acceleratedReadyTexts],
    acceleratedMode: false,
    acceleratedTriggeredBy: '',
    acceleratedTriggeredAtMs: 0,
    rounds: [],
    resolvedBy: '',
    resolvedAtMs: 0,
    resolvedState: '',
    resolvedReason: '',
    totalWallClockMs: 0,
  };

  function recordTimeline(signal = {}, currentElapsedMs = 0) {
    const signals = signal?.timelineSignals && typeof signal.timelineSignals === 'object'
      ? signal.timelineSignals
      : {};
    for (const [key, visible] of Object.entries(signals)) {
      if (!visible) continue;
      if (!signalTimeline[key]) {
        signalTimeline[key] = {
          firstSeenMs: currentElapsedMs,
          round,
        };
      }
    }
  }

  const defaultPlan = stages.map(stage => ({ ...stage, plan: 'default' }));
  const acceleratedPlan = acceleratedStages.map(stage => ({ ...stage, plan: 'accelerated' }));
  let executionPlan = [...defaultPlan];

  for (let stageIndex = 0; stageIndex < executionPlan.length; stageIndex += 1) {
    const stage = executionPlan[stageIndex];
    const seconds = Number(stage.seconds || 0);
    const intervalMs = Number(stage.intervalMs || 0);
    const plan = String(stage.plan || 'default');

    for (let i = 0; i < seconds; i++) {
      round += 1;

      const roundStartedAt = Date.now();
      const preprocessStartedAt = Date.now();
      await preprocessDreaminaEntryOverlays(page, runtime, context);
      const preprocessMs = Math.max(0, Date.now() - preprocessStartedAt);
      const detectStartedAt = Date.now();
      const signal = await detectDreaminaLoginEntrySignals(page, runtime, context);
      const detectSignalMs = Math.max(0, Date.now() - detectStartedAt);
      recordTimeline(signal, elapsedMs);
      const roundTrace = {
        round,
        elapsedBeforeWaitMs: elapsedMs,
        accumulatedWallClockBeforeMs: Math.max(0, roundStartedAt - wallClockStartedAt),
        stageSeconds: seconds,
        intervalMs,
        plan,
        preprocessMs,
        detectSignalMs,
        ctaClickMs: 0,
        postCtaWaitMs: 0,
        waitSleepMs: 0,
        roundWallClockMs: 0,
        accumulatedWallClockAfterMs: 0,
        found: Boolean(signal?.found),
        clickable: Boolean(signal?.clickable),
        label: String(signal?.label || ''),
        source: String(signal?.source || ''),
        value: String(signal?.value || ''),
        matchedTexts: Array.isArray(signal?.matchedTexts) ? [...signal.matchedTexts] : [],
        matchedSelectors: Array.isArray(signal?.matchedSelectors) ? [...signal.matchedSelectors] : [],
      };
      if (signal.found) {
        if (signal.clickable && signal.locator) {
          confirmTrace.resolvedBy = 'sign-in-detected-exit-wait-loop';
          confirmTrace.resolvedAtMs = elapsedMs;
          confirmTrace.resolvedState = 'ENTRY_SIGNAL_DETECTED';
          confirmTrace.resolvedReason = 'CLICKABLE_LOGIN_SIGNAL_DETECTED';

          const clickStartMs = elapsedMs;
          const ctaClickStartedAt = Date.now();
          await signal.locator.click({ timeout: 1500 }).catch(async () => {
            await signal.locator.click({ force: true, timeout: 1500 }).catch(() => {});
          });
          roundTrace.ctaClickMs = Math.max(0, Date.now() - ctaClickStartedAt);
          const postCtaWaitMs = Number(runtime?.entryPostCtaClickWaitMs || 600);
          roundTrace.postCtaWaitMs = postCtaWaitMs;
          await page.waitForTimeout(postCtaWaitMs).catch(() => {});
          elapsedMs += postCtaWaitMs;

          const recheckSignal = await detectDreaminaLoginEntrySignals(page, runtime, context);
          recordTimeline(recheckSignal, elapsedMs);
          const postClickGateReadyMs = Math.max(0, elapsedMs - clickStartMs);
          const recheckFound = Boolean(recheckSignal?.found);
          const recheckLabel = String(recheckSignal?.label || '');
          const recheckSource = String(recheckSignal?.source || '');
          const recheckValue = String(recheckSignal?.value || '');
          const gateLayerReady = recheckFound && (
            recheckLabel === 'email-input'
            || recheckLabel === 'continue-with-email'
            || recheckLabel === 'continue-with-email-modal'
            || recheckLabel === 'continue-with-email-modal-button'
          );

          roundTrace.recheckFound = recheckFound;
          roundTrace.recheckLabel = recheckLabel;
          roundTrace.recheckSource = recheckSource;
          roundTrace.recheckValue = recheckValue;
          roundTrace.ctaSource = String(signal.value || signal.label || '');
          roundTrace.ctaOpenedGateMs = clickStartMs;
          roundTrace.postClickGateReadyMs = postClickGateReadyMs;
          roundTrace.elapsedAfterActionMs = elapsedMs;
          roundTrace.roundWallClockMs = Math.max(0, Date.now() - roundStartedAt);
          roundTrace.accumulatedWallClockAfterMs = Math.max(0, Date.now() - wallClockStartedAt);
          confirmTrace.rounds.push(roundTrace);

          if (typeof logInfo === 'function') {
            logInfo(`dreamina.entry.loginSignal.detected-then-clicked | via=${signal.value} | recheck=${recheckLabel || 'none'} | gateLayerReady=${gateLayerReady ? 'Y' : 'N'} | round=${round} | elapsedMs=${elapsedMs}`);
          }

          confirmTrace.resolvedBy = gateLayerReady ? 'cta-click-gate-layer-confirmed' : 'cta-clicked-single-recheck-complete';
          confirmTrace.resolvedAtMs = elapsedMs;
          confirmTrace.resolvedState = 'ENTRY_READY';
          confirmTrace.resolvedReason = gateLayerReady
            ? (recheckLabel === 'email-input' ? 'EMAIL_INPUT_VISIBLE_AFTER_CTA' : 'LOGIN_GATE_LAYER_VISIBLE_AFTER_CTA')
            : 'CTA_CLICKED_SINGLE_RECHECK_COMPLETE';
          confirmTrace.totalWallClockMs = Math.max(0, Date.now() - wallClockStartedAt);
          return {
            ok: true,
            state: 'ENTRY_READY',
            source: gateLayerReady
              ? (recheckLabel === 'email-input' ? (recheckSignal.source || signal.source || '') : 'LOGIN_GATE_LAYER_READY')
              : 'LOGIN_ENTRY_CLICKED',
            value: recheckValue || recheckLabel || signal.value || signal.label || '',
            strength: 'strong',
            waitStepMs: elapsedMs,
            detail: {
              loginSignal: gateLayerReady ? recheckSignal : signal,
              ctaSignal: signal,
              round,
              elapsedMs,
              signalTimeline,
              confirmTrace,
              ctaSource: signal.value || signal.label || '',
              ctaOpenedGateMs: clickStartMs,
              postClickGateReadyMs,
              gateLayerReady,
            },
          };
        }

        if (signal.label === 'email-input') {
          if (typeof logInfo === 'function') {
            logInfo(`dreamina.entry.loginSignal.ready | label=${signal.label} | source=${signal.source} | value=${signal.value} | round=${round} | elapsedMs=${elapsedMs}`);
          }

          roundTrace.elapsedAfterActionMs = elapsedMs;
          roundTrace.roundWallClockMs = Math.max(0, Date.now() - roundStartedAt);
          roundTrace.accumulatedWallClockAfterMs = Math.max(0, Date.now() - wallClockStartedAt);
          confirmTrace.rounds.push(roundTrace);
          confirmTrace.resolvedBy = 'direct-email-input';
          confirmTrace.resolvedAtMs = elapsedMs;
          confirmTrace.resolvedState = 'ENTRY_READY';
          confirmTrace.resolvedReason = 'EMAIL_INPUT_VISIBLE';
          confirmTrace.totalWallClockMs = Math.max(0, Date.now() - wallClockStartedAt);
          return {
            ok: true,
            state: 'ENTRY_READY',
            source: signal.source || '',
            value: signal.value || signal.label || '',
            strength: 'strong',
            waitStepMs: elapsedMs,
            detail: {
              loginSignal: signal,
              round,
              elapsedMs,
              signalTimeline,
              confirmTrace,
              ctaSource: signal.value || signal.label || '',
              ctaOpenedGateMs: null,
              postClickGateReadyMs: null,
            },
          };
        }
      }

      if (!confirmTrace.acceleratedMode && acceleratedPlan.length) {
        const acceleratedReadyHit = acceleratedReadyTexts.find(text => Boolean(signalTimeline[`text:${text}`]));
        if (acceleratedReadyHit) {
          confirmTrace.acceleratedMode = true;
          confirmTrace.acceleratedTriggeredBy = acceleratedReadyHit;
          confirmTrace.acceleratedTriggeredAtMs = elapsedMs;
          executionPlan = executionPlan.slice(0, stageIndex + 1).concat(acceleratedPlan);
          if (typeof logInfo === 'function') {
            logInfo(`dreamina.entry.loginSignal.accelerated | text=${acceleratedReadyHit} | round=${round} | elapsedMs=${elapsedMs}`);
          }
          break;
        }
      }

      await page.waitForTimeout(intervalMs).catch(() => {});
      roundTrace.waitSleepMs = intervalMs;
      elapsedMs += intervalMs;
      roundTrace.roundWallClockMs = Math.max(0, Date.now() - roundStartedAt);
      roundTrace.accumulatedWallClockAfterMs = Math.max(0, Date.now() - wallClockStartedAt);
      confirmTrace.rounds.push(roundTrace);
    }
  }

  const debugSnapshot = await captureDreaminaEntryDebugSnapshot(page);
  return {
    ok: false,
    state: 'ENTRY_NOT_READY',
    source: '',
    value: '',
    strength: '',
    waitStepMs: elapsedMs,
    detail: {
      loginSignal: null,
      round,
      elapsedMs,
      signalTimeline,
      confirmTrace: {
        ...confirmTrace,
        resolvedBy: confirmTrace.resolvedBy || 'timeout',
        resolvedAtMs: confirmTrace.resolvedAtMs || elapsedMs,
        resolvedState: confirmTrace.resolvedState || 'ENTRY_NOT_READY',
        resolvedReason: confirmTrace.resolvedReason || 'LOGIN_SIGNAL_TIMEOUT',
        totalWallClockMs: confirmTrace.totalWallClockMs || Math.max(0, Date.now() - wallClockStartedAt),
      },
      ctaSource: '',
      ctaOpenedGateMs: null,
      postClickGateReadyMs: null,
      debugSnapshot,
      matchedTexts: [],
      matchedSelectors: [],
    },
  };
}
/**
 * 等待并确认 Dreamina 入口页 ready。
 *
 * 当前实现：
 * - 直接转调 staged login-entry wait 主体
 * - 兼容保留 waitForEntryReady 方法名，避免外层调用点立刻断裂
 */
/**
 * 统一记录 S1 观测时间线。
 *
 * 边界：
 * - 只负责记录信号首次出现时间
 * - 不做点击，不做恢复，不推进阶段
 */
function recordDreaminaSignalTimeline(signalTimeline = {}, signal = {}, currentElapsedMs = 0, round = 0) {
  const signals = signal?.timelineSignals && typeof signal.timelineSignals === 'object'
    ? signal.timelineSignals
    : {};
  for (const [key, visible] of Object.entries(signals)) {
    if (!visible) continue;
    if (!signalTimeline[key]) {
      signalTimeline[key] = {
        firstSeenMs: currentElapsedMs,
        round,
      };
    }
  }
}

async function captureDreaminaEntrySurfaceEvidence(page) {
  const url = String(page.url ? page.url() : '').trim();
  const title = String(await page.title().catch(() => '') || '').trim();
  const bodyPreview = String(await page.evaluate(() => (document.body?.innerText || '').trim().slice(0, 400)).catch(() => '') || '').trim();
  const siderMenuLoginExists = await page.locator('#SiderMenuLogin').count().then(count => count > 0).catch(() => false);
  const siderMenuLoginVisible = await isVisible(page.locator('#SiderMenuLogin').first());
  const menuitemCount = await page.getByRole('menuitem').count().catch(() => 0);
  const buttonCount = await page.getByRole('button').count().catch(() => 0);
  const signInTextVisible = await isVisible(page.getByText(/sign in|log in|login/i).first());
  const continueWithEmailVisible = await isVisible(page.getByText('Continue with email', { exact: false }).first());
  const modalVisible = await isVisible(page.locator('.lv-modal-wrapper').first());

  return {
    url,
    title,
    bodyPreview,
    siderMenuLoginExists,
    siderMenuLoginVisible,
    menuitemCount,
    buttonCount,
    signInTextVisible,
    continueWithEmailVisible,
    modalVisible,
  };
}

/**
 * 准备 entry surface，只做一次性动作。
 *
 * 边界：
 * - 允许清 overlay
 * - 允许做一次健康检查
 * - 不等待首页 ready
 * - 不等待 Sign in
 * - 不点击登录入口
 */
async function prepareDreaminaEntrySurface(page, runtime = {}, context = {}) {
  const prepareTrace = {
    overlayHandled: false,
    overlayMatchedType: '',
    overlayMatchedValue: '',
    inspectState: '',
    inspectSource: '',
    inspectValue: '',
    inspectDecision: '',
  };

  const overlayResult = await preprocessDreaminaEntryOverlays(page, runtime, context).catch(() => ({ handled: false }));
  prepareTrace.overlayHandled = Boolean(overlayResult?.handled);
  prepareTrace.overlayMatchedType = String(overlayResult?.matchedType || '');
  prepareTrace.overlayMatchedValue = String(overlayResult?.matchedValue || '');

  const healthResult = await checkEntryHealth(page, runtime, {
    ...context,
    skipOverlayPreprocess: true,
  }).catch(() => ({
    ok: false,
    state: 'ENTRY_HEALTH_FAILED',
    source: 'prepare-entry-surface',
    value: 'CHECK_ENTRY_HEALTH_THROWN',
    strength: '',
  }));

  prepareTrace.inspectState = String(healthResult?.state || '');
  prepareTrace.inspectSource = String(healthResult?.source || '');
  prepareTrace.inspectValue = String(healthResult?.value || '');
  prepareTrace.inspectDecision = String(healthResult?.healthTrace?.decision || '');

  if (healthResult?.ok === false) {
    return {
      ok: false,
      state: String(healthResult?.state || 'ENTRY_SURFACE_PREPARE_FAILED'),
      source: String(healthResult?.source || 'prepare-entry-surface'),
      value: String(healthResult?.value || 'ENTRY_SURFACE_PREPARE_FAILED'),
      strength: String(healthResult?.strength || ''),
      detail: {
        prepareTrace,
        healthResult,
      },
    };
  }

  return {
    ok: true,
    state: 'ENTRY_SURFACE_READY',
    source: 'prepare-entry-surface',
    value: 'ENTRY_SURFACE_READY',
    strength: 'medium',
    detail: {
      prepareTrace,
      healthResult,
    },
  };
}

/**
 * 第一层轮询，只等待首页 ready 文案。
 *
 * 契约：
 * - 成功/失败出口都必须返回 detail.signalTimeline
 * - 成功/失败出口都必须返回 detail.resolvedBy 或 detail.debugSnapshot 之一
 * - 不负责 Sign in 检测，不负责点击
 */
async function waitForDreaminaHomeReady(page, runtime = {}, context = {}) {
  const profile = loadDreaminaEntryProfile();
  const readyTexts = Array.isArray(profile?.loginSignals?.readyTexts) ? profile.loginSignals.readyTexts : [];
  const maxWaitMs = Number(runtime?.entryHomeReadyTimeoutMs || 5000);
  const intervalMs = Number(runtime?.entryHomeReadyPollIntervalMs || 300);
  const startedAt = Date.now();
  let elapsedMs = 0;
  let round = 0;
  const signalTimeline = {};
  const rounds = [];

  while (elapsedMs <= maxWaitMs) {
    round += 1;
    const detectStartedAt = Date.now();
    let matchedText = '';

    for (const text of readyTexts) {
      const locator = page.getByText(String(text || ''), { exact: false }).first();
      const visible = await isVisible(locator);
      if (visible && !signalTimeline[`text:${String(text || '')}`]) {
        signalTimeline[`text:${String(text || '')}`] = {
          firstSeenMs: elapsedMs,
          round,
        };
      }
      if (visible) {
        matchedText = String(text || '');
        break;
      }
    }

    rounds.push({
      round,
      elapsedMs,
      detectMs: Math.max(0, Date.now() - detectStartedAt),
      matchedText,
    });

    if (matchedText) {
      return {
        ok: true,
        state: 'HOME_READY',
        source: 'text',
        value: matchedText,
        strength: 'medium',
        waitStepMs: elapsedMs,
        detail: {
          signalTimeline,
          rounds,
          resolvedBy: 'ready-text',
          resolvedAtMs: elapsedMs,
          totalWallClockMs: Math.max(0, Date.now() - startedAt),
        },
      };
    }

    await page.waitForTimeout(intervalMs).catch(() => {});
    elapsedMs += intervalMs;
  }

  return {
    ok: false,
    state: 'HOME_READY_TIMEOUT',
    source: 'wait-home-ready',
    value: 'HOME_READY_TEXT_NOT_FOUND',
    strength: '',
    waitStepMs: elapsedMs,
    detail: {
      signalTimeline,
      rounds,
      totalWallClockMs: Math.max(0, Date.now() - startedAt),
      debugSnapshot: await captureDreaminaEntryDebugSnapshot(page),
      surfaceEvidence: await captureDreaminaEntrySurfaceEvidence(page),
    },
  };
}

/**
 * 第二层轮询，只等待 Sign in 入口。
 *
 * 契约：
 * - 成功/失败出口都必须返回 detail.signalTimeline
 * - 成功出口必须返回 detail.loginSignal
 * - 不负责点击，不负责 gate 确认
 */
async function waitForDreaminaSignInEntry(page, runtime = {}, context = {}) {
  const startedAt = Date.now();
  const maxWaitMs = Number(runtime?.entrySignInTimeoutMs || 8000);
  const intervalMs = Number(runtime?.entrySignInPollIntervalMs || 250);
  let elapsedMs = 0;
  let round = 0;
  const signalTimeline = {};
  const rounds = [];

  while (elapsedMs <= maxWaitMs) {
    round += 1;
    const detectStartedAt = Date.now();
    const signal = await detectDreaminaLoginEntrySignals(page, runtime, {
      ...context,
      detectMode: 'sign-in-entry-only',
    });
    recordDreaminaSignalTimeline(signalTimeline, signal, elapsedMs, round);

    rounds.push({
      round,
      elapsedMs,
      detectMs: Math.max(0, Date.now() - detectStartedAt),
      found: Boolean(signal?.found),
      clickable: Boolean(signal?.clickable),
      label: String(signal?.label || ''),
      source: String(signal?.source || ''),
      value: String(signal?.value || ''),
    });

    if (signal?.found && signal?.clickable && signal?.locator) {
      return {
        ok: true,
        state: 'SIGN_IN_FOUND',
        source: String(signal?.source || ''),
        value: String(signal?.value || signal?.label || 'SIGN_IN_FOUND'),
        strength: 'strong',
        waitStepMs: elapsedMs,
        detail: {
          loginSignal: signal,
          signalTimeline,
          rounds,
          resolvedBy: 'sign-in-entry',
          resolvedAtMs: elapsedMs,
          totalWallClockMs: Math.max(0, Date.now() - startedAt),
        },
      };
    }

    await page.waitForTimeout(intervalMs).catch(() => {});
    elapsedMs += intervalMs;
  }

  return {
    ok: false,
    state: 'SIGN_IN_NOT_FOUND',
    source: 'wait-sign-in-entry',
    value: 'SIGN_IN_ENTRY_NOT_FOUND',
    strength: '',
    waitStepMs: elapsedMs,
    detail: {
      signalTimeline,
      rounds,
      totalWallClockMs: Math.max(0, Date.now() - startedAt),
      debugSnapshot: await captureDreaminaEntryDebugSnapshot(page),
      surfaceEvidence: await captureDreaminaEntrySurfaceEvidence(page),
    },
  };
}

/**
 * 只点击一次 Sign in。
 *
 * 契约：
 * - 成功/失败出口都必须返回 detail.clickStrategy
 * - 只负责 click，不负责后续 gate 确认
 */
async function clickDreaminaSignInOnce(page, signInSignal = {}, runtime = {}, context = {}) {
  const locator = signInSignal?.locator || null;
  if (!locator) {
    return {
      ok: false,
      state: 'SIGN_IN_CLICK_FAILED',
      source: 'click-sign-in-once',
      value: 'SIGN_IN_LOCATOR_MISSING',
      strength: '',
      detail: {
        clickStrategy: 'missing-locator',
      },
    };
  }

  const clickStartedAt = Date.now();
  let clickStrategy = 'normal-click';
  try {
    await locator.click({ timeout: 1500 });
  } catch (error) {
    clickStrategy = 'force-click';
    try {
      await locator.click({ force: true, timeout: 1500 });
    } catch (forceError) {
      return {
        ok: false,
        state: 'SIGN_IN_CLICK_FAILED',
        source: 'click-sign-in-once',
        value: forceError?.message || error?.message || 'SIGN_IN_CLICK_FAILED',
        strength: '',
        detail: {
          clickStrategy,
          clickMs: Math.max(0, Date.now() - clickStartedAt),
        },
      };
    }
  }

  return {
    ok: true,
    state: 'SIGN_IN_CLICKED',
    source: 'click-sign-in-once',
    value: String(signInSignal?.value || signInSignal?.label || 'SIGN_IN_CLICKED'),
    strength: 'strong',
    detail: {
      clickStrategy,
      clickMs: Math.max(0, Date.now() - clickStartedAt),
      clickedSignal: signInSignal,
    },
  };
}

/**
 * 点击后只做一次短 gate 确认。
 *
 * 契约：
 * - 成功/失败出口都必须返回 detail.postClickGateReadyMs
 * - 失败出口必须返回 detail.debugSnapshot
 * - 不回到 home-ready / sign-in wait 层
 */
async function confirmDreaminaLoginGateAfterClick(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const startedAt = Date.now();
  const settleMs = Number(runtime?.entryPostCtaClickWaitMs || 450);
  await page.waitForTimeout(settleMs).catch(() => {});
  const signal = await detectDreaminaLoginEntrySignals(page, runtime, context);
  const recheckLabel = String(signal?.label || '');
  const gateLayerReady = Boolean(signal?.found) && (
    recheckLabel === 'email-input'
    || recheckLabel === 'continue-with-email'
    || recheckLabel === 'continue-with-email-modal'
    || recheckLabel === 'continue-with-email-modal-button'
  );

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.entry.gate-confirm | recheck=${recheckLabel || 'none'} | gateLayerReady=${gateLayerReady ? 'Y' : 'N'}`);
  }

  if (!gateLayerReady) {
    return {
      ok: false,
      state: 'LOGIN_GATE_CONFIRM_TIMEOUT',
      source: 'confirm-login-gate-once',
      value: String(signal?.value || signal?.label || 'LOGIN_GATE_CONFIRM_TIMEOUT'),
      strength: '',
      waitStepMs: settleMs,
      detail: {
        loginSignal: signal?.found ? signal : null,
        gateLayerReady: false,
        confirmMs: Math.max(0, Date.now() - startedAt),
        postClickGateReadyMs: settleMs,
        debugSnapshot: await captureDreaminaEntryDebugSnapshot(page),
      },
    };
  }

  return {
    ok: true,
    state: 'ENTRY_READY',
    source: recheckLabel === 'email-input' ? String(signal?.source || '') : 'LOGIN_GATE_LAYER_READY',
    value: String(signal?.value || signal?.label || 'LOGIN_GATE_LAYER_READY'),
    strength: 'strong',
    waitStepMs: settleMs,
    detail: {
      loginSignal: signal,
      gateLayerReady: true,
      confirmMs: Math.max(0, Date.now() - startedAt),
      postClickGateReadyMs: settleMs,
    },
  };
}

/**
 * Dreamina S1 新编排入口。
 *
 * 边界：
 * - prepare -> home ready -> sign in -> click -> confirm
 * - 每段单独负责自己的职责
 * - 当前先并行保留旧主链，待验证后再收旧实现
 *
 * 契约：
 * - 所有成功/失败出口必须稳定返回 detail.timingBreakdown
 * - 所有成功/失败出口必须稳定返回 detail.signalTimeline
 * - 所有成功/失败出口必须稳定返回 detail.flowTrace.resolvedPath
 */
async function runDreaminaEntryFlow(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const flowStartedAt = Date.now();
  const signalTimeline = {};
  const stageBreakdown = {
    prepareEntrySurfaceMs: 0,
    waitHomeReadyMs: 0,
    waitSignInEntryMs: 0,
    clickSignInOnceMs: 0,
    confirmLoginGateMs: 0,
  };
  const flowTrace = {
    prepare: null,
    homeReady: null,
    signInEntry: null,
    click: null,
    gateConfirm: null,
    resolvedPath: '',
  };

  if (typeof context?.onStepChange === 'function') {
    context.onStepChange('prepare-entry-surface');
  }
  const prepareStartedAt = Date.now();
  const prepareResult = await prepareDreaminaEntrySurface(page, runtime, context);
  stageBreakdown.prepareEntrySurfaceMs = Math.max(0, Date.now() - prepareStartedAt);
  flowTrace.prepare = prepareResult;
  if (!prepareResult?.ok) {
    return {
      ok: false,
      state: String(prepareResult?.state || 'ENTRY_SURFACE_PREPARE_FAILED'),
      source: String(prepareResult?.source || 'prepare-entry-surface'),
      value: String(prepareResult?.value || 'ENTRY_SURFACE_PREPARE_FAILED'),
      strength: String(prepareResult?.strength || ''),
      waitStepMs: stageBreakdown.prepareEntrySurfaceMs,
      detail: {
        loginSignal: null,
        signalTimeline,
        flowTrace: {
          ...flowTrace,
          resolvedPath: 'prepare-failed',
        },
        resolvedPath: 'prepare-failed',
        timingBreakdown: {
          ...stageBreakdown,
          totalMs: Math.max(0, Date.now() - flowStartedAt),
          source: 'runDreaminaEntryFlow',
        },
      },
    };
  }

  if (typeof context?.onStepChange === 'function') {
    context.onStepChange('wait-home-ready');
  }
  const homeReadyStartedAt = Date.now();
  const homeReadyResult = await waitForDreaminaHomeReady(page, runtime, context);
  stageBreakdown.waitHomeReadyMs = Math.max(0, Date.now() - homeReadyStartedAt);
  flowTrace.homeReady = homeReadyResult;
  if (homeReadyResult?.detail?.signalTimeline) Object.assign(signalTimeline, homeReadyResult.detail.signalTimeline);
  if (!homeReadyResult?.ok) {
    return {
      ok: false,
      state: String(homeReadyResult?.state || 'HOME_READY_TIMEOUT'),
      source: String(homeReadyResult?.source || 'wait-home-ready'),
      value: String(homeReadyResult?.value || 'HOME_READY_TIMEOUT'),
      strength: String(homeReadyResult?.strength || ''),
      waitStepMs: stageBreakdown.waitHomeReadyMs,
      detail: {
        loginSignal: null,
        signalTimeline,
        flowTrace: {
          ...flowTrace,
          resolvedPath: 'home-ready-failed',
        },
        resolvedPath: 'home-ready-failed',
        timingBreakdown: {
          ...stageBreakdown,
          totalMs: Math.max(0, Date.now() - flowStartedAt),
          source: 'runDreaminaEntryFlow',
        },
        debugSnapshot: homeReadyResult?.detail?.debugSnapshot || null,
      },
    };
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.entry.flow.home-ready | value=${homeReadyResult?.value || ''}`);
  }

  if (typeof context?.onStepChange === 'function') {
    context.onStepChange('wait-sign-in-entry');
  }
  const signInStartedAt = Date.now();
  const signInResult = await waitForDreaminaSignInEntry(page, runtime, context);
  stageBreakdown.waitSignInEntryMs = Math.max(0, Date.now() - signInStartedAt);
  flowTrace.signInEntry = signInResult;
  if (signInResult?.detail?.signalTimeline) Object.assign(signalTimeline, signInResult.detail.signalTimeline);
  if (!signInResult?.ok) {
    return {
      ok: false,
      state: String(signInResult?.state || 'SIGN_IN_NOT_FOUND'),
      source: String(signInResult?.source || 'wait-sign-in-entry'),
      value: String(signInResult?.value || 'SIGN_IN_NOT_FOUND'),
      strength: String(signInResult?.strength || ''),
      waitStepMs: stageBreakdown.waitSignInEntryMs,
      detail: {
        loginSignal: null,
        signalTimeline,
        flowTrace: {
          ...flowTrace,
          resolvedPath: 'sign-in-not-found',
        },
        resolvedPath: 'sign-in-not-found',
        timingBreakdown: {
          ...stageBreakdown,
          totalMs: Math.max(0, Date.now() - flowStartedAt),
          source: 'runDreaminaEntryFlow',
        },
        debugSnapshot: signInResult?.detail?.debugSnapshot || null,
      },
    };
  }

  if (typeof context?.onStepChange === 'function') {
    context.onStepChange('click-sign-in-once');
  }
  const clickStartedAt = Date.now();
  const clickResult = await clickDreaminaSignInOnce(page, signInResult?.detail?.loginSignal || null, runtime, context);
  stageBreakdown.clickSignInOnceMs = Math.max(0, Date.now() - clickStartedAt);
  flowTrace.click = clickResult;
  if (!clickResult?.ok) {
    return {
      ok: false,
      state: String(clickResult?.state || 'SIGN_IN_CLICK_FAILED'),
      source: String(clickResult?.source || 'click-sign-in-once'),
      value: String(clickResult?.value || 'SIGN_IN_CLICK_FAILED'),
      strength: String(clickResult?.strength || ''),
      waitStepMs: stageBreakdown.clickSignInOnceMs,
      detail: {
        loginSignal: signInResult?.detail?.loginSignal || null,
        signalTimeline,
        flowTrace: {
          ...flowTrace,
          resolvedPath: 'sign-in-click-failed',
        },
        resolvedPath: 'sign-in-click-failed',
        timingBreakdown: {
          ...stageBreakdown,
          totalMs: Math.max(0, Date.now() - flowStartedAt),
          source: 'runDreaminaEntryFlow',
        },
      },
    };
  }

  if (typeof context?.onStepChange === 'function') {
    context.onStepChange('confirm-login-gate-once');
  }
  const gateStartedAt = Date.now();
  const gateConfirmResult = await confirmDreaminaLoginGateAfterClick(page, runtime, context);
  stageBreakdown.confirmLoginGateMs = Math.max(0, Date.now() - gateStartedAt);
  flowTrace.gateConfirm = gateConfirmResult;
  recordDreaminaSignalTimeline(
    signalTimeline,
    gateConfirmResult?.detail?.loginSignal || {},
    stageBreakdown.prepareEntrySurfaceMs + stageBreakdown.waitHomeReadyMs + stageBreakdown.waitSignInEntryMs + stageBreakdown.clickSignInOnceMs + stageBreakdown.confirmLoginGateMs,
    0
  );

  if (!gateConfirmResult?.ok) {
    return {
      ok: false,
      state: String(gateConfirmResult?.state || 'LOGIN_GATE_CONFIRM_TIMEOUT'),
      source: String(gateConfirmResult?.source || 'confirm-login-gate-once'),
      value: String(gateConfirmResult?.value || 'LOGIN_GATE_CONFIRM_TIMEOUT'),
      strength: String(gateConfirmResult?.strength || ''),
      waitStepMs: stageBreakdown.confirmLoginGateMs,
      detail: {
        loginSignal: gateConfirmResult?.detail?.loginSignal || signInResult?.detail?.loginSignal || null,
        signalTimeline,
        flowTrace: {
          ...flowTrace,
          resolvedPath: 'login-gate-confirm-failed',
        },
        resolvedPath: 'login-gate-confirm-failed',
        ctaSource: signInResult?.detail?.loginSignal?.value || signInResult?.detail?.loginSignal?.label || '',
        ctaOpenedGateMs: stageBreakdown.clickSignInOnceMs,
        postClickGateReadyMs: gateConfirmResult?.detail?.postClickGateReadyMs ?? null,
        gateLayerReady: false,
        timingBreakdown: {
          ...stageBreakdown,
          totalMs: Math.max(0, Date.now() - flowStartedAt),
          source: 'runDreaminaEntryFlow',
        },
        debugSnapshot: gateConfirmResult?.detail?.debugSnapshot || null,
      },
    };
  }

  return {
    ok: true,
    state: String(gateConfirmResult?.state || 'ENTRY_READY'),
    source: String(gateConfirmResult?.source || 'LOGIN_GATE_LAYER_READY'),
    value: String(gateConfirmResult?.value || 'ENTRY_READY'),
    strength: String(gateConfirmResult?.strength || 'strong'),
    waitStepMs: Math.max(0, Date.now() - flowStartedAt),
    detail: {
      loginSignal: gateConfirmResult?.detail?.loginSignal || signInResult?.detail?.loginSignal || null,
      signalTimeline,
      flowTrace: {
        ...flowTrace,
        resolvedPath: 'click-then-confirm-gate',
      },
      resolvedPath: 'click-then-confirm-gate',
      ctaSource: signInResult?.detail?.loginSignal?.value || signInResult?.detail?.loginSignal?.label || '',
      ctaOpenedGateMs: stageBreakdown.clickSignInOnceMs,
      postClickGateReadyMs: gateConfirmResult?.detail?.postClickGateReadyMs ?? null,
      gateLayerReady: true,
      timingBreakdown: {
        ...stageBreakdown,
        totalMs: Math.max(0, Date.now() - flowStartedAt),
        source: 'runDreaminaEntryFlow',
      },
      confirmTrace: {
        resolvedBy: 'click-then-login-gate-visible',
        resolvedAtMs: Math.max(0, Date.now() - flowStartedAt),
        resolvedState: String(gateConfirmResult?.state || 'ENTRY_READY'),
        resolvedReason: 'LOGIN_GATE_LAYER_VISIBLE_AFTER_SIGN_IN_CLICK',
        totalWallClockMs: Math.max(0, Date.now() - flowStartedAt),
      },
    },
  };
}

async function waitForEntryReady(page, runtime = {}, context = {}) {
  return await runDreaminaEntryFlow(page, runtime, context);
}

/**
 * 将阶段 1 原始失败状态收敛成 Dreamina 专属 reason。
 */

/**
 * 检测 Dreamina 入口阶段是否出现可恢复错误态。
 *
 * 第一轮最小版只识别：
 * - Something went wrong
 * - Refresh the page and try again
 * - Refresh 按钮
 */
async function detectDreaminaEntryRecoverableError(page, runtime = {}, context = {}) {
  const profile = loadDreaminaEntryProfile();
  const errorTexts = Array.isArray(profile?.errorModal?.texts)
    ? profile.errorModal.texts
    : ['Something went wrong', 'Refresh the page and try again'];
  const refreshButtonPattern = String(profile?.errorModal?.refreshButtonPattern || 'refresh').trim();

  const errorTextHit = await findFirstVisibleByTexts(page, errorTexts);
  if (errorTextHit.ok) {
    return {
      ok: true,
      source: 'text',
      value: errorTextHit.text,
      reason: 'DREAMINA_ENTRY_ERROR_MODAL',
    };
  }

  const refreshButton = page.getByRole('button', { name: new RegExp(refreshButtonPattern || 'refresh', 'i') }).first();
  if (await isVisible(refreshButton)) {
    return {
      ok: true,
      source: 'button',
      value: 'refresh',
      reason: 'DREAMINA_ENTRY_ERROR_MODAL',
    };
  }

  return {
    ok: false,
    source: '',
    value: '',
    reason: '',
  };
}

/**
 * Dreamina 入口阶段恢复动作。
 *
 * 第一轮最小版只做：
 * - 命中可恢复错误态后优先点击 Refresh
 * - 否则退回 page.reload
 * - 恢复后等待一个短暂 post wait
 */
async function recoverEntry(page, classifiedFailure = {}, context = {}) {
  const { logInfo = null, logWarn = null, prefix = '', config = {}, capture = null, runtime = {} } = context;
  const profile = loadDreaminaEntryProfile();

  const recoverable = await detectDreaminaEntryRecoverableError(page, runtime, context);
  if (!recoverable.ok) {
    return {
      recovered: false,
      action: 'skip-recovery',
      reason: 'RECOVERY_NOT_NEEDED',
      postWaitMs: 0,
    };
  }

  const postRecoveryWaitMs = Number(runtime?.entryPostRecoveryWaitMs ?? profile?.errorModal?.postRecoveryWaitMs ?? 1200);
  const refreshButtonPattern = String(profile?.errorModal?.refreshButtonPattern || 'refresh').trim();
  const refreshButton = page.getByRole('button', { name: new RegExp(refreshButtonPattern || 'refresh', 'i') }).first();

  if (typeof logWarn === 'function') {
    logWarn(`dreamina.entry.recover | reason=${recoverable.reason} | source=${recoverable.source} | value=${recoverable.value}`);
  }
  if (typeof capture === 'function') {
    await capture(page, 'dreamina-entry-recover-before', prefix, config).catch(() => {});
  }

  let action = 'page-reload';
  if (await isVisible(refreshButton)) {
    await refreshButton.click().catch(() => {});
    action = 'click-refresh';
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: Number(runtime?.entryGotoTimeoutMs || runtime?.entryNavigationTimeoutMs || 30000) }).catch(() => {});
    action = 'page-reload';
  }

  if (postRecoveryWaitMs > 0) {
    await page.waitForTimeout(postRecoveryWaitMs).catch(() => {});
  }

  if (typeof capture === 'function') {
    await capture(page, 'dreamina-entry-recover-after', prefix, config).catch(() => {});
  }
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.entry.recover.done | action=${action} | postWaitMs=${postRecoveryWaitMs}`);
  }

  return {
    recovered: true,
    action,
    reason: recoverable.reason || classifiedFailure?.siteReason || 'DREAMINA_ENTRY_ERROR_MODAL',
    postWaitMs: postRecoveryWaitMs,
  };
}

/**
 * 入口 ready 主链确认（第一轮带 recover 版）。
 *
 * legacy compatibility path:
 * - 这是旧的 recover + rewait 兼容链
 * - 当前保留仅用于兼容/回退/旧产物对照
 * - Dreamina 主路径已迁到 runDreaminaEntryFlow(...)
 *
 * 流程：
 * 1. 先做一次 ready 检查
 * 2. 未命中则分类失败
 * 3. 尝试执行 entry recover
 * 4. recover 成功后再做一次 ready recheck
 */
async function captureDreaminaEntryDebugSnapshot(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const toPlainClickable = (element) => {
      const rect = element.getBoundingClientRect();
      const text = normalize(element.innerText || element.textContent || '');
      const ariaLabel = normalize(element.getAttribute('aria-label') || '');
      const role = normalize(element.getAttribute('role') || '');
      const className = normalize(typeof element.className === 'string' ? element.className : '');
      const id = normalize(element.getAttribute('id') || '');
      const href = normalize(element.getAttribute('href') || '');
      const name = normalize(element.getAttribute('name') || '');
      const title = normalize(element.getAttribute('title') || '');
      const tag = String(element.tagName || '').toLowerCase();
      const textPreview = normalize((element.innerText || element.textContent || '').slice(0, 240));
      const clickableHint = [text, ariaLabel, title, name, id, className].filter(Boolean).join(' | ');
      return {
        tag,
        role,
        text,
        textPreview,
        ariaLabel,
        title,
        name,
        id,
        className,
        href,
        x: Number(Math.round(rect.left || 0)),
        y: Number(Math.round(rect.top || 0)),
        w: Number(Math.round(rect.width || 0)),
        h: Number(Math.round(rect.height || 0)),
        summary: clickableHint,
      };
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter(visible)
      .map((element) => normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || ''))
      .filter(Boolean)
      .slice(0, 20);

    const inputs = Array.from(document.querySelectorAll('input, textarea, [role="textbox"]'))
      .filter(visible)
      .map((element) => ({
        tag: String(element.tagName || '').toLowerCase(),
        type: normalize(element.getAttribute('type') || ''),
        name: normalize(element.getAttribute('name') || ''),
        placeholder: normalize(element.getAttribute('placeholder') || ''),
        ariaLabel: normalize(element.getAttribute('aria-label') || ''),
      }))
      .slice(0, 20);

    const clickableInventory = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex], input[type="button"], input[type="submit"]'))
      .filter(visible)
      .map(toPlainClickable)
      .filter(item => item && typeof item === 'object')
      .slice(0, 32);

    const headerClickables = clickableInventory
      .filter(item => item.y >= 0 && item.y <= 220)
      .slice(0, 16);

    const keywordClickables = clickableInventory
      .filter(item => /sign in|log in|login|continue with email|email|account|profile|user|avatar/i.test(String(item.summary || '')))
      .slice(0, 16);

    return {
      url: String(window.location.href || ''),
      title: normalize(document.title || ''),
      bodyPreview: normalize(document.body?.innerText || '').slice(0, 800),
      visibleButtons: buttons,
      visibleInputs: inputs,
      clickableInventory,
      headerClickables,
      keywordClickables,
    };
  }).catch(() => ({
    url: String(page?.url ? page.url() : ''),
    title: '',
    bodyPreview: '',
    visibleButtons: [],
    visibleInputs: [],
    clickableInventory: [],
    headerClickables: [],
    keywordClickables: [],
  }));
}

async function confirmEntryReadyWithRecovery(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const phaseTrace = {
    initialWaitMs: 0,
    classifyMs: 0,
    recoverMs: 0,
    preprocessAfterRecoverMs: 0,
    rewaitMs: 0,
    resolvedPath: '',
    recovered: false,
    recoveryAction: '',
    recoveryReason: '',
  };

  const initialWaitStartedAt = Date.now();
  const readyResult = await waitForEntryReady(page, runtime, context);
  phaseTrace.initialWaitMs = Math.max(0, Date.now() - initialWaitStartedAt);
  if (readyResult?.ok) {
    return {
      ok: true,
      state: readyResult?.state || 'ENTRY_READY',
      source: readyResult?.source || '',
      value: readyResult?.value || '',
      strength: readyResult?.strength || '',
      waitStepMs: Number(readyResult?.waitStepMs || 0),
      recoveryResult: null,
      detail: {
        ...(readyResult?.detail && typeof readyResult.detail === 'object' ? readyResult.detail : {}),
        recoveryPhaseTrace: {
          ...phaseTrace,
          resolvedPath: 'initial-wait-success',
        },
      },
    };
  }

  const classifyStartedAt = Date.now();
  const classified = classifyEntryFailure({
    reason: readyResult?.state || 'ENTRY_NOT_READY',
    source: readyResult?.source || '',
    value: readyResult?.value || '',
  });
  phaseTrace.classifyMs = Math.max(0, Date.now() - classifyStartedAt);

  const recoveryStartedAt = Date.now();
  const recoveryResult = await recoverEntry(page, classified, {
    ...context,
    runtime,
  });
  phaseTrace.recoverMs = Math.max(0, Date.now() - recoveryStartedAt);
  phaseTrace.recovered = Boolean(recoveryResult?.recovered);
  phaseTrace.recoveryAction = String(recoveryResult?.action || '');
  phaseTrace.recoveryReason = String(recoveryResult?.reason || '');

  if (recoveryResult?.recovered) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.entry.ready.recheck | action=${recoveryResult.action} | reason=${recoveryResult.reason}`);
    }

    const preprocessStartedAt = Date.now();
    await preprocessDreaminaEntryOverlays(page, runtime, context);
    phaseTrace.preprocessAfterRecoverMs = Math.max(0, Date.now() - preprocessStartedAt);

    const rewaitStartedAt = Date.now();
    const readyAfterRecovery = await waitForEntryReady(page, runtime, {
      ...context,
      runtime,
      recoveryResult,
    });
    phaseTrace.rewaitMs = Math.max(0, Date.now() - rewaitStartedAt);

    if (readyAfterRecovery?.ok) {
      return {
        ok: true,
        state: readyAfterRecovery?.state || 'ENTRY_READY',
        source: readyAfterRecovery?.source || '',
        value: readyAfterRecovery?.value || '',
        strength: readyAfterRecovery?.strength || '',
        waitStepMs: Number(readyAfterRecovery?.waitStepMs || 0),
        recoveryResult,
        detail: {
          ...(readyAfterRecovery?.detail && typeof readyAfterRecovery.detail === 'object' ? readyAfterRecovery.detail : {}),
          recoveryAction: recoveryResult?.action || '',
          recoveryReason: recoveryResult?.reason || '',
          recoveryPhaseTrace: {
            ...phaseTrace,
            resolvedPath: 'recovery-rewait-success',
          },
        },
      };
    }
  }

  const failureSnapshot = await captureDreaminaEntryDebugSnapshot(page);
  const mergedDetail = {
    ...(readyResult?.detail && typeof readyResult.detail === 'object' ? readyResult.detail : {}),
    debugSnapshot: failureSnapshot,
    clickableInventory: Array.isArray(failureSnapshot?.clickableInventory) ? failureSnapshot.clickableInventory : [],
    headerClickables: Array.isArray(failureSnapshot?.headerClickables) ? failureSnapshot.headerClickables : [],
    keywordClickables: Array.isArray(failureSnapshot?.keywordClickables) ? failureSnapshot.keywordClickables : [],
    matchedTexts: Array.isArray(readyResult?.detail?.matchedTexts) ? readyResult.detail.matchedTexts : [],
    matchedSelectors: Array.isArray(readyResult?.detail?.matchedSelectors) ? readyResult.detail.matchedSelectors : [],
  };

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.entry.failure.snapshot | url=${failureSnapshot.url || ''} | title=${failureSnapshot.title || ''} | buttons=${(failureSnapshot.visibleButtons || []).slice(0, 6).join(' / ')}`);
  }

  return {
    ok: false,
    state: readyResult?.state || 'ENTRY_NOT_READY',
    reason: classified?.siteReason || classified?.reason || readyResult?.state || 'ENTRY_NOT_READY',
    source: readyResult?.source || '',
    value: readyResult?.value || '',
    strength: readyResult?.strength || '',
    waitStepMs: Number(readyResult?.waitStepMs || 0),
    recoveryResult: recoveryResult || null,
    detail: {
      ...mergedDetail,
      recoveryPhaseTrace: {
        ...phaseTrace,
        resolvedPath: recoveryResult?.recovered ? 'recovery-rewait-failed' : 'recovery-not-applied',
      },
    },
  };
}
function classifyEntryFailure(input = {}) {
  // 提取原始 reason/state，并统一转成大写。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;

  // 覆盖阶段 1 当前常见失败映射。
  if (reason === 'ENTRY_PAGE_OPEN_FAILED') siteReason = 'DREAMINA_ENTRY_PAGE_OPEN_FAILED';
  else if (reason === 'ENTRY_WHITE_SCREEN') siteReason = 'DREAMINA_ENTRY_WHITE_SCREEN';
  else if (reason === 'ENTRY_ERROR_PAGE') siteReason = 'DREAMINA_ENTRY_ERROR_PAGE';
  else if (reason === 'ENTRY_NOT_READY') siteReason = 'DREAMINA_ENTRY_NOT_READY';
  else if (reason === 'ENTRY_HEALTH_FAILED') siteReason = 'DREAMINA_ENTRY_HEALTH_FAILED';

  // 返回统一分类结果。
  return {
    reason,
    siteReason,
    hardFailure: reason === 'ENTRY_ERROR_PAGE',
  };
}

module.exports = {
  loadDreaminaEntryProfile,
  openEntryPage,
  checkEntryHealth,
  waitForEntryReady,
  runDreaminaEntryFlow,
  prepareDreaminaEntrySurface,
  waitForDreaminaHomeReady,
  waitForDreaminaSignInEntry,
  clickDreaminaSignInOnce,
  confirmDreaminaLoginGateAfterClick,
  preprocessDreaminaEntryOverlays,
  resolveDreaminaLoginSignalStages,
  detectDreaminaLoginEntrySignals,
  waitForDreaminaLoginEntryReady,
  detectDreaminaEntryRecoverableError,
  recoverEntry,
  confirmEntryReadyWithRecovery,
  classifyEntryFailure,
};
