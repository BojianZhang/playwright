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
//
// 【架构演进备注 GAP-3】
//   v0.0.2 中 hardProxyFailureReasons 定义在 config.json（可热修改，无需重启）。
//   当前版本改为硬编码，发现新 reason code 时需改代码并重新部署。
//   演进方向：将此 Set 的初始化包装为 createFailureClassifier(config) 工厂函数，
//   支持从 config.json 扩展枚举，同时保留此处的硬编码值作为内置基线。
//   在实际运行中频繁出现新 reason 时，优先考虑此演进。
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
//
// 【架构演进备注 GAP-3】
//   v0.0.2 中 businessFailureReasons 同样在 config.json 可配置。
//   若新增账号判断逻辑需要临时绕过代理惩罚，当前只能改代码。
//   演进方向同上（createFailureClassifier 工厂）。
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

/**
 * 【EVO-10 / EVO-15】从老架构（v0.0.2）提炼的 reason 标准化工具函数。
 *
 * 支持 "CODE|detail info" 格式的 finalReason：
 *   - code：用于枚举匹配（PROXY_HARD、BUSINESS 等分类判断）
 *   - detail：携带 debug 附件（截图名、错误原文等），不破坏主 code 匹配
 *
 * v0.0.2 原路径：runner.js:normalizeFailureReason() L397-L402
 *
 * @param {string} reason
 * @returns {{ code: string, detail: string }}
 */
function normalizeFailureReason(reason) {
  const raw = String(reason || '');
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx < 0) return { code: raw.trim().toUpperCase(), detail: '' };
  return {
    code: raw.slice(0, pipeIdx).trim().toUpperCase(),
    detail: raw.slice(pipeIdx + 1).trim(),
  };
}
/**
 * 【EXP-3 迁移】从老架构（v0.0.2）提炼的失败阶段推断函数。
 *
 * 根据 finalReason code 推断失败发生在哪个阶段，用于按阶段分析失败分布。
 * v0.0.2 原路径：runner.js:inferFailurePhase()
 *
 * 使用说明：
 *   - 入参为 finalReason 字符串（支持 code|detail 格式，自动取 code 部分）
 *   - 返回阶段标签字符串：precheck / entry / credential / verification / exists / signup / delivery / general
 *   - 不感知 config，为纯函数，可在任意层调用
 *
 * @param {string} reason - finalReason 字符串
 * @returns {string} 阶段标签
 */
function inferFailurePhase(reason = '') {
  const code = String(reason || '').split('|')[0].trim().toUpperCase();
  if (!code) return 'general';
  // 代理预检阶段
  if (/^(PROXY_PRECHECK|PROXY_CONNECT|DREAMINA_PROXY_CONNECTIVITY|PROXY_DNS|PROXY_TLS|PROXY_TIMEOUT|DREAMINA_PROXY_PRECHECK)/i.test(code)) return 'precheck';
  // 页面入口阶段
  if (/^(DREAMINA_ENTRY|DREAMINA_WHITE_SCREEN|DREAMINA_FIRST_LOAD|DREAMINA_OPEN|ENTRY_PAGE|DREAMINA_READY|DREAMINA_HOME|DREAMINA_BROWSER|LOGIN_ENTRY)/i.test(code)) return 'entry';
  // 凭据提交阶段
  if (/^(CREDENTIAL|S2_|DREAMINA_CREDENTIAL|SIGNUP_FORM)/i.test(code)) return 'credential';
  // 验证码阶段
  if (/^(VERIFICATION|FIRSTMAIL|WRONG_VERIFICATION|WRONG_CODE|DREAMINA_VERIFICATION|RATE_LIMITED|CODE_RATE)/i.test(code)) return 'verification';
  // 已存在
  if (/ACCOUNT_ALREADY_EXISTS|ACCOUNT_EXISTS/i.test(code)) return 'exists';
  // 注册被拒
  if (/SIGNUP_REJECTED/i.test(code)) return 'signup';
  // 账号交付/session阶段
  if (/^(S6_|SESSION|DELIVERY|ACCOUNT_DELIVERY|POST_REGISTER|POST_AUTH)/i.test(code)) return 'delivery';
  return 'general';
}

/**
 * 【GAP-3 修复】配置驱动的失败分类器工厂。
 *
 * 设计原则：
 *   - 内置枚举（PROXY_HARD_FAILURE_REASONS / BUSINESS_FAILURE_REASONS）作为不可删除的基线。
 *   - config.json 通过 failureClassifier 节追加或覆盖，无需修改代码。
 *   - reasonOverrides 优先级最高，用于处理"某个 reason 在内置枚举中分类不准确"的临时修正。
 *
 * config.json failureClassifier 节示例：
 * ```json
 * "failureClassifier": {
 *   "_comment": "失败原因分类扩展（追加到内置枚举，不替换）",
 *   "proxyHardReasons": ["MY_CUSTOM_PROXY_FAIL"],
 *   "businessReasons": ["MY_CUSTOM_BUSINESS_FAIL"],
 *   "reasonOverrides": {
 *     "SOME_AMBIGUOUS_REASON": "business"
 *   }
 * }
 * ```
 *
 * @param {object} [config={}] - 来自 loadBatchConfig() 的 config 对象
 * @returns {{ isProxyHardFailure, isBusinessFailure, isProxySoftFailure, classifyFailure }}
 */
