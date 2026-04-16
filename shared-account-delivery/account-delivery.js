// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— S6 account-delivery
//
// 文件定位：shared-account-delivery/account-delivery.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 账号交付阶段调度器。
// ✅ 负责 —— 统一的入参校验、重试调度、阶段耗时统计、日志规范化输出。
// ✅ 负责 —— 将 adapter 返回结果归一化为标准 StageResult 结构。
// ❌ 不负责 —— 任何业务实现细节（页面操作 / API 调用 / 选择器定义）。
// ❌ 不负责 —— 与特定平台（Dreamina / 其他）的耦合，adapter 由外部注入。
// ❌ 不负责 —— 持有 adapter 引用（adapter 通过 options.adapter 或 options.xxx 传入）。
//
// 调用方：Dreamina-register.js 的主链（runXxxStage）
// 依赖方：Dreamina/0.0.3/Sn-xxx/ 下对应的 adapter（调用 account-delivery-adapter（当前绑定 Dreamina），将注册成功的账号写入交付产物并返回 DeliveryResult）
// ═══════════════════════════════════════════════════════════════════════
'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../shared-utils/stage-logger');
const { syncStageStep } = require('../shared-utils/stage-runtime');

/**
 * 从 adapter 上解析指定方法。
 *
 * 作用：
 * - 统一第六阶段公共层对 adapter 方法的取用方式
 * - 如果方法不存在，就回退到 null，而不是让主流程直接炸掉
 */
function resolveAdapterMethod(adapter, methodName) {
  // 如果 adapter 本身不存在，就直接返回 null。
  if (!adapter || typeof adapter !== 'object') return null;
  // 从 adapter 上读取目标方法。
  const method = adapter[methodName];
  // 只有当目标字段是函数时才返回，否则统一回退 null。
  return typeof method === 'function' ? method : null;
}

/**
 * 规范化第六阶段输出结构。
 *
 * 作用：
 * - 保证外层无论 adapter 返回了什么，第六阶段最终输出结构都稳定
 * - 把 success / stage / reason / detail 等字段统一收敛
 */
function normalizeAccountDeliveryStageResult(input = {}) {
  // 统一 success。
  const success = Boolean(input.success);
  // 第六阶段 stage 固定为 account-delivery。
  const stage = 'account-delivery';
  // 原始 state；没有则给 UNKNOWN。
  const state = String(input.state || 'UNKNOWN').trim();
  // reason 优先用输入值；没有则回退 state。
  const reason = String(input.reason || state).trim();
  // 只有 success=true 时才允许向 delivery-complete 推进。
  const nextStage = success ? String(input.nextStage || 'delivery-complete').trim() : '';
  // 信号强度，默认空字符串。
  const signalStrength = String(input.signalStrength || '').trim();
  // 收敛层级，默认 none。
  const settleStage = String(input.settleStage || 'none').trim();
  // 检测来源，默认空字符串。
  const detectionSource = String(input.detectionSource || '').trim();
  // 是否有有意义变化；没有则保留 null。
  const stateChanged = typeof input.stateChanged === 'boolean' ? input.stateChanged : null;
  // 第六阶段内部轻量重试次数；默认 0。
  const retryCount = Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0;
  // detail 对象；没有则回退 null。
  const detail = input.detail && typeof input.detail === 'object' ? input.detail : null;

  // 返回统一结构。
  return {
    success,
    stage,
    state,
    reason,
    nextStage,
    source: detectionSource,
    signalStrength,
    settleStage,
    detectionSource,
    stateChanged,
    retryCount,
    detail,
  };
}

