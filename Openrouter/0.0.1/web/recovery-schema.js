'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 失败恢复策略 schema(单一来源·后端) — Openrouter / web / recovery-schema.js
//
// ⚠️ 这是 src/lib/recoverySchema.ts 的后端镜像。改前端 schema 的 key / 默认值时,务必同步这里。
//
// 【定位】「失败的账号该怎么自动恢复」按【失败类型】配置 —— 当前可配的是【自动重试时各失败类型是否参与重跑】
//   (run.py 的 AUTO_RETRY_FAILED 循环消费,依赖 Stage 1B 写进结果行的 fail_stage 按类型决策)。
// 【为什么只配重试参与度,不配换卡张数/ZIP/hcaptcha】那些旋钮已在【高级参数】(CARD_SWAP_ON_DECLINE/ZIP_RETRY)
//   和【引擎配置】(solveHcaptcha)里,这里【不重复造、不抢同一个 env】,只在页面上以链接指过去 → 失败恢复中心一处看全。
// 【铁律】歧义态(server-error/card-502/needphone)永远【不自动重绑】(RETRY-CARD-01),号被拒/坏邮箱永久跳过 ——
//   这两类【固定 giveup、不可配】,页面只读展示,绝不暴露成"可重试"开关。
//
// 默认全 'on' = 现状「自动重试重跑所有非永久失败」逐字节等价。空配置 / 解析失败 → Python 也退默认全重试。
// ═══════════════════════════════════════════════════════════════════════

