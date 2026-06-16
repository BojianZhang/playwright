'use strict';

/**
 * shared-utils/page.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— Playwright page 对象的通用只读工具（body 文本提取 / 正则匹配）。
 * ❌ 不负责 —— 任何页面业务语义（不知道哪个文本是"登录成功"或"验证码"）。
 * ❌ 不负责 —— 阶段编排，不做点击、填写、跳转等交互动作。
 * ❌ 不负责 —— 抛异常：出错时统一安全处理（catch → 返回空字符串 / false 结构）。
 *
 * 使用场景：
 * - 各 site adapter 中需要读取 body 全文或做 fallback 文本匹配时调用
 * - 替代各 adapter 中零散的 `page.locator('body').innerText().catch(...)` 写法
 */

/**
 * 安全提取并可选 normalize 页面 body 全文本。
 *
 * 边界：
 * - 只读取 body 文本内容，不做任何页面交互。
 * - normalize: true（默认）时把连续空白折叠成单个空格并 trim，方便做关键字匹配。
 * - normalize: false 时返回原始 innerText，保留换行格式。
 * - 出错时返回空字符串，不抛异常。
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ normalize?: boolean }} [options={}]
 * @returns {Promise<string>}
 */
async function safeBodyText(page, options = {}) {
  // normalize 默认开启（undefined 视为 true）。
  const normalize = options.normalize !== false;
  const raw = await page.locator('body').innerText().catch(() => '');
  if (!normalize) return String(raw || '');
  // 折叠连续空白后 trim，方便做 ready 文本扫描和正则匹配。
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * 遍历 regex patterns，在 body 全文中做模糊匹配，返回第一个命中结果。
 *
 * 边界：
 * - 只做文本读取和正则匹配，不做任何 DOM 交互。
 * - patterns 中每一项都会被当成正则字符串处理（flags: 'i'，忽略大小写）。
 * - 优先级应低于 selector / text 精确匹配，仅作为 ready 检测兜底层。
 * - 返回统一结构 { ok, source, value }，调用方按 ok 判断是否命中。
 * - patterns 为空时返回 { ok: false, ... }。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string[]} patterns - 正则字符串列表，按优先级排列
 * @returns {Promise<{ ok: boolean, source: string, value: string }>}
 */
async function findBodyPatternReady(page, patterns = []) {
  // 先提取 body 全文（normalize），再做正则匹配，避免每个 pattern 都单独读一次 DOM。
  const bodyText = await safeBodyText(page);
  for (const pattern of patterns) {
    // 每个 pattern 视为正则字符串（i flag 忽略大小写）。
    const regex = new RegExp(String(pattern || ''), 'i');
    if (regex.test(bodyText)) {
      return {
        ok: true,
        source: 'bodyText',
        value: pattern,
      };
    }
  }
  // 所有 pattern 均未命中，返回统一失败结构。
  return {
    ok: false,
    source: '',
    value: '',
  };
}

module.exports = {
  safeBodyText,
  findBodyPatternReady,
};
