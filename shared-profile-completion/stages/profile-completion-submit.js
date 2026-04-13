'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../../shared-stage-logger');

/**
 * profile-completion-submit.js
 *
 * Shared stage-4 orchestrator for profile completion submit.
 *
 * Boundary:
 * 1. wait for profile-completion ready
 * 2. build profile completion plan
 * 3. fill birthday fields
 * 4. submit profile-completion
 * 5. confirm submit result
 * 6. normalize final stage result
 */

/**
 * Resolve an adapter method from multiple candidate names.
 */
function resolveAdapterMethod(adapter, names = []) {
  for (const name of names) {
    if (typeof adapter?.[name] === 'function') {
      return adapter[name].bind(adapter);
    }
  }
  return null;
}

/**
 * Normalize stage-4 output shape.
 */
function normalizeProfileCompletionStageResult(input = {}) {
  return {
    success: Boolean(input.success),
    stage: 'profile-completion-submit',
    state: String(input.state || '').trim(),
    reason: String(input.reason || '').trim(),
    nextStage: String(input.nextStage || '').trim(),
    signalStrength: String(input.signalStrength || '').trim(),
    settleStage: String(input.settleStage || '').trim(),
    detectionSource: String(input.detectionSource || '').trim(),
    stateChanged: typeof input.stateChanged === 'boolean' ? input.stateChanged : null,
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    detail: input.detail || null,
  };
}

/**
 * Stage-4 main entry.
 *
 * Flow:
 * 1. wait for profile-completion ready
 * 2. build birthday/profile plan
 * 3. run continuous-flow or split-flow fill path
 * 4. submit profile-completion
 * 5. confirm submit result
 * 6. success -> next stage post-auth-ready
 * 7. failure -> classify by site adapter
 */
