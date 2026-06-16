// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— S5 post-auth-ready
//
// 文件定位：shared-post-auth-ready/post-auth-ready.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 登录后就绪检测阶段调度器。
// ✅ 负责 —— 统一的入参校验、重试调度、阶段耗时统计、日志规范化输出。
// ✅ 负责 —— 将 adapter 返回结果归一化为标准 StageResult 结构。
// ❌ 不负责 —— 任何业务实现细节（页面操作 / API 调用 / 选择器定义）。
// ❌ 不负责 —— 与特定平台（Dreamina / 其他）的耦合，adapter 由外部注入。
// ❌ 不负责 —— 持有 adapter 引用（adapter 通过 options.adapter 或 options.xxx 传入）。
//
// 调用方：Dreamina-register.js 的主链（runXxxStage）
// 依赖方：Dreamina/0.0.3/Sn-xxx/ 下对应的 adapter（调用 post-auth-ready-adapter（当前绑定 Dreamina），确认注册完成后页面稳定并返回 PostAuthResult）
// ═══════════════════════════════════════════════════════════════════════
'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../utils/stage-logger');
const { syncStageStep } = require('../utils/stage-runtime');

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
    source: detectionSource,
    signalStrength,
    settleStage,
    detectionSource,
    stateChanged,
    retryCount,
    detail,
  };
}

