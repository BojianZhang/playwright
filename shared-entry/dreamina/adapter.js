'use strict';

/**
 * adapter.js
 *
 * 这个文件是 Dreamina 站点在 shared-entry 体系下的专属适配层。
 *
 * 它的职责不是替代公共层，而是补公共层表达不了的 Dreamina 特殊逻辑。
 *
 * 你可以把它理解成：
 * - site-entry-health.js = 通用首页加载骨架
 * - dreamina-entry-profile.json = 静态配置
 * - adapter.js = Dreamina 专属动态处理
 *
 * 当前文件的边界：
 * 1. 负责 Dreamina 首页入口阶段的专属适配
 * 2. 负责 Dreamina 从首页进入“登录入口态”的第一阶段切换适配
 * 3. 负责 Dreamina 首页失败分类与轻量恢复动作
 *
 * 当前文件不负责：
 * - browser/context 创建
 * - 代理池调度
 * - runner 层流程
 * - 邮箱填写
 * - 验证码获取与填写
 * - 生日/注册提交/账号创建后续流程
 */

/**
 * 允许尝试点击的高置信 overlay 文案。
 *
 * 设计原则：
 * - 只放“明显是关闭/确认/跳过挡板”的词
 * - 不放 Continue / Sign in / Sign up 这类业务主按钮
 * - 目的不是穷举全站按钮，而是保守地清理常见挡板
 */
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

/**
 * Dreamina 首页更高置信的 ready 文本。
 *
 * 设计原则：
 * - 优先放 Dreamina 首页/登录入口更稳定的文案
 * - 这些信号的优先级高于 profile 里那些更泛化的兜底信号
 */
const DREAMINA_STRONG_READY_TEXTS = [
  'Continue with email',
  'Sign in',
  'Log in',
  'Login',
  'Sign up',
  'Create realistic talk',
  'Explore Create Assets',
  'Start Creating With AI Agent',
  'AI Image',
  'Canvas',
];

/**
 * Dreamina 首页更高置信的 ready selector。
 *
 * 设计原则：
 * - 优先放更像首页主区域/登录入口的结构信号
 * - 避免直接把 button / a 这种全站过泛 selector 当成强 ready
 */
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

/**
 * Dreamina 第一阶段登录入口候选配置。
 *
 * 作用：
 * - 定义首页到登录入口切换时，优先检查哪些入口
 * - 每个候选都带 type / 文本 / selector，方便后续点击与日志输出
 *
 * 注意：
 * - 这只是第一版骨架候选集，不代表已经完成最终定型
 * - 后续应根据真实页面命中情况继续收敛优先级
 */
