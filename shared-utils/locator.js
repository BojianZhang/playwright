'use strict';

/**
 * shared-utils/locator.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— Playwright locator 层的通用可见性判断、元素查找和安全点击。
 * ❌ 不负责 —— 任何页面业务语义（不知道 Dreamina / credential / verification）。
 * ❌ 不负责 —— 表单驱动逻辑（不命令 page.goto / page.fill / 主流程点击）。
 * ❌ 不负责 —— 阶段编排（不拥有 stage / step / retry 决策）。
 * ❌ 不负责 —— 抛异常：出错时统一安全处理（catch → 返回 false / 空结构）。
 *
 * 使用场景：
 * - 所有 site adapter 的基础可见性工具层
 * - 替代各 adapter 中完全重复定义的 isVisible / findFirstVisibleBy* 函数
 */

/**
 * 判断 locator 当前是否可见。
 *
 * 边界：
 * - 只做可见性检查，不做交互。
 * - 出错返回 false，不抛出异常。
 * - 适用于任意 Playwright locator 对象。
 *
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<boolean>}
 */
async function isVisible(locator) {
  // 使用 catch 兜底，避免 locator 本身不存在时抛出未捕获异常。
  return await locator.isVisible().catch(() => false);
}

/**
 * 判断 locator 当前是否可见且可交互（enabled）。
 *
 * 边界：
 * - 先检查 visible，再检查 enabled（short-circuit：不可见时不再检查 enabled）。
 * - 适用于"点击前校验"场景，避免盲点和误点隐藏/禁用元素。
 * - isEnabled 出错时默认返回 true（保守策略：出错后视为可交互）。
 *
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<boolean>}
 */
async function isVisibleAndEnabled(locator) {
  // 先做可见性检查，不可见则直接短路，无需再检查 enabled。
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  // 再检查 enabled，出错时保守返回 true（避免把出错误判为不可点击）。
  return Boolean(await locator.isEnabled().catch(() => true));
}

/**
 * 从 selector 列表中找到第一个当前可见的目标。
 *
 * 边界：
 * - 依次遍历 selectors，返回第一个命中的可见 locator 及其 selector。
 * - 不负责在命中后执行任何交互动作（只"找"不"点"）。
 * - 返回统一结构 { ok, selector, locator }，调用方按 ok 判断是否命中。
 * - selectors 为空或全部不可见时，返回 { ok: false, selector: '', locator: null }。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string[]} selectors - CSS selector 候选列表，按优先级排列
 * @returns {Promise<{ ok: boolean, selector: string, locator: import('@playwright/test').Locator|null }>}
 */
async function findFirstVisibleBySelectors(page, selectors = []) {
  for (const selector of selectors) {
    // 每次只取第一个匹配元素，避免多元素列表干扰可见性判断。
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) {
      // 命中后立即返回，不继续扫描剩余 selectors。
      return { ok: true, selector, locator };
    }
  }
  // 所有 selector 均未命中，返回统一失败结构。
  return { ok: false, selector: '', locator: null };
}

/**
 * 从文本列表中找到第一个当前可见的目标。
 *
 * 边界：
 * - 使用 getByText + exact: false 做宽松文本匹配（允许文本前后有其他内容）。
 * - 依次遍历 texts，返回第一个命中结果。
 * - 返回统一结构 { ok, text, locator }，调用方按 ok 判断是否命中。
 * - texts 为空或全部不可见时，返回 { ok: false, text: '', locator: null }。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string[]} texts - 文本候选列表，按优先级排列
 * @returns {Promise<{ ok: boolean, text: string, locator: import('@playwright/test').Locator|null }>}
 */
async function findFirstVisibleByTexts(page, texts = []) {
  for (const text of texts) {
    // exact: false 允许文本前后有其他内容，覆盖更多真实页面情形。
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    if (await isVisible(locator)) {
      // 命中后立即返回，不继续扫描剩余 texts。
      return { ok: true, text, locator };
    }
  }
  // 所有文本均未命中，返回统一失败结构。
  return { ok: false, text: '', locator: null };
}

/**
 * 安全读取 locator 的内部文本，并 normalize 空白字符。
 *
 * 边界：
 * - 只读取文本，不做任何 DOM 交互。
 * - normalize 会把连续空白（含换行）折叠成单个空格并 trim。
 * - 出错时返回 fallback（默认空字符串），不抛异常。
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {string} [fallback='']
 * @returns {Promise<string>}
 */
async function safeInnerText(locator, fallback = '') {
  // innerText 出错时使用 fallback，保证调用方拿到可用字符串。
  return String(await locator.innerText().catch(() => fallback) || fallback)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 安全批量读取 locator 的 DOM 元信息（tagName / className / 指定 attr 列表）。
 *
 * 边界：
 * - 只读取元信息，不做任何 DOM 交互或状态判断。
 * - 所有读取出错时返回空字符串，不抛异常。
 * - 调用方自行解读元信息业务含义（本函数不判断"是否可点击"等语义）。
 * - tagName / className 通过 evaluate 读取（getAttribute 无法获取 tagName）。
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {string[]} [attrs=['type','maxlength','autocomplete']] - 额外需要读取的 HTML attribute 列表
 * @returns {Promise<Record<string, string>>}
 */
async function safeLocatorMeta(locator, attrs = ['type', 'maxlength', 'autocomplete']) {
  // tagName 和 className 需要通过 evaluate 读取。
  const tagName = await locator.evaluate(node => String(node?.tagName || '')).catch(() => '');
  const className = await locator.evaluate(node => String(node?.className || '')).catch(() => '');
  // 其余 attr 通过 getAttribute 读取，出错时返回空字符串。
  const meta = { tagName, className };
  for (const attr of attrs) {
    meta[attr] = String(await locator.getAttribute(attr).catch(() => '') || '');
  }
  return meta;
}

/**
 * 尝试点击 locator，失败时不抛异常，返回成功/失败布尔值。
 *
 * 边界：
 * - 只负责单次点击尝试，不做重试循环。
 * - 点击超时通过 context.clickTimeout 控制（默认 1200ms），适合短时间 overlay 场景。
 * - 返回 true/false，由调用方决定后续行为（不在本函数内做策略分支）。
 * - 日志通过 context.logInfo / context.logWarn 输出，调用方可不传。
 *
 * @param {import('@playwright/test').Locator} locator
 * @param {string} label - 用于日志标识的描述文本（如 "button:Accept" / "selector:[aria-label=Close]"）
 * @param {{ logInfo?: Function, logWarn?: Function, clickTimeout?: number }} [context={}]
 * @returns {Promise<boolean>}
 */
async function tryClickLocator(locator, label, context = {}) {
  // 读取超时配置，默认 1200ms（足够短，不阻塞主流程）。
  const { logInfo = null, logWarn = null, clickTimeout = 1200 } = context;
  try {
    await locator.click({ timeout: clickTimeout });
    // 点击成功后写 info 日志，方便日志追踪 overlay 被清理的时序。
    if (typeof logInfo === 'function') {
      logInfo(`tryClickLocator | clicked: ${label}`);
    }
    return true;
  } catch (error) {
    // 点击失败时写 warn 日志，保留失败原因，调用方可决定是否继续尝试。
    if (typeof logWarn === 'function') {
      logWarn(`tryClickLocator | failed: ${label} | ${error?.message || String(error)}`);
    }
    return false;
  }
}

module.exports = {
  isVisible,
  isVisibleAndEnabled,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  safeInnerText,
  safeLocatorMeta,
  tryClickLocator,
};
