'use strict';

/**
 * profile-completion-submit.js
 *
 * 这个文件是阶段 4（profile completion submit）的公共流程骨架。
 *
 * 设计目标：
 * - 只做阶段 4 的公共 orchestrate
 * - 不掺杂站点专属 selector / 文案 / 资料填写细节
 * - 把阶段 4 的结果统一压平成稳定契约
 *
 * 当前边界：
 * 1. 等 profile-completion ready
 * 2. 生成资料填写计划
 * 3. 填写 year / month / day
 * 4. 提交 profile-completion
 * 5. 确认提交结果
 * 6. 统一返回阶段结果
 *
 * 明确不负责：
 * - 首页打开
 * - 登录入口切换
 * - credential submit
 * - verification submit
 * - post-auth-ready 最终确认
 * - session / storage
 * - runner 调度
 */

/**
 * 从 adapter 上解析某个阶段方法。
 *
 * 作用：
 * - 同时兼容通用命名和 Dreamina 风格命名
 * - 避免公共层直接写死某个站点的方法名
 */
function resolveAdapterMethod(adapter, names = []) {
  // 依次尝试候选方法名，只要某个方法存在，就直接返回绑定后的函数。
  for (const name of names) {
    // 如果当前 adapter 上存在这个函数，就返回绑定 this 之后的方法引用。
    if (typeof adapter?.[name] === 'function') {
      // bind(adapter) 的目的是保证后续调用时 this 不丢失。
      return adapter[name].bind(adapter);
    }
  }
  // 所有候选方法都不存在时，返回 null，交给上层统一判 adapter 不完整。
  return null;
}

/**
 * 统一阶段 4 的返回结构。
 *
 * 作用：
 * - 不同站点 adapter 的返回值可能不完全一致
 * - 公共层在这里统一压平成 profile-completion-submit 的稳定结果结构
 */
function normalizeProfileCompletionStageResult(input = {}) {
  // 返回统一阶段结构，方便外层 orchestrator 和日志消费。
  return {
    // 当前阶段是否成功完成。
    success: Boolean(input.success),
    // 固定阶段名，方便外层识别这是第四阶段结果。
    stage: 'profile-completion-submit',
    // 阶段内原始状态码。
    state: String(input.state || '').trim(),
    // 对外更稳定的原因说明。
    reason: String(input.reason || '').trim(),
    // 成功后应推进到哪个阶段。
    nextStage: String(input.nextStage || '').trim(),
    // 当前结果信号强度。
    signalStrength: String(input.signalStrength || '').trim(),
    // 当前结果是在第几层确认里收敛出来的。
    settleStage: String(input.settleStage || '').trim(),
    // 当前结果主要基于哪种检测来源得出。
    detectionSource: String(input.detectionSource || '').trim(),
    // 当前页面/输入状态是否发生了有意义变化。
    stateChanged: typeof input.stateChanged === 'boolean' ? input.stateChanged : null,
    // 第四阶段内部轻量重试次数；第一版默认为 0。
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    // 阶段内部详细上下文，供调试和分析使用。
    detail: input.detail || null,
  };
}

/**
 * 阶段 4 主入口。
 *
 * 执行顺序：
 * 1. 等 profile-completion ready
 * 2. 生成资料填写计划
 * 3. 填写 year / month / day
 * 4. 提交 profile-completion
 * 5. 确认提交结果
 * 6. 成功则推进到 post-auth-ready
 * 7. 失败则走站点分类
 */
