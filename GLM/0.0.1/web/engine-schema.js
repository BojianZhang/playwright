'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 引擎配置 schema(后端镜像)— GLM / web / engine-schema.js
//
// ⚠️ 这是 src/lib/engineSchema.ts 的后端镜像。改前端 schema 的 key / 默认值时,务必同步这里。
// 后端只需要两样:① 每引擎默认 opts(seed 内置「默认」配置)② 每引擎允许写入的 key 白名单(过滤未知键防注入)。
//
// GLM 单引擎(纯 Selenium / run.py)。引擎配置 = 该引擎"怎么跑"的技术行为(订阅/支付/自动重试/环境生命周期);
// 业务参数(套餐/周期)在控制台逐次选,密码/并发/数量是全局。
// ═══════════════════════════════════════════════════════════════════════

const ENGINES = ['selenium'];

// 每引擎默认 opts(键与值与前端 ENGINE_FIELDS 的 default 一一对应)。
const DEFAULTS = {
  // 纯 Selenium(z.ai 全流程:注册→滑块→邮箱验证→创建Key→订阅+支付):
  selenium: {
    doApiKey: true,            // 创建 API Key(独立于订阅;可只取 key 不订阅)
    doSubscribe: false,        // 订阅 GLM Coding Plan(选套餐+信用卡支付)
    plan: 'pro',               // lite | pro | max
    cycle: 'monthly',          // monthly | quarterly | yearly
    realCharge: false,         // 真实支付(关=dry-run 走到 Confirm 不真扣)
    chargeCount: '0',          // 整批最多真扣 N 次(0=不限)
    limitByCapacity: false,    // 按卡容量自动限批
    noDeleteEnv: false,        // 跑完保留环境(调试)
    autoRetryFailed: false, autoRetryTimes: '1',   // 自动重试失败号(resume 语义重跑 N 轮;默认关)
    sliderScale: '', sliderOffset: '', sliderAttempts: '',   // 滑块校准(空=Python 内置默认,真机校准时填)
    sliderGapMode: '', sliderLocalMinConf: '',   // 缺口识别策略(''=本地+Cap交叉 / capsolver-verified / local-first / pure-capsolver)+ 本地置信阈值(空=2.5)
    sliderVerifyTol: '', sliderVerifyMaxRefresh: '',   // CapSolver验证交付:cap↔本地一致容差px(空=6)+ 求一致刷新上限(空=3)
    sliderOpenWait: '', sliderNoControlGrace: '', sliderNoControlHardcap: '',   // 验证码【加载】超时(s):总等待(空=30)/无SDK就刷页(空=12=你说的"8秒"那个)/SDK在硬上限(空=25)
    apikeyWaitContent: true, apikeyContentWait: '', apikeyForceReload: false, accountDeadline: '', sliderStrictConsensus: false,   // 优化开关(稳定后定去留):取key等内容渲染(默认开)/内容等待s/黑屏硬刷/单号超时放弃s/滑块严格共识
  },
};

// 写入白名单 = 默认 opts 的键集合。
const KEYS = {};
for (const e of ENGINES) KEYS[e] = new Set(Object.keys(DEFAULTS[e]));

module.exports = { ENGINES, DEFAULTS, KEYS };
