'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 引擎配置 schema(后端镜像)— Openrouter / web / engine-schema.js
//
// ⚠️ 这是 src/lib/engineSchema.ts 的后端镜像。改前端 schema 的 key / 默认值时,务必同步这里。
// 后端只需要两样:① 每引擎默认 opts(seed 内置「默认」配置)② 每引擎允许写入的 key 白名单(过滤未知键防注入)。
//
// 边界(三方解耦):**引擎配置 = 该引擎"怎么跑"的技术行为**(填卡方式 / 求解 / 换IP / 环境生命周期 / 分流),
// 与"各环节做什么"的业务参数(环节策略预设:Key名/卡次数/金额)、与引擎无关的全局(密码/并发/数量)区分开。
// 默认值严格 = 重构前 ConsolePage 的 py state + card/register 策略预设里 engine-filtered 字段的默认,
// 保证"全默认引擎配置"跑出的 /jobs、/api/run payload 与重构前逐字段一致(硬回归不变量)。
// ═══════════════════════════════════════════════════════════════════════

const ENGINES = ['playwright', 'selenium', 'hybrid', 'split'];

// 每引擎默认 opts(键与值与前端 ENGINE_FIELDS 的 default 一一对应)。
const DEFAULTS = {
  // Playwright:浏览器内置跑;填卡方式 + 各步转人工/选卡/脏IP跳过(原 card/register 策略里 PW-only 字段)。
  playwright: {
    cardFillEngine: 'playwright', manualCaptcha: false,
    manualBilling: false, manualCardPick: false, skipDirtyIp: false,
  },
  // Selenium:AdsPower 全流程;只暴露纯 selenium(pipeline.py)真正读的:求解模式 + 点框后复检等待 + 跑完保留环境。
  // (cardDeadline/solveFutileCap/maxHcaptchaCardSwaps 仅 hybrid 读,不放进 selenium 默认,避免"设了不生效"。)
  selenium: {
    solveHcaptcha: 'random', hcRecheckWait: '5', noDeleteEnv: false,
  },
  // 混合:Selenium 那套 + 换IP/冷却/重开/手动选卡 + 每账号新环境/保留环境/开始前不清理。
  hybrid: {
    solveHcaptcha: 'random', cardDeadline: '480', solveFutileCap: '3', maxHcaptchaCardSwaps: '1',
    hcRecheckWait: '5', maxRotations: '3', cooldownHours: '3', maxReopen: '3', manualCard: false,
    isolate: false, noDeleteEnv: false, noGc: false,
  },
  // 分流:混合那套 + 分流比例(一半 Selenium、一半混合)。
  split: {
    solveHcaptcha: 'random', cardDeadline: '480', solveFutileCap: '3', maxHcaptchaCardSwaps: '1',
    hcRecheckWait: '5', maxRotations: '3', cooldownHours: '3', maxReopen: '3', manualCard: false,
    isolate: false, noDeleteEnv: false, noGc: false, splitRatio: '0.5',
  },
};

// 写入白名单 = 默认 opts 的键集合。
const KEYS = {};
for (const e of ENGINES) KEYS[e] = new Set(Object.keys(DEFAULTS[e]));

module.exports = { ENGINES, DEFAULTS, KEYS };
