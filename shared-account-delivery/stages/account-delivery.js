'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
} = require('../../shared-stage-logger');

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
    signalStrength,
    settleStage,
    detectionSource,
    stateChanged,
    retryCount,
    detail,
  };
}

/**
 * 运行第六阶段：account-delivery。
 *
 * 当前版本只先把骨架、顺序、字段和注释钉死：
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
  logStageProgress('account-delivery', '等待 account-delivery 阶段入口', {
    context: buildStageLogContext(options),
  });
  const deliveryReady = await waitForAccountDeliveryReady(page, runtime, context);
  if (deliveryReady?.ok) {
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

    logStageFail('account-delivery', 'account-delivery 阶段入口失败', {
      context: buildStageLogContext(options),
      extra: [
        deliveryReady?.state ? `state=${deliveryReady.state}` : '',
        deliveryReady?.source ? `source=${deliveryReady.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).join(' | '),
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
      detail: {
        deliveryReady,
        accountSummary: null,
        deliveryPayload: null,
        resultConfirmation: null,
        classified,
      },
    });
  }

  // 从上游 post-auth-ready 阶段 detail 中显式摘取关键信号，避免下游 adapter 自己猜路径。
  const postAuthDetail = context?.stageResults?.postAuthReady?.detail || null;
  const sessionInspection = postAuthDetail?.sessionInspection || null;
  const uiConfirmation = postAuthDetail?.uiConfirmation || null;
  const postAuthResultConfirmation = postAuthDetail?.resultConfirmation || null;

  // 第二步：收集账号最终交付摘要；如果 adapter 还没实现，就保留 null。
  logStageProgress('account-delivery', '收集账号最终交付摘要', {
    context: buildStageLogContext(options),
  });
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

  // 第三步：组装 delivery payload；如果 adapter 还没实现，就保留 null。
  logStageProgress('account-delivery', '构建 delivery payload', {
    context: buildStageLogContext(options),
  });
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

  // 第四步：收口最终 success / failure / unknown；如果 adapter 还没实现，则回退 unknown。
  logStageProgress('account-delivery', '确认 account-delivery 最终结果', {
    context: buildStageLogContext(options),
  });
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

  // 如果最终结果确认成功，则直接按成功结构收口。
  if (resultConfirmation?.ok) {
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
      detail: {
        deliveryReady,
        accountSummary,
        deliveryPayload,
        resultConfirmation,
        classified: null,
      },
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
  logStageFail('account-delivery', 'account-delivery 阶段失败', {
    context: buildStageLogContext(options),
    extra: [
      resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
      resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).join(' | '),
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
    detail: {
      deliveryReady,
      accountSummary,
      deliveryPayload,
      resultConfirmation,
      classified,
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeAccountDeliveryStageResult,
  runAccountDeliveryStage,
};