const DREAMINA_LOGIN_ENTRY_CANDIDATES = [
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

/**
 * 登录门确认用 selector。
 *
 * 作用：
 * - 用来判断点击登录入口后，页面是否已经进入“登录前表单态”
 * - 第一版先放输入框/邮件输入类信号
 */
const DREAMINA_LOGIN_GATE_SELECTORS = [
  'input[type="email"]',
  'input[role="textbox"]',
  '[type="email"]',
  '[class*="email"] input',
];

/**
 * Dreamina 首页/登录门阶段专属错误弹窗文本。
 *
 * 作用：
 * - 用于识别旧链里真实存在的 Something went wrong / Refresh 异常页
 * - 第一轮只做识别，不自动恢复，不点 Refresh
 */
const DREAMINA_ERROR_MODAL_TEXTS = [
  'Something went wrong',
  'Refresh',
  'Refresh the page and try again',
];

/**
 * 一些明显过泛的 selector，不适合直接当强 ready 信号。
 *
 * 例如：
 * - button
 * - a
 *
 * 这些元素在错误页、空壳页、弹层里也很常见，容易造成假阳性。
 */
const OVER_GENERIC_READY_SELECTORS = new Set([
  'button',
  'a',
  'div',
  'span',
]);

/**
 * 判断元素是不是可见且可交互。
 *
 * 作用：
 * - 减少盲点、误点和异常点击
 * - 只对当前确实可见的候选元素执行点击
 */
async function isVisibleAndEnabled(locator) {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;

  const enabled = await locator.isEnabled().catch(() => true);
  return Boolean(enabled);
}

/**
 * 尝试点击单个 locator。
 *
 * 作用：
 * - 统一点击行为与日志格式
 * - 尽量使用短超时，避免挡板点击本身拖慢首页流程
 */
async function tryClickLocator(locator, label, context = {}) {
  const { logInfo = null, logWarn = null } = context;

  try {
    await locator.click({ timeout: 1200 });
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.preprocessOverlays | 已点击 overlay 候选: ${label}`);
    }
    return true;
  } catch (error) {
    if (typeof logWarn === 'function') {
      logWarn(`dreamina.adapter.preprocessOverlays | overlay 候选点击失败: ${label} | ${error.message}`);
    }
    return false;
  }
}

/**
 * 尝试通过按钮文本清理常见挡板。
 *
 * 作用：
 * - 用一组高置信按钮文案，保守地清理 cookie/tips/onboarding 这类挡板
 * - 每次命中一个后就先返回，避免一次性乱点多个按钮
 */
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

/**
 * 尝试通过常见关闭控件清理挡板。
 *
 * 作用：
 * - 有些弹层没有明确按钮文案，只给一个 close icon / aria-label
 * - 这里补一层高置信 selector 级清理
 */
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
 * 预处理首页 overlay / 遮罩 / 弹层。
 *
 * 作用：
 * - 在首页 ready 判断前，先尝试移除会挡住交互的页面元素。
 * - 这里是 Dreamina 站点专属入口，后续如果发现某些弹层只在 Dreamina 出现，
 *   就应该优先收在这里，而不是把逻辑写脏到公共层。
 *
 * 当前这版实现策略：
 * 1. 先尝试点击高置信的“关闭/同意/跳过”按钮
 * 2. 再尝试点击常见 close selector
 * 3. 整体保持保守，不去碰 Continue / Sign in / Sign up 等业务主按钮
 */
async function preprocessOverlays(page, context = {}) {
  const { logInfo = null } = context;

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.preprocessOverlays | 开始执行第一版 overlay 清理');
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
    logInfo('dreamina.adapter.preprocessOverlays | 未发现可安全处理的 overlay');
  }

  return {
    handled: false,
    action: 'noop',
    reason: 'NO_SAFE_OVERLAY_ACTION_MATCHED',
  };
}

/**
 * 从 selector 列表里过滤掉过泛 selector。
 *
 * 作用：
 * - 避免把 button / a 这种全站常见元素直接当成强 ready 信号
 * - 让 ready 判定更保守、更像首页真实可用状态
 */
function filterStrongReadySelectors(selectors = []) {
  return selectors.filter(selector => !OVER_GENERIC_READY_SELECTORS.has(String(selector || '').trim().toLowerCase()));
}

/**
 * 检查是否命中某个文本 ready 信号。
 *
 * 作用：
 * - 统一文本级 ready 检查返回结构
 * - 给 waitForDreaminaReady / 登录入口检测复用
 */
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

/**
 * 检查是否命中某个 selector ready 信号。
 *
 * 作用：
 * - 统一 selector 级 ready 检查返回结构
 * - 给 waitForDreaminaReady / 登录门确认复用
 */
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

/**
 * 检查 body 文本是否命中兜底 ready pattern。
 *
 * 这层优先级最低，只作为兜底。
 */
async function findBodyPatternReady(page, patterns = []) {
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').trim();
  for (const pattern of patterns) {
    const regex = new RegExp(String(pattern || ''), 'i');
    if (regex.test(bodyText)) {
      return {
        ok: true,
        source: 'bodyText',
        value: pattern,
      };
    }
  }

  return {
    ok: false,
    source: '',
    value: '',
  };
}

/**
 * 等待 Dreamina 首页进入真正可操作状态。
 *
 * 第一版更像样的判定逻辑：
 * 1. 先做一轮 Dreamina 强 ready selector 检查
 * 2. 再做一轮 Dreamina 强 ready 文本检查
 * 3. 再看 profile 里过滤后的 selector
 * 4. 再看 profile 里的文本 ready signal
 * 5. 最后才退到 body pattern 兜底
 *
 * 设计目标：
 * - 优先命中高置信首页主信号
 * - 避免 button / a 这类过泛元素直接把错误页判成 ready
 * - 保留轻量等待，给首页首屏一点时间起来
 */
async function waitForDreaminaReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;

  const filteredRuntimeSelectors = filterStrongReadySelectors(runtime.readySelectors || []);
  const strongSelectors = [...new Set([...(DREAMINA_STRONG_READY_SELECTORS || []), ...filteredRuntimeSelectors])];
  const strongTexts = [...new Set([...(DREAMINA_STRONG_READY_TEXTS || []), ...((runtime.readyTextSignals || []).filter(Boolean))])];
  const start = Date.now();
  const maxWaitMs = Number(runtime.firstLoadGraceWaitMs || 0);
  const earlyMidWaitMs = maxWaitMs > 0 ? Math.min(2000, maxWaitMs) : 0;
  const midWaitMs = maxWaitMs > 0 ? Math.min(4000, maxWaitMs) : 0;
  const steps = maxWaitMs > 0 ? [0, Math.min(800, maxWaitMs), earlyMidWaitMs, midWaitMs, maxWaitMs] : [0];
  const uniqueSteps = [...new Set(steps)];
  const trace = {
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
    'AI Image',
    'Canvas',
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
        waitTrace: trace,
      };
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中强 selector ready 信号: ${strongSelectorHit.value} | elapsed=${Date.now() - start}ms | stepWait=${waitMs}`);
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
        waitTrace: trace,
      };
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中强文本 ready 信号: ${strongTextHit.value} | elapsed=${Date.now() - start}ms | stepWait=${waitMs}`);
      }
      return strongTextHit;
    }

    trace.rounds.push(round);
    if (bodyPatternHit.ok && waitMs >= maxWaitMs && maxWaitMs > 0) {
      trace.matchedKind = 'body-pattern';
      trace.matchedValue = String(bodyPatternHit.value || '');
      bodyPatternHit.detail = {
        ...(bodyPatternHit.detail && typeof bodyPatternHit.detail === 'object' ? bodyPatternHit.detail : {}),
        waitTrace: trace,
      };
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中末段 body pattern 兜底信号: ${bodyPatternHit.value} | elapsed=${Date.now() - start}ms | stepWait=${waitMs}`);
      }
      return bodyPatternHit;
    }
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.waitForDreaminaReady | 未命中 Dreamina ready 信号 | elapsed=${Date.now() - start}ms | steps=${uniqueSteps.join(',')}`);
  }

  return {
    ok: false,
    source: '',
    value: '',
    detail: {
      waitTrace: trace,
    },
  };
}

/**
 * 汇总 diagnostics 中的失败证据。
 *
 * 作用：
 * - 把 requestFailures / responseErrors / pageErrors / consoleMessages 统一拉平
 * - 方便后面做 Dreamina 站点级失败分类
 */
function collectFailureEvidence(diagnostics = null) {
  return {
    requestFailures: Array.isArray(diagnostics?.requestFailures) ? diagnostics.requestFailures : [],
    responseErrors: Array.isArray(diagnostics?.responseErrors) ? diagnostics.responseErrors : [],
    pageErrors: Array.isArray(diagnostics?.pageErrors) ? diagnostics.pageErrors : [],
    consoleMessages: Array.isArray(diagnostics?.consoleMessages) ? diagnostics.consoleMessages : [],
  };
}

/**
 * 判断 diagnostics 里是否存在前端资源/脚本加载失败证据。
 *
 * 作用：
 * - 把资源未加载、chunk 错误、脚本错误归成“前端资源失败”类
 * - 便于首页失败分类更贴近真实问题类型
 */
function hasFrontendLoadFailureEvidence(evidence = {}) {
  const lines = [
    ...evidence.requestFailures,
    ...evidence.responseErrors,
    ...evidence.pageErrors,
    ...evidence.consoleMessages,
  ].map(item => String(item || ''));

  return lines.some(line => /chunk|script|stylesheet|module|failed to load resource|load failed|refused|blocked|cors/i.test(line));
}

/**
 * 判断 diagnostics 里是否存在网络/连接层失败证据。
 *
 * 作用：
 * - 把 timeout / net::ERR / proxy / dns 这类问题归成“连接失败”类
 */
function hasNetworkFailureEvidence(evidence = {}) {
  const lines = [
    ...evidence.requestFailures,
    ...evidence.responseErrors,
    ...evidence.pageErrors,
    ...evidence.consoleMessages,
  ].map(item => String(item || ''));

  return lines.some(line => /timeout|timed out|net::|err_|connection|proxy|dns|tunnel|ssl|econn|socket/i.test(line));
}

/**
 * 判断 diagnostics 里是否存在疑似风控/拦截信号。
 *
 * 作用：
 * - 把 captcha / challenge / 403 / 429 / access denied 归成“风控/拦截”类
 */
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
 * 对 Dreamina 首页失败做站点专属补充归类。
 *
 * 第一版分类目标：
 * - 保留公共层的 WHITE_SCREEN / DEAD_PAGE / READY_SIGNAL_MISSING 主 reason
 * - 再补一个更像 Dreamina 自己问题语义的 siteReason
 * - 方便 runner / 日志后续区分“网络坏”“资源坏”“挑战页”“只是没 ready”
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
 * 判断某类站点失败是否值得做“轻量恢复”。
 *
 * 第一版策略：
 * - 只恢复 READY_MISSING 类
 * - 不恢复 challenge / blocked / 明确网络失败 / 明确资源硬失败
 * - 不恢复 WHITE_SCREEN / DEAD_PAGE 这类已经很重的失败
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

/**
 * 对可恢复的 ready-missing 类失败做一次轻量恢复等待。
 *
 * 作用：
 * - 不做重操作，不乱 reload，不碰外层 page recreate
 * - 只给页面一次额外的喘息机会
 */
async function waitBrieflyForRecovery(page, context = {}) {
  const { logInfo = null, runtime = {} } = context;
  const waitMs = Math.min(Math.max(Number(runtime.firstLoadGraceWaitMs || 800), 800), 2500);

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.recoverDreaminaEntry | 执行轻量恢复等待 ${waitMs}ms`);
  }

  await page.waitForTimeout(waitMs);

  return {
    recovered: false,
    action: 'wait-briefly',
    reason: `WAITED_${waitMs}MS`,
  };
}

