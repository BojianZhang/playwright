'use strict';

/**
 * 从 adapter 上解析指定方法。
 *
 * 作用：
 * - 统一第五阶段公共层对 adapter 方法的取用方式
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
 * 规范化第五阶段输出结构。
 *
 * 作用：
 * - 保证外层无论 adapter 返回了什么，第五阶段最终输出结构都稳定
 * - 把 success / stage / reason / detail 等字段统一收敛
 */
function normalizePostAuthReadyStageResult(input = {}) {
  // 统一 success。
  const success = Boolean(input.success);
  // 第五阶段 stage 固定为 post-auth-ready。
  const stage = 'post-auth-ready';
  // 原始 state；没有则给 UNKNOWN。
  const state = String(input.state || 'UNKNOWN').trim();
  // reason 优先用输入值；没有则回退 state。
  const reason = String(input.reason || state).trim();
  // 只有 success=true 时才允许向 registration-complete 推进。
  const nextStage = success ? String(input.nextStage || 'registration-complete').trim() : '';
  // 信号强度，默认空字符串。
  const signalStrength = String(input.signalStrength || '').trim();
  // 收敛层级，默认 none。
  const settleStage = String(input.settleStage || 'none').trim();
  // 检测来源，默认空字符串。
  const detectionSource = String(input.detectionSource || '').trim();
  // 页面是否发生了有意义变化；没有则保留 null。
  const stateChanged = typeof input.stateChanged === 'boolean' ? input.stateChanged : null;
  // 第五阶段内部轻量重试次数；默认 0。
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
 * 运行第五阶段：post-auth-ready。
 *
 * 当前版本只先把骨架、顺序、字段和注释钉死：
 * 1. 等待第五阶段入口 ready
 * 2. 检查 session / storage / cookie 可用态
 * 3. 检查 UI 登录后信号
 * 4. 收口最终 success / failure / unknown
 * 5. 失败时做站点语义分类
 *
 * 注意：
 * - 这里先优先把阶段边界和输出结构写稳
 * - 真正站点细节交给 adapter
 */
async function runPostAuthReadyStage(options = {}) {
  // 从统一 options 中解构第五阶段常用输入。
  const {
    page,
    account = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  // 取日志函数；没有则保持 null。
  const { logInfo = null } = context;

  // 解析第五阶段各步骤所需 adapter 方法。
  const waitForPostAuthReady = resolveAdapterMethod(adapter, 'waitForPostAuthReady');
  const inspectPostAuthSession = resolveAdapterMethod(adapter, 'inspectPostAuthSession');
  const confirmPostAuthUi = resolveAdapterMethod(adapter, 'confirmPostAuthUi');
  const confirmPostAuthResult = resolveAdapterMethod(adapter, 'confirmPostAuthResult');
  const classifyPostAuthFailure = resolveAdapterMethod(adapter, 'classifyPostAuthFailure');

  // 如果最基本的入口 ready 方法不存在，直接返回结构化失败。
  if (!waitForPostAuthReady) {
    return normalizePostAuthReadyStageResult({
      success: false,
      state: 'POST_AUTH_ADAPTER_METHOD_MISSING',
      reason: 'POST_AUTH_ADAPTER_METHOD_MISSING',
      nextStage: '',
      signalStrength: '',
      settleStage: 'none',
      detectionSource: '',
      stateChanged: null,
      retryCount: 0,
      detail: {
        missingMethod: 'waitForPostAuthReady',
      },
    });
  }

  // 第一步：等待第五阶段入口 ready。
  const postAuthReady = await waitForPostAuthReady(page, runtime, context);
  // 如果入口不 ready，则直接按阶段 5 失败收口。
  if (!postAuthReady?.ok) {
    const classified = classifyPostAuthFailure
      ? classifyPostAuthFailure({ state: postAuthReady?.state || 'POST_AUTH_NOT_READY', source: postAuthReady?.source, value: postAuthReady?.value })
      : null;

    return normalizePostAuthReadyStageResult({
      success: false,
      state: String(postAuthReady?.state || 'POST_AUTH_NOT_READY'),
      reason: classified?.siteReason || String(postAuthReady?.state || 'POST_AUTH_NOT_READY'),
      nextStage: '',
      signalStrength: String(postAuthReady?.strength || ''),
      settleStage: String(postAuthReady?.settleStage || 'none'),
      detectionSource: String(postAuthReady?.source || ''),
      stateChanged: typeof postAuthReady?.stateChanged === 'boolean' ? postAuthReady.stateChanged : null,
      retryCount: 0,
      detail: {
        postAuthReady,
        sessionInspection: null,
        uiConfirmation: null,
        resultConfirmation: null,
        classified,
      },
    });
  }

  // 第二步：检查 session / storage / cookie 可用态；如果 adapter 还没实现，就保留 null。
  const sessionInspection = inspectPostAuthSession
    ? await inspectPostAuthSession(page, runtime, { ...context, postAuthReady })
    : null;

  // 第三步：检查 UI 登录后信号；如果 adapter 还没实现，就保留 null。
  const uiConfirmation = confirmPostAuthUi
    ? await confirmPostAuthUi(page, runtime, { ...context, postAuthReady, sessionInspection })
    : null;

  // 第四步：收口最终 success / failure / unknown；如果 adapter 还没实现，则回退 unknown。
  const resultConfirmation = confirmPostAuthResult
    ? await confirmPostAuthResult(page, runtime, { ...context, postAuthReady, sessionInspection, uiConfirmation })
    : {
        ok: false,
        state: 'POST_AUTH_RESULT_UNKNOWN',
        nextStage: '',
        source: '',
        value: '',
        strength: '',
        settleStage: 'none',
      };

  // 如果最终结果确认成功，则直接按成功结构收口。
  if (resultConfirmation?.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`postAuth.ready.success | state=${resultConfirmation.state || 'REGISTRATION_COMPLETE'} | source=${resultConfirmation.source || ''} | value=${resultConfirmation.value || ''}`);
    }

    return normalizePostAuthReadyStageResult({
      success: true,
      state: String(resultConfirmation?.state || 'REGISTRATION_COMPLETE'),
      reason: String(resultConfirmation?.state || 'REGISTRATION_COMPLETE'),
      nextStage: String(resultConfirmation?.nextStage || 'registration-complete'),
      signalStrength: String(resultConfirmation?.strength || ''),
      settleStage: String(resultConfirmation?.settleStage || 'none'),
      detectionSource: String(resultConfirmation?.source || ''),
      stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
      retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
      detail: {
        postAuthReady,
        sessionInspection,
        uiConfirmation,
        resultConfirmation,
        classified: null,
      },
    });
  }

  // 第五步：失败时做站点语义分类；如果 adapter 还没实现分类器，则 classified 保持 null。
  const classified = classifyPostAuthFailure
    ? classifyPostAuthFailure({
        state: resultConfirmation?.state || 'POST_AUTH_RESULT_UNKNOWN',
        source: resultConfirmation?.source,
        value: resultConfirmation?.value,
      })
    : null;

  // 返回统一失败结构。
  return normalizePostAuthReadyStageResult({
    success: false,
    state: String(resultConfirmation?.state || 'POST_AUTH_RESULT_UNKNOWN'),
    reason: classified?.siteReason || String(resultConfirmation?.state || 'POST_AUTH_RESULT_UNKNOWN'),
    nextStage: '',
    signalStrength: String(resultConfirmation?.strength || ''),
    settleStage: String(resultConfirmation?.settleStage || 'none'),
    detectionSource: String(resultConfirmation?.source || ''),
    stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
    retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
    detail: {
      postAuthReady,
      sessionInspection,
      uiConfirmation,
      resultConfirmation,
      classified,
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizePostAuthReadyStageResult,
  runPostAuthReadyStage,
};
