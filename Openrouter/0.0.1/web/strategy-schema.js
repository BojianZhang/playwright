'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 环节策略 schema(后端镜像)— Openrouter / web / strategy-schema.js
//
// ⚠️ 这是 src/lib/strategySchema.ts 的后端镜像。改前端 schema 的 key / 默认值时,务必同步这里。
// 后端只需要两样:① 每环节默认 opts(seed 内置「默认」预设)② 每环节允许写入的 key 白名单(过滤未知键防注入)。
// 默认值严格 = 前端 schema 默认 = 重构前 useState 初值。
// 注:环节只留各步"业务参数";"引擎怎么跑"的技术行为已迁到 engine-schema.js(引擎配置)。
// ═══════════════════════════════════════════════════════════════════════

const STAGES = ['key', 'card', 'charge'];

// 每环节默认 opts(键与值与前端 STRATEGY_SCHEMA 的 default 一一对应)。
const DEFAULTS = {
  key: { apiKeyName: '', apiKeyExpiration: 'No expiration' },
  card: { cardMaxUses: '10', maxCardTries: '3' },
  charge: { topUpAmount: '5' },
};

// 写入白名单 = 默认 opts 的键集合。
const KEYS = {};
for (const s of STAGES) KEYS[s] = new Set(Object.keys(DEFAULTS[s]));

module.exports = { STAGES, DEFAULTS, KEYS };
