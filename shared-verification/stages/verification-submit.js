'use strict';

/**
 * verification-submit.js
 *
 * 这个文件是阶段 3（verification submit）的公共流程骨架。
 *
 * 设计目标：
 * - 只做阶段 3 的公共 orchestrate
 * - 不掺杂站点专属 selector / 文案 / provider 实现细节
 * - 把阶段 3 的结果统一压平成稳定契约
 *
 * 当前边界：
 * 1. 等 verification stage ready
 * 2. 获取验证码
 * 3. 解析验证码输入目标
 * 4. 输入验证码
 * 5. 确认提交结果
 * 6. 统一返回阶段结果
 *
 * 明确不负责：
 * - 首页打开
 * - 登录入口切换
 * - credential submit
 * - birthday / profile completion 实际填写
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
 * 统一阶段 3 的返回结构。
 *
 * 作用：
 * - 不同站点 adapter 的返回值可能不完全一致
 * - 公共层在这里统一压平成 verification-submit 的稳定结果结构
 */
function normalizeVerificationStageResult(input = {}) {
  // 返回统一阶段结构，方便外层 orchestrator 和日志消费。
  return {
    // 当前阶段是否成功完成。
    success: Boolean(input.success),
    // 固定阶段名，方便外层识别这是第三阶段结果。
    stage: 'verification-submit',
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
    // verification 内有限重试次数。
    retryCount: Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    // 阶段内部详细上下文，供调试和分析使用。
    detail: input.detail || null,
  };
}

/**
 * 阶段 3 主入口。
 *
 * 执行顺序：
 * 1. 等 verification stage ready
 * 2. 获取验证码
 * 3. 解析验证码输入目标
 * 4. 输入验证码
 * 5. 确认提交结果
 * 6. 成功则推进到 profile-completion
 * 7. 失败则走站点分类
 */
