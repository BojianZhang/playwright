'use strict';

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../../shared-stage-logger');
const { syncStageStep } = require('../../shared-stage-runtime');

function resolveAdapterMethod(adapter, names = []) {
  for (const name of names) {
    if (typeof adapter?.[name] === 'function') {
      return adapter[name].bind(adapter);
    }
  }
  return null;
}

function normalizeExistsPrecheckResult(input = {}) {
  return {
    success: Boolean(input.success),
    stage: 'exists-precheck',
    state: String(input.state || '').trim(),
    reason: String(input.reason || '').trim(),
    nextStage: String(input.nextStage || '').trim(),
    signalStrength: String(input.signalStrength || '').trim(),
    detectionSource: String(input.detectionSource || '').trim(),
    stateChanged: typeof input.stateChanged === 'boolean' ? input.stateChanged : null,
    detail: input.detail || null,
  };
}

async function runExistsPrecheckStage(options = {}) {
  const { page, account, adapter, runtime = {}, context = {} } = options;
  const stageTimer = createStageTimer();

  if (!adapter) {
    syncStageStep(options, { stage: 'exists-precheck', step: 'stage-fail' });
    return normalizeExistsPrecheckResult({
      success: false,
      state: 'ADAPTER_MISSING',
      reason: 'EXISTS_PRECHECK_ADAPTER_MISSING',
    });
  }

  const precheck = resolveAdapterMethod(adapter, ['precheckAccountExists', 'precheckDreaminaAccountExists']);
  if (!precheck) {
    syncStageStep(options, { stage: 'exists-precheck', step: 'stage-success' });
    logStageSuccess('exists-precheck', 'exists 预检查未配置，默认继续注册', {
      context: buildStageLogContext(options),
      extra: 'state=EXISTS_PRECHECK_SKIPPED | next=credential-submit',
    });
    return normalizeExistsPrecheckResult({
      success: true,
      state: 'EXISTS_PRECHECK_SKIPPED',
      reason: 'EXISTS_PRECHECK_NOT_IMPLEMENTED',
      nextStage: 'credential-submit',
      signalStrength: 'weak',
      detectionSource: 'adapter-missing',
    });
  }

  syncStageStep(options, { stage: 'exists-precheck', step: 'precheck-account-exists' });
  logStageProgress('exists-precheck', '注册前检查账号是否已存在', {
    context: buildStageLogContext(options),
  });

  const result = await precheck(page, account, runtime, context);
  if (result?.ok && result?.state === 'ACCOUNT_NOT_EXISTS_PRECHECK_CLEAR') {
    syncStageStep(options, { stage: 'exists-precheck', step: 'stage-success' });
    logStageSuccess('exists-precheck', '注册前 exists 预检查通过', {
      context: buildStageLogContext(options),
      extra: [
        `state=${result.state}`,
        result?.source ? `source=${result.source}` : '',
        `durationMs=${formatDurationMs(stageTimer.elapsedMs())}`,
      ].filter(Boolean).join(' | '),
    });
    return normalizeExistsPrecheckResult({
      success: true,
      state: result.state,
      reason: result.reason || result.state,
      nextStage: 'credential-submit',
      signalStrength: result.signalStrength || 'weak',
      detectionSource: result.source || 'precheck',
      detail: result,
    });
  }

  if (result?.ok && result?.state === 'ACCOUNT_ALREADY_EXISTS_PRECHECK') {
    syncStageStep(options, { stage: 'exists-precheck', step: 'stage-fail' });
    logStageFail('exists-precheck', '注册前 exists 预检查命中已存在账号', {
      context: buildStageLogContext(options),
      extra: [
        `state=${result.state}`,
        `reason=${result.reason || 'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK'}`,
        result?.source ? `source=${result.source}` : '',
        `durationMs=${formatDurationMs(stageTimer.elapsedMs())}`,
      ].filter(Boolean).join(' | '),
    });
    return normalizeExistsPrecheckResult({
      success: false,
      state: result.state,
      reason: result.reason || 'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
      signalStrength: result.signalStrength || 'strong',
      detectionSource: result.source || 'precheck',
      detail: result,
    });
  }

  syncStageStep(options, { stage: 'exists-precheck', step: 'stage-success' });
  logStageSuccess('exists-precheck', '注册前 exists 预检查未命中，继续注册', {
    context: buildStageLogContext(options),
    extra: [
      `state=${result?.state || 'EXISTS_PRECHECK_INCONCLUSIVE'}`,
      result?.source ? `source=${result.source}` : '',
      `durationMs=${formatDurationMs(stageTimer.elapsedMs())}`,
    ].filter(Boolean).join(' | '),
  });
  return normalizeExistsPrecheckResult({
    success: true,
    state: result?.state || 'EXISTS_PRECHECK_INCONCLUSIVE',
    reason: result?.reason || result?.state || 'EXISTS_PRECHECK_INCONCLUSIVE',
    nextStage: 'credential-submit',
    signalStrength: result?.signalStrength || 'weak',
    detectionSource: result?.source || 'precheck',
    detail: result || null,
  });
}

module.exports = {
  runExistsPrecheckStage,
};