async function runProfileCompletionSubmitStage(options = {}) {
  // 从 options 中解构出当前阶段需要的公共输入。
  const {
    // 当前真实执行动作的页面对象。
    page,
    // 当前账号上下文。
    account,
    // 当前站点的阶段 4 adapter。
    adapter,
    // 阶段运行时参数。
    runtime = {},
    // 附加上下文，例如日志函数和阶段共享结果。
    context = {},
  } = options;

  // 如果 adapter 缺失，说明当前阶段没有站点实现，直接返回失败。
  if (!adapter) {
    return normalizeProfileCompletionStageResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'PROFILE_COMPLETION_STAGE_ADAPTER_MISSING',
    });
  }

  // 解析第四阶段所需的 adapter 方法。
  const waitForProfileReady = resolveAdapterMethod(adapter, ['waitForProfileCompletionReady', 'waitForDreaminaProfileCompletionReady']);
  const buildProfilePlan = resolveAdapterMethod(adapter, ['buildProfileCompletionPlan', 'buildDreaminaProfileCompletionPlan']);
  const fillYear = resolveAdapterMethod(adapter, ['fillBirthdayYear', 'fillDreaminaBirthdayYear']);
  const fillMonth = resolveAdapterMethod(adapter, ['fillBirthdayMonth', 'fillDreaminaBirthdayMonth']);
  const fillDay = resolveAdapterMethod(adapter, ['fillBirthdayDay', 'fillDreaminaBirthdayDay']);
  const fillBirthdayContinuous = resolveAdapterMethod(adapter, ['fillBirthdayContinuousFlow', 'fillDreaminaBirthdayContinuousFlow']);
  const submitProfileCompletion = resolveAdapterMethod(adapter, ['submitProfileCompletion', 'submitDreaminaProfileCompletion']);
  const confirmSubmitResult = resolveAdapterMethod(adapter, ['confirmProfileCompletionSubmitResult', 'confirmDreaminaProfileCompletionSubmitResult']);
  const classifyFailure = resolveAdapterMethod(adapter, ['classifyProfileCompletionFailure', 'classifyDreaminaProfileCompletionFailure']);

  // 如果阶段 4 必需方法不完整，就直接失败，不让主链继续跑半截。
  if (!waitForProfileReady || !buildProfilePlan || !fillYear || !fillMonth || !fillDay || !submitProfileCompletion || !confirmSubmitResult) {
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
        hasSubmitProfileCompletion: Boolean(submitProfileCompletion),
        hasConfirmSubmitResult: Boolean(confirmSubmitResult),
      },
    });
  }

  // 第一步：确认当前页面已经进入 profile-completion 阶段。
  const profileReady = await waitForProfileReady(page, runtime, context);
  // 如果阶段 4 都没 ready，后续资料填写就没有意义。
  if (!profileReady?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: profileReady?.state || 'PROFILE_COMPLETION_NOT_READY' }) : null;
    return normalizeProfileCompletionStageResult({
      success: false,
      state: profileReady?.state || 'PROFILE_COMPLETION_NOT_READY',
      reason: classified?.siteReason || classified?.reason || profileReady?.state || 'PROFILE_COMPLETION_NOT_READY',
      signalStrength: profileReady?.strength || '',
      detectionSource: profileReady?.source || '',
      detail: { profileReady, classified },
    });
  }

  // 第二步：生成本轮资料填写计划。
  const birthdayFillPlan = await buildProfilePlan(page, account, runtime, { ...context, profileReady });
  // 如果填写计划都生成不了，说明阶段 4 无法继续。
  if (!birthdayFillPlan?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: birthdayFillPlan?.state || 'PROFILE_COMPLETION_PLAN_FAILED' }) : null;
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

  if (fillBirthdayContinuous) {
    birthdayContinuousResult = await fillBirthdayContinuous(page, birthdayFillPlan, runtime, { ...context, profileReady, birthdayFillPlan });
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
    // 第三步：填写 year。
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

    // 第四步：填写 month。
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

    // 第五步：填写 day。
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

  // 第六步：提交 profile completion。
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
  // 如果提交动作本身失败，就在这一层直接收口。
  if (!submitResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: submitResult?.state || 'PROFILE_COMPLETION_SUBMIT_FAILED' }) : null;
    return normalizeProfileCompletionStageResult({
      success: false,
      state: submitResult?.state || 'PROFILE_COMPLETION_SUBMIT_FAILED',
      reason: classified?.siteReason || classified?.reason || submitResult?.state || 'PROFILE_COMPLETION_SUBMIT_FAILED',
      detectionSource: submitResult?.source || '',
      stateChanged: typeof submitResult?.stateChanged === 'boolean' ? submitResult.stateChanged : null,
      detail: { profileReady, birthdayFillPlan, birthdayContinuousResult, yearFillResult, monthFillResult, dayFillResult, submitResult, classified },
    });
  }

  // 第七步：确认提交结果。
  const confirmResult = await confirmSubmitResult(page, runtime, {
    ...context,
    profileReady,
    birthdayFillPlan,
    yearFillResult,
    monthFillResult,
    dayFillResult,
    submitResult,
  });

  // 如果确认结果成功，说明当前阶段可以推进到 post-auth-ready。
  if (confirmResult?.ok) {
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

  // 到这里说明确认结果没有成功，需要进入失败分类。
  const classified = classifyFailure ? classifyFailure({ reason: confirmResult?.state || 'PROFILE_COMPLETION_RESULT_UNKNOWN' }) : null;
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

// 导出阶段 4 公共层可复用的主能力。
module.exports = {
  // 导出方法解析工具，方便后续测试或别的阶段复用同类模式。
  resolveAdapterMethod,
  // 导出统一结果结构归一化方法。
  normalizeProfileCompletionStageResult,
  // 导出阶段 4 主入口。
  runProfileCompletionSubmitStage,
};
