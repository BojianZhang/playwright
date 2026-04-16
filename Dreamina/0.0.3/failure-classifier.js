'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— Dreamina/0.0.3
//
// 文件定位：Dreamina/0.0.3/failure-classifier.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 将注册流程失败原因码分类为"代理失败"或"业务失败"。
// ✅ 负责 —— 提供代理热剔除决策依据（isProxyHardFailure → 触发热剔除）。
// ✅ 负责 —— 提供代理惩罚豁免依据（isBusinessFailure → 不惩罚代理）。
// ❌ 不负责 —— 实际的剔除操作（由 Dreamina-batch-runner.js 执行）。
// ❌ 不负责 —— 任何页面操作或 API 调用。
// ❌ 不负责 —— 跨站点通用性（本文件仅对应 Dreamina 平台的失败枚举）。
//
// 调用方：Dreamina/0.0.3/Dreamina-batch-runner.js → processBatchTask
// ═══════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// 代理硬失败枚举（触发热剔除：从运行时池中移除该代理）
//
// 判定原则：
//   - 失败原因明确指向代理网络层（连通性 / TLS / 目标不可达）
//   - 与账号无关，换账号也不会成功
//   - 继续使用该代理只会浪费 Worker 时间
// ─────────────────────────────────────────────────────────────────────────────
const PROXY_HARD_FAILURE_REASONS = new Set([
  // S0 proxy-precheck 探活失败
  'DREAMINA_PROXY_CONNECTIVITY_FAILED',       // TCP 连通失败
  'DREAMINA_PROXY_TARGET_UNREACHABLE',        // 主目标站点不可达
  'DREAMINA_PROXY_TLS_FAILED',               // TLS 握手失败
  'DREAMINA_PROXY_SECONDARY_TARGET_FAILED',  // 副目标也不可达
  'DREAMINA_PROXY_DNS_FAILED',               // DNS 解析失败
  'DREAMINA_PROXY_TIMEOUT',                  // 连通超时

  // S1 entry 页面级网络失败
  'DREAMINA_ENTRY_WHITE_SCREEN',             // Dreamina 首页白屏
  'DREAMINA_ENTRY_DEAD_PAGE',               // Dreamina 首页死页
  'SITE_ENTRY_OPEN_RETRY_EXHAUSTED',         // 多次重试后仍无法打开首页
  'SITE_ENTRY_PAGE_CONTEXT_INVALID',         // page/context 异常，需重建

  // 一般性代理网络失败
  'PROXY_CONNECTIVITY_FAILED',
  'PROXY_TIMEOUT',
]);

// ─────────────────────────────────────────────────────────────────────────────
// 业务失败枚举（不惩罚代理，仅标记账号状态）
//
// 判定原则：
//   - 失败原因指向账号本身（已存在、验证码错误、注册被拒）
//   - 换一条代理也不会成功
//   - 代理本身是健康的，不应扣分或剔除
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_FAILURE_REASONS = new Set([
  // 账号已存在
  'ACCOUNT_ALREADY_EXISTS',
  'ACCOUNT_ALREADY_EXISTS_PRECHECK',
  'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
  'KNOWN_EXISTS_ACCOUNT_SKIPPED',

  // 验证码相关业务失败
  'DREAMINA_VERIFICATION_WRONG_CODE',
  'DREAMINA_VERIFICATION_CODE_RATE_LIMITED',
  'DREAMINA_VERIFICATION_MAX_ATTEMPTS_EXHAUSTED',
  'FIRSTMAIL_API_CODE_TIMEOUT',       // API 拉取超时（可能是邮件未到）
  'FIRSTMAIL_API_CODE_NOT_FOUND',     // 未找到验证码邮件

  // Credential 业务失败
  'DREAMINA_CREDENTIAL_NO_STATE_CHANGE_AFTER_ALL_STRATEGIES',
  'DREAMINA_CREDENTIAL_NO_STATE_CHANGE',

  // 注册主动被拒（账号层面）
  'SIGNUP_REJECTED',
  'SIGNUP_REJECTED_IP_BANNED',        // ← IP 封禁也属业务失败，换账号无效，但换代理可能有效
                                      //   此处保守处理：不惩罚代理，由 proxyHardBlocked 判定
]);

// ─────────────────────────────────────────────────────────────────────────────
// 公共函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断某个失败原因是否属于"代理硬失败"。
 *
 * 代理硬失败 → 触发运行时热剔除（从内存池移除该代理，不再分配给后续任务）。
 *
 * @param {string} reason - 失败原因码（大小写不敏感）
 * @returns {boolean}
 */
function isProxyHardFailure(reason) {
  return PROXY_HARD_FAILURE_REASONS.has(String(reason || '').trim().toUpperCase());
}

/**
 * 判断某个失败原因是否属于"业务失败"。
 *
 * 业务失败 → 不惩罚代理（不扣分、不剔除）。仅标记账号状态。
 *
 * @param {string} reason - 失败原因码（大小写不敏感）
 * @returns {boolean}
 */
function isBusinessFailure(reason) {
  const upper = String(reason || '').trim().toUpperCase();
  return BUSINESS_FAILURE_REASONS.has(upper);
}

/**
 * 综合判断：既不是代理硬失败，也不是已知业务失败 → 视为软失败（代理轻度惩罚）。
 *
 * 软失败场景举例：
 *   - ready signal 缺失但代理连通性正常
 *   - 页面交互超时但非白屏
 *
 * @param {string} reason
 * @returns {boolean}
 */
function isProxySoftFailure(reason) {
  return !isProxyHardFailure(reason) && !isBusinessFailure(reason);
}

/**
 * 返回失败的分类标签，用于日志输出。
 *
 * @param {string} reason
 * @returns {'proxy-hard' | 'business' | 'proxy-soft' | 'unknown'}
 */
function classifyFailure(reason) {
  if (!reason) return 'unknown';
  if (isProxyHardFailure(reason)) return 'proxy-hard';
  if (isBusinessFailure(reason)) return 'business';
  return 'proxy-soft';
}

module.exports = {
  isProxyHardFailure,
  isBusinessFailure,
  isProxySoftFailure,
  classifyFailure,
  PROXY_HARD_FAILURE_REASONS,
  BUSINESS_FAILURE_REASONS,
};
