'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Stripe 拒付原因分类(页面拒付文案 → 结构化 decline_code)
//
// 文件定位:Openrouter/0.0.1/billing/decline-classify.js
//
// 背景:系统原来把所有拒付塌成一个 "declined",分不清「卡真没钱(insufficient_funds)」与
//   「环境/风控(do_not_honor / generic_decline)」→ 无法据此走对的恢复流程(没钱该换卡、风控该换IP)。
//
// ★诚实约束:Stripe Radar 风控拦截在页面上几乎只显示通用 "Your card was declined.",文字层面【无法】
//   与普通 generic_decline 区分 → 本函数对这类只给 generic_decline,【绝不】假装识别出 radar_block。
//
// ★必须与 selenium-e2e/common/attribution.py classify_decline 逐枚举同口径(同序同码),
//   改一处必同步另一处(node card-pool.test 与 py test_pipeline_logic 各自有对拍用例)。
// ═══════════════════════════════════════════════════════════════════════

// 匹配顺序【具体 → 通用】:最关键的 insufficient_funds 是很具体的短语,优先且不易误命中。
const DECL_PATTERNS = [
  ['insufficient_funds', /insufficient funds|insufficient balance/i],
  ['incorrect_cvc',      /security code is (?:incorrect|invalid)|incorrect (?:cvc|cvv)|invalid (?:cvc|cvv)/i],
  ['incorrect_number',   /card number is (?:incorrect|invalid)|incorrect card number|invalid card number/i],
  ['expired_card',       /card (?:has )?expired|expired card|card is expired|expired card number/i],
  ['do_not_honor',       /do not honou?r/i],
  ['card_not_supported', /card (?:type )?(?:is )?not supported|your card is not supported/i],
  ['generic_decline',    /card was declined|payment (?:failed|was declined)|could not complete|\bdeclined\b/i],
];

/**
 * 页面拒付文案 → decline_code ∈ insufficient_funds / incorrect_cvc / incorrect_number /
 * expired_card / do_not_honor / card_not_supported / generic_decline;没匹配到拒付返回 ''。
 * @param {string} text
 * @returns {string}
 */
function classifyDecline(text) {
  try {
    const t = String(text == null ? '' : text);
    if (!t) return '';
    for (const [code, rx] of DECL_PATTERNS) { if (rx.test(t)) return code; }
    return '';
  } catch (_e) { return ''; }
}

// 人类可读标签(UI 失败行/恢复弹窗用);未知码原样返回。
const DECLINE_LABEL = {
  insufficient_funds: '余额不足',
  incorrect_cvc: 'CVC 错误',
  incorrect_number: '卡号错误',
  expired_card: '卡已过期',
  do_not_honor: '银行拒付(do_not_honor)',
  card_not_supported: '卡类型不支持',
  generic_decline: '通用拒付(多为风控)',
};

// 是否「卡真没钱/卡本身坏」类(应换卡)vs 环境/风控类(应换IP·换卡再试)。
// insufficient_funds=真没钱;incorrect_*/expired/not_supported=卡本身问题(该卡作废换卡);
// do_not_honor/generic_decline=环境/风控(换IP+换卡争取,非保证)。
function isCardFaultDecline(code) {
  return ['insufficient_funds', 'incorrect_cvc', 'incorrect_number', 'expired_card', 'card_not_supported'].includes(String(code || ''));
}

module.exports = { classifyDecline, DECLINE_LABEL, DECL_PATTERNS, isCardFaultDecline };
