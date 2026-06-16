// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— S1 Dreamina（site adapter）
//
// 文件定位：Dreamina/0.0.3/S1-entry/adapter.js
// 平台绑定：仅服务于 Dreamina，非通用 adapter
//
// 负责：
//   ✅ 检测 Dreamina 首页 overlay / loading 状态，完成页面就绪等待。
//   ✅ Dreamina 专属 CSS 选择器、文案匹配、交互序列定义。
//   ✅ 对首页 / 登录门阶段失败做站点级 siteReason 补充分类。
//   ✅ 对 READY_MISSING 类失败执行轻量恢复动作。
//
// 不负责：
//   ❌ 阶段调度、重试策略、日志格式化  → shared-entry/stages/entry.js
//   ❌ 跨阶段状态传递                  → Dreamina-register.js
//   ❌ 浏览器 / context / 代理配置     → runner 层
//   ❌ 邮箱填写、验证码、注册后续流程  → S2-S6 adapters
//
// 被调用方：
//   - shared-entry/site-entry-health.js（通过 resolveSiteAdapter 注入）
//   - Dreamina-register.js（buildDreaminaEntryStageAdapter 直接调用）
//
// profiles：Dreamina/0.0.3/S1-entry/profiles/
// ═══════════════════════════════════════════════════════════════════════
'use strict';

const { until } = require('../../../lib/utils/until');
const { isVisibleAndEnabled, tryClickLocator } = require('../../../lib/utils/locator');
const { findBodyPatternReady } = require('../../../lib/utils/page');

// 可安全点击以关闭 overlay 的高置信度按钮文本。
// 只放"关闭 / 同意 / 跳过"语义，刻意排除 Continue / Sign in / Sign up 等业务主按钮，
// 防止误点导致跳过正常入口流程。
const SAFE_OVERLAY_TEXT_PATTERNS = [
  'Accept',
  'I agree',
  'Agree',
  'Got it',
  'Close',
  'Skip',
  'Dismiss',
  'Maybe later',
  'Not now',
  'OK',
];


// Dreamina 首页 / 登录入口的强置信度 ready 文本信号。
// 优先级高于 profile 里更泛化的兜底信号。
const DREAMINA_STRONG_READY_TEXTS = [
  'Continue with email',
  'Sign in',
  'Log in',
  'Login',
  'Sign up',
  'Create realistic talk',
];


// 首页 shell 层内容文本——能证明主体已渲染，但不能单独作为登录入口就绪依据。
// 仅用于观测 / 证据记录，不作为 waitForDreaminaReady 的直接成功条件。
const DREAMINA_HOME_SHELL_TEXTS = [
  'Explore Create Assets',
  'Start Creating With AI Agent',
  'AI Image',
  'Canvas',
];


// 强置信度结构化 ready selector——优先选取登录 / 注册区域的 DOM 节点，
// 避免使用 button / a 这类在错误页也普遍存在的泛化元素。
const DREAMINA_STRONG_READY_SELECTORS = [
  '[class*="credit-display-container"]',
  '[class*="login"] button',
  '[class*="signin"] button',
  '[class*="sign-in"] button',
  '[class*="signup"] button',
  '[class*="sign-up"] button',
  'input[role="textbox"]',
  'input[type="email"]',
  'button[data-testid*="login"]',
  'button[data-testid*="sign"]',
];


// 首页 → 登录门切换时，按优先级排列的登录入口候选配置。
// 每条候选带有 type / text / selector，保证点击与日志输出一致。
// 优先级从高到低：home 侧边栏 > 文本匹配 > 结构化 selector。
const DREAMINA_LOGIN_ENTRY_CANDIDATES = [
  {
    type: 'home-sidebar-sign-in',
    text: null,
    selector: '[class*="sider"] :text("Sign in"), nav :text("Sign in"), aside :text("Sign in")',
  },
  {
    type: 'continue-with-email',
    text: 'Continue with email',
    selector: null,
  },
  {
    type: 'sign-in-text',
    text: 'Sign in',
    selector: null,
  },
  {
    type: 'login-text',
    text: 'Login',
    selector: null,
  },
  {
    type: 'log-in-text',
    text: 'Log in',
    selector: null,
  },
  {
    type: 'sign-up-text',
    text: 'Sign up',
    selector: null,
  },
  {
    type: 'sign-in-selector',
    text: null,
    selector: '[class*="login"] button, [class*="signin"] button, [class*="sign-in"] button, [class*="signup"] button, [class*="sign-up"] button',
  },
];


// 用于确认页面已进入"登录前表单态"（即 email 输入框可见）的 selector 集合。
// 供 confirmDreaminaLoginGate 使用。
const DREAMINA_LOGIN_GATE_SELECTORS = [
  'input[type="email"]',
  'input[role="textbox"]',
  '[type="email"]',
  '[class*="email"] input',
];


// Dreamina 首页 / 登录门阶段专属错误弹窗文本。
// 第一轮仅识别，不自动点击 Refresh 恢复，避免将异常误当正常态处理。
const DREAMINA_ERROR_MODAL_TEXTS = [
  'Something went wrong',
  'Refresh',
  'Refresh the page and try again',
];

// 过于泛化的元素，不适合直接作为强 ready 信号——
// 在错误页、空白页、弹层等场景中同样普遍存在，容易造成假阳性。
const OVER_GENERIC_READY_SELECTORS = new Set([
  'button',
  'a',
  'div',
  'span',
]);


/** 尝试通过点击高置信度按钮文本来关闭可见 overlay，命中第一个后立即返回。 */
async function dismissOverlayBySafeTexts(page, context = {}) {
  for (const text of SAFE_OVERLAY_TEXT_PATTERNS) {
    const locator = page.getByRole('button', { name: text, exact: false }).first();
    const clickable = await isVisibleAndEnabled(locator);
    if (!clickable) continue;

    const clicked = await tryClickLocator(locator, `button:${text}`, context);
    if (clicked) {
      await page.waitForTimeout(400);
      return {
        handled: true,
        action: 'click-safe-text-button',
        reason: `SAFE_TEXT:${text}`,
      };
    }
  }

  return {
    handled: false,
    action: 'noop',
    reason: 'NO_SAFE_TEXT_BUTTON_FOUND',
  };
}

/** 尝试通过结构化关闭控件（aria-label、data-testid）来关闭可见 overlay。 */
async function dismissOverlayByCloseSelectors(page, context = {}) {
  const selectorCandidates = [
    '[aria-label="Close"]',
    '[aria-label="close"]',
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '[data-testid*="close"]',
    '[class*="close"] button',
    'button[class*="close"]',
    '[role="dialog"] button[aria-label="Close"]',
  ];

  for (const selector of selectorCandidates) {
    const locator = page.locator(selector).first();
    const clickable = await isVisibleAndEnabled(locator);
    if (!clickable) continue;

    const clicked = await tryClickLocator(locator, `selector:${selector}`, context);
    if (clicked) {
      await page.waitForTimeout(400);
      return {
        handled: true,
        action: 'click-close-selector',
        reason: `CLOSE_SELECTOR:${selector}`,
      };
    }
  }

  return {
    handled: false,
    action: 'noop',
    reason: 'NO_CLOSE_SELECTOR_FOUND',
  };
}

