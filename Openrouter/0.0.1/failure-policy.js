'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / failure-policy（错误 → 恢复动作 路由策略）
//
// 文件定位：Openrouter/0.0.1/failure-policy.js
//
// 用途：把每个阶段的失败原因映射成一条「恢复动作」，让重试循环按错路由，
//       而不是整批换浏览器从头重来。配合断点续跑：重试会自动跳过已完成阶段。
//
// 动作：
//   retry            —— 同代理重试（瞬时 UI/读信类错误）
//   retry-new-proxy  —— 换一个代理再试（代理/Turnstile/连通性）
//   relogin          —— 下次尝试强制登录模式（会话失效；续跑跳过已完成阶段）
//   blacklist        —— 拉黑账号，永不重试（账号锁定/不允许/已存在）
//   abort            —— 放弃该账号（未知/无法自愈，如硬模式账单失败）
//
// 纯模块（无副作用、无 IO），便于单测穷举。
// ═══════════════════════════════════════════════════════════════════════

// 精确表：错误码 → { action, maxRetries }。maxRetries 是该动作的内层预算
// （全局还有 maxAttempts 硬顶兜底）。
const TABLE = {
  // 代理 / Turnstile / 连通性 / 浏览器启动 —— 换代理重试
  PROXY_CONNECTIVITY_FAILED: { action: 'retry-new-proxy', maxRetries: 3 },
  OPENROUTER_HOME_UNREACHABLE: { action: 'retry-new-proxy', maxRetries: 3 },
  PROXY_PRECHECK_BAD: { action: 'retry-new-proxy', maxRetries: 3 },
  TURNSTILE_FAILED: { action: 'retry-new-proxy', maxRetries: 3 },
  TURNSTILE_CALLBACK_MISSING: { action: 'retry-new-proxy', maxRetries: 3 },
  BROWSER_LAUNCH_FAILED: { action: 'retry-new-proxy', maxRetries: 3 },

  // 会话失效 / 登录失败 —— 重新登录
  API_KEY_NOT_LOGGED_IN: { action: 'relogin', maxRetries: 2 },
  SIGNIN_FAILED: { action: 'relogin', maxRetries: 2 },
  LOGIN_NOT_CONFIRMED: { action: 'relogin', maxRetries: 2 },

  // 取Key UI / 注册结果未知 / 邮箱链接读取 —— 同代理重试
  API_KEY_MODAL_NOT_OPEN: { action: 'retry', maxRetries: 2 },
  API_KEY_NOT_CAPTURED: { action: 'retry', maxRetries: 2 },
  API_KEY_CAPTURE_FAILED: { action: 'retry', maxRetries: 2 },
  REGISTER_NO_VERIFY_PAGE: { action: 'retry', maxRetries: 2 },
  REGISTER_SUBMIT_RESULT_UNKNOWN: { action: 'retry', maxRetries: 2 },
  MAGIC_LINK_EMAIL_NOT_FOUND: { action: 'retry', maxRetries: 2 },
  MAGIC_LINK_LOGIN_UNCONFIRMED: { action: 'retry', maxRetries: 2 },
  VERIFY_LINK_NOT_FOUND: { action: 'retry', maxRetries: 2 },

  // 永久性账号问题 —— 拉黑，永不重试
  ACCOUNT_LOCKED: { action: 'blacklist', maxRetries: 0 },
  ACCOUNT_NOT_ALLOWED: { action: 'blacklist', maxRetries: 0 },
  ACCOUNT_ALREADY_EXISTS: { action: 'blacklist', maxRetries: 0 },

  // 硬模式账单失败 —— 放弃（换卡是 billing 阶段内的事，换浏览器治不了被拒卡）
  BILLING_FAILED: { action: 'abort', maxRetries: 0 },
  // declined 换够卡仍全被拒 —— 疑 IP/AVS 风控。env-pool 模式由 job-runner@388 抢先 env-rotate;
  // 原生(无 env-pool)模式落到这里→换代理换 IP 重试。maxRetries 对齐 MAX_CARD_SWAPS 默认 2。
  BILLING_DECLINED_EXHAUSTED: { action: 'retry-new-proxy', maxRetries: 2 },
};

// 正则兜底：抛异常的阶段把原始报错文本放进 reason（非 *_THREW 码），精确表会漏。
const REGEX_FALLBACK = [
  { re: /PROXY|UNREACHABLE|TURNSTILE|CONNECT|ECONN|ETIMEDOUT|TIMEOUT|NET::/i, action: 'retry-new-proxy', maxRetries: 3 },
  { re: /NOT_LOGGED_IN|SIGNIN|LOGIN/i, action: 'relogin', maxRetries: 2 },
  { re: /LOCKED|NOT_ALLOWED|ALREADY_EXISTS|BANNED|SUSPENDED/i, action: 'blacklist', maxRetries: 0 },
  { re: /THREW|UNKNOWN|MODAL|CAPTURE|VERIFY|MAGIC_LINK|TIMEOUT/i, action: 'retry', maxRetries: 2 },
];

const DEFAULT = { action: 'abort', maxRetries: 0 };

// 允许的动作（单一来源；server 校验、UI 下拉都复用）。
const ACTIONS = ['retry', 'retry-new-proxy', 'relogin', 'blacklist', 'abort'];

