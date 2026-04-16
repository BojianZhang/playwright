'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— S0 proxy-precheck 便利入口
//
// 文件定位：shared-proxy-precheck/index.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 从本地 proxies.txt 加载代理 → 选取一条 → 调用预检主链的快捷入口。
// ✅ 负责 —— 将 local-proxy-loader + runProxyPrecheckChain 组合为单次调用接口。
// ❌ 不负责 —— 代理可达性探测的具体实现（由 stages/proxy-precheck.js 驱动）。
// ❌ 不负责 —— 批量代理管理、代理池轮换（由 Dreamina-batch-runner.js 负责）。
// ❌ 不负责 —— 任何 Dreamina 业务逻辑（adapter 由外部注入或使用默认值）。
//
// 调用方：本地调试 / 单次代理预检场景
// 依赖：
//   - Dreamina/0.0.3/S0-proxy-precheck/local-proxy-loader.js（数据文件）
//   - Dreamina/0.0.3/S0-proxy-precheck/proxy-precheck-adapter.js（运行内容层）
//   - shared-proxy-precheck/stages/proxy-precheck.js（框架调度层）
// ═══════════════════════════════════════════════════════════════════════

// local-proxy-loader 已迁至 Dreamina/0.0.3/S0-proxy-precheck/
const { loadLocalProxies, summarizeProxy } = require('../Dreamina/0.0.3/S0-proxy-precheck/local-proxy-loader');
// 阶段调度器（框架层，留在 stages/）
const { runProxyPrecheckChain } = require('./proxy-precheck');
// 默认 adapter（运行内容层，已迁至 Dreamina/0.0.3/S0-proxy-precheck/）
const dreaminaProxyPrecheckAdapter = require('../Dreamina/0.0.3/S0-proxy-precheck/proxy-precheck-adapter');

/**
 * 从本地代理列表选取指定索引位置的代理。
 *
 * 边界：
 * - proxies 为空时返回 null（不抛异常）。
 * - preferredIndex 越界时自动 clamp 到合法范围。
 *
 * @param {Array} proxies - loadLocalProxies() 返回的代理列表
 * @param {{ preferredIndex?: number }} [options={}]
 * @returns {object|null}
 */
function selectLocalProxy(proxies = [], options = {}) {
  const list = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
  const preferredIndex = Number.isFinite(Number(options.preferredIndex)) ? Number(options.preferredIndex) : 0;
  if (!list.length) return null;
  return list[Math.max(0, Math.min(preferredIndex, list.length - 1))] || null;
}

/**
 * 从本地 proxies.txt 读取代理并执行 Dreamina 代理预检。
 *
 * 边界：
 * - 代理列表为空时返回 LOCAL_PROXY_SOURCE_EMPTY 结构（不抛异常）。
 * - adapter 可由外部注入，默认使用 Dreamina adapter。
 * - 本函数是"本地调试"快捷入口，不用于批次生产运行。
 *
 * 返回结构（字段说明）：
 * - success {boolean}     — 代理可达性检测是否通过
 * - stage   {string}      — 始终为 'proxy-precheck'
 * - state   {string}      — 状态枚举（如 PROXY_PRECHECK_PASS / LOCAL_PROXY_SOURCE_EMPTY）
 * - reason  {string}      — 失败时的原因码
 * - proxy   {object|null} — 被选取并探测的代理对象
 * - proxySummary {object|null} — 代理摘要（server / host / port 等）
 *
 * @param {{ page?, runtime?, context?, preferredIndex?, adapter? }} [options={}]
 * @returns {Promise<object>}
 */
async function runDreaminaProxyPrecheckFromLocal(options = {}) {
  const {
    page = null,
    runtime = {},
    context = {},
    preferredIndex = 0,
    adapter = dreaminaProxyPrecheckAdapter,
  } = options;

  const proxies = loadLocalProxies(options);
  const proxy = selectLocalProxy(proxies, { preferredIndex });

  if (!proxy) {
    // 本地代理列表为空，视为配置错误直接返回失败结构。
    return {
      success: false,
      stage: 'proxy-precheck',
      state: 'LOCAL_PROXY_SOURCE_EMPTY',
      reason: 'LOCAL_PROXY_SOURCE_EMPTY',
      nextStage: '',
      signalStrength: '',
      settleStage: 'bootstrap',
      detectionSource: 'local-proxies.txt',
      stateChanged: null,
      retryCount: 0,
      proxy: null,
      proxySummary: null,
      detail: {
        source: 'local-proxies.txt',
        selectedIndex: preferredIndex,
      },
    };
  }

  // 调用框架层调度器，传入选取的代理和注入的 adapter。
  const result = await runProxyPrecheckChain({
    page,
    proxy,
    adapter,
    runtime,
    context: {
      ...context,
      proxy,
      proxySummary: summarizeProxy(proxy),
    },
  });

  return {
    ...result,
    // 追加 proxy / proxySummary 到结果顶层，方便调用方直接读取。
    proxy,
    proxySummary: summarizeProxy(proxy),
  };
}

module.exports = {
  selectLocalProxy,
  runDreaminaProxyPrecheckFromLocal,
};