/**
 * 在执行 ready 信号检测前，预处理 Dreamina 首页的遮罩 / 蒙层。
 * 处理顺序：安全文本按钮 → close 结构 selector。
 * 保守策略：不触碰 Sign in / Continue / Sign up 等业务主按钮。
 */
async function preprocessOverlays(page, context = {}) {
  const { logInfo = null } = context;

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.preprocessOverlays | starting overlay cleanup pass');
  }

  const byText = await dismissOverlayBySafeTexts(page, context);
  if (byText.handled) {
    return byText;
  }

  const bySelector = await dismissOverlayByCloseSelectors(page, context);
  if (bySelector.handled) {
    return bySelector;
  }

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.preprocessOverlays | no safe overlay text matched');
  }

  return {
    handled: false,
    action: 'noop',
    reason: 'NO_SAFE_OVERLAY_ACTION_MATCHED',
  };
}

// 从 selector 列表中过滤掉 OVER_GENERIC_READY_SELECTORS 中的泛化元素，
// 防止将错误页上也普遍存在的元素误判为 ready 信号。
function filterStrongReadySelectors(selectors = []) {
  return selectors.filter(selector => !OVER_GENERIC_READY_SELECTORS.has(String(selector || '').trim().toLowerCase()));
}

/** 扫描文本 ready 信号；返回第一个可见匹配项，以及完整的信号映射表（用于 trace）。 */
async function findVisibleReadyText(page, texts = []) {
  const timelineSignals = {};
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();
    const visible = await locator.isVisible().catch(() => false);
    timelineSignals[`text:${String(text || '')}`] = visible;
    if (visible) {
      return {
        ok: true,
        source: 'text',
        value: text,
        timelineSignals,
      };
    }
  }

  return {
    ok: false,
    source: '',
    value: '',
    timelineSignals,
  };
}

/** 扫描 selector ready 信号；返回第一个可见匹配项，以及完整的信号映射表（用于 trace）。 */
async function findVisibleReadySelector(page, selectors = []) {
  const timelineSignals = {};
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    timelineSignals[`selector:${String(selector || '')}`] = visible;
    if (visible) {
      return {
        ok: true,
        source: 'selector',
        value: selector,
        timelineSignals,
      };
    }
  }

  return {
    ok: false,
    source: '',
    value: '',
    timelineSignals,
  };
}

// findBodyPatternReady


/**
 * 等待 Dreamina 首页进入真正可操作状态。
 *
 * 优先级顺序：
 *   1. Dreamina 强置信度结构化 ready selector
 *   2. Dreamina 强置信度 ready 文本（登录入口 / Sign in 可见）
 *   3. profile 提供的补充 selector / 文本
 *   4. body pattern 兜底（最后手段，仅在 maxWaitMs 耗尽后触发）
 *
 * 首页 shell 文本（Explore Create Assets 等）仅用于 trace 观测，
 * 不单独作为成功条件。
 */
async function waitForDreaminaReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;

  const filteredRuntimeSelectors = filterStrongReadySelectors(runtime.readySelectors || []);
  const strongSelectors = [...new Set([...(DREAMINA_STRONG_READY_SELECTORS || []), ...filteredRuntimeSelectors])];
  const runtimeStrongTexts = ((runtime.readyTextSignals || []).filter(Boolean)).filter((text) => {
    const normalized = String(text || '').trim().toLowerCase();
    return !DREAMINA_HOME_SHELL_TEXTS.some((shellText) => String(shellText || '').trim().toLowerCase() === normalized);
  });
  const strongTexts = [...new Set([...(DREAMINA_STRONG_READY_TEXTS || []), ...runtimeStrongTexts])];
  const start = Date.now();
  const maxWaitMs = Number(runtime.firstLoadGraceWaitMs || 0);
  const earlyMidWaitMs = maxWaitMs > 0 ? Math.min(2000, maxWaitMs) : 0;
  const midWaitMs = maxWaitMs > 0 ? Math.min(4000, maxWaitMs) : 0;
  const steps = maxWaitMs > 0 ? [0, Math.min(800, maxWaitMs), earlyMidWaitMs, midWaitMs, maxWaitMs] : [0];
  const uniqueSteps = [...new Set(steps)];
  const trace = {
    observerVersion: 'dreamina-ready-v1',
    maxWaitMs,
    steps: uniqueSteps,
    rounds: [],
    matchedKind: '',
    matchedValue: '',
  };

  const healthObservationSelectors = [
    'input[type="email"]',
    'input[role="textbox"]',
    '[class*="email"] input',
    '[class*="login"] button',
    '[class*="signin"] button',
    '[class*="sign-in"] button',
    '[class*="signup"] button',
    '[class*="sign-up"] button',
  ];
  const healthObservationTexts = [
    'Sign in',
    'Continue with email',
    'Enter email',
    ...DREAMINA_HOME_SHELL_TEXTS,
  ];

  let lastTargetWaitMs = 0;

  for (const waitMs of uniqueSteps) {
    const round = {
      waitMs,
      deltaWaitMs: Math.max(0, waitMs - lastTargetWaitMs),
      elapsedBeforeWaitMs: Date.now() - start,
      elapsedAfterWaitMs: null,
      selectorHit: null,
      textHit: null,
      bodyPatternHit: null,
      observedSelectors: {},
      observedTexts: {},
      observedBodyPreview: '',
    };

    if (round.deltaWaitMs > 0) {
      await page.waitForTimeout(round.deltaWaitMs);
    }
    lastTargetWaitMs = waitMs;
    round.elapsedAfterWaitMs = Date.now() - start;

    const observedSelectorResult = await findVisibleReadySelector(page, healthObservationSelectors);
    round.observedSelectors = observedSelectorResult?.timelineSignals || {};

    const observedTextResult = await findVisibleReadyText(page, healthObservationTexts);
    round.observedTexts = observedTextResult?.timelineSignals || {};

    const observedBodyText = (await page.locator('body').innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();
    round.observedBodyPreview = observedBodyText.slice(0, 240);

    const strongSelectorHit = await findVisibleReadySelector(page, strongSelectors);
    round.selectorHit = strongSelectorHit?.ok ? String(strongSelectorHit.value || '') : null;
    if (strongSelectorHit.ok) {
      trace.rounds.push(round);
      trace.matchedKind = 'strong-selector';
      trace.matchedValue = String(strongSelectorHit.value || '');
      strongSelectorHit.detail = {
        ...(strongSelectorHit.detail && typeof strongSelectorHit.detail === 'object' ? strongSelectorHit.detail : {}),
        observerVersion: 'dreamina-ready-v1',
        observeTrace: trace,
        waitTrace: trace,
      };
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | strong selector ready: ${strongSelectorHit.value} | elapsed=${Date.now() - readyStartAt}ms`);
      }
      return strongSelectorHit;
    }

    const bodyPatternHit = await findBodyPatternReady(page, runtime.readyBodyPatterns || []);
    round.bodyPatternHit = bodyPatternHit?.ok ? String(bodyPatternHit.value || '') : null;

    const strongTextHit = await findVisibleReadyText(page, strongTexts);
    round.textHit = strongTextHit?.ok ? String(strongTextHit.value || '') : null;
    if (strongTextHit.ok) {
      trace.rounds.push(round);
      trace.matchedKind = 'strong-text';
      trace.matchedValue = String(strongTextHit.value || '');
      strongTextHit.detail = {
        ...(strongTextHit.detail && typeof strongTextHit.detail === 'object' ? strongTextHit.detail : {}),
        observerVersion: 'dreamina-ready-v1',
        observeTrace: trace,
        waitTrace: trace,
      };
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | strong text ready: ${strongTextHit.value} | elapsed=${Date.now() - readyStartAt}ms`);
      }
      return strongTextHit;
    }

    const homeShellTextHit = await findVisibleReadyText(page, DREAMINA_HOME_SHELL_TEXTS);
    if (homeShellTextHit.ok) {
      round.textHit = round.textHit || String(homeShellTextHit.value || '');
      if (!trace.matchedKind) {
        trace.matchedKind = 'home-shell-text';
        trace.matchedValue = String(homeShellTextHit.value || '');
      }
    }

    trace.rounds.push(round);
    if (bodyPatternHit.ok && waitMs >= maxWaitMs && maxWaitMs > 0) {
      trace.matchedKind = 'body-pattern';
      trace.matchedValue = String(bodyPatternHit.value || '');
      bodyPatternHit.detail = {
        ...(bodyPatternHit.detail && typeof bodyPatternHit.detail === 'object' ? bodyPatternHit.detail : {}),
        observerVersion: 'dreamina-ready-v1',
        observeTrace: trace,
        waitTrace: trace,
      };
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | body pattern fallback ready: ${bodyPatternHit.value} | elapsed=${Date.now() - readyStartAt}ms`);
      }
      return bodyPatternHit;
    }
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.waitForDreaminaReady | no ready signal matched | elapsed=${Date.now() - readyStartAt}ms`);
  }

  return {
    ok: false,
    source: '',
    value: '',
    detail: {
      observerVersion: 'dreamina-ready-v1',
      observeTrace: trace,
      waitTrace: trace,
    },
  };
}

