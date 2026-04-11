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
 * 等待 Dreamina 首页进入真正可操作状态。
 *
 * 作用：
 * - 公共层只能做通用 ready signal 判断。
 * - 如果 Dreamina 有“只有它自己才知道的 ready 条件”，就应该放这里。
 *
 * 典型场景：
 * - 某个主容器出现才算 ready
 * - 某个按钮可点击才算 ready
 * - 某个 loading skeleton 消失才算 ready
 * - 关闭弹层后需要做二次 ready 检查
 *
 * 当前状态：
 * - 先复用外部 profile 提供的通用 readySignals
 * - 真正的 Dreamina 特殊逻辑后续再补
 */
async function waitForDreaminaReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;

  for (const selector of runtime.readySelectors || []) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中 selector ready 信号: ${selector}`);
      }
      return {
        ok: true,
        source: 'selector',
        value: selector,
      };
    }
  }

  for (const text of runtime.readyTextSignals || []) {
    const visible = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
    if (visible) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.adapter.waitForDreaminaReady | 命中文本 ready 信号: ${text}`);
      }
      return {
        ok: true,
        source: 'text',
        value: text,
      };
    }
  }

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.waitForDreaminaReady | 当前未命中 Dreamina 专属 ready 信号');
  }

  return {
    ok: false,
    source: '',
    value: '',
  };
}

/**
 * 对 Dreamina 首页失败做站点专属补充归类。
 *
 * 作用：
 * - 公共层只能给出通用 reason，例如 WHITE_SCREEN / DEAD_PAGE / READY_SIGNAL_MISSING。
 * - 如果 Dreamina 有更细的失败口径，就应该在这里补分类。
 *
 * 典型场景：
 * - Dreamina 特有 DOM 命中某个状态时，直接归类为专属失败
 * - Dreamina 控制台错误模式可归成更细粒度错误
 * - 首页结构存在，但主入口容器缺失时，转成 Dreamina 专属 reason
 *
 * 当前状态：
 * - 先把公共 reason 原样返回
 * - 后续根据真实日志和 diagnostics 再细化
 */
function classifyDreaminaEntryFailure(input = {}) {
  const reason = String(input.reason || 'UNKNOWN');
  const diagnostics = input.diagnostics || null;

  return {
    reason,
    siteReason: reason,
    hardFailure: reason === 'WHITE_SCREEN' || reason === 'DEAD_PAGE',
    diagnostics,
  };
}

/**
 * 尝试对 Dreamina 首页做一次站点专属恢复动作。
 *
 * 作用：
 * - 某些失败不一定要立刻交给公共层重试。
 * - Dreamina 如果存在轻量恢复动作，可以先在这里做一次站点内恢复。
 *
 * 典型场景：
 * - 关闭一个已知挡板后重试 ready 检查
 * - 对某个已知 loading 状态额外 wait 一次
 * - 对某种可恢复的首页状态做轻量 click / dismiss
 *
 * 当前状态：
 * - 先提供空骨架，不做实际恢复
 */
async function recoverDreaminaEntry(page, input = {}, context = {}) {
  const { logInfo = null } = context;
  const reason = String(input.reason || 'UNKNOWN');

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.adapter.recoverDreaminaEntry | 当前为骨架实现，未执行恢复动作 | reason=${reason}`);
  }

  return {
    recovered: false,
    action: 'noop',
    reason,
  };
}

module.exports = {
  SAFE_OVERLAY_TEXT_PATTERNS,
  isVisibleAndEnabled,
  tryClickLocator,
  dismissOverlayBySafeTexts,
  dismissOverlayByCloseSelectors,
  preprocessOverlays,
  waitForDreaminaReady,
  classifyDreaminaEntryFailure,
  recoverDreaminaEntry,
};