/**
 * 尝试对 Dreamina 首页做一次站点专属恢复动作。
 *
 * 第一版轻量恢复策略：
 * 1. 对 challenge / blocked / 明确网络失败 / 明确资源失败：直接放弃恢复
 * 2. 对 READY_MISSING 类：
 *    - 先再跑一轮保守 overlay 清理
 *    - 再做一次轻量等待
 * 3. 整体不做 reload，不碰 browser/context，不抢外层 orchestrator 的职责
 */
async function recoverDreaminaEntry(page, input = {}, context = {}) {
  const { logInfo = null } = context;
  const reason = String(input.siteReason || input.reason || 'UNKNOWN');

  if (!isRecoverableDreaminaEntryFailure(input)) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.recoverDreaminaEntry | 当前失败不适合做轻量恢复 | reason=${reason}`);
    }
    return {
      recovered: false,
      action: 'skip-recovery',
      reason,
    };
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.recoverDreaminaEntry | 对可恢复失败尝试轻量恢复 | reason=${reason}`);
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

/**
 * 检查当前页面是否已经直接处于“邮箱登录门已就绪”状态。
 *
 * 作用：
 * - 这是第一阶段登录里最重要的前置短路判断。
 * - 如果 email input 已经出现，说明当前页面已经处在登录门，不应再重复点击首页入口。
 * - 这个判断优先级必须高于 Continue with email / Sign in / Login 等普通入口扫描。
 */
