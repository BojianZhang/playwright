// 失败恢复策略字段 schema —— 前端渲染的唯一事实源。
// ⚠️ 改这里要同步改 web/recovery-schema.js(后端 seed 默认值 + 写入白名单 + 生成 GLM_RECOVERY_JSON)。两份 key/默认值必须一致。
//
// 【定位】「失败的账号该怎么自动恢复」按【失败类型】配置。当前可配 = 自动重试(AUTO_RETRY)时各失败类型是否参与重跑,
//   依赖 Stage 1B 写进结果行的 fail_stage(register/key/card/charge)。默认全 'on' = 现状重试所有非永久失败,逐字节等价。
// 【不重复造】换卡张数/ZIP/hcaptcha 已在「高级参数」「引擎配置」里 → 这里只在页面以链接指过去,不抢同一个 env。
// 【铁律·只读展示】歧义态(server-error/card-502/needphone)固定不重绑(RETRY-CARD-01);号被拒/坏邮箱永久跳过 —— 不暴露成开关。

export interface RecoveryField {
  key: string;
  label: string;
  hint?: string;
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}

// 与 PresetEditor 共用:可配的失败类型重试开关
export const RECOVERY_FIELDS: RecoveryField[] = [
  { key: 'retryRegister', label: '注册失败', type: 'select', default: 'on',
    hint: 'FORM_NOT_FILLED / LEGAL / UNCONFIRMED 等注册失败,自动重试时是否重跑',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试(留作人工/换号源)' }] },
  { key: 'retryKey', label: '取 Key 失败', type: 'select', default: 'on',
    hint: 'NEWKEY / WIZARD 取 Key 失败,自动重试时是否重跑',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试' }] },
  { key: 'retryCard', label: '加卡失败(可重试)', type: 'select', default: 'on',
    hint: 'declined / hcaptcha / unknown 等可重试加卡失败;★歧义态(server-error/card-502/needphone)固定不重绑,不受此项影响',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试(避免再烧卡/BIN)' }] },
  { key: 'retryCharge', label: '充值失败', type: 'select', default: 'on',
    hint: '充值 declined / 未确认成功,自动重试时是否重跑(已充成功的永不重扣,与此无关)',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试' }] },
];

export function recoveryDefaults(): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = {};
  for (const f of RECOVERY_FIELDS) o[f.key] = f.default;
  return o;
}

// 固定规则(只读展示,不可配)—— 让用户在一处看到失败恢复的全貌
export const RECOVERY_FIXED_RULES = [
  { label: '加卡歧义态', detail: 'server-error / card-502 / needphone:卡可能已提交 Stripe → 永不自动重绑(RETRY-CARD-01),留人工核验', tone: 'warn' as const },
  { label: '号被拒(NOT_ALLOWED)', detail: 'z.ai 永久拒该号 → 自动登记、永久跳过、不重跑', tone: 'fail' as const },
  { label: '坏邮箱 / 整域不可达', detail: '收不到验证邮件 → 自动登记、跳过,换邮箱源', tone: 'neutral' as const },
];
