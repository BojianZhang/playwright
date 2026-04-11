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
 * 这个文件适合承接：
 * 1. Dreamina 专属 overlay 处理
 * 2. Dreamina 专属 ready 信号补充判断
 * 3. Dreamina 专属首页恢复动作
 * 4. Dreamina 专属失败原因补充归类
 *
 * 这个文件不适合承接：
 * - browser/context 创建
 * - 代理池调度
 * - runner 层流程
 * - 邮箱 / 验证码 / 生日 / 注册后半段业务
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
 */
async function findVisibleReadyText(page, texts = []) {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();
    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      return {
        ok: true,
        source: 'text',
        value: text,
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
 * 检查是否命中某个 selector ready 信号。
 */
async function findVisibleReadySelector(page, selectors = []) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      return {
        ok: true,
        source: 'selector',
        value: selector,
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
  const steps = maxWaitMs > 0 ? [0, Math.min(800, maxWaitMs), maxWaitMs] : [0];

  for (const waitMs of [...new Set(steps)]) {
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const strongSelectorHit = await findVisibleReadySelector(page, strongSelectors);
    if (strongSelectorHit.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中强 selector ready 信号: ${strongSelectorHit.value} | elapsed=${Date.now() - start}ms`);
      }
      return strongSelectorHit;
    }

    const strongTextHit = await findVisibleReadyText(page, strongTexts);
    if (strongTextHit.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中强文本 ready 信号: ${strongTextHit.value} | elapsed=${Date.now() - start}ms`);
      }
      return strongTextHit;
    }

    const bodyPatternHit = await findBodyPatternReady(page, runtime.readyBodyPatterns || []);
    if (bodyPatternHit.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中 body pattern 兜底信号: ${bodyPatternHit.value} | elapsed=${Date.now() - start}ms`);
      }
      return bodyPatternHit;
    }
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.waitForDreaminaReady | 未命中 Dreamina ready 信号 | elapsed=${Date.now() - start}ms`);
  }

  return {
    ok: false,
    source: '',
    value: '',
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

module.exports = {
  SAFE_OVERLAY_TEXT_PATTERNS,
  DREAMINA_STRONG_READY_TEXTS,
  DREAMINA_STRONG_READY_SELECTORS,
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
};