async function detectDreaminaEmailGateReady(page, context = {}) {
  const { logInfo = null } = context;
  const emailGate = await findVisibleReadySelector(page, DREAMINA_LOGIN_GATE_SELECTORS);
  if (emailGate.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.detectDreaminaEmailGateReady | 当前已在邮箱登录门: ${emailGate.value}`);
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
 * 捕获第一阶段登录门切换前后的轻量页面状态快照。
 *
 * 作用：
 * - 用于判断“点击登录入口后到底有没有产生状态变化”
 * - 这里只抓最轻量、最有用的几个字段，不做重 DOM 对比
 *
 * 为什么需要它：
 * - 点击成功并不等于页面状态真的变了
 * - 没有快照就很难区分“点击失败”和“点击无变化”
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

/**
 * 比较点击前后快照，判断页面是否发生了足够明确的状态变化。
 *
 * 作用：
 * - 不追求完全精确的 DOM diff
 * - 只判断对第一阶段登录最重要的几个状态是否有变化
 */
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

/**
 * 检测 Dreamina 首页/登录门阶段专属错误弹窗。
 *
 * 作用：
 * - 识别 Something went wrong / Refresh 这类旧链已验证存在的异常态
 * - 第一轮只做识别，不自动恢复，不点击 Refresh
 *
 * 这么做的原因：
 * - 先把问题分类准确，再决定是否要加自动恢复动作
 * - 避免第一轮就把恢复逻辑做重
 */
async function detectDreaminaErrorModal(page, context = {}) {
  const { logInfo = null } = context;

  for (const text of DREAMINA_ERROR_MODAL_TEXTS) {
    const locator = page.getByText(text, { exact: false }).first();
    if (await locator.isVisible().catch(() => false)) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.detectDreaminaErrorModal | 命中 Dreamina 错误弹窗信号: ${text}`);
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

/**
 * 对点击后的状态切换做一次非常轻的保护性等待。
 *
 * 作用：
 * - 避免页面状态切换慢一拍时被立刻误判失败
 * - 不恢复旧的大轮询，只给一次很轻的缓冲时间
 *
 * 为什么放在第一阶段登录里：
 * - Dreamina 首页 -> 登录门切换不是严格同步瞬时完成
 * - 轻等待能显著降低“点完马上判失败”的误伤率
 */
async function waitAfterLoginEntryAction(page, context = {}) {
  const { logInfo = null } = context;
  const waitMs = 700;
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.waitAfterLoginEntryAction | 点击后保护性等待 ${waitMs}ms`);
  }
  await page.waitForTimeout(waitMs);
  return waitMs;
}

/**
 * 查找 Dreamina 第一阶段登录入口。
 *
 * 作用：
 * - 在首页 ready 之后，按既定优先级识别当前处于哪一种“登录前态”
 * - 优先判断是否已经进入登录 modal 外层
 * - 再判断首页上的 Sign in / Login / Sign up 这类外层入口
 * - 第一阶段只做到登录 modal，不再把 email gate 当成阶段目标
 *
 * 这个方法只负责“识别状态和入口”，不负责点击，不负责最终确认登录门是否真的打开。
 */
async function findDreaminaLoginEntry(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;

  /**
   * 第一步：优先短路判断是否已经进入登录 modal 外层。
   *
   * 第一阶段边界到登录 modal 为止，
   * 不再把 email input / email gate 作为 S1 内目标。
   */
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

  /**
   * 第二步：按登录入口优先级扫描候选。
   *
   * 当前优先级原则：
   * 1. Sign in / Login / Log in / Sign up
   * 2. 结构化 selector 兜底
   */
  const loginPageButton = page.locator('[class*="login-button"]').first();
  const loginPageButtonVisible = await loginPageButton.isVisible().catch(() => false);
  if (loginPageButtonVisible) {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.findDreaminaLoginEntry | 命中 login 页面按钮容器: [class*="login-button"]');
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
          logInfo(`dreamina.adapter.findDreaminaLoginEntry | 命中登录入口文本候选: ${candidate.type} | text=${candidate.text}`);
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
            logInfo(`dreamina.adapter.findDreaminaLoginEntry | 命中登录入口 selector 候选: ${candidate.type} | selector=${selector}`);
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
    logInfo('dreamina.adapter.findDreaminaLoginEntry | 当前未找到 Dreamina 登录入口候选');
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
 * 打开 Dreamina 第一阶段登录入口。
 *
 * 作用：
 * - 先调用 findDreaminaLoginEntry 找到当前最优入口
 * - 如果已经在登录 modal 外层，直接短路成功
 * - 如果只是首页外层入口，则点击入口并返回点击结果
 * - 同时记录点击前后快照，判断页面是否真的发生了有意义的状态变化
 *
 * 这个方法只负责“执行入口点击动作”，不负责最终确认点击后是否真的进入登录门。
 */
async function openDreaminaLoginEntry(page, runtime = {}, context = {}) {
  const { logInfo = null, logWarn = null } = context;
  const entry = await findDreaminaLoginEntry(page, runtime, context);

  /**
   * 已经在登录 modal 外层时，直接视为第一阶段登录入口完成。
   *
   * 这里不再点击任何东西，避免把已经好的状态重新点坏。
   */
  if (entry.found && entry.alreadyInGate) {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.openDreaminaLoginEntry | 当前已在登录 modal 外层，跳过入口点击');
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
      logWarn('dreamina.adapter.openDreaminaLoginEntry | 未找到可用登录入口');
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
      logWarn(`dreamina.adapter.openDreaminaLoginEntry | 登录入口不可点击: ${entry.type}`);
    }
    return {
      success: false,
      reason: 'LOGIN_ENTRY_NOT_CLICKABLE',
      entry,
      clicked: false,
    };
  }

  /**
   * 点击前做轻量状态快照。
   *
   * 目的不是做重 DOM diff，而是给“点击后无状态变化”这种真实问题留证据。
   */
  const beforeSnapshot = await captureDreaminaLoginGateSnapshot(page, context);

  try {
    await entry.locator.click({ timeout: 1500 });

    /**
     * 点击后做一次很轻的保护性等待。
     *
     * 这样做的原因：
     * - 登录门切换有时不是同步立刻完成
     * - 没有这一步容易把“慢一拍”误判成失败
     */
    await waitAfterLoginEntryAction(page, context);

    const afterSnapshot = await captureDreaminaLoginGateSnapshot(page, context);
    const hasStateChange = hasMeaningfulLoginGateStateChange(beforeSnapshot, afterSnapshot);

    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.openDreaminaLoginEntry | 已点击登录入口: ${entry.type} | stateChanged=${hasStateChange ? 'Y' : 'N'}`);
    }

    if (!hasStateChange) {
      return {
        success: false,
        reason: 'LOGIN_ENTRY_CLICK_NO_STATE_CHANGE',
        entry,
        clicked: true,
        beforeSnapshot,
        afterSnapshot,
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
    };
  } catch (error) {
    if (typeof logWarn === 'function') {
      logWarn(`dreamina.adapter.openDreaminaLoginEntry | 点击登录入口失败: ${entry.type} | ${error.message}`);
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
 * 确认 Dreamina 是否已经进入“登录门/登录前表单态”。
 *
 * 作用：
 * - 在点击登录入口后，确认页面是否真的出现登录前必要信号
 * - 第一优先确认 email input 是否已经出现
 * - 第二优先确认是否只进入了 Continue with email 这一层中间态
 * - 额外识别 Dreamina 专属错误弹窗，避免把异常态误当成普通 gate 失败
 *
 * 这个方法不负责填写邮箱，也不负责点击发送验证码。
 * 它只回答一个问题：
 * “现在是不是已经进入登录门了？进入到了哪一层？”
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

  /**
   * 先识别 Dreamina 专属错误弹窗。
   *
   * 第一轮先只识别，不自动恢复；
   * 这样至少能把错误分类做准，不再把这类页面异常混成普通 gate not ready。
   */
  const errorModal = await detectDreaminaErrorModal(page, context);
  if (errorModal.ok) {
    return {
      ok: false,
      state: 'ERROR_MODAL_VISIBLE',
      source: 'text',
      value: errorModal.value,
    };
  }

  /**
   * 第一优先：email gate ready。
   *
   * email input 是第一阶段登录切换成功的最强确认信号，
   * 因为它直接表示“现在已经可以填写邮箱了”。
   */
  const emailGate = await detectDreaminaEmailGateReady(page, context);
  if (emailGate.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.confirmDreaminaLoginGate | 命中邮箱登录门信号: ${emailGate.value}`);
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

  /**
   * 第二优先：Continue with email 可见。
   *
   * 这通常表示已经从首页进入了登录门外层，
   * 但还没有真正进入 email input 就绪状态。
   */
  const continueLayer = await findVisibleReadyText(page, ['Continue with email']);
  if (continueLayer.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.adapter.confirmDreaminaLoginGate | 命中登录门外层信号: ${continueLayer.value}`);
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

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.confirmDreaminaLoginGate | 当前未确认进入登录门');
  }

  return {
    ok: false,
    state: 'LOGIN_GATE_NOT_READY',
    source: '',
    value: '',
  };
}