function createFailureClassifier(config = {}) {
  const ext = config?.failureClassifier || {};

  // 合并内置基线 + config 追加
  const hardSet = new Set([
    ...PROXY_HARD_FAILURE_REASONS,
    ...((Array.isArray(ext.proxyHardReasons) ? ext.proxyHardReasons : []).map(r => String(r).trim().toUpperCase())),
  ]);
  const bizSet = new Set([
    ...BUSINESS_FAILURE_REASONS,
    ...((Array.isArray(ext.businessReasons) ? ext.businessReasons : []).map(r => String(r).trim().toUpperCase())),
  ]);

  // reasonOverrides: { 'REASON_CODE': 'proxy-hard' | 'business' | 'proxy-soft' }
  const overrides = {};
  if (ext.reasonOverrides && typeof ext.reasonOverrides === 'object') {
    for (const [k, v] of Object.entries(ext.reasonOverrides)) {
      overrides[String(k).trim().toUpperCase()] = String(v || '').trim().toLowerCase();
    }
  }

  function resolve(reason) {
    const upper = String(reason || '').trim().toUpperCase();
    if (!upper) return 'unknown';
    if (overrides[upper]) return overrides[upper];
    if (hardSet.has(upper)) return 'proxy-hard';
    if (bizSet.has(upper)) return 'business';
    return 'proxy-soft';
  }

  return {
    isProxyHardFailure: (reason) => resolve(reason) === 'proxy-hard',
    isBusinessFailure: (reason) => resolve(reason) === 'business',
    isProxySoftFailure: (reason) => resolve(reason) === 'proxy-soft',
    classifyFailure: (reason) => resolve(reason) || 'unknown',
  };
}


// ═══════════════════════════════════════════════════════════════════════
// 决策型失败谓词（DECISION PREDICATES）— 从 0.0.3 Dreamina-batch-runner.js 内联迁入
//
// 说明：以下 6 个谓词原内联在 batch-runner 巨石中（6 处散落）。它们与上方
// failure-classifier 的「粗粒度分类」职责不同——分别驱动【不同决策点】：
//   · isExistsBusinessFailure        → existsCount 统计 / 账号迁移
//   · isTerminalBusinessFailure      → 是否终止「换代理重试」循环
//   · isRetryableProxyOrEnvironmentFailure / shouldRetryAccountWithNextProxy → 是否换代理再试
//   · isBlacklistFailure             → 是否写 account-state/blacklisted-accounts.json
//   · isAccountRetryFailure          → 是否写 account-state/retry-accounts.json
// 这些谓词【刻意保持独立】（原注释明确「职责不同，不应合并」），本次只把它们
// 与 failure-classifier 收口到【同一文件 failure-policy.js】，作为失败策略单一来源，
// 不改变任何判定逻辑（逐字节迁移）。
// ═══════════════════════════════════════════════════════════════════════
/**
 * 判断结果是否属于“账号已存在”类失败（用于 bucket 分类和账号迁移）。
 *
 * 与 failure-classifier.js 的关系：
 *   - failure-classifier.isBusinessFailure() 覆盖更宽的业务失败枚举（含验证码、凭据等）。
 *   - 本处仅关注“账号已存在”这一特定子集，驱动 existsCount 统计和账号迁移。
 *   - 两者职责不同，不应合并。
 */
function isExistsBusinessFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim();
  return [
    'DREAMINA_ACCOUNT_ALREADY_EXISTS',
    'ACCOUNT_ALREADY_EXISTS',
    'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
    'ACCOUNT_ALREADY_EXISTS_PRECHECK',
  ].includes(reason);
}

/**
 * 判断结果是否属于“终止型业务失败”（不应换代理重试）。
 *
 * 与 failure-classifier.js 的关系：
 *   - failure-classifier.isBusinessFailure() 判断是否免于代理惩罚；本函数判断是否应终止重试循环。
 *   - 如需新增“终止型”原因码，请同步评估 failure-classifier.BUSINESS_FAILURE_REASONS 是否需要同步。
 */
function isTerminalBusinessFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim();
  return [
    'DREAMINA_ACCOUNT_ALREADY_EXISTS',
    'ACCOUNT_ALREADY_EXISTS',
    'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
    'ACCOUNT_ALREADY_EXISTS_PRECHECK',
    'SIGNUP_REJECTED',
    'DREAMINA_SIGNUP_REJECTED',
    'SIGNUP_REJECTED_IP_BANNED',
    'DREAMINA_SIGNUP_REJECTED_IP_BANNED',
    'VERIFICATION_CODE_RATE_LIMITED',
    'DREAMINA_VERIFICATION_CODE_RATE_LIMITED',
    'KNOWN_EXISTS_ACCOUNT_SKIPPED',
  ].includes(reason);
}

