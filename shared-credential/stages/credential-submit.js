'use strict';

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
    detail: input.detail || null,
  };
}

/**
 * 阶段 2 主入口。
 *
 * 作用：
 * - 统一编排 credential submit 阶段
 * - 当前先保留最小骨架，等待具体站点 adapter 接入
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
    return normalizeCredentialStageResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'CREDENTIAL_STAGE_ADAPTER_MISSING',
    });
  }

  if (typeof adapter.waitForDreaminaCredentialFormReady !== 'function'
    && typeof adapter.waitForCredentialFormReady !== 'function') {
    return normalizeCredentialStageResult({
      success: false,
      state: 'ADAPTER_INCOMPLETE',
      reason: 'CREDENTIAL_STAGE_FORM_READY_METHOD_MISSING',
    });
  }

  return normalizeCredentialStageResult({
    success: false,
    state: 'STAGE_SCAFFOLD_ONLY',
    reason: 'CREDENTIAL_STAGE_NOT_CONNECTED_YET',
    detail: {
      account: account?.email || '',
      hasPage: Boolean(page),
      runtimeMode: String(runtime.mode || ''),
      note: '阶段 2 公共骨架已建立，待接入具体站点 adapter 主流程。',
    },
  });
}

module.exports = {
  normalizeCredentialStageResult,
  runCredentialSubmitStage,
};