/** 将 diagnostics 中的各类数组合并为统一的 evidence 对象，供下游分类器使用。 */
function collectFailureEvidence(diagnostics = null) {
  return {
    requestFailures: Array.isArray(diagnostics?.requestFailures) ? diagnostics.requestFailures : [],
    responseErrors: Array.isArray(diagnostics?.responseErrors) ? diagnostics.responseErrors : [],
    pageErrors: Array.isArray(diagnostics?.pageErrors) ? diagnostics.pageErrors : [],
    consoleMessages: Array.isArray(diagnostics?.consoleMessages) ? diagnostics.consoleMessages : [],
  };
}

/** 若 evidence 中存在前端资源加载失败迹象（chunk / script / CORS），返回 true。 */
function hasFrontendLoadFailureEvidence(evidence = {}) {
  const lines = [
    ...evidence.requestFailures,
    ...evidence.responseErrors,
    ...evidence.pageErrors,
    ...evidence.consoleMessages,
  ].map(item => String(item || ''));

  return lines.some(line => /chunk|script|stylesheet|module|failed to load resource|load failed|refused|blocked|cors/i.test(line));
}

/** 若 evidence 中存在网络 / 代理 / 连接层失败迹象，返回 true。 */
function hasNetworkFailureEvidence(evidence = {}) {
  const lines = [
    ...evidence.requestFailures,
    ...evidence.responseErrors,
    ...evidence.pageErrors,
    ...evidence.consoleMessages,
  ].map(item => String(item || ''));

  return lines.some(line => /timeout|timed out|net::|err_|connection|proxy|dns|tunnel|ssl|econn|socket/i.test(line));
}

/** 若 evidence 中存在反爬 / challenge / 访问拒绝迹象，返回 true。 */
function hasBlockedOrChallengeEvidence(evidence = {}) {
  const lines = [
    ...evidence.requestFailures,
    ...evidence.responseErrors,
    ...evidence.pageErrors,
    ...evidence.consoleMessages,
  ].map(item => String(item || ''));

  return lines.some(line => /captcha|challenge|forbidden|403|429|too many requests|access denied|blocked/i.test(line));
}

/**
 * 对 Dreamina 首页失败补充站点级 siteReason。
 * 在框架通用 reason（WHITE_SCREEN / DEAD_PAGE / READY_SIGNAL_MISSING）基础上，
 * 结合 evidence 细化子原因，便于日志区分和后续重试策略判断。
 */
function classifyDreaminaEntryFailure(input = {}) {
  const reason = String(input.reason || 'UNKNOWN').trim().toUpperCase();
  const diagnostics = input.diagnostics || null;
  const whiteScreen = input.whiteScreen || null;
  const deadPage = input.deadPage || null;
  const readySignal = input.readySignal || null;
  const evidence = collectFailureEvidence(diagnostics);

  let siteReason = reason || 'UNKNOWN';
  let hardFailure = reason === 'WHITE_SCREEN' || reason === 'DEAD_PAGE';

  if (reason === 'WHITE_SCREEN') {
    if (hasBlockedOrChallengeEvidence(evidence)) {
      siteReason = 'DREAMINA_WHITE_SCREEN_CHALLENGE';
    } else if (hasFrontendLoadFailureEvidence(evidence)) {
      siteReason = 'DREAMINA_WHITE_SCREEN_ASSET_FAILURE';
    } else if (hasNetworkFailureEvidence(evidence)) {
      siteReason = 'DREAMINA_WHITE_SCREEN_NETWORK_FAILURE';
    } else {
      siteReason = 'DREAMINA_WHITE_SCREEN';
    }
  } else if (reason === 'DEAD_PAGE') {
    if (hasBlockedOrChallengeEvidence(evidence)) {
      siteReason = 'DREAMINA_DEAD_PAGE_CHALLENGE';
    } else if (hasFrontendLoadFailureEvidence(evidence)) {
      siteReason = 'DREAMINA_DEAD_PAGE_ASSET_FAILURE';
    } else if (hasNetworkFailureEvidence(evidence)) {
      siteReason = 'DREAMINA_DEAD_PAGE_NETWORK_FAILURE';
    } else {
      siteReason = 'DREAMINA_DEAD_PAGE';
    }
  } else if (reason === 'READY_SIGNAL_MISSING') {
    if (readySignal?.ok) {
      siteReason = 'DREAMINA_READY_SIGNAL_CONFLICT';
    } else if (hasBlockedOrChallengeEvidence(evidence)) {
      siteReason = 'DREAMINA_ENTRY_CHALLENGE';
      hardFailure = true;
    } else if (hasFrontendLoadFailureEvidence(evidence)) {
      siteReason = 'DREAMINA_READY_MISSING_ASSET_FAILURE';
    } else if (hasNetworkFailureEvidence(evidence)) {
      siteReason = 'DREAMINA_READY_MISSING_NETWORK_FAILURE';
    } else if (whiteScreen?.suspected) {
      siteReason = 'DREAMINA_READY_MISSING_AFTER_WHITE_SCREEN_SUSPECT';
    } else if (deadPage?.hasStrongFailureEvidence) {
      siteReason = 'DREAMINA_READY_MISSING_WITH_FAILURE_EVIDENCE';
    } else {
      siteReason = 'DREAMINA_READY_SIGNAL_MISSING';
    }
  }

  return {
    reason,
    siteReason,
    hardFailure,
    diagnostics,
    evidenceSummary: {
      requestFailures: evidence.requestFailures.length,
      responseErrors: evidence.responseErrors.length,
      pageErrors: evidence.pageErrors.length,
      consoleMessages: evidence.consoleMessages.length,
      hasFrontendLoadFailureEvidence: hasFrontendLoadFailureEvidence(evidence),
      hasNetworkFailureEvidence: hasNetworkFailureEvidence(evidence),
      hasBlockedOrChallengeEvidence: hasBlockedOrChallengeEvidence(evidence),
    },
  };
}

