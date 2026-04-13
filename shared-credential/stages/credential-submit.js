'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
} = require('../../shared-stage-logger');

/**
 * credential-submit.js
 *
 * 这个文件是阶段 2（credential submit）的公共流程骨架。
 *
 * 它负责：
 * 1. 调用站点 adapter 等待表单 ready
 * 2. 调用站点 adapter 填写 credential 字段
 * 3. 调用站点 adapter 提交表单
 * 4. 调用站点 adapter 确认提交结果
 * 5. 统一返回阶段结果
 *
 * 它不负责：
 * - 某站点的具体 selector
 * - 某站点的具体错误提示
 * - 某站点的具体成功信号
 */

/**
 * 从 adapter 上取某个方法。
 *
 * 作用：
 * - 当前先兼容 Dreamina 风格命名
 * - 后续如果 OpenAI / Claude adapter 用统一命名，这里也能自然兼容
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
 * 统一阶段 2 的返回结构。
 *
 * 作用：
 * - 不同站点 adapter 返回值可能不完全一致
 * - 公共层在这里压平成统一结果结构
 */
function normalizeCredentialStageResult(input = {}) {
  return {
    success: Boolean(input.success),
    stage: 'credential-submit',
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

/**
 * 阶段 2 主入口。
 *
 * 作用：
 * - 统一编排 credential submit 阶段
 * - 当前先接通 Dreamina adapter 的真实流程
 *
 * 当前执行顺序：
 * 1. 等 form ready
 * 2. 填 email
 * 3. 填 password
 * 4. 点 submit
 * 5. 确认提交结果
 * 6. 如果失败，走站点分类
 */
async function runCredentialSubmitStage(options = {}) {
  const {
    page,
    account,
    adapter,
    runtime = {},
    context = {},
  } = options;

  if (!adapter) {
    logStageFail('credential-submit', 'adapter 缺失', {
      context: buildStageLogContext(options),
      extra: 'reason=CREDENTIAL_STAGE_ADAPTER_MISSING',
    });
    return normalizeCredentialStageResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'CREDENTIAL_STAGE_ADAPTER_MISSING',
    });
  }

  const waitForFormReady = resolveAdapterMethod(adapter, ['waitForCredentialFormReady', 'waitForDreaminaCredentialFormReady']);
  const fillEmail = resolveAdapterMethod(adapter, ['fillCredentialEmail', 'fillDreaminaCredentialEmail']);
  const fillPassword = resolveAdapterMethod(adapter, ['fillCredentialPassword', 'fillDreaminaCredentialPassword']);
  const submitForm = resolveAdapterMethod(adapter, ['submitCredentialForm', 'submitDreaminaCredentialForm']);
  const confirmSubmitResult = resolveAdapterMethod(adapter, ['confirmCredentialSubmitResult', 'confirmDreaminaCredentialSubmitResult']);
  const classifyFailure = resolveAdapterMethod(adapter, ['classifyCredentialSubmitFailure', 'classifyDreaminaCredentialSubmitFailure']);

  if (!waitForFormReady || !fillEmail || !fillPassword || !submitForm || !confirmSubmitResult) {
    logStageFail('credential-submit', 'adapter 必需方法缺失', {
      context: buildStageLogContext(options),
      extra: [
        `hasWaitForFormReady=${Boolean(waitForFormReady)}`,
        `hasFillEmail=${Boolean(fillEmail)}`,
        `hasFillPassword=${Boolean(fillPassword)}`,
        `hasSubmitForm=${Boolean(submitForm)}`,
        `hasConfirmSubmitResult=${Boolean(confirmSubmitResult)}`,
      ].join(' | '),
    });
    return normalizeCredentialStageResult({
      success: false,
      state: 'ADAPTER_INCOMPLETE',
      reason: 'CREDENTIAL_STAGE_REQUIRED_METHOD_MISSING',
      detail: {
        hasWaitForFormReady: Boolean(waitForFormReady),
        hasFillEmail: Boolean(fillEmail),
        hasFillPassword: Boolean(fillPassword),
        hasSubmitForm: Boolean(submitForm),
        hasConfirmSubmitResult: Boolean(confirmSubmitResult),
      },
    });
  }

  /**
   * 第一步：等 credential form ready。
   *
   * 如果这里都没过，后面的 fill / submit 就都没有意义。
   */
  logStageProgress('credential-submit', '等待 credential form ready', {
    context: buildStageLogContext(options),
  });
  const formReady = await waitForFormReady(page, runtime, context);
  if (formReady?.ok) {
    logStageSuccess('credential-submit', 'credential form ready', {
      context: buildStageLogContext(options),
      extra: [
        formReady?.state ? `state=${formReady.state}` : '',
        formReady?.source ? `source=${formReady.source}` : '',
      ].filter(Boolean).join(' | '),
    });
  }
  if (!formReady?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: formReady?.state || 'FORM_NOT_READY' }) : null;
    logStageFail('credential-submit', 'credential form 未就绪', {
      context: buildStageLogContext(options),
      extra: [
        formReady?.state ? `state=${formReady.state}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).join(' | '),
    });
    return normalizeCredentialStageResult({
      success: false,
      state: formReady?.state || 'FORM_NOT_READY',
      reason: classified?.siteReason || classified?.reason || formReady?.state || 'FORM_NOT_READY',
      detail: {
        formReady,
        classified,
      },
    });
  }

  /**
   * 第二步：填 email。
   *
   * 这里把 formReady 通过 context 继续传下去，
   * 让 adapter 可以复用前一步已经识别出的字段，不必重复扫描。
   */
  logStageProgress('credential-submit', '填写邮箱', {
    context: buildStageLogContext(options),
  });
  const emailResult = await fillEmail(page, account, runtime, { ...context, formReady });
  if (emailResult?.ok) {
    logStageSuccess('credential-submit', '邮箱填写成功', {
      context: buildStageLogContext(options),
      extra: emailResult?.state ? `state=${emailResult.state}` : '',
    });
  }
  if (!emailResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: emailResult?.state || 'EMAIL_FILL_FAILED' }) : null;
    logStageFail('credential-submit', '邮箱填写失败', {
      context: buildStageLogContext(options),
      extra: [
        emailResult?.state ? `state=${emailResult.state}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).join(' | '),
    });
    return normalizeCredentialStageResult({
      success: false,
      state: emailResult?.state || 'EMAIL_FILL_FAILED',
      reason: classified?.siteReason || classified?.reason || emailResult?.state || 'EMAIL_FILL_FAILED',
      detail: {
        formReady,
        emailResult,
        classified,
      },
    });
  }

  /**
   * 第三步：填 password。
   *
   * 当前阶段 2 先按 Dreamina 的 email + password 结构接通。
   * 后续如果有站点只需要 email，这里可以再扩成字段可选策略。
   */
  logStageProgress('credential-submit', '填写密码', {
    context: buildStageLogContext(options),
  });
  const passwordResult = await fillPassword(page, account, runtime, { ...context, formReady });
  if (passwordResult?.ok) {
    logStageSuccess('credential-submit', '密码填写成功', {
      context: buildStageLogContext(options),
      extra: passwordResult?.state ? `state=${passwordResult.state}` : '',
    });
  }
  if (!passwordResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: passwordResult?.state || 'PASSWORD_FILL_FAILED' }) : null;
    logStageFail('credential-submit', '密码填写失败', {
      context: buildStageLogContext(options),
      extra: [
        passwordResult?.state ? `state=${passwordResult.state}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).join(' | '),
    });
    return normalizeCredentialStageResult({
      success: false,
      state: passwordResult?.state || 'PASSWORD_FILL_FAILED',
      reason: classified?.siteReason || classified?.reason || passwordResult?.state || 'PASSWORD_FILL_FAILED',
      detail: {
        formReady,
        emailResult,
        passwordResult,
        classified,
      },
    });
  }

  /**
   * 第四步：提交表单。
   *
   * 这里只做 submit 动作，不在公共层写任何站点特有按钮逻辑。
   */
  logStageProgress('credential-submit', '提交 credential 表单', {
    context: buildStageLogContext(options),
  });
  const submitResult = await submitForm(page, runtime, { ...context, formReady });
  if (submitResult?.ok) {
    logStageSuccess('credential-submit', 'credential 表单提交成功', {
      context: buildStageLogContext(options),
      extra: submitResult?.state ? `state=${submitResult.state}` : '',
    });
  }
  if (!submitResult?.ok) {
    const classified = classifyFailure ? classifyFailure({ reason: submitResult?.state || 'FORM_SUBMIT_FAILED' }) : null;
    logStageFail('credential-submit', 'credential 表单提交失败', {
      context: buildStageLogContext(options),
      extra: [
        submitResult?.state ? `state=${submitResult.state}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).join(' | '),
    });
    return normalizeCredentialStageResult({
      success: false,
      state: submitResult?.state || 'FORM_SUBMIT_FAILED',
      reason: classified?.siteReason || classified?.reason || submitResult?.state || 'FORM_SUBMIT_FAILED',
      detail: {
        formReady,
        emailResult,
        passwordResult,
        submitResult,
        classified,
      },
    });
  }

  /**
   * 第五步：确认提交结果。
   *
   * 这是阶段 2 的成败判定核心。
   * 成功时通常意味着进入下一阶段（Dreamina 当前是 verification）。
   */
  logStageProgress('credential-submit', '确认 credential 提交结果', {
    context: buildStageLogContext(options),
  });
  const confirmResult = await confirmSubmitResult(page, runtime, {
    ...context,
    formReady,
    emailResult,
    passwordResult,
    submitResult,
  });
  if (confirmResult?.ok) {
    logStageSuccess('credential-submit', 'credential 阶段成功', {
      context: buildStageLogContext(options),
      extra: [
        confirmResult?.state ? `state=${confirmResult.state}` : '',
        confirmResult?.nextStage ? `next=${confirmResult.nextStage}` : '',
        confirmResult?.source ? `source=${confirmResult.source}` : '',
      ].filter(Boolean).join(' | '),
    });
    return normalizeCredentialStageResult({
      success: true,
      state: confirmResult?.state || 'CREDENTIAL_SUBMIT_OK',
      reason: confirmResult?.state || 'CREDENTIAL_SUBMIT_OK',
      nextStage: confirmResult?.nextStage || 'verification',
      signalStrength: confirmResult?.strength || '',
      settleStage: confirmResult?.settleStage || '',
      detectionSource: confirmResult?.source || '',
      stateChanged: typeof submitResult?.hasStateChange === 'boolean' ? submitResult.hasStateChange : null,
      detail: {
        formReady,
        emailResult,
        passwordResult,
        submitResult,
        confirmResult,
      },
    });
  }

  /**
   * 第六步：失败时走站点分类。
   *
   * 这样公共层只负责流程，具体 reason 语义仍由站点 adapter 定义。
   */
  const classified = classifyFailure ? classifyFailure({ reason: confirmResult?.state || 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN' }) : null;
  logStageFail('credential-submit', 'credential 阶段失败', {
    context: buildStageLogContext(options),
    extra: [
      confirmResult?.state ? `state=${confirmResult.state}` : '',
      confirmResult?.source ? `source=${confirmResult.source}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).join(' | '),
  });
  return normalizeCredentialStageResult({
    success: false,
    state: confirmResult?.state || 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
    reason: classified?.siteReason || classified?.reason || confirmResult?.state || 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
    nextStage: '',
    signalStrength: confirmResult?.strength || '',
    settleStage: confirmResult?.settleStage || '',
    detectionSource: confirmResult?.source || '',
    stateChanged: typeof submitResult?.hasStateChange === 'boolean' ? submitResult.hasStateChange : null,
    detail: {
      formReady,
      emailResult,
      passwordResult,
      submitResult,
      confirmResult,
      classified,
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeCredentialStageResult,
  runCredentialSubmitStage,
};