function buildPostAuthReadyStageDetail(input = {}) {
  const {
    postAuthReady = null,
    sessionInspection = null,
    initialSessionInspection = null,
    sessionObservationTrace = [],
    uiConfirmation = null,
    resultConfirmation = null,
    classified = null,
    timingBreakdown = null,
    extra = null,
  } = input;

  return {
    postAuthReady,
    sessionInspection,
    initialSessionInspection,
    sessionObservationTrace,
    uiConfirmation,
    resultConfirmation,
    classified,
    timingBreakdown,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

/**
 * 运行第五阶段：post-auth-ready。
 *
 * Shared boundary:
 * - Own stage-5 orchestration only
 * - Consume adapter hooks for ready / session / UI / result / classify
 * - Record shared timing, observation trace, logging, normalization
 *
 * Shared does NOT:
 * - Re-implement Dreamina site-specific session detection logic
 * - Own unbounded retry policy or multi-layer confirm loops
 * - Replace adapter result semantics with custom site heuristics
 *
 * 当前版本主流程：
 * 1. 等待第五阶段入口 ready
 * 2. 检查 session / storage / cookie 可用态
 * 3. 在 shared 层执行唯一允许的一段有限 session observation loop
 * 4. 检查 UI 登录后信号
 * 5. 收口最终 success / failure / unknown
 * 6. 失败时做站点语义分类
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

  const stageTimer = createStageTimer();
  const timingBreakdown = {
    waitPostAuthReadyMs: 0,
    inspectSessionMs: 0,
    observeSessionMs: 0,
    confirmUiMs: 0,
    confirmResultMs: 0,
    totalMs: 0,
  };

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
    syncStageStep(options, { stage: 'post-auth-ready', step: 'stage-fail' });
    logStageFail('post-auth-ready', 'adapter 必需方法缺失', {
      context: buildStageLogContext(options),
      extra: 'missing=waitForPostAuthReady',
    });
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
  syncStageStep(options, { stage: 'post-auth-ready', step: 'wait-post-auth-ready' });
  logStageProgress('post-auth-ready', '等待 post-auth-ready 阶段入口', {
    context: buildStageLogContext(options),
  });
  const postAuthReadyStartMs = stageTimer.elapsedMs();
  const postAuthReady = await waitForPostAuthReady(page, runtime, context);
  timingBreakdown.waitPostAuthReadyMs = Math.max(0, stageTimer.elapsedMs() - postAuthReadyStartMs);
  if (postAuthReady?.ok) {
    syncStageStep(options, { stage: 'post-auth-ready', step: 'stage-success' });
    logStageSuccess('post-auth-ready', 'post-auth-ready 阶段入口就绪', {
      context: buildStageLogContext(options),
      extra: [
        postAuthReady?.state ? `state=${postAuthReady.state}` : '',
        postAuthReady?.source ? `source=${postAuthReady.source}` : '',
      ].filter(Boolean).join(' | '),
    });
  }
  // 如果入口不 ready，则直接按阶段 5 失败收口。
  if (!postAuthReady?.ok) {
    const classified = classifyPostAuthFailure
      ? classifyPostAuthFailure({ state: postAuthReady?.state || 'POST_AUTH_NOT_READY', source: postAuthReady?.source, value: postAuthReady?.value })
      : null;

    syncStageStep(options, { stage: 'post-auth-ready', step: 'stage-fail' });
    logStageFail('post-auth-ready', 'post-auth-ready 阶段入口失败', {
      context: buildStageLogContext(options),
      extra: [
        postAuthReady?.state ? `state=${postAuthReady.state}` : '',
        postAuthReady?.source ? `source=${postAuthReady.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });

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
      detail: buildPostAuthReadyStageDetail({
        postAuthReady,
        sessionInspection: null,
        uiConfirmation: null,
        resultConfirmation: null,
        classified,
        timingBreakdown,
      }),
    });
  }

  // 第二步：检查 session / storage / cookie 可用态；如果 adapter 还没实现，就保留 null。
  syncStageStep(options, { stage: 'post-auth-ready', step: 'inspect-session' });
  logStageProgress('post-auth-ready', '检查 session / storage / cookie 可用态', {
    context: buildStageLogContext(options),
  });
  const inspectSessionStartMs = stageTimer.elapsedMs();
  const sessionInspection = inspectPostAuthSession
    ? await inspectPostAuthSession(page, runtime, { ...context, postAuthReady })
    : null;
  timingBreakdown.inspectSessionMs = Math.max(0, stageTimer.elapsedMs() - inspectSessionStartMs);

  const sessionObservationTrace = [];
  let effectiveSessionInspection = sessionInspection;
  if (inspectPostAuthSession) {
    // 这是 shared 层唯一允许的一段有限 session observation loop。
    // 作用是等待 hard session 晚到，而不是在 shared 层重新实现站点级确认策略。
    const observationSteps = Array.isArray(runtime?.postAuthSessionObservationStepsMs) && runtime.postAuthSessionObservationStepsMs.length
      ? runtime.postAuthSessionObservationStepsMs
      : [500, 1500, 3000, 5000];
    let accumulatedWaitMs = 0;
    let promotedObservation = null;
    for (const rawStepMs of observationSteps) {
      const targetWaitMs = Math.max(0, Number(rawStepMs || 0));
      const deltaWaitMs = Math.max(0, targetWaitMs - accumulatedWaitMs);
      if (deltaWaitMs > 0) {
        await page.waitForTimeout(deltaWaitMs).catch(() => {});
      }
      accumulatedWaitMs = targetWaitMs;
      const observed = await inspectPostAuthSession(page, runtime, { ...context, postAuthReady, observation: true, observationWaitMs: targetWaitMs });
      sessionObservationTrace.push({
        waitMs: targetWaitMs,
        state: String(observed?.state || ''),
        source: String(observed?.source || ''),
        value: String(observed?.value || ''),
        strength: String(observed?.strength || ''),
        hasHardSession: Boolean(observed?.cookieSummary?.matchedValue),
        sessionId: String(observed?.cookieSummary?.matchedValue || ''),
        cookiePresentKeys: observed?.cookieSummary?.presentKeys || [],
        softCookiePresentKeys: observed?.cookieSummary?.softCookieSummary?.presentKeys || [],
        matchedDomain: String(observed?.cookieSummary?.matchedDomain || ''),
        currentUrl: String(page.url ? page.url() : ''),
      });
      if (!promotedObservation && observed?.cookieSummary?.matchedValue) {
        promotedObservation = observed;
        if (typeof logInfo === 'function') {
          logInfo(`postAuth.session.hard-detected | waitMs=${targetWaitMs} | source=${observed.source || ''} | value=${observed.value || ''}`);
        }
        break;
      }
    }
    timingBreakdown.observeSessionMs = Math.max(0, observationSteps.length ? accumulatedWaitMs : 0);
    if (promotedObservation) {
      effectiveSessionInspection = promotedObservation;
      if (typeof logInfo === 'function') {
        logInfo(`postAuth.session.promoted | source=${promotedObservation.source || ''} | value=${promotedObservation.value || ''} | matchedDomain=${promotedObservation?.cookieSummary?.matchedDomain || ''}`);
      }
    }
  }

  // 第三步：检查 UI 登录后信号；如果 adapter 还没实现，就保留 null。
  syncStageStep(options, { stage: 'post-auth-ready', step: 'confirm-ui-signal' });
  logStageProgress('post-auth-ready', '检查 UI 登录后信号', {
    context: buildStageLogContext(options),
  });
  const confirmUiStartMs = stageTimer.elapsedMs();
  const uiConfirmation = confirmPostAuthUi
    ? await confirmPostAuthUi(page, runtime, { ...context, postAuthReady, sessionInspection: effectiveSessionInspection })
    : null;
  timingBreakdown.confirmUiMs = Math.max(0, stageTimer.elapsedMs() - confirmUiStartMs);

  // 第四步：收口最终 success / failure / unknown；如果 adapter 还没实现，则回退 unknown。
  syncStageStep(options, { stage: 'post-auth-ready', step: 'confirm-post-auth-result' });
  logStageProgress('post-auth-ready', '确认 post-auth-ready 最终结果', {
    context: buildStageLogContext(options),
  });
  const confirmResultStartMs = stageTimer.elapsedMs();
  const resultConfirmation = confirmPostAuthResult
    ? await confirmPostAuthResult(page, runtime, { ...context, postAuthReady, sessionInspection: effectiveSessionInspection, uiConfirmation })
    : {
        ok: false,
        state: 'POST_AUTH_RESULT_UNKNOWN',
        nextStage: '',
        source: '',
        value: '',
        strength: '',
        settleStage: 'none',
      };
  timingBreakdown.confirmResultMs = Math.max(0, stageTimer.elapsedMs() - confirmResultStartMs);
  timingBreakdown.totalMs = stageTimer.elapsedMs();

  // 如果最终结果确认成功，则直接按成功结构收口。
  if (resultConfirmation?.ok) {
    syncStageStep(options, { stage: 'post-auth-ready', step: 'stage-success' });
    logStageSuccess('post-auth-ready', 'post-auth-ready 阶段成功', {
      context: buildStageLogContext(options),
      extra: [
        resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
        resultConfirmation?.nextStage ? `next=${resultConfirmation.nextStage}` : '',
        resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      ].filter(Boolean).join(' | '),
    });
    if (typeof logInfo === 'function') {
      logInfo(`postAuth.ready.success | state=${resultConfirmation.state || 'POST_AUTH_READY_ONLY'} | source=${resultConfirmation.source || ''} | value=${resultConfirmation.value || ''}`);
    }

    return normalizePostAuthReadyStageResult({
      success: true,
      state: String(resultConfirmation?.state || 'POST_AUTH_READY_ONLY'),
      reason: String(resultConfirmation?.state || 'POST_AUTH_READY_ONLY'),
      nextStage: String(resultConfirmation?.nextStage || 'account-delivery'),
      signalStrength: String(resultConfirmation?.strength || ''),
      settleStage: String(resultConfirmation?.settleStage || 'none'),
      detectionSource: String(resultConfirmation?.source || ''),
      stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
      retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
      detail: buildPostAuthReadyStageDetail({
        postAuthReady,
        sessionInspection: effectiveSessionInspection,
        initialSessionInspection: sessionInspection,
        sessionObservationTrace,
        uiConfirmation,
        resultConfirmation,
        classified: null,
        timingBreakdown,
      }),
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
  syncStageStep(options, { stage: 'post-auth-ready', step: 'stage-fail' });
    logStageFail('post-auth-ready', 'post-auth-ready 阶段失败', {
    context: buildStageLogContext(options),
    extra: [
      resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
      resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
  });
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
    detail: buildPostAuthReadyStageDetail({
      postAuthReady,
      sessionInspection: effectiveSessionInspection,
      initialSessionInspection: sessionInspection,
      sessionObservationTrace,
      uiConfirmation,
      resultConfirmation,
      classified,
      timingBreakdown,
    }),
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizePostAuthReadyStageResult,
  runPostAuthReadyStage,
};