/**
 * 仅对无硬性证据（网络 / 资源 / challenge）的 READY_MISSING 类失败返回 true。
 * 白屏和死页属于不可恢复类，直接返回 false。
 */
function isRecoverableDreaminaEntryFailure(input = {}) {
  const siteReason = String(input.siteReason || input.reason || 'UNKNOWN').trim().toUpperCase();

  if (!siteReason) return false;
  if (siteReason.includes('CHALLENGE')) return false;
  if (siteReason.includes('NETWORK_FAILURE')) return false;
  if (siteReason.includes('ASSET_FAILURE')) return false;
  if (siteReason.includes('WHITE_SCREEN')) return false;
  if (siteReason.includes('DEAD_PAGE')) return false;

  return siteReason.includes('READY');
}

/** 非破坏性恢复等待：给页面一次额外机会，不重载、不重建 context。 */
async function waitBrieflyForRecovery(page, context = {}) {
  const { logInfo = null, runtime = {} } = context;
  const waitMs = Math.min(Math.max(Number(runtime.firstLoadGraceWaitMs || 800), 800), 2500);

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.recoverDreaminaEntry | lightweight recovery wait ${waitMs}ms`);
  }

  await page.waitForTimeout(waitMs);

  return {
    recovered: false,
    action: 'wait-briefly',
    reason: `WAITED_${waitMs}MS`,
  };
}

/**
 * 对 Dreamina 入口失败尝试站点专属轻量恢复。
 * 仅适用于 READY_MISSING 类，不重载 / 不重建 context。
 * 策略：重跑 overlay 清理 → 短暂等待 → 重新检测 ready。
 */
async function recoverDreaminaEntry(page, input = {}, context = {}) {
  const { logInfo = null } = context;
  const reason = String(input.siteReason || input.reason || 'UNKNOWN');

  if (!isRecoverableDreaminaEntryFailure(input)) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.recoverDreaminaEntry | failure not recoverable | reason=${reason}`);
    }
    return {
      recovered: false,
      action: 'skip-recovery',
      reason,
    };
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.recoverDreaminaEntry | attempting lightweight recovery | reason=${reason}`);
  }

  const overlayResult = await preprocessOverlays(page, context);
  if (overlayResult?.handled) {
    return {
      recovered: false,
      action: 'overlay-preprocessed',
      reason: overlayResult.reason || reason,
    };
  }

  return waitBrieflyForRecovery(page, context);
}

/** 检测当前页面是否已到达邮箱输入登录门（最高优先级前置短路判断）。 */
async function detectDreaminaEmailGateReady(page, context = {}) {
  const { logInfo = null } = context;
  const emailGate = await findVisibleReadySelector(page, DREAMINA_LOGIN_GATE_SELECTORS);
  if (emailGate.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.detectDreaminaEmailGateReady | already in email gate: ${emailGate.value}`);
    }
    return {
      ok: true,
      state: 'EMAIL_GATE_READY',
      source: emailGate.source,
      value: emailGate.value,
      detail: {
        loginSignal: emailGate,
        signalTimeline: emailGate?.timelineSignals && typeof emailGate.timelineSignals === 'object'
          ? Object.fromEntries(
            Object.entries(emailGate.timelineSignals)
              .filter(([, visible]) => Boolean(visible))
              .map(([key]) => [key, {
                firstSeenAt: new Date().toISOString(),
                elapsedMs: 0,
                round: 1,
              }])
          )
          : null,
      },
    };
  }

  return {
    ok: false,
    state: 'EMAIL_GATE_NOT_READY',
    source: '',
    value: '',
    detail: {
      loginSignal: emailGate,
      signalTimeline: null,
    },
  };
}

/**
 * 在点击登录入口前后采集轻量页面状态快照。
 * 只读取关键 DOM 信号，不做重量级 diff。
 * 用于区分"点击无效"与"点击成功但状态切换较慢"两种情况。
 */
async function captureDreaminaLoginGateSnapshot(page, context = {}) {
  const emailGate = await detectDreaminaEmailGateReady(page, context);
  const continueLayer = await findVisibleReadyText(page, ['Continue with email']);
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();

  const loginCheckboxChecked = await page.locator('label.lv-checkbox.privacyCheck input[type="checkbox"]').first().isChecked().catch(() => false);
  const loginCheckboxVisible = await page.locator('label.lv-checkbox.privacyCheck').first().isVisible().catch(() => false);
  const loginButton = page.locator('[class*="login-button"]').first();
  const loginButtonVisible = await loginButton.isVisible().catch(() => false);
  const loginButtonEnabled = await loginButton.isEnabled().catch(() => false);
  const loginButtonClassName = await loginButton.evaluate(node => String(node?.className || '')).catch(() => '');
  const loginPageVisible = await page.locator('text=Sign in').first().isVisible().catch(() => false);
  const modalWrapperVisible = await page.locator('.lv-modal-wrapper').first().isVisible().catch(() => false);

  return {
    url: page.url(),
    emailGateReady: Boolean(emailGate.ok),
    continueLayerVisible: Boolean(continueLayer.ok),
    loginCheckboxVisible: Boolean(loginCheckboxVisible),
    loginCheckboxChecked: Boolean(loginCheckboxChecked),
    loginButtonVisible: Boolean(loginButtonVisible),
    loginButtonEnabled: Boolean(loginButtonEnabled),
    loginButtonClassName: String(loginButtonClassName || ''),
    loginPageVisible: Boolean(loginPageVisible),
    modalWrapperVisible: Boolean(modalWrapperVisible),
    bodyTextLength: bodyText.length,
    bodyPreview: bodyText.slice(0, 200),
  };
}

// 对比点击前后快照。body 文本长度变化 ≥ 40 个字符视为有意义的状态变化。
function hasMeaningfulLoginGateStateChange(before = null, after = null) {
  if (!before || !after) return false;
  if (before.url !== after.url) return true;
  if (before.emailGateReady !== after.emailGateReady) return true;
  if (before.continueLayerVisible !== after.continueLayerVisible) return true;
  if (before.loginCheckboxChecked !== after.loginCheckboxChecked) return true;
  if (before.loginButtonEnabled !== after.loginButtonEnabled) return true;
  if (before.loginButtonClassName !== after.loginButtonClassName) return true;
  if (before.modalWrapperVisible !== after.modalWrapperVisible) return true;
  if (before.bodyPreview !== after.bodyPreview) return true;
  if (Math.abs(Number(before.bodyTextLength || 0) - Number(after.bodyTextLength || 0)) >= 40) return true;
  return false;
}