function buildAccountDeliveryStageDetail(input = {}) {
  const {
    deliveryReady = null,
    accountSummary = null,
    deliveryPayload = null,
    sessionRecord = null,
    resultConfirmation = null,
    classified = null,
    timingBreakdown = null,
    extra = null,
  } = input;

  return {
    deliveryReady,
    accountSummary,
    deliveryPayload,
    sessionRecord,
    resultConfirmation,
    classified,
    timingBreakdown,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

/**
 * 运行第六阶段：account-delivery。
 *
 * Shared boundary:
 * - Own stage-6 orchestration only
 * - Consume adapter hooks for ready / summary / payload / result / classify
 * - Prefer explicit reuse of upstream post-auth-ready outputs instead of re-deriving them
 *
 * Shared does NOT:
 * - Re-implement site-specific delivery business rules
 * - Re-run post-auth-ready confirmation logic
 * - Own extra retry / observation loops for delivery semantics
 *
 * 当前主流程：
 * 1. 等待第六阶段入口 ready
 * 2. 收集账号最终交付摘要
 * 3. 组装 delivery payload
 * 4. 收口最终 success / failure / unknown
 * 5. 失败时做站点语义分类
 */
async function runAccountDeliveryStage(options = {}) {
  // 从统一 options 中解构第六阶段常用输入。
  const {
    page,
    account = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  const stageTimer = createStageTimer();
  const timingBreakdown = {
    waitAccountDeliveryReadyMs: 0,
    collectAccountSummaryMs: 0,
    buildDeliveryPayloadMs: 0,
    confirmDeliveryResultMs: 0,
    totalMs: 0,
  };

  // 取日志函数；没有则保持 null。
  const { logInfo = null } = context;

  // 解析第六阶段各步骤所需 adapter 方法。
  const waitForAccountDeliveryReady = resolveAdapterMethod(adapter, 'waitForAccountDeliveryReady');
  const collectAccountDeliverySummary = resolveAdapterMethod(adapter, 'collectAccountDeliverySummary');
  const buildAccountDeliveryPayload = resolveAdapterMethod(adapter, 'buildAccountDeliveryPayload');
  const confirmAccountDeliveryResult = resolveAdapterMethod(adapter, 'confirmAccountDeliveryResult');
  const classifyAccountDeliveryFailure = resolveAdapterMethod(adapter, 'classifyAccountDeliveryFailure');

  // 如果最基本的入口 ready 方法不存在，直接返回结构化失败。
  if (!waitForAccountDeliveryReady) {
    syncStageStep(options, { stage: 'account-delivery', step: 'stage-fail' });
    logStageFail('account-delivery', 'adapter 必需方法缺失', {
      context: buildStageLogContext(options),
      extra: 'missing=waitForAccountDeliveryReady',
    });
    return normalizeAccountDeliveryStageResult({
      success: false,
      state: 'ACCOUNT_DELIVERY_ADAPTER_METHOD_MISSING',
      reason: 'ACCOUNT_DELIVERY_ADAPTER_METHOD_MISSING',
      nextStage: '',
      signalStrength: '',
      settleStage: 'none',
      detectionSource: '',
      stateChanged: null,
      retryCount: 0,
      detail: {
        missingMethod: 'waitForAccountDeliveryReady',
      },
    });
  }

  // 第一步：等待第六阶段入口 ready。
  syncStageStep(options, { stage: 'account-delivery', step: 'wait-account-delivery-ready' });
  logStageProgress('account-delivery', '等待 account-delivery 阶段入口', {
    context: buildStageLogContext(options),
  });
  const deliveryReadyStartMs = stageTimer.elapsedMs();
  const deliveryReady = await waitForAccountDeliveryReady(page, runtime, context);
  timingBreakdown.waitAccountDeliveryReadyMs = Math.max(0, stageTimer.elapsedMs() - deliveryReadyStartMs);
  if (deliveryReady?.ok) {
    syncStageStep(options, { stage: 'account-delivery', step: 'stage-success' });
    logStageSuccess('account-delivery', 'account-delivery 阶段入口就绪', {
      context: buildStageLogContext(options),
      extra: [
        deliveryReady?.state ? `state=${deliveryReady.state}` : '',
        deliveryReady?.source ? `source=${deliveryReady.source}` : '',
      ].filter(Boolean).join(' | '),
    });
  }
  // 如果入口不 ready，则直接按阶段 6 失败收口。
  if (!deliveryReady?.ok) {
    const classified = classifyAccountDeliveryFailure
      ? classifyAccountDeliveryFailure({ state: deliveryReady?.state || 'ACCOUNT_DELIVERY_NOT_READY', source: deliveryReady?.source, value: deliveryReady?.value })
      : null;

    syncStageStep(options, { stage: 'account-delivery', step: 'stage-fail' });
    logStageFail('account-delivery', 'account-delivery 阶段入口失败', {
      context: buildStageLogContext(options),
      extra: [
        deliveryReady?.state ? `state=${deliveryReady.state}` : '',
        deliveryReady?.source ? `source=${deliveryReady.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });

    return normalizeAccountDeliveryStageResult({
      success: false,
      state: String(deliveryReady?.state || 'ACCOUNT_DELIVERY_NOT_READY'),
      reason: classified?.siteReason || String(deliveryReady?.state || 'ACCOUNT_DELIVERY_NOT_READY'),
      nextStage: '',
      signalStrength: String(deliveryReady?.strength || ''),
      settleStage: String(deliveryReady?.settleStage || 'none'),
      detectionSource: String(deliveryReady?.source || ''),
      stateChanged: typeof deliveryReady?.stateChanged === 'boolean' ? deliveryReady.stateChanged : null,
      retryCount: 0,
      detail: buildAccountDeliveryStageDetail({
        deliveryReady,
        accountSummary: null,
        deliveryPayload: null,
        sessionRecord: null,
        resultConfirmation: null,
        classified,
        timingBreakdown,
      }),
    });
  }

  // 从上游 post-auth-ready 阶段 detail 中显式摘取关键信号，避免下游 adapter 自己猜路径。
  const postAuthDetail = context?.stageResults?.postAuthReady?.detail || null;
  const sessionInspection = postAuthDetail?.sessionInspection || null;
  const uiConfirmation = postAuthDetail?.uiConfirmation || null;
  const postAuthResultConfirmation = postAuthDetail?.resultConfirmation || null;

  // 第二步：收集账号最终交付摘要；如果 adapter 还没实现，就保留 null。
  syncStageStep(options, { stage: 'account-delivery', step: 'collect-account-summary' });
  logStageProgress('account-delivery', '收集账号最终交付摘要', {
    context: buildStageLogContext(options),
  });
  const collectSummaryStartMs = stageTimer.elapsedMs();
  const accountSummary = collectAccountDeliverySummary
    ? await collectAccountDeliverySummary(page, account, runtime, {
        ...context,
        deliveryReady,
        postAuthDetail,
        sessionInspection,
        uiConfirmation,
        postAuthResultConfirmation,
      })
    : null;
  timingBreakdown.collectAccountSummaryMs = Math.max(0, stageTimer.elapsedMs() - collectSummaryStartMs);

  // 第三步：组装 delivery payload；如果 adapter 还没实现，就保留 null。
  syncStageStep(options, { stage: 'account-delivery', step: 'build-delivery-payload' });
  logStageProgress('account-delivery', '构建 delivery payload', {
    context: buildStageLogContext(options),
  });
  const buildPayloadStartMs = stageTimer.elapsedMs();
  const deliveryPayload = buildAccountDeliveryPayload
    ? await buildAccountDeliveryPayload(page, account, runtime, {
        ...context,
        deliveryReady,
        accountSummary,
        postAuthDetail,
        sessionInspection,
        uiConfirmation,
        postAuthResultConfirmation,
      })
    : null;
  timingBreakdown.buildDeliveryPayloadMs = Math.max(0, stageTimer.elapsedMs() - buildPayloadStartMs);

  // 第四步：收口最终 success / failure / unknown；如果 adapter 还没实现，则回退 unknown。
  syncStageStep(options, { stage: 'account-delivery', step: 'confirm-account-delivery-result' });
  logStageProgress('account-delivery', '确认 account-delivery 最终结果', {
    context: buildStageLogContext(options),
  });
  const confirmResultStartMs = stageTimer.elapsedMs();
  const resultConfirmation = confirmAccountDeliveryResult
    ? await confirmAccountDeliveryResult(page, account, runtime, {
        ...context,
        deliveryReady,
        accountSummary,
        deliveryPayload,
        postAuthDetail,
        sessionInspection,
        uiConfirmation,
        postAuthResultConfirmation,
      })
    : {
        ok: false,
        state: 'ACCOUNT_DELIVERY_RESULT_UNKNOWN',
        nextStage: '',
        source: '',
        value: '',
        strength: '',
        settleStage: 'none',
      };
  timingBreakdown.confirmDeliveryResultMs = Math.max(0, stageTimer.elapsedMs() - confirmResultStartMs);
  timingBreakdown.totalMs = stageTimer.elapsedMs();

  // 如果最终结果确认成功，则直接按成功结构收口。
  if (resultConfirmation?.ok) {
    syncStageStep(options, { stage: 'account-delivery', step: 'stage-success' });
    logStageSuccess('account-delivery', 'account-delivery 阶段成功', {
      context: buildStageLogContext(options),
      extra: [
        resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
        resultConfirmation?.nextStage ? `next=${resultConfirmation.nextStage}` : '',
        resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      ].filter(Boolean).join(' | '),
    });
    if (typeof logInfo === 'function') {
      logInfo(`accountDelivery.success | state=${resultConfirmation.state || 'DELIVERY_COMPLETE'} | source=${resultConfirmation.source || ''} | value=${resultConfirmation.value || ''}`);
    }

    return normalizeAccountDeliveryStageResult({
      success: true,
      state: String(resultConfirmation?.state || 'DELIVERY_COMPLETE'),
      reason: String(resultConfirmation?.state || 'DELIVERY_COMPLETE'),
      nextStage: String(resultConfirmation?.nextStage || 'delivery-complete'),
      signalStrength: String(resultConfirmation?.strength || ''),
      settleStage: String(resultConfirmation?.settleStage || 'none'),
      detectionSource: String(resultConfirmation?.source || ''),
      stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
      retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
      detail: buildAccountDeliveryStageDetail({
        deliveryReady,
        accountSummary,
        deliveryPayload,
        sessionRecord: deliveryPayload?.sessionRecord || accountSummary?.sessionRecord || null,
        resultConfirmation,
        classified: null,
        timingBreakdown,
      }),
    });
  }

  // 第五步：失败时做站点语义分类；如果 adapter 还没实现分类器，则 classified 保持 null。
  const classified = classifyAccountDeliveryFailure
    ? classifyAccountDeliveryFailure({
        state: resultConfirmation?.state || 'ACCOUNT_DELIVERY_RESULT_UNKNOWN',
        source: resultConfirmation?.source,
        value: resultConfirmation?.value,
      })
    : null;

  // 返回统一失败结构。
  syncStageStep(options, { stage: 'account-delivery', step: 'stage-fail' });
    logStageFail('account-delivery', 'account-delivery 阶段失败', {
    context: buildStageLogContext(options),
    extra: [
      resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
      resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
  });
  return normalizeAccountDeliveryStageResult({
    success: false,
    state: String(resultConfirmation?.state || 'ACCOUNT_DELIVERY_RESULT_UNKNOWN'),
    reason: classified?.siteReason || String(resultConfirmation?.state || 'ACCOUNT_DELIVERY_RESULT_UNKNOWN'),
    nextStage: '',
    signalStrength: String(resultConfirmation?.strength || ''),
    settleStage: String(resultConfirmation?.settleStage || 'none'),
    detectionSource: String(resultConfirmation?.source || ''),
    stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
    retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
    detail: buildAccountDeliveryStageDetail({
      deliveryReady,
      accountSummary,
      deliveryPayload,
      sessionRecord: deliveryPayload?.sessionRecord || accountSummary?.sessionRecord || null,
      resultConfirmation,
      classified,
      timingBreakdown,
    }),
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeAccountDeliveryStageResult,
  runAccountDeliveryStage,
};