/**
 * 判断结果是否属于“可换代理重试”类失败（D6 关系说明）。
 *
 * 与 failure-classifier.js 的关系：
 *   - failure-classifier.isProxyHardFailure() 判断代理是否应被热剥撤（粗粒度）。
 *   - 本函数判断是否値得换一条代理再次尝试同一账号（重试策略决策）。
 *   - 两者枚举集合部分重叠但语义不同，不应合并。
 *   - 维护时如需新增可重试原因码，请同步检查 failure-classifier.PROXY_HARD_FAILURE_REASONS 是否需要同步。
 */
function isRetryableProxyOrEnvironmentFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim();
  if (!reason) return false;
  if (isTerminalBusinessFailure(result)) return false;
  return [
    'DREAMINA_PROXY_CONNECTIVITY_FAILED',
    'PROXY_CONNECTIVITY_FAILED',
    'DREAMINA_PROXY_PRECHECK_BAD',
    'PROXY_PRECHECK_BAD',
    'DREAMINA_BROWSER_SMOKE_BLANK_PAGE',
    'DREAMINA_BROWSER_SMOKE_FAILED',
    'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT',
    'ENTRY_PAGE_OPEN_FAILED',
    'DREAMINA_ENTRY_PAGE_OPEN_FAILED',
    'DREAMINA_WHITE_SCREEN',
    'DREAMINA_FIRST_LOAD_DEAD_PAGE',
    'DREAMINA_READY_SIGNAL_MISSING',
    'DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY',
    'DREAMINA_LOGIN_ENTRY_NOT_FOUND',
    'LOGIN_ENTRY_FAILED',
    'LOGIN_ENTRY_CLICK_NO_STATE_CHANGE',
  ].includes(reason);
}

function shouldRetryAccountWithNextProxy(result = {}, attempt = 1, batchContext = {}) {
  const maxAttempts = Math.max(1, Number(batchContext?.config?.maxProxyRetriesPerAccount || 2));
  if (attempt >= maxAttempts) return false;
  return isRetryableProxyOrEnvironmentFailure(result);
}

/**
 * 判断是否属于「黑名单硬失败」——账号不应再被重试。
 * 对应 account-state/blacklisted-accounts.json 写入条件。
 */
function isBlacklistFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim().toUpperCase();
  return [
    'SIGNUP_REJECTED',
    'DREAMINA_SIGNUP_REJECTED',
    'SIGNUP_REJECTED_IP_BANNED',
    'DREAMINA_SIGNUP_REJECTED_IP_BANNED',
    'VERIFICATION_CODE_RATE_LIMITED',
    'DREAMINA_VERIFICATION_CODE_RATE_LIMITED',
  ].some(function(k) { return reason === k || reason.startsWith(k); });
}

/**
 * 判断是否属于「软失败可重试」——由偶发网络/代理/页面环境引起，可放回待跑队列。
 * 对应 account-state/retry-accounts.json 写入条件。
 */
function isAccountRetryFailure(result = {}) {
  if (isBlacklistFailure(result)) return false;
  if (isTerminalBusinessFailure(result)) return false;
  const reason = String(result?.finalReason || result?.finalState || '').trim().toUpperCase();
  return [
    'DREAMINA_PROXY_CONNECTIVITY_FAILED',
    'PROXY_CONNECTIVITY_FAILED',
    'DREAMINA_PROXY_PRECHECK_BAD',
    'PROXY_PRECHECK_BAD',
    'DREAMINA_BROWSER_SMOKE_BLANK_PAGE',
    'DREAMINA_BROWSER_SMOKE_FAILED',
    'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT',
    'ENTRY_PAGE_OPEN_FAILED',
    'DREAMINA_ENTRY_PAGE_OPEN_FAILED',
    'DREAMINA_WHITE_SCREEN',
    'DREAMINA_FIRST_LOAD_DEAD_PAGE',
    'DREAMINA_READY_SIGNAL_MISSING',
    'DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY',
    'DREAMINA_LOGIN_ENTRY_NOT_FOUND',
    'LOGIN_ENTRY_FAILED',
    'LOGIN_ENTRY_CLICK_NO_STATE_CHANGE',
    'DREAMINA_CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
    'CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
  ].includes(reason);
}

module.exports = {
  // —— 粗粒度分类（原 failure-classifier.js）——
  isProxyHardFailure,
  isBusinessFailure,
  isProxySoftFailure,
  classifyFailure,
  normalizeFailureReason,
  inferFailurePhase,
  PROXY_HARD_FAILURE_REASONS,
  BUSINESS_FAILURE_REASONS,
  createFailureClassifier,
  // —— 决策型谓词（原 batch-runner 内联）——
  isExistsBusinessFailure,
  isTerminalBusinessFailure,
  isRetryableProxyOrEnvironmentFailure,
  shouldRetryAccountWithNextProxy,
  isBlacklistFailure,
  isAccountRetryFailure,
};