async function runVerificationSubmitStage(options = {}) {
  // 从 options 中解构出当前阶段需要的公共输入。
  const {
    // 当前真实执行动作的页面对象。
    page,
    // 当前账号上下文。
    account,
    // 当前站点的阶段 3 adapter。
    adapter,
    // 阶段运行时参数。
    runtime = {},
    // 附加上下文，例如日志函数和阶段共享结果。
    context = {},
  } = options;

  // 如果 adapter 缺失，说明当前阶段根本没有站点实现，直接按统一结构返回失败。
  if (!adapter) {
    return normalizeVerificationStageResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'VERIFICATION_STAGE_ADAPTER_MISSING',
    });
  }

  // 解析“等待 verification ready”的方法。
  const waitForStageReady = resolveAdapterMethod(adapter, ['waitForVerificationStageReady', 'waitForDreaminaVerificationStageReady']);
  // 解析“获取验证码”的方法。
  const fetchCode = resolveAdapterMethod(adapter, ['fetchVerificationCode', 'fetchDreaminaVerificationCode']);
  const triggerCodeResend = resolveAdapterMethod(adapter, ['triggerVerificationCodeResend', 'triggerDreaminaVerificationCodeResend']);
  // 解析“找到验证码输入目标”的方法。
  const resolveCodeInput = resolveAdapterMethod(adapter, ['resolveVerificationInput', 'resolveDreaminaVerificationInput']);
  // 解析“输入验证码”的方法。
  const fillCode = resolveAdapterMethod(adapter, ['fillVerificationCode', 'fillDreaminaVerificationCode']);
  // 解析“确认验证码提交结果”的方法。
  const confirmSubmitResult = resolveAdapterMethod(adapter, ['confirmVerificationSubmitResult', 'confirmDreaminaVerificationSubmitResult']);
  // 解析“站点失败分类”的方法。
  const classifyFailure = resolveAdapterMethod(adapter, ['classifyVerificationFailure', 'classifyDreaminaVerificationFailure']);

  // 如果阶段 3 必需方法不完整，就直接失败，不让主链继续跑到半截。
  if (!waitForStageReady || !fetchCode || !resolveCodeInput || !fillCode || !confirmSubmitResult) {
    return normalizeVerificationStageResult({
      success: false,
      state: 'ADAPTER_INCOMPLETE',
      reason: 'VERIFICATION_STAGE_REQUIRED_METHOD_MISSING',
      detail: {
        hasWaitForStageReady: Boolean(waitForStageReady),
        hasFetchCode: Boolean(fetchCode),
        hasResolveCodeInput: Boolean(resolveCodeInput),
        hasFillCode: Boolean(fillCode),
        hasConfirmSubmitResult: Boolean(confirmSubmitResult),
      },
    });
  }

  // 第一步：确认当前页面已经进入 verification 阶段。
  const verificationReady = await waitForStageReady(page, runtime, context);
  // 如果 verification 阶段都没 ready，后续获取验证码和填码都没有意义。
  if (!verificationReady?.ok) {
    // 先尝试走站点失败分类，让 reason 更贴近站点语义。
    const classified = classifyFailure ? classifyFailure({ reason: verificationReady?.state || 'VERIFICATION_STAGE_NOT_READY' }) : null;
    // 按统一结构返回失败结果。
    return normalizeVerificationStageResult({
      success: false,
      state: verificationReady?.state || 'VERIFICATION_STAGE_NOT_READY',
      reason: classified?.siteReason || classified?.reason || verificationReady?.state || 'VERIFICATION_STAGE_NOT_READY',
      signalStrength: verificationReady?.strength || '',
      detectionSource: verificationReady?.source || '',
      detail: { verificationReady, classified },
    });
  }

  // 从 runtime 中读取 verification 阶段内部重试上限；默认允许第一次尝试 + 1 次重试。
  const verificationRetryMaxAttempts = Math.max(1, Number(runtime?.verificationRetryMaxAttempts || 2));
  // 维护一个已使用验证码集合，避免 wrong code 后反复拿到并重复填写同一个验证码。
  const usedCodes = new Set();
  // 记录最近一次获取验证码结果。
  let fetchCodeResult = null;
  // 记录最近一次输入目标解析结果。
  let codeInputResolution = null;
  // 记录最近一次输入结果。
  let fillResult = null;
  // 记录最近一次确认结果。
  let confirmResult = null;
  // 记录当前重试摘要，方便最终 detail 对外输出。
  const retrySummary = [];

  // 从第一次尝试开始，最多执行 verificationRetryMaxAttempts 轮 verification 内部尝试。
  for (let attemptIndex = 1; attemptIndex <= verificationRetryMaxAttempts; attemptIndex++) {
    // 第二步：获取验证码。
    fetchCodeResult = await fetchCode(page, account, runtime, {
      ...context,
      verificationReady,
      usedCodes,
      attemptIndex,
    });
    // 记录本轮拉码摘要，便于后续分析 verification 内部重试过程。
    retrySummary.push({
      attemptIndex,
      fetchState: fetchCodeResult?.state || '',
      code: String(fetchCodeResult?.code || ''),
      provider: String(fetchCodeResult?.provider || ''),
      matchMode: String(fetchCodeResult?.matchMode || ''),
    });
    // 如果验证码拿不到，第三阶段也无法继续。
    if (!fetchCodeResult?.ok) {
      const duplicateSkipped = String(fetchCodeResult?.value || '').startsWith('DUPLICATE_CODE_SKIPPED:');
      if (duplicateSkipped && attemptIndex < verificationRetryMaxAttempts) {
        const resendResult = triggerCodeResend
          ? await triggerCodeResend(page, runtime, {
              ...context,
              verificationReady,
              fetchCodeResult,
              usedCodes,
              attemptIndex,
            })
          : null;

        retrySummary.push({
          attemptIndex,
          resendState: resendResult?.state || (triggerCodeResend ? 'VERIFICATION_CODE_RESEND_NOT_AVAILABLE' : 'VERIFICATION_CODE_RESEND_UNSUPPORTED'),
          action: 'resend-and-refetch',
        });

        if (resendResult?.ok) {
          continue;
        }
      }

      // 先尝试按站点语义分类失败原因。
      const classified = classifyFailure ? classifyFailure({ reason: fetchCodeResult?.state || 'VERIFICATION_CODE_NOT_AVAILABLE' }) : null;
      // 返回统一失败结果。
      return normalizeVerificationStageResult({
        success: false,
        state: fetchCodeResult?.state || 'VERIFICATION_CODE_NOT_AVAILABLE',
        reason: classified?.siteReason || classified?.reason || fetchCodeResult?.state || 'VERIFICATION_CODE_NOT_AVAILABLE',
        detectionSource: fetchCodeResult?.source || '',
        retryCount: attemptIndex - 1,
        detail: { verificationReady, fetchCodeResult, classified, retrySummary },
      });
    }

    // 只要当前拉到的验证码非空，就把它加入 usedCodes，避免下一轮继续重复消费同一个验证码。
    if (String(fetchCodeResult?.code || '').trim()) {
      usedCodes.add(String(fetchCodeResult.code).trim());
    }

    // 第三步：解析验证码输入目标。
    codeInputResolution = await resolveCodeInput(page, runtime, { ...context, verificationReady, fetchCodeResult, usedCodes, attemptIndex });
    // 如果连输入目标都找不到，就不能继续输入验证码。
    if (!codeInputResolution?.ok) {
      // 先尝试按站点语义分类失败原因。
      const classified = classifyFailure ? classifyFailure({ reason: codeInputResolution?.state || 'VERIFICATION_INPUT_NOT_FOUND' }) : null;
      // 返回统一失败结果。
      return normalizeVerificationStageResult({
        success: false,
        state: codeInputResolution?.state || 'VERIFICATION_INPUT_NOT_FOUND',
        reason: classified?.siteReason || classified?.reason || codeInputResolution?.state || 'VERIFICATION_INPUT_NOT_FOUND',
        signalStrength: codeInputResolution?.strength || '',
        detectionSource: codeInputResolution?.source || '',
        retryCount: attemptIndex - 1,
        detail: { verificationReady, fetchCodeResult, codeInputResolution, classified, retrySummary },
      });
    }

    // 第四步：执行验证码输入动作。
    fillResult = await fillCode(page, fetchCodeResult.code, runtime, { ...context, verificationReady, fetchCodeResult, codeInputResolution, usedCodes, attemptIndex });
    // 如果验证码输入动作失败，就在这一层直接收口，不继续误跑到结果确认。
    if (!fillResult?.ok) {
      // 先尝试按站点语义分类失败原因。
      const classified = classifyFailure ? classifyFailure({ reason: fillResult?.state || 'VERIFICATION_CODE_FILL_FAILED' }) : null;
      // 返回统一失败结果。
      return normalizeVerificationStageResult({
        success: false,
        state: fillResult?.state || 'VERIFICATION_CODE_FILL_FAILED',
        reason: classified?.siteReason || classified?.reason || fillResult?.state || 'VERIFICATION_CODE_FILL_FAILED',
        detectionSource: fillResult?.source || '',
        stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
        retryCount: attemptIndex - 1,
        detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, classified, retrySummary },
      });
    }

    // 第五步：确认验证码提交结果。
    confirmResult = await confirmSubmitResult(page, runtime, {
      ...context,
      verificationReady,
      fetchCodeResult,
      codeInputResolution,
      fillResult,
      usedCodes,
      attemptIndex,
    });

    // 如果确认结果成功，说明当前阶段可以推进到下一阶段。
    if (confirmResult?.ok) {
      // 返回统一成功结构。
      return normalizeVerificationStageResult({
        success: true,
        state: confirmResult?.state || 'VERIFICATION_SUBMIT_OK',
        reason: confirmResult?.state || 'VERIFICATION_SUBMIT_OK',
        nextStage: confirmResult?.nextStage || 'profile-completion',
        signalStrength: confirmResult?.strength || '',
        settleStage: confirmResult?.settleStage || '',
        detectionSource: confirmResult?.source || '',
        stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
        retryCount: attemptIndex - 1,
        detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, confirmResult, retrySummary },
      });
    }

    // 如果当前轮返回 wrong code，并且后面还有剩余轮次，则进入 verification 阶段内下一轮重试。
    if (String(confirmResult?.state || '') === 'WRONG_VERIFICATION_CODE' && attemptIndex < verificationRetryMaxAttempts) {
      retrySummary.push({
        attemptIndex,
        confirmState: 'WRONG_VERIFICATION_CODE',
        action: 'retry-next-code',
      });
      continue;
    }

    // 走到这里说明当前确认结果没有成功，且不应继续 verification 内重试，需要进入失败分类。
    const classified = classifyFailure ? classifyFailure({ reason: confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN' }) : null;
    // 返回统一失败结构。
    return normalizeVerificationStageResult({
      success: false,
      state: confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN',
      reason: classified?.siteReason || classified?.reason || confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN',
      nextStage: '',
      signalStrength: confirmResult?.strength || '',
      settleStage: confirmResult?.settleStage || '',
      detectionSource: confirmResult?.source || '',
      stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
      retryCount: attemptIndex - 1,
      detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, confirmResult, classified, retrySummary },
    });
  }

  // 理论上不应走到这里；如果真的走到这里，按 unknown 兜底返回，避免主链无返回。
  return normalizeVerificationStageResult({
    success: false,
    state: confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN',
    reason: confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN',
    nextStage: '',
    signalStrength: confirmResult?.strength || '',
    settleStage: confirmResult?.settleStage || '',
    detectionSource: confirmResult?.source || '',
    stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
    retryCount: Math.max(0, verificationRetryMaxAttempts - 1),
    detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, confirmResult, retrySummary },
  });
}

// 导出阶段 3 公共层可复用的主能力。
module.exports = {
  // 导出方法解析工具，方便后续测试或别的阶段复用同类模式。
  resolveAdapterMethod,
  // 导出统一结果结构归一化方法。
  normalizeVerificationStageResult,
  // 导出阶段 3 主入口。
  runVerificationSubmitStage,
};
