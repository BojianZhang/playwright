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
const accountStore = require('../data/account-store');   // 账单等级单调护栏(H3)+ 续跑 prior 比对

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
 * 从阶段结果提取「账号进度快照」，写入状态库支撑断点续跑。
 * 只写正向事实（已注册/已取Key/账单状态/已改密），不会用空值覆盖既有进度。
 *
 * @param {object} params { account, runtime, stageResults, failStage, failReason }
 * @returns {object} 仅含已达成字段的增量快照
 */
function buildStateSnapshot({ account = {}, runtime = {}, stageResults = {}, failStage = '', failReason = '' }) {
  const tp = runtime.taskParams || {};
  const unified = String(tp.unifiedPassword || '').trim();
  const original = account.password || '';
  const snap = { email: account.email || '', originalPassword: original };

  // 注册/登录成功 → 记录已注册 + 当前 OpenRouter 登录密码（统一密码优先）。
  if (stageResults.register && stageResults.register.success === true) {
    snap.registered = true;
    snap.loginPassword = unified || original;
  }
  // 取到 Key → 记录（重跑复用，绝不重复建）。
  const keyDetail = stageResults.apiKey && stageResults.apiKey.detail;
  if (keyDetail && keyDetail.apiKey) {
    snap.apiKey = keyDetail.apiKey;
    snap.apiKeyName = keyDetail.apiKeyName || '';
    snap.expiration = keyDetail.expiration || '';
  }
  // 账单真实状态（含 declined，供续跑判定换卡重跑）。
  // ★H3 单调护栏(防二次扣款):billing 阶段【失败重跑】返回的 declined/server-error/no-card/page-closed 等
  //   都不在 BILLING_LEVEL(等级 0)。若直接覆盖,会把【上一轮已达成】的 card-bound(2)/success(3) 降级 →
  //   下次续跑 billingSatisfied 误判未达标 → 对已绑卡/已充值号重新加卡/充值(真金白银,不可回滚)。
  //   故只在【新状态等级 ≥ 上一轮(priorState)】时才写;更低则保留台账已有更高等级(不写 → update merge 保留)。
  //   与 web/engine-runner.js bridge 的护栏同口径。fresh 跑(无 priorState)attainedLevel(undefined)=0 → 行为不变。
  const billDetail = stageResults.billing && stageResults.billing.detail;
  if (billDetail && billDetail.billingStatus) {
    const prevStatus = runtime.priorState && runtime.priorState.billingStatus;
    if (accountStore.attainedLevel(billDetail.billingStatus) >= accountStore.attainedLevel(prevStatus)) {
      snap.billingStatus = billDetail.billingStatus;
      snap.charged = billDetail.charged || 0;
      snap.cardLast4 = billDetail.cardLast4 || '';
    }
    // else: 新等级更低(失败重跑)→ 不写 billingStatus/charged/cardLast4,保留 store 中已达成的更高等级。
  }
  // 改密结果 + 据此推断邮箱当前密码（改过=统一密码，否则=原密码）。
  // ★不降级(配合 H2 增量落盘):export 阶段未跑完时 pwChanged=undefined。若此时无条件写 mailboxPassword=original,
  //   会把【上一轮已改密】(priorState.passwordChanged)的事实抹掉 → 续跑/被杀后邮箱密码回退成原密码、读不到 OTP。
  //   故未确定时:若上一轮已改密则保留改密事实,否则才回退原密码(fresh 跑无 priorState → 仍为 original,逐字节不变)。
  const pwChanged = stageResults.export && stageResults.export.detail
    ? stageResults.export.detail.passwordChanged : undefined;
  const priorPwChanged = !!(runtime.priorState && runtime.priorState.passwordChanged);
  if (pwChanged != null) {
    snap.passwordChanged = !!pwChanged;
    snap.mailboxPassword = pwChanged ? (unified || original) : original;
  } else if (priorPwChanged) {
    snap.passwordChanged = true;
    snap.mailboxPassword = (runtime.priorState && runtime.priorState.mailboxPassword) || (unified || original);
  } else {
    snap.mailboxPassword = original;
  }

  const exitIp = (runtime.ipCheck && runtime.ipCheck.browserRuntimeIp)
    || (stageResults.proxyPrecheck && stageResults.proxyPrecheck.detail && stageResults.proxyPrecheck.detail.exitIp);
  if (exitIp) snap.exitIp = exitIp;

  if (failStage) snap.lastStage = failStage;
  if (failReason) snap.lastReason = failReason;
  return snap;
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
      return finalize({ success: false, stage, state: 'STAGE_RUNNER_MISSING', reason: 'STAGE_RUNNER_MISSING', stageResults, account, proxy, runtime, context });
    }

    const stageContext = { ...context, proxy, runtime, stageResults };
    let result;
    try {
      result = await run({ page, account, proxy, runtime, context: stageContext });
    } catch (error) {
      result = { success: false, state: `${stage.toUpperCase()}_THREW`, reason: String(error?.message || 'STAGE_THREW'), detail: { error: String(error?.message || error) } };
    }

    stageResults[key] = result;

    // ★H2 增量落盘(防丢 key/重建孤儿 key):每个阶段成功即把【已达成事实】持久化。否则取到 Key 后,
    //   最长的 billing 阶段(Stripe Radar 等待 60s+)被 Ctrl+C/taskkill/SIGTERM/崩溃打断时,只在收口
    //   finalize() 落盘的 apiKey 永不写入 → 续跑 accountStore 无 key → apiKey 阶段重建第二把,第一把成孤儿。
    //   buildStateSnapshot 只写正向事实 + 含 H3 单调护栏、accountStore.update 是幂等 merge → 重复写安全;
    //   失败阶段仍由下方 finalize 落盘(带 failStage/failReason)。
    if (result && result.success === true && context && typeof context.saveState === 'function') {
      try { context.saveState(buildStateSnapshot({ account, runtime, stageResults })); }
      catch (_e) { /* 增量落盘失败不致命:finalize 会再写一次 */ }
    }

    if (!result || result.success !== true) {
      return finalize({
        success: false,
        stage,
        state: result?.state || `${stage}_FAILED`,
        reason: result?.reason || result?.state || `${stage}_FAILED`,
        stageResults, account, proxy, runtime, context,
      });
    }
  }

  // 全部阶段成功。
  return finalize({ success: true, stage: 'export', state: 'REGISTER_FLOW_COMPLETE', reason: '', stageResults, account, proxy, runtime, context });
}

/**
 * 归一化最终结果，附带 deliveryPayload。
 */
function finalize({ success, stage, state, reason, stageResults, account, proxy, runtime, context }) {
  // 持久化账号进度（成功和失败都写，失败时记录已完成的部分阶段以便续跑）。
  try {
    if (context && typeof context.saveState === 'function') {
      context.saveState(buildStateSnapshot({
        account, runtime, stageResults,
        failStage: success ? '' : stage,
        failReason: success ? '' : (reason || state),
      }));
    }
  } catch (_e) { /* 落状态失败不致命 */ }
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
  buildStateSnapshot,
  STAGE_DEFS,
};