// 可配置的失败类型(与 fail_stage 对齐):每类一个「自动重试是否参与」开关。
//   card 仅指【可重试的加卡失败】(declined/hcaptcha/unknown);歧义态已被 run.py 计完成不在此列。
const FIELDS = [
  { key: 'retryRegister', failStage: 'register', label: '注册失败', type: 'select', def: 'on',
    hint: 'FORM_NOT_FILLED / LEGAL / UNCONFIRMED 等注册阶段失败,自动重试时是否重跑',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试(留作人工/换号源)' }] },
  { key: 'retryKey', failStage: 'key', label: '取 Key 失败', type: 'select', def: 'on',
    hint: 'NEWKEY / WIZARD 取 Key 失败,自动重试时是否重跑',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试' }] },
  { key: 'retryCard', failStage: 'card', label: '加卡失败(可重试)', type: 'select', def: 'on',
    hint: '加卡被拒 declined / 人机验证 hcaptcha / 检测不到 unknown 等【可重试】加卡失败;★歧义态(server-error/card-502/needphone)固定不重绑,不受此项影响',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试(避免再烧卡/BIN)' }] },
  { key: 'retryCharge', failStage: 'charge', label: '充值失败', type: 'select', def: 'on',
    hint: '充值 declined / 未确认成功,自动重试时是否重跑(已充成功的永不重扣,与此无关)',
    options: [{ value: 'on', label: '参与重试(默认)' }, { value: 'off', label: '不重试' }] },
];

// ─────────────────────────────────────────────────────────────────────────
// ★恢复【动作】字段(Stage:失败恢复方案)—— 与上面 FIELDS(重试参与度)正交。
//   FIELDS = 运行期 AUTO_RETRY「某失败类型要不要重跑」(→ OPENROUTER_RECOVERY_JSON);
//   ACTION_FIELDS = 续跑/批量恢复时「这套流程怎么重跑」(换IP轮数/ZIP/换卡策略/人机换卡),
//   经 recoveryResumeOptions() → recoverOptions → server.js 白名单 → buildEnv 已有的 env 映射
//   (CARD_STRATEGY/ZIP_RETRY/AUTO_RETRY_*/FIXC_SOLVE_HCAPTCHA),【不】塞进 recovery JSON。
//
// ★★铁律:ACTION_FIELDS 绝不并入 FIELDS —— 否则会泄漏进 OPENROUTER_RECOVERY_JSON 破坏逐字节不变。
//   recoveryEnvJson 永远只遍历 FIELDS;动作字段只经 recoveryResumeOptions 流出。
//   默认全 '' = 不注入任何动作 = 与现状弹窗(旋钮归零)逐字节等价。swapOnHcaptcha 必须三态
//   (''=继承源/全局,不能用 bool 否则会强制 off → 回归把源批的 swap 关掉)。
const ACTION_FIELDS = [
  { key: 'ipRounds', label: '换 IP 重试轮数', type: 'number', def: '', min: 0, max: 5,
    hint: '自动重试失败号 N 轮,每轮换出口 IP(declined 多为环境/风控 → 换 IP 是最安全的恢复杠杆)。空=不开自动重试' },
  { key: 'zipRetry', label: 'ZIP 重试次数', type: 'number', def: '', min: 0, max: 12,
    hint: '加卡/充值 declined 多为 AVS/ZIP 不匹配 → 同卡换 ZIP 重试几次(免税州 ZIP)。空=用引擎默认' },
  { key: 'cardStrategy', label: '换卡策略', type: 'select', def: '',
    hint: '重跑【未绑卡】号时如何选卡;★已绑卡的号续跑复用原卡,此项对它无效',
    options: [{ value: '', label: '不指定(用引擎默认)' }, { value: 'spread', label: 'spread 摊开(每号尽量不同卡/BIN)' }, { value: 'random', label: 'random 随机' }, { value: 'concentrate', label: 'concentrate 集中(灌同一张测容量)' }] },
  { key: 'swapOnHcaptcha', label: '人机验证时换卡', type: 'select', def: '',
    hint: 'hCaptcha 隐形企业框硬解常无效 → 过不去就换卡(swap)。空=继承源/全局,不强制改',
    options: [{ value: '', label: '继承源/全局(默认)' }, { value: 'on', label: '开:过不去换卡(swap)' }, { value: 'off', label: '关:不换卡' }] },
];

const ALL_FIELDS = [...FIELDS, ...ACTION_FIELDS];
const DEFAULTS = ALL_FIELDS.reduce((o, f) => { o[f.key] = f.def; return o; }, {});
const KEYS = new Set(ALL_FIELDS.map((f) => f.key));

// 把激活预设的 opts(flat)→ Python(common/recovery.py)消费的策略 JSON。
//   结构 { retry: { retryRegister:'on'|'off', ... } };缺项 Python 退默认 'on'(重试)。
// ★只序列化 FIELDS(retry.*)子集,绝不含 ACTION_FIELDS → 加任何动作字段输出逐字节不变。
function recoveryEnvJson(opts) {
  const o = opts || {};
  const retry = {};
  for (const f of FIELDS) {
    const v = o[f.key];
    if (v != null && String(v).trim() !== '') retry[f.key] = String(v).trim();
  }
  return JSON.stringify({ retry });
}

// 把激活预设的【动作】字段 → 批量恢复/续跑用的 recoverOptions(server.js handleApiRunResume 白名单消费)。
//   纯函数;空串/未设 = 省略该键(= 不注入 → 默认行为不变)。与 src/lib/recoverySchema.ts 同名函数逐字段一致。
function recoveryResumeOptions(opts) {
  const o = opts || {};
  const out = {};
  // ipRounds → autoRetryFailed + autoRetryTimes(每轮换出口 IP;declined 唯一安全杠杆)。clamp 5(与 buildEnv 同口径)。
  const ip = Number(o.ipRounds);
  if (o.ipRounds !== undefined && String(o.ipRounds).trim() !== '' && Number.isFinite(ip) && ip > 0) {
    out.autoRetryFailed = true;
    out.autoRetryTimes = Math.min(ip, 5);
  }
  // zipRetry → zipRetry(>=0;'0' 有效不省略,'' 省略)
  const z = Number(o.zipRetry);
  if (o.zipRetry !== undefined && String(o.zipRetry).trim() !== '' && Number.isFinite(z) && z >= 0) {
    out.zipRetry = z;
  }
  // cardStrategy 枚举透传(非法/空 → 省略)
  if (['random', 'spread', 'concentrate'].includes(String(o.cardStrategy))) out.cardStrategy = String(o.cardStrategy);
  // swapOnHcaptcha 'on' → solveHcaptcha:'swap';'off'/'' → 省略(不强制,继承源/全局)
  if (String(o.swapOnHcaptcha) === 'on') out.solveHcaptcha = 'swap';
  return out;
}

module.exports = { FIELDS, ACTION_FIELDS, DEFAULTS, KEYS, recoveryEnvJson, recoveryResumeOptions };
