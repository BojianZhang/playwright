'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / register（注册流程编排器）
//
// 文件定位：Openrouter/0.0.1/Openrouter-register.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 构建有序 stageRegistry，按 S0..S6 顺序调用各阶段公共 runner，
//            把 adapter 注入其中；收口归一化为 RegisterFlowResult。
// ❌ 不负责 —— 页面 DOM 操作（各 Sn-*/adapter.js）、并发调度（job-runner/batch-runner）、
//            浏览器创建（shared-browser-runtime）。
//
// 现状【Step 2】：各阶段 run 暂为 makeNoopStage 占位（返回 {success:true}），
//   仅打通「编排 + 浏览器 + onWorkerUpdate 流」。后续步骤把 run 换成 shared-* runner，
//   把 adapter 换成 Sn-*/adapter.js。换入位置见每个 stage 的 TODO。
// ═══════════════════════════════════════════════════════════════════════

const stages = require('./stages');

// 阶段链定义：key 用于内部索引，stage 是对外可读的阶段名；run 为 stages.js 中的实现。
const STAGE_DEFS = [
  { key: 'proxyPrecheck', stage: 'proxy-precheck', run: stages.proxyPrecheck },
  { key: 'emailPasswordChange', stage: 'email-password-change', run: stages.emailPasswordChange },
  { key: 'register', stage: 'openrouter-register', run: stages.register },
  { key: 'magicLinkLogin', stage: 'magic-link-login', run: stages.magicLinkLogin },
  { key: 'apiKey', stage: 'api-key', run: stages.apiKey },
  { key: 'billing', stage: 'billing-card-topup', run: stages.billing },
  { key: 'export', stage: 'export', run: stages.exportStage },
];

/**
 * 构建阶段注册表（有序）。stages.js 的每个函数签名为 async (ctx) => result。
 * @param {object} [runtime={}]
 * @returns {Array<{key,stage,run}>}
 */
function buildOpenrouterStageRegistry(runtime = {}) {
  return STAGE_DEFS.map(def => ({ ...def }));
}

/**
 * 组装最终交付 payload（导出/回显共用）。
 * 从各阶段结果中提取已知字段；缺失字段留空字符串。
 *
 * @param {object} params { account, proxy, runtime, stageResults }
 * @returns {object}
 */
function buildDeliveryPayload({ account = {}, proxy = {}, runtime = {}, stageResults = {} }) {
  const apiKey = stageResults.apiKey?.detail?.apiKey
    || stageResults.export?.detail?.apiKey
    || '';
  const exitIp = runtime?.ipCheck?.browserRuntimeIp
    || stageResults.proxyPrecheck?.detail?.exitIp
    || '';
  const billingDetail = stageResults.billing?.detail || {};
  // 密码模型：原来密码=输入的邮箱密码；现在密码(password)=统一密码(若设置,即 OpenRouter 登录密码)。
  const unified = String(runtime?.taskParams?.unifiedPassword || '').trim();
  const passwordChanged = !!stageResults.export?.detail?.passwordChanged;
  const originalPassword = account.password || '';
  const currentPassword = unified || originalPassword; // OpenRouter 登录用
  return {
    email: account.email || '',
    password: currentPassword,
    originalPassword,
    mailboxPassword: passwordChanged ? (unified || originalPassword) : originalPassword,
    passwordChanged,
    apiKey,
    apiKeyName: runtime?.taskParams?.apiKeyName || '',
    topUpAmount: runtime?.taskParams?.topUpAmount || 0,
    billingStatus: billingDetail.billingStatus || 'skipped',
    charged: billingDetail.charged || 0,
    cardLast4: billingDetail.cardLast4 || '',
    proxy: proxy?.host ? `${proxy.host}:${proxy.port}` : (proxy?.raw || ''),
    exitIp,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 运行一次完整注册流程（单账号）。
 *
 * @param {object} options
 * @param {import('playwright').Page} options.page
 * @param {object} options.account                 { email, password }
 * @param {object} [options.proxy]
 * @param {object} [options.runtime]               运行期配置（含 taskParams / ipCheck 等）
 * @param {object} [options.context]               跨阶段上下文（含可选 onStageStart 钩子）
 * @param {Array}  [options.stageRegistry]         覆盖默认注册表（测试用）
 * @returns {Promise<object>} RegisterFlowResult { success, stage, state, reason, detail }
 */
async function runOpenrouterRegisterFlow(options = {}) {
  const {
    page,
    account = {},
    proxy = {},
    runtime = {},
    context = {},
    stageRegistry = buildOpenrouterStageRegistry(runtime),
  } = options;

  const stageResults = {};
  const onStageStart = typeof context.onStageStart === 'function' ? context.onStageStart : () => {};

  for (const stageEntry of stageRegistry) {
    const { key, stage, run } = stageEntry;
    onStageStart(stage);

    if (typeof run !== 'function') {
      return finalize({ success: false, stage, state: 'STAGE_RUNNER_MISSING', reason: 'STAGE_RUNNER_MISSING', stageResults, account, proxy, runtime });
    }

    const stageContext = { ...context, proxy, runtime, stageResults };
    let result;
    try {
      result = await run({ page, account, proxy, runtime, context: stageContext });
    } catch (error) {
      result = { success: false, state: `${stage.toUpperCase()}_THREW`, reason: String(error?.message || 'STAGE_THREW'), detail: { error: String(error?.message || error) } };
    }

    stageResults[key] = result;

    if (!result || result.success !== true) {
      return finalize({
        success: false,
        stage,
        state: result?.state || `${stage}_FAILED`,
        reason: result?.reason || result?.state || `${stage}_FAILED`,
        stageResults, account, proxy, runtime,
      });
    }
  }

  // 全部阶段成功。
  return finalize({ success: true, stage: 'export', state: 'REGISTER_FLOW_COMPLETE', reason: '', stageResults, account, proxy, runtime });
}

/**
 * 归一化最终结果，附带 deliveryPayload。
 */
function finalize({ success, stage, state, reason, stageResults, account, proxy, runtime }) {
  return {
    success,
    stage,
    state,
    reason: reason || state,
    nextStage: '',
    detail: {
      stages: stageResults,
      deliveryPayload: success ? buildDeliveryPayload({ account, proxy, runtime, stageResults }) : null,
    },
  };
}

module.exports = {
  runOpenrouterRegisterFlow,
  buildOpenrouterStageRegistry,
  buildDeliveryPayload,
  STAGE_DEFS,
};
