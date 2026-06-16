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

const DEFAULTS = FIELDS.reduce((o, f) => { o[f.key] = f.def; return o; }, {});
const KEYS = new Set(FIELDS.map((f) => f.key));

// 把激活预设的 opts(flat)→ Python(common/recovery.py)消费的策略 JSON。
//   结构 { retry: { retryRegister:'on'|'off', ... } };缺项 Python 退默认 'on'(重试)。
function recoveryEnvJson(opts) {
  const o = opts || {};
  const retry = {};
  for (const f of FIELDS) {
    const v = o[f.key];
    if (v != null && String(v).trim() !== '') retry[f.key] = String(v).trim();
  }
  return JSON.stringify({ retry });
}

module.exports = { FIELDS, DEFAULTS, KEYS, recoveryEnvJson };