/** 检测 Dreamina 错误弹窗（Something went wrong / Refresh）。仅识别，不自动点击恢复。 */
async function detectDreaminaErrorModal(page, context = {}) {
  const { logInfo = null } = context;

  for (const text of DREAMINA_ERROR_MODAL_TEXTS) {
    const locator = page.getByText(text, { exact: false }).first();
    if (await locator.isVisible().catch(() => false)) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.detectDreaminaErrorModal | error modal text matched: ${text}`);
      }
      return {
        ok: true,
        reason: 'ERROR_MODAL_VISIBLE',
        value: text,
      };
    }
  }

  return {
    ok: false,
    reason: 'NO_ERROR_MODAL',
    value: '',
  };
}

// 点击登录入口后固定等待 700ms，防止门状态切换较慢时被误判为点击失败。
async function waitAfterLoginEntryAction(page, context = {}) {
  const { logInfo = null } = context;
  const waitMs = 700;
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.waitAfterLoginEntryAction | post-click wait ${waitMs}ms`);
  }
  await page.waitForTimeout(waitMs);
  return waitMs;
}

/**
 * 轮询 confirmDreaminaLoginGate 直至登录门就绪或超时。
 * 在点击登录入口后调用，用于异步感知门状态切换。
 */
async function waitForDreaminaLoginGateTransition(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const timeoutMs = Number(runtime?.entryPostClickGateTransitionTimeoutMs || 3200);
  const pollMs = Number(runtime?.entryPostClickGateTransitionPollMs || 250);

  const transitionResult = await until({
    timeoutMs,
    intervalMs: pollMs,
    probe: async ({ round, elapsedMs }) => {
      const gateState = await confirmDreaminaLoginGate(page, runtime, context).catch(() => null);
      return {
        round,
        elapsedMs,
        gateState,
        ready: Boolean(gateState?.ok && (
          gateState?.state === 'EMAIL_GATE_READY'
          || gateState?.state === 'LOGIN_GATE_LAYER_READY'
        )),
      };
    },
    isDone: (result = {}) => Boolean(result?.ready),
    abortWhen: () => false,
  });

  if (transitionResult?.ok && transitionResult?.result?.gateState) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.waitForDreaminaLoginGateTransition | gate matched after click | state=${transitionState.state}`);
    }
    return {
      ok: true,
      gateState: transitionResult.result.gateState,
      elapsedMs: Math.max(0, transitionResult.elapsedMs || 0),
      observeTrace: {
        observerVersion: 'shared-until-v1',
        rounds: Number(transitionResult?.round || 0),
        elapsedMs: Math.max(0, transitionResult.elapsedMs || 0),
        timeout: false,
      },
    };
  }

  return {
    ok: false,
    gateState: null,
    elapsedMs: Math.max(0, transitionResult?.elapsedMs || 0),
    observeTrace: {
      observerVersion: 'shared-until-v1',
      rounds: Number(transitionResult?.round || 0),
      elapsedMs: Math.max(0, transitionResult?.elapsedMs || 0),
      timeout: Boolean(transitionResult?.timeout),
    },
  };
}

// 定位 Dreamina 首页侧边栏的 Sign in 按钮（页面下方，y ≥ 400）。
// y 坐标守卫用于排除 header 区域同名按钮，该按钮点击后行为与侧边栏入口不同。
async function findDreaminaHomeSidebarSignIn(page, context = {}) {
  const { logInfo = null } = context;
  const candidateLocators = [
    page.locator('[class*="sider"]').getByText('Sign in', { exact: false }).first(),
    page.locator('nav').getByText('Sign in', { exact: false }).first(),
    page.locator('aside').getByText('Sign in', { exact: false }).first(),
    page.locator('[class*="menu"]').getByText('Sign in', { exact: false }).first(),
  ];

  for (const locator of candidateLocators) {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await locator.boundingBox().catch(() => null);
    const lowOnPage = box && Number(box.y || 0) >= 400;
    if (!lowOnPage) continue;
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.findDreaminaHomeSidebarSignIn | home sidebar sign-in found | y=${Math.round(box.y)}`);
    }
    return {
      found: true,
      type: 'home-sidebar-sign-in',
      matchType: 'selector',
      text: 'Sign in',
      selector: 'home-sidebar-sign-in',
      locator,
      alreadyInGate: false,
      nextExpectedState: 'LOGIN_GATE_LAYER_READY',
    };
  }

  return {
    found: false,
    type: '',
    matchType: '',
    text: null,
    selector: null,
    locator: null,
    alreadyInGate: false,
    nextExpectedState: '',
  };
}

/**
 * 识别当前页面最优登录入口，返回带 locator 的类型化结果。
 *
 * 短路优先级：
 *   1. 已在登录门层（Continue with email / modal 可见）→ alreadyInGate: true
 *   2. 首页侧边栏 Sign in（结构化，最可靠）
 *   3. DREAMINA_LOGIN_ENTRY_CANDIDATES（文本匹配 → selector 兜底）
 */
async function findDreaminaLoginEntry(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;

  const continueLayerState = await findVisibleReadyText(page, ['Continue with email']);
  const modalVisible = await page.locator('.lv-modal-wrapper').first().isVisible().catch(() => false);
  if (continueLayerState.ok || modalVisible) {
    return {
      found: true,
      type: 'login-gate-layer-ready',
      matchType: modalVisible ? 'modal' : 'gate-layer',
      text: continueLayerState.ok ? continueLayerState.value : 'LOGIN_MODAL_VISIBLE',
      selector: modalVisible ? '.lv-modal-wrapper' : null,
      locator: null,
      alreadyInGate: true,
      nextExpectedState: 'LOGIN_GATE_LAYER_READY',
    };
  }

  const homeSidebarSignIn = await findDreaminaHomeSidebarSignIn(page, context);
  if (homeSidebarSignIn.found) {
    return homeSidebarSignIn;
  }

  const loginPageButton = page.locator('[class*="login-button"]').first();
  const loginPageButtonVisible = await loginPageButton.isVisible().catch(() => false);
  if (loginPageButtonVisible) {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.findDreaminaLoginEntry | login page button container matched');
    }
    return {
      found: true,
      type: 'login-page-sign-in',
      matchType: 'selector',
      text: 'Sign in',
      selector: '[class*="login-button"]',
      locator: loginPageButton,
      alreadyInGate: false,
      nextExpectedState: 'LOGIN_GATE_LAYER_READY',
    };
  }

  for (const candidate of DREAMINA_LOGIN_ENTRY_CANDIDATES) {
    if (candidate.text) {
      const locator = page.getByText(candidate.text, { exact: false }).first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        if (typeof logInfo === 'function') {
          logInfo(`dreamina.adapter.findDreaminaLoginEntry | text candidate matched: ${candidate.type} | text=${candidateText}`);
        }
        return {
          found: true,
          type: candidate.type,
          matchType: 'text',
          text: candidate.text,
          selector: null,
          locator,
          alreadyInGate: false,
          nextExpectedState: 'LOGIN_GATE_LAYER_READY',
        };
      }
    }

    if (candidate.selector) {
      const selectors = String(candidate.selector).split(',').map(item => item.trim()).filter(Boolean);
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible) {
          if (typeof logInfo === 'function') {
            logInfo(`dreamina.adapter.findDreaminaLoginEntry | selector candidate matched: ${candidate.type} | selector=${candidate.selector}`);
          }
          return {
            found: true,
            type: candidate.type,
            matchType: 'selector',
            text: null,
            selector,
            locator,
            alreadyInGate: false,
            nextExpectedState: 'LOGIN_GATE_LAYER_READY',
          };
        }
      }
    }
  }

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.findDreaminaLoginEntry | no candidate found');
  }

  return {
    found: false,
    type: '',
    matchType: '',
    text: null,
    selector: null,
    locator: null,
    alreadyInGate: false,
    nextExpectedState: '',
  };
}

