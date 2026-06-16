// 环节策略字段 schema —— 前端渲染 + payload 取值的唯一事实源。
// ⚠️ 改这里要同步改 web/strategy-schema.js(后端 seed 默认值 + 写入白名单);两份字段 key 与默认值必须一致。
//
// 边界(三方解耦):这里只放各环节"做什么"的【业务参数】(取Key:名称/有效期;加卡:每卡次数/试卡数;充值:金额)。
//   ↔ "该引擎怎么跑"的技术行为(填卡方式 / 求解 / 换IP / 环境生命周期 / 各步转人工)已迁到【引擎配置】(lib/engineSchema)。
//   ↔ 与引擎无关的全局(密码/并发/数量等)在控制台 state。
//   注册/绑地址/改密无独立业务参数,不做命名预设(注册的"验证码转人工"是 PW 引擎行为,在引擎配置里)。
// engines 缺省=全引擎;列了则只在这些引擎显示并下发(目前业务参数多为 playwright 专用)。
// 默认值严格 = 重构前 ConsolePage 的 useState 初值,保证"全默认预设"跑出的 payload 与重构前逐字段一致。

export type FieldType = 'text' | 'number' | 'select' | 'bool';
export type EngineKey = 'playwright' | 'selenium' | 'hybrid' | 'split';

export interface StrategyField {
  key: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  engines?: EngineKey[];
  default: string | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export const STRATEGY_STAGES = ['key', 'card', 'charge'] as const;
export type PresetStage = typeof STRATEGY_STAGES[number];
export const STAGE_TITLE: Record<PresetStage, string> = { key: '取 API 密钥', card: '加卡', charge: '充值' };

const PW: EngineKey[] = ['playwright'];

export const STRATEGY_SCHEMA: Record<PresetStage, StrategyField[]> = {
  key: [
    { key: 'apiKeyName', label: 'API Key 名称', hint: '留空=随机', type: 'text', default: '', engines: PW },
    { key: 'apiKeyExpiration', label: 'Key 有效期', type: 'select', default: 'No expiration', engines: PW, options: [
      { value: 'No expiration', label: '永不过期' }, { value: '7 days', label: '7 天' }, { value: '30 days', label: '30 天' }, { value: '90 days', label: '90 天' },
    ] },
  ],
  card: [
    { key: 'cardMaxUses', label: '每张卡最大次数', hint: '用尽自动换下一张', type: 'number', default: '10', min: 1 },
    { key: 'maxCardTries', label: '最多试卡数', hint: '被拒自动换下一张', type: 'number', default: '3', min: 1, max: 10, engines: PW },
  ],
  charge: [
    { key: 'topUpAmount', label: '充值金额', hint: '美元 · 最低 5', type: 'number', default: '5', min: 5, step: 1 },
    { key: 'realCharge', label: '真实充值(真扣款)', hint: '关=整批走到充值步但不真点 Purchase(测全流程零成本);开=真扣(受卡容量/同卡并发闸)', type: 'select', default: 'off', options: [
      { value: 'off', label: '关 · 走到充值不真扣(dry-run 测试)' }, { value: 'on', label: '开 · 真实扣款(受卡充值容量闸)' },
    ] },
    { key: 'chargeCount', label: '整批最多真充次数', hint: '安全帽:整批最多真扣 N 次,达 N 就停真扣(其余号到充值步标"测试帽");0=不限', type: 'number', default: '0', min: 0, step: 1 },
  ],
};

// schema 默认值(用于未加载/缺字段时兜底,等于 P1 useState 初值)。
export function stageDefaults(stage: PresetStage): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of STRATEGY_SCHEMA[stage]) out[f.key] = f.default;
  return out;
}

// 取某环节"激活预设"的 opts,按当前引擎过滤;缺字段用 schema 默认兜底。
// 不按"环节是否启用"过滤 —— 与 P1 一致(这些参数一直随 payload 下发,执行与否由 do* 开关控制)。
export function activeOpts(
  strategies: { stages?: Record<string, { activeId: string; presets: { id: string; opts: Record<string, string | boolean> }[] }> } | undefined,
  stage: PresetStage,
  engine: EngineKey,
): Record<string, string | boolean> {
  const fields = STRATEGY_SCHEMA[stage];
  const st = strategies?.stages?.[stage];
  const preset = st ? (st.presets.find((p) => p.id === st.activeId) || st.presets[0]) : undefined;
  const opts = preset?.opts || {};
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    if (f.engines && !f.engines.includes(engine)) continue;
    out[f.key] = (f.key in opts) ? opts[f.key] : f.default;
  }
  return out;
}
