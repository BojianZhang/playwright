// 引擎配置字段 schema —— 引擎配置页渲染 + payload 取值的唯一事实源。
// ⚠️ 改这里要同步改 web/engine-schema.js(后端 seed 默认值 + 写入白名单);两份字段 key 与默认值必须一致。
//
// 边界(三方解耦):**引擎配置 = 该引擎"怎么跑"的技术行为**(填卡方式 / 求解 / 换IP / 环境生命周期 / 分流 + 各步转人工)。
//   ↔ 环节策略预设(lib/strategySchema)= 各环节"做什么"的业务参数(Key名/有效期、每卡次数/试卡数、充值金额)。
//   ↔ 全局(控制台 state)= 与引擎无关的运行设置(统一密码/模式/并发/数量/显示浏览器/续跑/拟人)。
//   ↔ 浏览器接管 + 环境来源(控制台 state:browserProvider/envIds/useAdspowerPool)= "这次用哪些资源",留在控制台。
// 默认值严格 = 重构前 ConsolePage 的 py state + card/register 策略里 engine-filtered 字段默认,保证全默认 payload 逐字段一致。

import type { EngineKey, FieldType } from './strategySchema';

export type { EngineKey } from './strategySchema';

export interface EngineField {
  key: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  default: string | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export const ENGINE_LIST: { key: EngineKey; label: string }[] = [
  { key: 'playwright', label: 'Playwright(内置)' },
  { key: 'selenium', label: 'Selenium' },
  { key: 'hybrid', label: '混合' },
  { key: 'split', label: '两套分流' },
];
export const ENGINE_SUBTITLE: Record<EngineKey, string> = {
  playwright: '内置浏览器跑 · 填卡方式 + 各步转人工/选卡/脏IP跳过',
  selenium: 'AdsPower 全流程 · 求解模式 + 加卡超时 + 验证失败换卡 + 环境保留',
  hybrid: 'Playwright 注册 → Selenium 加卡 · Selenium 那套 + 换IP/冷却/重开/手动选卡 + 环境生命周期',
  split: '账号随机分两组,分别走 Selenium / 混合 · 含分流比例',
};

// 各字段(复用重构前的 label/hint/options,只是换了归属位置)。
const F_SOLVE: EngineField = { key: 'solveHcaptcha', label: '遇到人机验证时', hint: '三种都会先免费点一次「I am human」复选框;此项只决定点框过不去(弹真图片挑战)时怎么办', type: 'select', default: 'random', options: [
  { value: 'off', label: '只点选框 · 过不去就换卡(不花 2Captcha)' },
  { value: 'on', label: '点选框 + 2Captcha 硬解(尽量保住这张卡)' },
  { value: 'random', label: '点选框 · 随机:一半硬解 / 一半换卡(默认)' },
] };
const F_DEADLINE: EngineField = { key: 'cardDeadline', label: '加卡超时上限(秒)', hint: '单账号加卡超过就放弃 · 0=不限时', type: 'number', default: '480', min: 0 };
const F_FUTILE: EngineField = { key: 'solveFutileCap', label: '验证失败几次后改换卡', hint: '自动过验证仍卡这么多次→直接换卡', type: 'number', default: '3', min: 0 };
const F_SWAPS: EngineField = { key: 'maxHcaptchaCardSwaps', label: '因人机验证换卡上限', hint: '因反复撞验证而换卡,最多换几张就停', type: 'number', default: '1', min: 0 };
const F_HC_RECHECK: EngineField = { key: 'hcRecheckWait', label: '点框后复检等待(秒)', hint: '点完「I am human」后最多等这么久看框是否消失/绑成,再判过不去换卡;给慢放行的 checkbox 框更多机会(隐形框无效)', type: 'number', default: '5', min: 0, step: 0.5 };
const F_NODEL: EngineField = { key: 'noDeleteEnv', label: '跑完保留环境', hint: '不删除 AdsPower 环境,方便事后检查(平时别开)', type: 'bool', default: false };
const HS_ROTATE: EngineField[] = [
  { key: 'maxRotations', label: '最多换几次 IP', hint: '加卡一直卡住时换几次网络出口再试', type: 'number', default: '3', min: 0 },
  { key: 'cooldownHours', label: '冷却等待(小时)', hint: '换IP还不行后,隔多久再重试该账号', type: 'number', default: '3', min: 0, step: 0.5 },
  { key: 'maxReopen', label: '加卡失败重开次数', hint: '同一环境最多重开几次浏览器补加卡', type: 'number', default: '3', min: 0 },
  { key: 'manualCard', label: '手动选卡', hint: '付款页弹卡池面板手动点选(需开「显示浏览器窗口」)', type: 'bool', default: false },
];
const HS_ENVLIFE: EngineField[] = [
  { key: 'isolate', label: '每账号全新环境', hint: '每个账号用全新环境,失败也删', type: 'bool', default: false },
  { key: 'noGc', label: '开始前不清理残留环境', hint: '跳过启动时自动清理上次没删掉的环境', type: 'bool', default: false },
];

export const ENGINE_FIELDS: Record<EngineKey, EngineField[]> = {
  playwright: [
    { key: 'cardFillEngine', label: '填卡方式', hint: '一般保持「自动」即可,其余为实验项', type: 'select', default: 'playwright', options: [
      { value: 'playwright', label: '自动(推荐,适用绝大多数情况)' }, { value: 'playwright,osinput', label: '自动 → 系统输入(兜底,实验)' },
      { value: 'osinput', label: '系统键盘输入(实验)' }, { value: 'extension', label: '浏览器扩展(需预装,实验)' },
      { value: 'selenium', label: 'Selenium(冗余,实验)' }, { value: 'api', label: 'API 直连(实验)' },
    ] },
    { key: 'manualCaptcha', label: '验证码转人工', hint: '自动解不出时转人工(需开「显示浏览器窗口」)', type: 'bool', default: false },
    { key: 'manualBilling', label: '加卡转人工', hint: '自动加卡没成时转人工(需开「显示浏览器窗口」)', type: 'bool', default: false },
    { key: 'manualCardPick', label: '手动选卡', hint: '付款页弹卡池面板手动点选(需开「显示浏览器窗口」)', type: 'bool', default: false },
    { key: 'skipDirtyIp', label: '高风险网络跳过加卡', hint: '代理/机房类 IP(易被银行拒)时跳过加卡,默认关', type: 'bool', default: false },
  ],
  // 纯 selenium(run.py→pipeline.py)只读 FIXC_SOLVE_HCAPTCHA + FIXC_HC_RECHECK_WAIT(走 fixc_core);
  // cardDeadline/solveFutileCap/maxHcaptchaCardSwaps 仅 hybrid_run.py 读 → 对 selenium 是死字段,不展示。
  selenium: [F_SOLVE, F_HC_RECHECK, F_NODEL],
  hybrid: [F_SOLVE, F_DEADLINE, F_FUTILE, F_SWAPS, F_HC_RECHECK, ...HS_ROTATE, ...HS_ENVLIFE, F_NODEL],
  split: [F_SOLVE, F_DEADLINE, F_FUTILE, F_SWAPS, F_HC_RECHECK, ...HS_ROTATE, ...HS_ENVLIFE, F_NODEL,
    { key: 'splitRatio', label: '两套方案分配比例', hint: '0–1,如 0.5 表示一半 Selenium、一半混合', type: 'number', default: '0.5', min: 0, max: 1, step: 0.1 },
  ],
};

// schema 默认值(用于未加载/缺字段时兜底,等于重构前各引擎默认参数)。
export function engineDefaults(engine: EngineKey): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of ENGINE_FIELDS[engine]) out[f.key] = f.default;
  return out;
}

// 取某引擎"激活预设"的 opts;缺字段用 schema 默认兜底。供 buildPayload/buildRunPayload 取值。
export function engineActiveOpts(
  configs: { engines?: Record<string, { activeId: string; presets: { id: string; opts: Record<string, string | boolean> }[] }> } | undefined,
  engine: EngineKey,
): Record<string, string | boolean> {
  const en = configs?.engines?.[engine];
  const preset = en ? (en.presets.find((p) => p.id === en.activeId) || en.presets[0]) : undefined;
  return { ...engineDefaults(engine), ...(preset?.opts || {}) };
}