/**
 * 定位并点击最优 Dreamina 登录入口。
 * 首次成功即返回；通过前后快照对比检测"静默点击失败"
 *（点击事件触发但页面状态无变化）。
 */
async function openDreaminaLoginEntry(page, runtime = {}, context = {}) {
  const { logInfo = null, logWarn = null } = context;
  const entry = await findDreaminaLoginEntry(page, runtime, context);

  if (entry.found && entry.alreadyInGate) {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.openDreaminaLoginEntry | already in login gate layer, skipping click');
    }
    return {
      success: true,
      reason: 'LOGIN_GATE_LAYER_READY',
      entry,
      clicked: false,
      nextExpectedState: 'LOGIN_GATE_LAYER_READY',
    };
  }

  if (!entry.found || !entry.locator) {
    if (typeof logWarn === 'function') {
      logWarn('dreamina.adapter.openDreaminaLoginEntry | no valid login entry found');
    }
    return {
      success: false,
      reason: 'LOGIN_ENTRY_NOT_FOUND',
      entry,
      clicked: false,
    };
  }

  const clickable = await isVisibleAndEnabled(entry.locator);
  if (!clickable) {
    if (typeof logWarn === 'function') {
      logWarn(`dreamina.adapter.openDreaminaLoginEntry | entry not clickable: ${entry.type}`);
    }
    return {
      success: false,
      reason: 'LOGIN_ENTRY_NOT_CLICKABLE',
      entry,
      clicked: false,
    };
  }

  const beforeSnapshot = await captureDreaminaLoginGateSnapshot(page, context);

  try {
    if (entry.type === 'home-sidebar-sign-in') {
      await entry.locator.scrollIntoViewIfNeeded().catch(() => { });
      await entry.locator.click({ timeout: 1500 }).catch(async () => {
        const box = await entry.locator.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await entry.locator.click({ force: true, timeout: 1500 });
        }
      });
    } else {
      await entry.locator.click({ timeout: 1500 });
    }

    await waitAfterLoginEntryAction(page, context);

    const afterSnapshot = await captureDreaminaLoginGateSnapshot(page, context);
    const hasStateChange = hasMeaningfulLoginGateStateChange(beforeSnapshot, afterSnapshot);
    const postClickGateTransition = await waitForDreaminaLoginGateTransition(page, runtime, context);

    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.openDreaminaLoginEntry | entry clicked: ${entry.type} | stateChanged=${stateChanged}`);
    }

    if (postClickGateTransition?.ok) {
      return {
        success: true,
        reason: 'LOGIN_GATE_LAYER_READY',
        entry,
        clicked: true,
        nextExpectedState: postClickGateTransition?.gateState?.state || entry.nextExpectedState || 'LOGIN_GATE_LAYER_READY',
        beforeSnapshot,
        afterSnapshot,
        postClickGateTransition,
        observeTrace: postClickGateTransition?.observeTrace || null,
      };
    }

    if (!hasStateChange) {
      return {
        success: false,
        reason: 'LOGIN_ENTRY_CLICK_NO_STATE_CHANGE',
        entry,
        clicked: true,
        beforeSnapshot,
        afterSnapshot,
        postClickGateTransition,
        observeTrace: postClickGateTransition?.observeTrace || null,
      };
    }

    return {
      success: true,
      reason: 'LOGIN_ENTRY_CLICKED',
      entry,
      clicked: true,
      nextExpectedState: entry.nextExpectedState || 'LOGIN_GATE_LAYER_READY',
      beforeSnapshot,
      afterSnapshot,
      postClickGateTransition,
      observeTrace: postClickGateTransition?.observeTrace || null,
    };
  } catch (error) {
    if (typeof logWarn === 'function') {
      logWarn(`dreamina.adapter.openDreaminaLoginEntry | click failed: ${entry.type} | ${error.message}`);
    }
    return {
      success: false,
      reason: 'LOGIN_ENTRY_CLICK_FAILED',
      entry,
      clicked: false,
      error: error.message,
    };
  }
}

/**
 * 确认当前页面是否处于 Dreamina 登录门状态。
 * ok:true 时返回以下状态之一：
 *   - EMAIL_GATE_READY          （email 输入框已可见）
 *   - LOGIN_GATE_LAYER_READY    （Continue with email 或 modal 外层可见）
 * 纯检测，不做任何点击或填写操作。
 */
async function confirmDreaminaLoginGate(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const startAt = Date.now();
  const buildTimeline = (signal = {}, round = 1) => {
    const timelineSignals = signal?.timelineSignals && typeof signal.timelineSignals === 'object'
      ? signal.timelineSignals
      : null;
    if (!timelineSignals) {
      return null;
    }

    const signalTimeline = {};
    for (const [key, visible] of Object.entries(timelineSignals)) {
      if (!visible) {
        continue;
      }
      signalTimeline[key] = {
        firstSeenAt: new Date().toISOString(),
        elapsedMs: Math.max(0, Date.now() - startAt),
        round,
      };
    }
    return Object.keys(signalTimeline).length ? signalTimeline : null;
  };

  const errorModal = await detectDreaminaErrorModal(page, context);
  if (errorModal.ok) {
    return {
      ok: false,
      state: 'ERROR_MODAL_VISIBLE',
      source: 'text',
      value: errorModal.value,
    };
  }

  const emailGate = await detectDreaminaEmailGateReady(page, context);
  if (emailGate.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.confirmDreaminaLoginGate | email gate matched: ${emailGate.value}`);
    }
    return {
      ok: true,
      state: 'EMAIL_GATE_READY',
      source: emailGate.source,
      value: emailGate.value,
      detail: {
        loginSignal: emailGate,
        signalTimeline: buildTimeline(emailGate),
      },
    };
  }

  const continueLayer = await findVisibleReadyText(page, ['Continue with email']);
  if (continueLayer.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.confirmDreaminaLoginGate | login gate layer matched: ${continueLayer.value}`);
    }
    return {
      ok: true,
      state: 'LOGIN_GATE_LAYER_READY',
      source: continueLayer.source,
      value: continueLayer.value,
      detail: {
        loginSignal: continueLayer,
        signalTimeline: buildTimeline(continueLayer),
      },
    };
  }

  const loginModalVisible = await page.locator('.lv-modal-wrapper').first().isVisible().catch(() => false);
  if (loginModalVisible) {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.confirmDreaminaLoginGate | login gate modal outer layer matched');
    }
    return {
      ok: true,
      state: 'LOGIN_GATE_LAYER_READY',
      source: 'modal',
      value: 'LOGIN_MODAL_VISIBLE',
      detail: {
        loginSignal: {
          ok: true,
          source: 'modal',
          value: 'LOGIN_MODAL_VISIBLE',
          label: 'login-modal-visible',
          clickable: false,
          timelineSignals: {
            loginModalVisible: true,
          },
        },
        signalTimeline: {
          loginModalVisible: {
            firstSeenAt: new Date().toISOString(),
            elapsedMs: Math.max(0, Date.now() - startAt),
            round: 1,
          },
        },
      },
    };
  }

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.confirmDreaminaLoginGate | login gate not confirmed');
  }

  return {
    ok: false,
    state: 'LOGIN_GATE_NOT_READY',
    source: '',
    value: '',
  };
}

/**
 * 首页 → 登录门切换的顶层编排方法。
 * 执行顺序：
 *   1. overlay 清理
 *   2. 前置检查：是否已在 email gate → 提前成功返回
 *   3. 查找并点击最优登录入口
 *   4. 点击后确认登录门状态
 *   5. 兜底：若仅到达 LOGIN_GATE_LAYER 外层，再做一次点击尝试
 *
 * 不填写 email，不推进 email gate 之后的流程。
 */
async function ensureDreaminaLoginGate(page, runtime = {}, context = {}) {
  const { logInfo = null, logWarn = null } = context;
  const gateStartAt = Date.now();
  const gateTrace = {
    preprocessOverlaysMs: 0,
    initialConfirmMs: 0,
    openEntryMs: 0,
    postOpenConfirmMs: 0,
    secondJumpMs: 0,
    postSecondJumpConfirmMs: 0,
    resolvedAtMs: null,
    resolvedState: '',
    resolvedReason: '',
  };

  const preprocessStartAt = Date.now();
  await preprocessOverlays(page, context);
  gateTrace.preprocessOverlaysMs = Math.max(0, Date.now() - preprocessStartAt);

  const initialConfirmStartAt = Date.now();
  let gateState = await confirmDreaminaLoginGate(page, runtime, context);
  gateTrace.initialConfirmMs = Math.max(0, Date.now() - initialConfirmStartAt);
  if (gateState.ok && gateState.state === 'LOGIN_GATE_LAYER_READY') {
    return {
      success: true,
      reason: 'LOGIN_GATE_LAYER_READY',
      state: gateState.state,
      gateState,
      detail: gateState?.detail && typeof gateState.detail === 'object'
        ? {
          ...gateState.detail,
          loginSignal: gateState?.detail?.loginSignal || gateState,
          signalTimeline: gateState?.detail?.signalTimeline || gateState?.detail?.loginSignal?.timelineSignals || null,
          gateTrace: {
            ...gateTrace,
            resolvedAtMs: Math.max(0, Date.now() - gateStartAt),
            resolvedState: gateState.state || '',
            resolvedReason: 'LOGIN_GATE_LAYER_READY',
          },
        }
        : {
          loginSignal: gateState,
          signalTimeline: null,
          gateTrace: {
            ...gateTrace,
            resolvedAtMs: Math.max(0, Date.now() - gateStartAt),
            resolvedState: gateState.state || '',
            resolvedReason: 'LOGIN_GATE_LAYER_READY',
          },
        },
    };
  }

  const openEntryStartAt = Date.now();
  const openResult = await openDreaminaLoginEntry(page, runtime, context);
  gateTrace.openEntryMs = Math.max(0, Date.now() - openEntryStartAt);
  if (!openResult.success) {
    return {
      success: false,
      reason: openResult.reason,
      state: 'LOGIN_ENTRY_FAILED',
      openResult,
    };
  }

  const postOpenConfirmStartAt = Date.now();
  gateState = await confirmDreaminaLoginGate(page, runtime, context);
  gateTrace.postOpenConfirmMs = Math.max(0, Date.now() - postOpenConfirmStartAt);
  if (gateState.ok && gateState.state === 'LOGIN_GATE_LAYER_READY') {
    return {
      success: true,
      reason: 'LOGIN_GATE_LAYER_READY',
      state: gateState.state,
      openResult,
      gateState,
      detail: gateState?.detail && typeof gateState.detail === 'object'
        ? {
          ...gateState.detail,
          loginSignal: gateState?.detail?.loginSignal || gateState,
          signalTimeline: gateState?.detail?.signalTimeline || gateState?.detail?.loginSignal?.timelineSignals || null,
          observeTrace: openResult?.observeTrace || openResult?.postClickGateTransition?.observeTrace || null,
          postClickGateTransition: openResult?.postClickGateTransition || null,
          gateTrace: {
            ...gateTrace,
            resolvedAtMs: Math.max(0, Date.now() - gateStartAt),
            resolvedState: gateState.state || '',
            resolvedReason: 'LOGIN_GATE_LAYER_READY',
          },
        }
        : {
          loginSignal: gateState,
          signalTimeline: null,
          gateTrace: {
            ...gateTrace,
            resolvedAtMs: Math.max(0, Date.now() - gateStartAt),
            resolvedState: gateState.state || '',
            resolvedReason: 'LOGIN_GATE_LAYER_READY',
          },
        },
    };
  }

  if (gateState.ok && gateState.state === 'LOGIN_GATE_LAYER_READY') {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.ensureDreaminaLoginGate | already in login gate outer layer, S1 success');
    }

    return {
      success: true,
      reason: 'LOGIN_GATE_LAYER_READY',
      state: gateState.state,
      openResult,
      gateState,
      detail: gateState?.detail && typeof gateState.detail === 'object'
        ? {
          ...gateState.detail,
          loginSignal: gateState?.detail?.loginSignal || gateState,
          signalTimeline: gateState?.detail?.signalTimeline || gateState?.detail?.loginSignal?.timelineSignals || null,
          gateTrace: {
            ...gateTrace,
            resolvedAtMs: Math.max(0, Date.now() - gateStartAt),
            resolvedState: gateState.state || '',
            resolvedReason: 'LOGIN_GATE_LAYER_READY',
          },
        }
        : {
          loginSignal: gateState,
          signalTimeline: null,
          gateTrace: {
            ...gateTrace,
            resolvedAtMs: Math.max(0, Date.now() - gateStartAt),
            resolvedState: gateState.state || '',
            resolvedReason: 'LOGIN_GATE_LAYER_READY',
          },
        },
    };
  }

  if (typeof logWarn === 'function') {
    logWarn('dreamina.adapter.ensureDreaminaLoginGate | login gate not confirmed after entry click');
  }

  return {
    success: false,
    reason: 'LOGIN_GATE_NOT_CONFIRMED',
    state: gateState.state || 'LOGIN_GATE_NOT_READY',
    openResult,
    gateState,
  };
}

/**
 * 对登录门阶段失败补充 Dreamina 专属 siteReason。
 * 覆盖场景：未找到入口、入口点击失败、点击后登录门未确认。
 */
function classifyDreaminaLoginGateFailure(input = {}) {
  const reason = String(input.reason || 'UNKNOWN').trim().toUpperCase();
  const state = String(input.state || '').trim().toUpperCase();

  let siteReason = reason;

  if (reason === 'LOGIN_ENTRY_NOT_FOUND') {
    siteReason = 'DREAMINA_LOGIN_ENTRY_NOT_FOUND';
  } else if (reason === 'LOGIN_ENTRY_NOT_CLICKABLE') {
    siteReason = 'DREAMINA_LOGIN_ENTRY_NOT_CLICKABLE';
  } else if (reason === 'LOGIN_ENTRY_CLICK_FAILED') {
    siteReason = 'DREAMINA_LOGIN_ENTRY_CLICK_FAILED';
  } else if (reason === 'LOGIN_ENTRY_CLICK_NO_STATE_CHANGE') {
    siteReason = 'DREAMINA_LOGIN_ENTRY_CLICK_NO_STATE_CHANGE';
  } else if (state === 'ERROR_MODAL_VISIBLE') {
    siteReason = 'DREAMINA_LOGIN_GATE_ERROR_MODAL_VISIBLE';
  } else if (reason === 'LOGIN_GATE_NOT_CONFIRMED' && state === 'LOGIN_GATE_LAYER_ONLY') {
    siteReason = 'DREAMINA_EMAIL_GATE_NOT_REACHED';
  } else if (reason === 'LOGIN_GATE_NOT_CONFIRMED') {
    siteReason = 'DREAMINA_LOGIN_GATE_NOT_CONFIRMED';
  }

  return {
    reason,
    state,
    siteReason,
    hardFailure: false,
  };
}

/**
 * S1 阶段完整入口流程：打开页面 → 检测就绪 → 推进至登录门。
 * 这是 shared-entry 框架通过 siteAdapter.runDreaminaEntryFlow 消费的唯一导出入口。
 */
async function runDreaminaEntryFlow(page, runtime = {}, context = {}) {
  const startedAt = Date.now();
  const readyStartedAt = Date.now();
  const readyResult = await waitForDreaminaReady(page, runtime, context);
  const waitHomeReadyMs = Math.max(0, Date.now() - readyStartedAt);

  if (!readyResult?.ok) {
    return {
      ok: false,
      state: readyResult?.state || 'ENTRY_READY_SIGNAL_MISSING',
      source: readyResult?.source || 'dreamina-ready',
      value: readyResult?.value || 'ENTRY_READY_SIGNAL_MISSING',
      strength: readyResult?.strength || '',
      detail: {
        timingBreakdown: {
          prepareEntrySurfaceMs: 0,
          waitHomeReadyMs,
          waitSignInEntryMs: 0,
          clickSignInOnceMs: 0,
          confirmLoginGateMs: 0,
          totalMs: Math.max(0, Date.now() - startedAt),
          source: 'runDreaminaEntryFlow',
        },
        signalTimeline: readyResult?.detail?.signalTimeline || null,
      },
    };
  }

  const gateStartedAt = Date.now();
  const gateResult = await ensureDreaminaLoginGate(page, runtime, context);
  const confirmLoginGateMs = Math.max(0, Date.now() - gateStartedAt);

  if (!gateResult?.success) {
    return {
      ok: false,
      state: gateResult?.state || 'LOGIN_ENTRY_FAILED',
      source: gateResult?.reason || 'LOGIN_ENTRY_FAILED',
      value: gateResult?.reason || gateResult?.state || 'LOGIN_ENTRY_FAILED',
      strength: '',
      detail: {
        loginSignal: gateResult?.detail?.loginSignal || gateResult?.gateState || null,
        signalTimeline: gateResult?.detail?.signalTimeline || null,
        gateTrace: gateResult?.detail?.gateTrace || null,
        timingBreakdown: {
          prepareEntrySurfaceMs: 0,
          waitHomeReadyMs,
          waitSignInEntryMs: 0,
          clickSignInOnceMs: Number(gateResult?.detail?.gateTrace?.openEntryMs || 0),
          confirmLoginGateMs,
          totalMs: Math.max(0, Date.now() - startedAt),
          source: 'runDreaminaEntryFlow',
        },
      },
    };
  }

  const resolvedAtMs = Math.max(0, Date.now() - startedAt);
  return {
    ok: true,
    state: 'ENTRY_READY',
    source: gateResult?.state === 'LOGIN_GATE_LAYER_READY' ? 'LOGIN_GATE_LAYER_READY' : (gateResult?.state || 'ENTRY_READY'),
    value: gateResult?.reason || gateResult?.state || 'ENTRY_READY',
    strength: 'strong',
    detail: {
      loginSignal: gateResult?.detail?.loginSignal || gateResult?.gateState || null,
      signalTimeline: gateResult?.detail?.signalTimeline || null,
      postClickGateReadyMs: Number(gateResult?.detail?.gateTrace?.postOpenConfirmMs || 0),
      confirmTrace: {
        resolvedBy: 'ensure-login-gate',
        resolvedAtMs,
        resolvedState: gateResult?.state || 'ENTRY_READY',
        resolvedReason: gateResult?.reason || 'LOGIN_GATE_LAYER_READY',
      },
      timingBreakdown: {
        prepareEntrySurfaceMs: 0,
        waitHomeReadyMs,
        waitSignInEntryMs: 0,
        clickSignInOnceMs: Number(gateResult?.detail?.gateTrace?.openEntryMs || 0),
        confirmLoginGateMs,
        totalMs: resolvedAtMs,
        source: 'runDreaminaEntryFlow',
      },
      gateTrace: gateResult?.detail?.gateTrace || null,
    },
  };
}

module.exports = {
  dismissOverlayBySafeTexts,
  dismissOverlayByCloseSelectors,
  preprocessOverlays,
  preprocessDreaminaEntryOverlays: preprocessOverlays, // 别名：供 buildDreaminaEntryStageAdapter 通过 siteAdapter.preprocessDreaminaEntryOverlays 调用
  filterStrongReadySelectors,
  findVisibleReadyText,
  findVisibleReadySelector,
  waitForDreaminaReady,
  collectFailureEvidence,
  hasFrontendLoadFailureEvidence,
  hasNetworkFailureEvidence,
  hasBlockedOrChallengeEvidence,
  classifyDreaminaEntryFailure,
  isRecoverableDreaminaEntryFailure,
  waitBrieflyForRecovery,
  recoverDreaminaEntry,
  detectDreaminaEmailGateReady,
  captureDreaminaLoginGateSnapshot,
  hasMeaningfulLoginGateStateChange,
  detectDreaminaErrorModal,
  waitAfterLoginEntryAction,
  waitForDreaminaLoginGateTransition,
  findDreaminaLoginEntry,
  openDreaminaLoginEntry,
  confirmDreaminaLoginGate,
  ensureDreaminaLoginGate,
  classifyDreaminaLoginGateFailure,
  runDreaminaEntryFlow,
};