/**
 * 确保 Dreamina 当前页面进入第一阶段登录门。
 *
 * 作用：
 * - 这是“首页 -> 登录门”的总编排方法
 * - 它负责把首页状态推进到 email gate ready
 * - 只做到登录门，不继续做邮箱填写/验证码等后续业务
 *
 * 当前第一版编排策略：
 * 1. 先做一次 overlay 清理
 * 2. 先确认是否已经在 email gate
 * 3. 如果不是，再找最优登录入口并点击
 * 4. 点击后确认是否已经进入 gate
 * 5. 如果只是进入 Continue with email 这一层，再做第二跳
 * 6. 再次确认是否进入 email gate
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

  /**
   * 先清一次挡板。
   *
   * 原因：
   * - 首页入口经常会被 cookie / onboarding / 提示层挡住
   * - 不先清挡板，后续入口判断和点击都可能失真
   */
  const preprocessStartAt = Date.now();
  await preprocessOverlays(page, context);
  gateTrace.preprocessOverlaysMs = Math.max(0, Date.now() - preprocessStartAt);

  /**
   * 第一步确认：是不是已经在 email gate。
   */
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

  /**
   * 第二步：尝试点击首页登录入口。
   */
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

  /**
   * 第三步：点击后先做一轮 gate 确认。
   */
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

  /**
   * 第四步：点击后只要进入登录 modal 外层，就视为第一阶段成功。
   *
   * 这是从旧逻辑提炼出来的真实行为：
   * - 某些首页入口不会直接打开 email input
   * - 而是先进入登录门外层，再出现 Continue with email
   */
  if (gateState.ok && gateState.state === 'LOGIN_GATE_LAYER_READY') {
    if (typeof logInfo === 'function') {
      logInfo('dreamina.adapter.ensureDreaminaLoginGate | 已进入登录门外层，视为第一阶段成功，后续由下阶段继续推进 Continue with email');
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
    logWarn('dreamina.adapter.ensureDreaminaLoginGate | 点击登录入口后仍未确认进入登录门');
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
 * 对第一阶段登录入口失败做专属分类。
 *
 * 作用：
 * - 把“首页 ready 之后进入登录入口”这一段失败独立分类
 * - 让日志和后续策略能区分：是没找到入口、点不了、点了没变化，还是 Dreamina 异常弹窗
 *
 * 这类分类只服务“首页 -> 登录门”这一段，
 * 不用于验证码、生日、注册提交等后续阶段。
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

module.exports = {
  SAFE_OVERLAY_TEXT_PATTERNS,
  DREAMINA_STRONG_READY_TEXTS,
  DREAMINA_STRONG_READY_SELECTORS,
  DREAMINA_LOGIN_ENTRY_CANDIDATES,
  DREAMINA_LOGIN_GATE_SELECTORS,
  DREAMINA_ERROR_MODAL_TEXTS,
  OVER_GENERIC_READY_SELECTORS,
  isVisibleAndEnabled,
  tryClickLocator,
  dismissOverlayBySafeTexts,
  dismissOverlayByCloseSelectors,
  preprocessOverlays,
  filterStrongReadySelectors,
  findVisibleReadyText,
  findVisibleReadySelector,
  findBodyPatternReady,
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
  findDreaminaLoginEntry,
  openDreaminaLoginEntry,
  confirmDreaminaLoginGate,
  ensureDreaminaLoginGate,
  classifyDreaminaLoginGateFailure,
};