// 错误目录：每个码的中文说明（是什么/为什么报/在哪个阶段），供弹框展示。
// 末尾 4 个 _FALLBACK_* + _DEFAULT 是「抛异常的原始文本按关键字归类」的兜底桶。
const CATALOG = {
  PROXY_CONNECTIVITY_FAILED: { stage: '代理预检', why: '代理连通性预检失败（连不上代理/出网异常）' },
  OPENROUTER_HOME_UNREACHABLE: { stage: '代理预检', why: '经该代理打不开 OpenRouter 首页（线路被墙/超时）' },
  PROXY_PRECHECK_BAD: { stage: '代理预检', why: '代理预检不合格（出口 IP 风险/响应异常）' },
  TURNSTILE_FAILED: { stage: '注册/登录', why: 'Turnstile 人机验证未通过' },
  TURNSTILE_CALLBACK_MISSING: { stage: '注册/登录', why: 'Turnstile 回调 token 未注入页面' },
  BROWSER_LAUNCH_FAILED: { stage: '启动', why: '浏览器启动失败（环境/显示器/资源）' },
  API_KEY_NOT_LOGGED_IN: { stage: '取Key', why: '取 Key 时发现未登录（会话失效）' },
  SIGNIN_FAILED: { stage: '登录', why: '登录提交失败' },
  LOGIN_NOT_CONFIRMED: { stage: '登录', why: '登录后未确认进入已登录态' },
  API_KEY_MODAL_NOT_OPEN: { stage: '取Key', why: '创建 Key 弹窗未打开（UI 时序）' },
  API_KEY_NOT_CAPTURED: { stage: '取Key', why: 'Key 创建后未捕获到明文' },
  API_KEY_CAPTURE_FAILED: { stage: '取Key', why: '抓取 Key 过程异常' },
  REGISTER_NO_VERIFY_PAGE: { stage: '注册', why: '注册后未跳到「查收验证邮件」页' },
  REGISTER_SUBMIT_RESULT_UNKNOWN: { stage: '注册', why: '注册提交后结果不确定（续跑去重兜底）' },
  MAGIC_LINK_EMAIL_NOT_FOUND: { stage: '邮箱验证', why: '邮箱里没找到登录魔法链接邮件' },
  MAGIC_LINK_LOGIN_UNCONFIRMED: { stage: '邮箱验证', why: '点了魔法链接但未确认登录成功' },
  VERIFY_LINK_NOT_FOUND: { stage: '邮箱验证', why: '验证邮件里没找到验证链接' },
  ACCOUNT_LOCKED: { stage: '账号', why: '账号被锁定' },
  ACCOUNT_NOT_ALLOWED: { stage: '账号', why: '账号不被允许（地区/风控）' },
  ACCOUNT_ALREADY_EXISTS: { stage: '账号', why: '账号已存在（如需续跑改「仅登录」模式）' },
  BILLING_FAILED: { stage: '账单', why: '账单/充值硬失败（卡被拒等，换浏览器治不了）' },
  BILLING_DECLINED_EXHAUSTED: { stage: '账单', why: '换够卡仍全被拒(疑IP/AVS风控) → 换干净环境/代理(新IP)重试' },
  _FALLBACK_PROXY: { stage: '兜底', why: '原始报错含 PROXY/UNREACHABLE/TURNSTILE/CONNECT/TIMEOUT → 按代理类处理' },
  _FALLBACK_RELOGIN: { stage: '兜底', why: '原始报错含 NOT_LOGGED_IN/SIGNIN/LOGIN → 按会话失效处理' },
  _FALLBACK_BLACKLIST: { stage: '兜底', why: '原始报错含 LOCKED/NOT_ALLOWED/ALREADY_EXISTS/BANNED → 按永久问题处理' },
  _FALLBACK_RETRY: { stage: '兜底', why: '原始报错含 THREW/UNKNOWN/MODAL/CAPTURE/VERIFY 等 → 按瞬时错误处理' },
  _DEFAULT: { stage: '兜底', why: '以上都不匹配的未知报错文本 → 放弃，需人工查看' },
};

// 覆盖表来源（用户在 UI 配的）。守护式 require：缺文件/未建库时退化为「无覆盖」，
// 保证 failure-policy 纯逻辑可单测、不依赖磁盘。
let policyStore;
try { policyStore = require('./account-state/policy-store'); }
catch (_e) { policyStore = { getOverrides: () => ({}) }; }

/**
 * 内置分类（不含用户覆盖）—— 纯逻辑，供穷举单测。
 * @param {string} reason
 * @returns {{action: string, maxRetries: number}}
 */
function classifyBuiltin(reason) {
  const r = String(reason || '').trim();
  if (TABLE[r]) return { ...TABLE[r] };
  for (const f of REGEX_FALLBACK) {
    if (f.re.test(r)) return { action: f.action, maxRetries: f.maxRetries };
  }
  return { ...DEFAULT };
}

/**
 * 把失败原因分类成恢复动作：用户覆盖优先（合法才生效），否则走内置。
 * 同步、无 IO —— 在重试热路径每次调用。
 * @param {string} reason
 * @returns {{action: string, maxRetries: number}}
 */
function classify(reason) {
  const r = String(reason || '').trim();
  const ov = policyStore.getOverrides();
  const o = ov && ov[r];
  if (o && ACTIONS.includes(o.action)) return { action: o.action, maxRetries: Number(o.maxRetries) || 0 };
  return classifyBuiltin(r);
}

/**
 * 给 UI 用的「生效策略」全表：每个码的说明 + 内置 + 覆盖 + 当前生效。
 * @returns {Array<object>}
 */
function effectivePolicy() {
  const ov = policyStore.getOverrides() || {};
  return Object.keys(CATALOG).map((code) => {
    const builtin = TABLE[code] || DEFAULT;
    const override = (ov[code] && ACTIONS.includes(ov[code].action)) ? ov[code] : null;
    const settable = !code.startsWith('_'); // 兜底桶/默认不可单独配置
    return { code, ...CATALOG[code], settable, builtin, override, effective: override || builtin };
  });
}

module.exports = {
  classify, classifyBuiltin, effectivePolicy,
  ACTIONS, CATALOG, _TABLE: TABLE, _DEFAULT: DEFAULT,
};