async function runProfileCompletionSubmitStage(options = {}) {
  const {
    page,
    account,
    adapter,
    runtime = {},
    context = {},
  } = options;

  const stageTimer = createStageTimer();

  if (!adapter) {
    logStageFail('profile-completion-submit', 'adapter 缺失', {
      context: buildStageLogContext(options),
      extra: 'reason=PROFILE_COMPLETION_STAGE_ADAPTER_MISSING',
    });
    return normalizeProfileCompletionStageResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'PROFILE_COMPLETION_STAGE_ADAPTER_MISSING',
    });
  }

  const waitForProfileReady = resolveAdapterMethod(adapter, ['waitForProfileCompletionReady', 'waitForDreaminaProfileCompletionReady']);
  const buildProfilePlan = resolveAdapterMethod(adapter, ['buildProfileCompletionPlan', 'buildDreaminaProfileCompletionPlan']);
  const fillYear = resolveAdapterMethod(adapter, ['fillBirthdayYear', 'fillDreaminaBirthdayYear']);
  const fillMonth = resolveAdapterMethod(adapter, ['fillBirthdayMonth', 'fillDreaminaBirthdayMonth']);
  const fillDay = resolveAdapterMethod(adapter, ['fillBirthdayDay', 'fillDreaminaBirthdayDay']);
  const fillBirthdayContinuous = resolveAdapterMethod(adapter, ['fillBirthdayContinuousFlow', 'fillDreaminaBirthdayContinuousFlow']);
  const submitProfileCompletion = resolveAdapterMethod(adapter, ['submitProfileCompletion', 'submitDreaminaProfileCompletion']);
  const confirmSubmitResult = resolveAdapterMethod(adapter, ['confirmProfileCompletionSubmitResult', 'confirmDreaminaProfileCompletionSubmitResult']);
  const classifyFailure = resolveAdapterMethod(adapter, ['classifyProfileCompletionFailure', 'classifyDreaminaProfileCompletionFailure']);

  const hasSplitFlowMethods = Boolean(fillYear && fillMonth && fillDay);
  const hasContinuousFlowMethod = Boolean(fillBirthdayContinuous);

  // Base required capabilities must exist.
  // Fill path can be either continuous-flow or split-flow.
  if (!waitForProfileReady || !buildProfilePlan || !submitProfileCompletion || !confirmSubmitResult || (!hasContinuousFlowMethod && !hasSplitFlowMethods)) {
    logStageFail('profile-completion-submit', 'adapter 必需方法缺失', {
      context: buildStageLogContext(options),
      extra: [
        `hasWaitForProfileReady=${Boolean(waitForProfileReady)}`,
        `hasBuildProfilePlan=${Boolean(buildProfilePlan)}`,
        `hasSubmitProfileCompletion=${Boolean(submitProfileCompletion)}`,
        `hasConfirmSubmitResult=${Boolean(confirmSubmitResult)}`,
        `hasContinuousFlowMethod=${Boolean(hasContinuousFlowMethod)}`,
        `hasSplitFlowMethods=${Boolean(hasSplitFlowMethods)}`,
      ].join(' | '),
    });
    return normalizeProfileCompletionStageResult({
      success: false,
      state: 'ADAPTER_INCOMPLETE',
      reason: 'PROFILE_COMPLETION_STAGE_REQUIRED_METHOD_MISSING',
      detail: {
        hasWaitForProfileReady: Boolean(waitForProfileReady),
        hasBuildProfilePlan: Boolean(buildProfilePlan),
        hasFillYear: Boolean(fillYear),
        hasFillMonth: Boolean(fillMonth),
        hasFillDay: Boolean(fillDay),
        hasFillBirthdayContinuous: Boolean(fillBirthdayContinuous),
        hasSplitFlowMethods,
        hasContinuousFlowMethod,
        hasSubmitProfileCompletion: Boolean(submitProfileCompletion),
        hasConfirmSubmitResult: Boolean(confirmSubmitResult),
      },
    });
  }

  const readyTimer = createStageTimer();
  logStageProgress('profile-completion-submit', '等待资料补全阶段 ready', {
    context: buildStageLogContext(options),
  });
  const profileReady = await waitForProfileReady(page, runtime, context);
  if (profileReady?.ok) {
    logStageSuccess('profile-completion-submit', '资料补全阶段 ready', {
      context: buildStageLogContext(options),
      extra: [
        profileReady?.state ? `state=${profileReady.state}` : '',
        profileReady?.source ? `source=${profileReady.source}` : '',
        profileReady?.strength ? `strength=${profileReady.strength}` : '',
        `stepDurationMs=${formatDurationMs(readyTimer.elapsedMs())}`,
      ].filter(Boolean).join(' | '),
    });
  }
  if (!profileReady?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: profileReady?.state || 'PROFILE_COMPLETION_NOT_READY' }) : null;
    logStageFail('profile-completion-submit', '资料补全阶段未就绪', {
      context: buildStageLogContext(options),
      extra: [
        profileReady?.state ? `state=${profileReady.state}` : '',
        profileReady?.source ? `source=${profileReady.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    return normalizeProfileCompletionStageResult({
      success: false,
      state: profileReady?.state || 'PROFILE_COMPLETION_NOT_READY',
      reason: classified?.siteReason || classified?.reason || profileReady?.state || 'PROFILE_COMPLETION_NOT_READY',
      signalStrength: profileReady?.strength || '',
      detectionSource: profileReady?.source || '',
      detail: { profileReady, classified },
    });
  }

  const planTimer = createStageTimer();
  logStageProgress('profile-completion-submit', '生成资料填写计划', {
    context: buildStageLogContext(options),
  });
  const birthdayFillPlan = await buildProfilePlan(page, account, runtime, { ...context, profileReady });
  if (birthdayFillPlan?.ok) {
    logStageSuccess('profile-completion-submit', '资料填写计划生成成功', {
      context: buildStageLogContext(options),
      extra: [
        birthdayFillPlan?.state ? `state=${birthdayFillPlan.state}` : '',
        birthdayFillPlan?.source ? `source=${birthdayFillPlan.source}` : '',
        `stepDurationMs=${formatDurationMs(planTimer.elapsedMs())}`,
      ].filter(Boolean).join(' | '),
    });
  }
  if (!birthdayFillPlan?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: birthdayFillPlan?.state || 'PROFILE_COMPLETION_PLAN_FAILED' }) : null;
    logStageFail('profile-completion-submit', '资料填写计划生成失败', {
      context: buildStageLogContext(options),
      extra: [
        birthdayFillPlan?.state ? `state=${birthdayFillPlan.state}` : '',
        birthdayFillPlan?.source ? `source=${birthdayFillPlan.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    return normalizeProfileCompletionStageResult({
      success: false,
      state: birthdayFillPlan?.state || 'PROFILE_COMPLETION_PLAN_FAILED',
      reason: classified?.siteReason || classified?.reason || birthdayFillPlan?.state || 'PROFILE_COMPLETION_PLAN_FAILED',
      detectionSource: birthdayFillPlan?.source || '',
      detail: { profileReady, birthdayFillPlan, classified },
    });
  }

  let yearFillResult = null;
  let monthFillResult = null;
  let dayFillResult = null;
  let birthdayContinuousResult = null;
  const hasContinuousFlow = Boolean(fillBirthdayContinuous);
  const hasSplitFlow = Boolean(fillYear && fillMonth && fillDay);

  if (fillBirthdayContinuous) {
    const fillTimer = createStageTimer();
    logStageProgress('profile-completion-submit', '执行 birthday continuous flow', {
      context: buildStageLogContext(options),
    });
    birthdayContinuousResult = await fillBirthdayContinuous(page, birthdayFillPlan, runtime, { ...context, profileReady, birthdayFillPlan });
    if (birthdayContinuousResult?.ok) {
      logStageSuccess('profile-completion-submit', 'birthday continuous flow 成功', {
        context: buildStageLogContext(options),
        extra: [
          birthdayContinuousResult?.state ? `state=${birthdayContinuousResult.state}` : '',
          `stepDurationMs=${formatDurationMs(fillTimer.elapsedMs())}`,
        ].filter(Boolean).join(' | '),
      });
    }
  }

  if (birthdayContinuousResult?.ok) {
    yearFillResult = {
      ok: true,
      state: 'BIRTHDAY_YEAR_FILLED',
      source: 'profile-input',
      value: birthdayContinuousResult?.detail?.year || '',
      stateChanged: true,
      mode: 'continuous-flow',
    };
    monthFillResult = {
      ok: true,
      state: 'BIRTHDAY_MONTH_FILLED',
      source: 'profile-input',
      value: birthdayContinuousResult?.detail?.month || '',
      stateChanged: true,
      mode: 'continuous-flow',
      attempts: [],
      nextState: birthdayContinuousResult?.detail?.nextState || null,
    };
    dayFillResult = {
      ok: true,
      state: 'BIRTHDAY_DAY_FILLED',
      source: 'profile-input',
      value: birthdayContinuousResult?.detail?.day || '',
      stateChanged: true,
      mode: 'continuous-flow',
      attempts: [],
      nextState: birthdayContinuousResult?.detail?.nextState || null,
    };
  } else if (hasSplitFlow) {
    logStageProgress('profile-completion-submit', 'continuous flow 不可用，进入 split fallback', {
      context: buildStageLogContext(options),
    });
    yearFillResult = await fillYear(page, birthdayFillPlan, runtime, { ...context, profileReady, birthdayFillPlan, birthdayContinuousResult });
    if (!yearFillResult?.ok) {
      const classified = classifyFailure ? classifyFailure({ reason: yearFillResult?.state || 'BIRTHDAY_YEAR_FILL_FAILED' }) : null;
      return normalizeProfileCompletionStageResult({
        success: false,
        state: yearFillResult?.state || 'BIRTHDAY_YEAR_FILL_FAILED',
        reason: classified?.siteReason || classified?.reason || yearFillResult?.state || 'BIRTHDAY_YEAR_FILL_FAILED',
        detectionSource: yearFillResult?.source || '',
        stateChanged: typeof yearFillResult?.stateChanged === 'boolean' ? yearFillResult.stateChanged : null,
        detail: { profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult, classified },
      });
    }

    monthFillResult = await fillMonth(page, birthdayFillPlan, runtime, { ...context, profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult });
    if (!monthFillResult?.ok) {
      const classified = classifyFailure ? classifyFailure({ reason: monthFillResult?.state || 'BIRTHDAY_MONTH_FILL_FAILED' }) : null;
      return normalizeProfileCompletionStageResult({
        success: false,
        state: monthFillResult?.state || 'BIRTHDAY_MONTH_FILL_FAILED',
        reason: classified?.siteReason || classified?.reason || monthFillResult?.state || 'BIRTHDAY_MONTH_FILL_FAILED',
        detectionSource: monthFillResult?.source || '',
        stateChanged: typeof monthFillResult?.stateChanged === 'boolean' ? monthFillResult.stateChanged : null,
        detail: { profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult, monthFillResult, classified },
      });
    }

    dayFillResult = await fillDay(page, birthdayFillPlan, runtime, { ...context, profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult, monthFillResult });
    if (!dayFillResult?.ok) {
      const classified = classifyFailure ? classifyFailure({ reason: dayFillResult?.state || 'BIRTHDAY_DAY_FILL_FAILED' }) : null;
      return normalizeProfileCompletionStageResult({
        success: false,
        state: dayFillResult?.state || 'BIRTHDAY_DAY_FILL_FAILED',
        reason: classified?.siteReason || classified?.reason || dayFillResult?.state || 'BIRTHDAY_DAY_FILL_FAILED',
        detectionSource: dayFillResult?.source || '',
        stateChanged: typeof dayFillResult?.stateChanged === 'boolean' ? dayFillResult.stateChanged : null,
        detail: { profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult, monthFillResult, dayFillResult, classified },
      });
    }
  } else {
    return normalizeProfileCompletionStageResult({
      success: false,
      state: 'ADAPTER_INCOMPLETE',
      reason: 'PROFILE_COMPLETION_STAGE_NO_ACTIVE_FILL_PATH',
      detail: { profileReady, birthdayFillPlan, hasContinuousFlow, hasSplitFlow, birthdayContinuousResult },
    });
  }

  const submitTimer = createStageTimer();
  logStageProgress('profile-completion-submit', '提交资料补全结果', {
    context: buildStageLogContext(options),
  });
  const submitResult = birthdayContinuousResult?.ok && birthdayContinuousResult?.detail?.submitPerformed
    ? {
        ok: true,
        state: 'PROFILE_COMPLETION_SUBMITTED',
        source: birthdayContinuousResult?.detail?.submitOwner || 'continuous-flow',
        value: 'birthday-continuous-flow-submitted',
        beforeSnapshot: null,
        afterSnapshot: null,
        stateChanged: true,
      }
    : await submitProfileCompletion(page, runtime, { ...context, profileReady, birthdayFillPlan, yearFillResult, monthFillResult, dayFillResult, birthdayContinuousResult });
  if (!submitResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: submitResult?.state || 'PROFILE_COMPLETION_SUBMIT_FAILED' }) : null;
    logStageFail('profile-completion-submit', '资料补全提交失败', {
      context: buildStageLogContext(options),
      extra: [
        submitResult?.state ? `state=${submitResult.state}` : '',
        submitResult?.source ? `source=${submitResult.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    return normalizeProfileCompletionStageResult({
      success: false,
      state: submitResult?.state || 'PROFILE_COMPLETION_SUBMIT_FAILED',
      reason: classified?.siteReason || classified?.reason || submitResult?.state || 'PROFILE_COMPLETION_SUBMIT_FAILED',
      detectionSource: submitResult?.source || '',
      stateChanged: typeof submitResult?.stateChanged === 'boolean' ? submitResult.stateChanged : null,
      detail: { profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult, monthFillResult, dayFillResult, submitResult, classified },
    });
  }

  const confirmTimer = createStageTimer();
  logStageProgress('profile-completion-submit', '确认资料补全提交结果', {
    context: buildStageLogContext(options),
  });
  const confirmResult = await confirmSubmitResult(page, runtime, {
    ...context,
    profileReady,
    birthdayFillPlan,
    yearFillResult,
    monthFillResult,
    dayFillResult,
    submitResult,
  });

  if (confirmResult?.ok) {
    logStageSuccess('profile-completion-submit', '资料补全提交成功', {
      context: buildStageLogContext(options),
      extra: [
        confirmResult?.state ? `state=${confirmResult.state}` : '',
        confirmResult?.nextStage ? `next=${confirmResult.nextStage}` : '',
        confirmResult?.source ? `source=${confirmResult.source}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    return normalizeProfileCompletionStageResult({
      success: true,
      state: confirmResult?.state || 'PROFILE_COMPLETION_SUBMIT_OK',
      reason: confirmResult?.state || 'PROFILE_COMPLETION_SUBMIT_OK',
      nextStage: confirmResult?.nextStage || 'post-auth-ready',
      signalStrength: confirmResult?.strength || '',
      settleStage: confirmResult?.settleStage || '',
      detectionSource: confirmResult?.source || '',
      stateChanged: typeof submitResult?.stateChanged === 'boolean' ? submitResult.stateChanged : null,
      detail: { profileReady, birthdayFillPlan, yearFillResult, monthFillResult, dayFillResult, submitResult, confirmResult },
    });
  }

  const classified = classifyFailure ? classifyFailure({ reason: confirmResult?.state || 'PROFILE_COMPLETION_RESULT_UNKNOWN' }) : null;
  logStageFail('profile-completion-submit', '资料补全结果失败', {
    context: buildStageLogContext(options),
    extra: [
      confirmResult?.state ? `state=${confirmResult.state}` : '',
      confirmResult?.source ? `source=${confirmResult.source}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
  });
  return normalizeProfileCompletionStageResult({
    success: false,
    state: confirmResult?.state || 'PROFILE_COMPLETION_RESULT_UNKNOWN',
    reason: classified?.siteReason || classified?.reason || confirmResult?.state || 'PROFILE_COMPLETION_RESULT_UNKNOWN',
    nextStage: '',
    signalStrength: confirmResult?.strength || '',
    settleStage: confirmResult?.settleStage || '',
    detectionSource: confirmResult?.source || '',
    stateChanged: typeof submitResult?.stateChanged === 'boolean' ? submitResult.stateChanged : null,
    detail: { profileReady, birthdayFillPlan, yearFillResult, monthFillResult, dayFillResult, submitResult, confirmResult, classified },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeProfileCompletionStageResult,
  runProfileCompletionSubmitStage,
};