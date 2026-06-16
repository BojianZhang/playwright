// 失败恢复策略字段 schema —— 前端渲染的唯一事实源。
// ⚠️ 改这里要同步改 web/recovery-schema.js(后端 seed 默认值 + 写入白名单 + 生成 OPENROUTER_RECOVERY_JSON)。两份 key/默认值必须一致。
//
// 【定位】「失败的账号该怎么自动恢复」按【失败类型】配置。当前可配 = 自动重试(AUTO_RETRY)时各失败类型是否参与重跑,
//   依赖 Stage 1B 写进结果行的 fail_stage(register/key/card/charge)。默认全 'on' = 现状重试所有非永久失败,逐字节等价。
// 【不重复造】换卡张数/ZIP/hcaptcha 已在「高级参数」「引擎配置」里 → 这里只在页面以链接指过去,不抢同一个 env。
// 【铁律·只读展示】歧义态(server-error/card-502/needphone)固定不重绑(RETRY-CARD-01);号被拒/坏邮箱永久跳过 —— 不暴露成开关。

export interface RecoveryField {
  key: string;
  label: string;
  hint?: string;
  type: 'select' | 'number';
  options?: { value: string; label: string }[];
  default: string;
  min?: number;
  max?: number;
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

// ★恢复【动作】字段(与上面 RECOVERY_FIELDS 重试参与度正交)—— 与 web/recovery-schema.js ACTION_FIELDS 同步。
//   这些经 recoveryResumeOptions() → 批量恢复 recoverOptions → 后端 buildEnv 已有 env 映射,不进 OPENROUTER_RECOVERY_JSON。
//   默认全 '' = 不注入 = 与现状逐字节等价。swapOnHcaptcha 三态('' 继承源/全局)。
export const RECOVERY_ACTION_FIELDS: RecoveryField[] = [
  { key: 'ipRounds', label: '换 IP 重试轮数', type: 'number', default: '', min: 0, max: 5,
    hint: '自动重试失败号 N 轮,每轮换出口 IP(declined 多为环境/风控 → 换 IP 是最安全的恢复杠杆)。空=不开自动重试' },
  { key: 'zipRetry', label: 'ZIP 重试次数', type: 'number', default: '', min: 0, max: 12,
    hint: '加卡/充值 declined 多为 AVS/ZIP 不匹配 → 同卡换 ZIP 重试几次(免税州 ZIP)。空=用引擎默认' },
  { key: 'cardStrategy', label: '换卡策略', type: 'select', default: '',
    hint: '重跑【未绑卡】号时如何选卡;★已绑卡的号续跑复用原卡,此项对它无效',
    options: [{ value: '', label: '不指定(用引擎默认)' }, { value: 'spread', label: 'spread 摊开(每号尽量不同卡/BIN)' }, { value: 'random', label: 'random 随机' }, { value: 'concentrate', label: 'concentrate 集中(灌同一张测容量)' }] },
  { key: 'swapOnHcaptcha', label: '人机验证时换卡', type: 'select', default: '',
    hint: 'hCaptcha 隐形企业框硬解常无效 → 过不去就换卡(swap)。空=继承源/全局,不强制改',
    options: [{ value: '', label: '继承源/全局(默认)' }, { value: 'on', label: '开:过不去换卡(swap)' }, { value: 'off', label: '关:不换卡' }] },
];

// 失败恢复策略编辑器的完整字段集(重试参与度 + 恢复动作)
export const RECOVERY_ALL_FIELDS: RecoveryField[] = [...RECOVERY_FIELDS, ...RECOVERY_ACTION_FIELDS];

export function recoveryDefaults(): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = {};
  for (const f of RECOVERY_ALL_FIELDS) o[f.key] = f.default;
  return o;
}

// 把恢复方案的【动作】字段 → 批量恢复 recoverOptions。与 web/recovery-schema.js recoveryResumeOptions 逐字段一致。
//   空串/未设 = 省略该键(= 不注入 → 默认行为不变)。
export interface RecoverOptions { autoRetryFailed?: boolean; autoRetryTimes?: number; zipRetry?: number; cardStrategy?: string; solveHcaptcha?: string }
export function recoveryResumeOptions(opts: Record<string, string | boolean> | undefined): RecoverOptions {
  const o = opts || {};
  const out: RecoverOptions = {};
  const ip = Number(o.ipRounds);
  if (o.ipRounds !== undefined && String(o.ipRounds).trim() !== '' && Number.isFinite(ip) && ip > 0) { out.autoRetryFailed = true; out.autoRetryTimes = Math.min(ip, 5); }
  const z = Number(o.zipRetry);
  if (o.zipRetry !== undefined && String(o.zipRetry).trim() !== '' && Number.isFinite(z) && z >= 0) out.zipRetry = z;
  if (['random', 'spread', 'concentrate'].includes(String(o.cardStrategy))) out.cardStrategy = String(o.cardStrategy);
  if (String(o.swapOnHcaptcha) === 'on') out.solveHcaptcha = 'swap';
  return out;
}

// 固定规则(只读展示,不可配)—— 让用户在一处看到失败恢复的全貌
export const RECOVERY_FIXED_RULES = [
  { label: '加卡歧义态', detail: 'server-error / card-502 / needphone:卡可能已提交 Stripe → 永不自动重绑(RETRY-CARD-01),留人工核验', tone: 'warn' as const },
  { label: '号被拒(NOT_ALLOWED)', detail: 'OpenRouter 永久拒该号 → 自动登记、永久跳过、不重跑', tone: 'fail' as const },
  { label: '坏邮箱 / 整域不可达', detail: '收不到验证邮件 → 自动登记、跳过,换邮箱源', tone: 'neutral' as const },
];
