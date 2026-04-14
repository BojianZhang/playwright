'use strict';

// 引入文件系统模块，用来读取 Dreamina 阶段 1 profile JSON 配置文件。
const fs = require('fs');
// 引入 path 模块，用来安全拼接当前目录下的 profile 文件路径。
const path = require('path');

// 当前 Dreamina 阶段 1 profile 的固定文件路径。
const DREAMINA_ENTRY_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-entry-profile.json');

// profile 缓存对象，避免每次调用 adapter 方法都重复读取磁盘文件。
let dreaminaEntryProfileCache = null;

/**
 * 读取 Dreamina 阶段 1 profile。
 *
 * 作用：
 * - 从 JSON 文件加载静态规则
 * - 默认走内存缓存
 * - 在需要时允许 forceReload 强制重新读取
 */
function loadDreaminaEntryProfile(options = {}) {
  // 读取是否要求强制刷新 profile 的开关。
  const forceReload = Boolean(options?.forceReload);
  // 如果没有要求强制刷新，并且缓存里已经有 profile，就直接返回缓存。
  if (!forceReload && dreaminaEntryProfileCache) return dreaminaEntryProfileCache;
  // 从磁盘读取 profile 文件原始文本。
  const raw = fs.readFileSync(DREAMINA_ENTRY_PROFILE_PATH, 'utf8');
  // 解析 JSON，同时去掉可能存在的 BOM 头。
  dreaminaEntryProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  // 返回最新读取到的 profile 对象。
  return dreaminaEntryProfileCache;
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

/**
 * 判断 locator 当前是否可见。
 *
 * 作用：
 * - 统一阶段 1 所有可见性判断逻辑
 * - 出错时不抛异常，而是安全返回 false
 */
async function isVisible(locator) {
  // 尝试调用 Playwright 的 isVisible，若抛错则兜底为 false。
  return await locator.isVisible().catch(() => false);
}

/**
 * 从 selector 列表中找到第一个当前可见的目标。
 */
async function findFirstVisibleBySelectors(page, selectors = []) {
  // 依次遍历所有候选 selector。
  for (const selector of selectors) {
    // 基于当前 selector 取第一个匹配元素。
    const locator = page.locator(selector).first();
    // 如果当前 locator 可见，就直接返回命中结果。
    if (await isVisible(locator)) {
      return { ok: true, selector, locator };
    }
  }
  // 如果所有 selector 都没命中，就返回统一失败结构。
  return { ok: false, selector: '', locator: null };
}

/**
 * 从文本列表中找到第一个当前可见的目标。
 */
async function findFirstVisibleByTexts(page, texts = []) {
  // 依次遍历所有候选文本。
  for (const text of texts) {
    // 基于当前文本构造 Playwright text locator。
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    // 如果当前文本命中并且可见，就直接返回结果。
    if (await isVisible(locator)) {
      return { ok: true, text, locator };
    }
  }
  // 如果所有文本都没命中，就返回统一失败结构。
  return { ok: false, text: '', locator: null };
}

/**
 * 打开或校正 Dreamina 入口页。
 *
 * 当前草案实现：
 * - 如果当前 URL 已在 Dreamina 域内，则不强制 goto
 * - 否则执行 goto 到 entryUrl
 */
async function openEntryPage(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 阶段 1 profile。
  const profile = loadDreaminaEntryProfile();
  // 读取 entryUrl。
  const entryUrl = String(profile?.entryUrl || '').trim();
  // 读取当前 URL。
  const currentUrl = String(page.url ? page.url() : '').trim();

  // 如果当前 URL 已经包含 Dreamina 域名片段，则认为入口页打开步骤可以跳过。
  if (currentUrl && currentUrl.includes('dreamina.com')) {
    if (typeof logInfo === 'function') logInfo(`dreamina.entry.open | source=url | value=${currentUrl} | strength=weak`);
    return {
      ok: true,
      state: 'ENTRY_PAGE_OPENED',
      source: 'url',
      value: currentUrl,
      strength: 'weak',
      stateChanged: false,
    };
  }

  try {
    // 执行 goto 到 entryUrl。
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: Number(runtime?.entryGotoTimeoutMs || 30000) }).catch(() => {});
    // 如果有日志函数，记录本轮 goto。
    if (typeof logInfo === 'function') logInfo(`dreamina.entry.open | source=goto | value=${entryUrl} | strength=strong`);
    return {
      ok: true,
      state: 'ENTRY_PAGE_OPENED',
      source: 'goto',
      value: entryUrl,
      strength: 'strong',
      stateChanged: true,
    };
  } catch (error) {
    // goto 异常时，返回统一失败结构。
    return {
      ok: false,
      state: 'ENTRY_PAGE_OPEN_FAILED',
      source: 'goto',
      value: error?.message || entryUrl,
      strength: 'strong',
      stateChanged: false,
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
  const postOverlayWaitMs = Number(runtime?.entryPostOverlayWaitMs ?? overlays.postOverlayWaitMs ?? 1500);

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

  for (const text of readyTexts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    const visible = await isVisible(locator);
    timelineSignals[`text:${String(text || '')}`] = visible;
    if (visible) {
      matchedTexts.push(String(text || ''));
      return { found: true, clickable: false, locator, label: 'ready-text', source: 'text', value: text, matchedTexts, matchedSelectors, timelineSignals };
    }
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

  return { found: false, clickable: false, label: '', source: '', value: '', matchedTexts, matchedSelectors, timelineSignals };
}

/**
 * Dreamina 登录入口 staged wait。
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
          if (gateLayerReady) {
            if (typeof logInfo === 'function') {
              logInfo(`dreamina.entry.loginSignal.cta-opened-gate | via=${signal.value} | recheck=${recheckLabel} | round=${round} | elapsedMs=${elapsedMs}`);
            }
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
            confirmTrace.resolvedBy = recheckLabel === 'email-input' ? 'cta-recheck-email-input' : 'cta-recheck-login-gate-layer';
            confirmTrace.resolvedAtMs = elapsedMs;
            confirmTrace.resolvedState = 'ENTRY_READY';
            confirmTrace.resolvedReason = recheckLabel === 'email-input'
              ? 'EMAIL_INPUT_VISIBLE_AFTER_CTA'
              : 'LOGIN_GATE_LAYER_VISIBLE_AFTER_CTA';
            confirmTrace.totalWallClockMs = Math.max(0, Date.now() - wallClockStartedAt);
            return {
              ok: true,
              state: 'ENTRY_READY',
              source: recheckLabel === 'email-input'
                ? (recheckSignal.source || signal.source || '')
                : 'LOGIN_GATE_LAYER_READY',
              value: recheckValue || recheckLabel || signal.value || '',
              strength: 'strong',
              waitStepMs: elapsedMs,
              detail: {
                loginSignal: recheckSignal,
                ctaSignal: signal,
                round,
                elapsedMs,
                signalTimeline,
                confirmTrace,
                ctaSource: signal.value || signal.label || '',
                ctaOpenedGateMs: clickStartMs,
                postClickGateReadyMs,
              },
            };
          }
          continue;
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
async function waitForEntryReady(page, runtime = {}, context = {}) {
  return await waitForDreaminaLoginEntryReady(page, runtime, context);
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

  const postRecoveryWaitMs = Number(runtime?.entryPostRecoveryWaitMs ?? profile?.errorModal?.postRecoveryWaitMs ?? 4000);
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
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  openEntryPage,
  checkEntryHealth,
  waitForEntryReady,
  preprocessDreaminaEntryOverlays,
  resolveDreaminaLoginSignalStages,
  detectDreaminaLoginEntrySignals,
  waitForDreaminaLoginEntryReady,
  detectDreaminaEntryRecoverableError,
  recoverEntry,
  confirmEntryReadyWithRecovery,
  classifyEntryFailure,
};
