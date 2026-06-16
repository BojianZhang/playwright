'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-browser-runtime
//
// 文件定位：shared-browser-runtime/resource-policy.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 提供通用的资源拦截策略（拦截 image / media / font 等媒体资源以节省带宽与内存）。
// ❌ 不负责 —— 页面业务逻辑重定向（API route 拦截由具体 stage adapter 控制）。
// ❌ 不负责 —— 浏览器实例的管理。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 归一化被拦截资源类型配置
 *
 * @param {string[]} [input=null]
 * @returns {string[]}
 */
function normalizeBlockedResourceTypes(input = null) {
  return Array.isArray(input)
    ? input.map(item => String(item || '').trim().toLowerCase()).filter(Boolean)
    : ['image', 'media', 'font'];
}

/**
 * 在 Playwright BrowserContext 对象上应用全局路由拦截策略
 * 拦截不需要的媒体资源，加快页面加载极简开销。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string[]} [blockedResourceTypes=[]]
 * @returns {Promise<void>}
 */
async function applyResourcePolicy(context, blockedResourceTypes = []) {
  const blocked = normalizeBlockedResourceTypes(blockedResourceTypes);
  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = String(request.resourceType() || '').trim().toLowerCase();
    if (blocked.includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });
}

module.exports = {
  normalizeBlockedResourceTypes,
  applyResourcePolicy,
};
