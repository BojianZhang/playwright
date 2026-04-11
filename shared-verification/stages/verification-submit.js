'use strict';

/**
 * verification-submit.js
 *
 * 这个文件是阶段 3（verification submit）的公共流程骨架。
 *
 * 它负责：
 * 1. 调用站点 adapter 等待 verification stage ready
 * 2. 调用站点 adapter 获取验证码
 * 3. 调用站点 adapter 解析验证码输入目标
 * 4. 调用站点 adapter 输入验证码
 * 5. 调用站点 adapter 确认提交结果
 * 6. 统一返回阶段结果
 *
 * 它不负责：
 * - 某站点的具体 selector
 * - 某站点的具体错误提示
 * - 某站点的具体验证码来源实现
 */

function resolveAdapterMethod(adapter, names = []) {
  for (const name of names) {
    if (typeof adapter?.[name] === 'function') {
      return adapter[name].bind(adapter);
    }
  }
  return null;
}

function normalizeVerificationStageResult(input = {}) {
  return {
    success: Boolean(input.success),
    stage: 'verification-submit',
    state: String(input.state || '').trim(),
    reason: String(input.reason || '').trim(),
    nextStage: String(input.nextStage || '').trim(),
    signalStrength: String(input.signalStrength || '').trim(),
    settleStage: String(input.settleStage || '').trim(),
    detectionSource: String(input.detectionSource || '').trim(),
    stateChanged: typeof input.stateChanged === 'boolean' ? input.stateChanged : null,
    detail: input.detail || null,
  };
}

async function runVerificationSubmitStage(options = {}) {
  const {
    page,
    account,
    adapter,
    runtime = {},
    context = {},
  } = options;

  if (!adapter) {
    return normalizeVerificationStageResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'VERIFICATION_STAGE_ADAPTER_MISSING',
    });
  }

  const waitForStageReady = resolveAdapterMethod(adapter, ['waitForVerificationStageReady', 'waitForDreaminaVerificationStageReady']);
  const fetchCode = resolveAdapterMethod(adapter, ['fetchVerificationCode', 'fetchDreaminaVerificationCode']);
  const resolveCodeInput = resolveAdapterMethod(adapter, ['resolveVerificationInput', 'resolveDreaminaVerificationInput']);
  const fillCode = resolveAdapterMethod(adapter, ['fillVerificationCode', 'fillDreaminaVerificationCode']);
  const confirmSubmitResult = resolveAdapterMethod(adapter, ['confirmVerificationSubmitResult', 'confirmDreaminaVerificationSubmitResult']);
  const classifyFailure = resolveAdapterMethod(adapter, ['classifyVerificationFailure', 'classifyDreaminaVerificationFailure']);

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

  const verificationReady = await waitForStageReady(page, runtime, context);
  if (!verificationReady?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: verificationReady?.state || 'VERIFICATION_STAGE_NOT_READY' }) : null;
    return normalizeVerificationStageResult({
      success: false,
      state: verificationReady?.state || 'VERIFICATION_STAGE_NOT_READY',
      reason: classified?.siteReason || classified?.reason || verificationReady?.state || 'VERIFICATION_STAGE_NOT_READY',
      signalStrength: verificationReady?.strength || '',
      detectionSource: verificationReady?.source || '',
      detail: { verificationReady, classified },
    });
  }

  const fetchCodeResult = await fetchCode(page, account, runtime, { ...context, verificationReady });
  if (!fetchCodeResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: fetchCodeResult?.state || 'VERIFICATION_CODE_NOT_AVAILABLE' }) : null;
    return normalizeVerificationStageResult({
      success: false,
      state: fetchCodeResult?.state || 'VERIFICATION_CODE_NOT_AVAILABLE',
      reason: classified?.siteReason || classified?.reason || fetchCodeResult?.state || 'VERIFICATION_CODE_NOT_AVAILABLE',
      detectionSource: fetchCodeResult?.source || '',
      detail: { verificationReady, fetchCodeResult, classified },
    });
  }

  const codeInputResolution = await resolveCodeInput(page, runtime, { ...context, verificationReady, fetchCodeResult });
  if (!codeInputResolution?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: codeInputResolution?.state || 'VERIFICATION_INPUT_NOT_FOUND' }) : null;
    return normalizeVerificationStageResult({
      success: false,
      state: codeInputResolution?.state || 'VERIFICATION_INPUT_NOT_FOUND',
      reason: classified?.siteReason || classified?.reason || codeInputResolution?.state || 'VERIFICATION_INPUT_NOT_FOUND',
      signalStrength: codeInputResolution?.strength || '',
      detectionSource: codeInputResolution?.source || '',
      detail: { verificationReady, fetchCodeResult, codeInputResolution, classified },
    });
  }

  const fillResult = await fillCode(page, fetchCodeResult.code, runtime, { ...context, verificationReady, fetchCodeResult, codeInputResolution });
  if (!fillResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: fillResult?.state || 'VERIFICATION_CODE_FILL_FAILED' }) : null;
    return normalizeVerificationStageResult({
      success: false,
      state: fillResult?.state || 'VERIFICATION_CODE_FILL_FAILED',
      reason: classified?.siteReason || classified?.reason || fillResult?.state || 'VERIFICATION_CODE_FILL_FAILED',
      detectionSource: fillResult?.source || '',
      stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
      detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, classified },
    });
  }

  const confirmResult = await confirmSubmitResult(page, runtime, {
    ...context,
    verificationReady,
    fetchCodeResult,
    codeInputResolution,
    fillResult,
  });

  if (confirmResult?.ok) {
    return normalizeVerificationStageResult({
      success: true,
      state: confirmResult?.state || 'VERIFICATION_SUBMIT_OK',
      reason: confirmResult?.state || 'VERIFICATION_SUBMIT_OK',
      nextStage: confirmResult?.nextStage || 'profile-completion',
      signalStrength: confirmResult?.strength || '',
      settleStage: confirmResult?.settleStage || '',
      detectionSource: confirmResult?.source || '',
      stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
      detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, confirmResult },
    });
  }

  const classified = classifyFailure ? classifyFailure({ reason: confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN' }) : null;
  return normalizeVerificationStageResult({
    success: false,
    state: confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN',
    reason: classified?.siteReason || classified?.reason || confirmResult?.state || 'VERIFICATION_RESULT_UNKNOWN',
    nextStage: '',
    signalStrength: confirmResult?.strength || '',
    settleStage: confirmResult?.settleStage || '',
    detectionSource: confirmResult?.source || '',
    stateChanged: typeof fillResult?.stateChanged === 'boolean' ? fillResult.stateChanged : null,
    detail: { verificationReady, fetchCodeResult, codeInputResolution, fillResult, confirmResult, classified },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeVerificationStageResult,
  runVerificationSubmitStage,
};
