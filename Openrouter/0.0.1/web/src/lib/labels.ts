// 前端共享标签【单一来源】—— 杜绝同一常量在多处定义、值还不一致(审计:ENGINE_LABEL 的 split 曾有 '两引擎'/'两引擎随机'/'两套分流' 三版;
// DECLINE_LABEL 在 panels/RunDetail/Diagnose 三处各一份)。后端口径见 web/engine-schema.js / billing/decline-classify.js。
// 各 feature/page 一律从这里 import,需要时再 re-export(保持既有 `from '../features/runs'` 等导入路径不变)。

// 引擎名:split 统一用 '两套分流'(与 ENGINE_LIST / lib/engineSchema 一致)。
export const ENGINE_LABEL: Record<string, string> = { playwright: 'Playwright', selenium: 'Selenium', hybrid: '混合', split: '两套分流' };

// 计费动作(控制台/运行历史)。
export const BILLING_ACTION_LABEL: Record<string, string> = { none: '仅取Key', address: '绑地址', card: '加卡', charge: '充值' };

// Stripe 拒付原因(与 billing/decline-classify.js DECLINE_LABEL 同义,改一处两端都要同步)。
export const DECLINE_LABEL: Record<string, string> = {
  insufficient_funds: '余额不足', incorrect_cvc: 'CVC错误', incorrect_number: '卡号错误',
  expired_card: '卡已过期', do_not_honor: '银行拒付', card_not_supported: '卡不支持', generic_decline: '通用拒付(多为风控)',
};

// 适用范围(元素维护 / 高级参数共用):原来 selectorsSchema 与 advancedSchema 各定义一份同值的 label+color → 易漂移。
export const SCOPE_LABEL: Record<string, string> = { selenium: '纯Selenium', hybrid: '混合', both: '两套共用' };
export const SCOPE_COLOR: Record<string, string> = { selenium: '#2563eb', hybrid: '#7c3aed', both: '#0d9488' };
