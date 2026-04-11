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
 * 预处理首页 overlay / 遮罩 / 弹层。
 *
 * 作用：
 * - 在首页 ready 判断前，先尝试移除会挡住交互的页面元素。
 * - 这里是 Dreamina 站点专属入口，后续如果发现某些弹层只在 Dreamina 出现，
 *   就应该优先收在这里，而不是把逻辑写脏到公共层。
 *
 * 当前状态：
 * - 先保留空骨架
 * - 后续可在这里补 cookie banner、tips dialog、onboarding mask 等处理
 */
async function preprocessOverlays(page, context = {}) {
  const { log = null, logInfo = null } = context;

  if (typeof logInfo === 'function') {
    logInfo('dreamina.adapter.preprocessOverlays | 当前为骨架实现，尚未注入 Dreamina 专属 overlay 处理');
  }

  return {
    handled: false,
    action: 'noop',
    reason: 'NOT_IMPLEMENTED',
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
  preprocessOverlays,
  waitForDreaminaReady,
  classifyDreaminaEntryFailure,
  recoverDreaminaEntry,
};
