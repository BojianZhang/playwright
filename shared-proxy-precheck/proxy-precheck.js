// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— S0 proxy-precheck
//
// 文件定位：shared-proxy-precheck/proxy-precheck.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 代理可达性预检阶段调度器。
// ✅ 负责 —— 统一的入参校验、重试调度、阶段耗时统计、日志规范化输出。
// ✅ 负责 —— 将 adapter 返回结果归一化为标准 StageResult 结构。
// ❌ 不负责 —— 任何业务实现细节（页面操作 / API 调用 / 选择器定义）。
// ❌ 不负责 —— 与特定平台（Dreamina / 其他）的耦合，adapter 由外部注入。
// ❌ 不负责 —— 持有 adapter 引用（adapter 通过 options.adapter 或 options.xxx 传入）。
//
// 调用方：Dreamina-register.js 的主链（runXxxStage）
// 依赖方：Dreamina/0.0.3/Sn-xxx/ 下对应的 adapter（调用 proxy-precheck-adapter（当前绑定 Dreamina），驱动代理连通性探测并返回 ProxyPrecheckResult）
// ═══════════════════════════════════════════════════════════════════════
'use strict';

/**
 * proxy-precheck.js
 *
 * 这是 shared proxy-precheck stage 的编排层。
 *
 * 它负责：
 * - 解析 adapter hooks
 * - 编排一次性 proxy precheck 主链
 * - 记录阶段日志
 * - 归一化 shared stage 输出结果
 *
 * 它不负责：
 * - 具体网络请求实现
 * - 代理连通性探测细节
 * - 目标站点判定细节
 * - retry / 多轮探测 / 策略循环
 * - 站点专属失败分类细节
 */

const {
  logStageProgress,
  logStageSuccess,
  logStageFail,
  buildStageLogContext,
  createStageTimer,
  formatDurationMs,
} = require('../shared-utils/stage-logger');

// ==============================
// 基础工具层
// 只负责 adapter hook 解析与 shared result 归一化。
// 不负责具体探测行为。
// ==============================

function resolveAdapterMethod(adapter, methodName) {
  if (!adapter || typeof adapter !== 'object') return null;
  const method = adapter[methodName];
  return typeof method === 'function' ? method : null;
}

function normalizeProxyPrecheckResult(input = {}) {
  const success = Boolean(input.success);
  const stage = 'proxy-precheck';
  const state = String(input.state || 'UNKNOWN').trim();
  const reason = String(input.reason || state).trim();
  const nextStage = success ? String(input.nextStage || 'proxy-precheck-complete').trim() : '';
  const proxyGrade = String(input.proxyGrade || (success ? 'OK' : 'BAD')).trim();
  const signalStrength = String(input.signalStrength || '').trim();
  const settleStage = String(input.settleStage || 'none').trim();
  const detectionSource = String(input.detectionSource || '').trim();
  const stateChanged = typeof input.stateChanged === 'boolean' ? input.stateChanged : null;
  const retryCount = Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0;
  const detail = input.detail && typeof input.detail === 'object' ? input.detail : null;

  return {
    success,
    stage,
    state,
    reason,
    nextStage,
    proxyGrade,
    source: detectionSource,
    detectionSource,
    signalStrength,
    settleStage,
    stateChanged,
    retryCount,
    detail,
  };
}

// ==============================
// stage orchestrator 层
// 负责按固定顺序执行 connectivity gate -> parallel targets -> result confirmation。
// 不负责 retry，也不扩成多轮策略链。
// ==============================

async function runProxyPrecheckChain(options = {}) {
  const {
    proxy = {},
    adapter = {},
    runtime = {},
    context = {},
  } = options;

  const stageTimer = createStageTimer();

  const checkProxyConnectivity = resolveAdapterMethod(adapter, 'checkProxyConnectivity');
  const checkProxyExitIp = resolveAdapterMethod(adapter, 'checkProxyExitIp');
  const checkDreaminaPrimaryTarget = resolveAdapterMethod(adapter, 'checkDreaminaPrimaryTarget');
  const checkDreaminaSecondaryTarget = resolveAdapterMethod(adapter, 'checkDreaminaSecondaryTarget');
  const checkDreaminaHomepageShell = resolveAdapterMethod(adapter, 'checkDreaminaHomepageShell');
  const checkDreaminaLoginAffordance = resolveAdapterMethod(adapter, 'checkDreaminaLoginAffordance');
  const browserSmokeCheckDreaminaHomepage = resolveAdapterMethod(adapter, 'browserSmokeCheckDreaminaHomepage');
  const confirmProxyPrecheckResult = resolveAdapterMethod(adapter, 'confirmProxyPrecheckResult');
  const classifyProxyPrecheckFailure = resolveAdapterMethod(adapter, 'classifyProxyPrecheckFailure');

  // Step 1: connectivity gate
  // 先做最外层 fail-fast，避免坏代理继续浪费后续目标检查。
  logStageProgress('proxy-precheck', '检查代理连通性', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const connectivity = checkProxyConnectivity ? await checkProxyConnectivity(proxy, runtime, context) : null;
  if (connectivity && connectivity.ok === false) {
    const classified = classifyProxyPrecheckFailure
      ? classifyProxyPrecheckFailure({ state: connectivity.state, source: connectivity.source, value: connectivity.value })
      : null;
    logStageFail('proxy-precheck', '代理连通性失败', {
      context: buildStageLogContext({ proxy, runtime, context }),
      extra: [
        connectivity?.state ? `state=${connectivity.state}` : '',
        connectivity?.source ? `source=${connectivity.source}` : '',
        classified?.siteReason ? `classified=${classified.siteReason}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    // connectivity fail-fast 出口
    return normalizeProxyPrecheckResult({
      success: false,
      state: String(connectivity.state || 'PROXY_CONNECTIVITY_FAILED'),
      reason: classified?.siteReason || String(connectivity.state || 'PROXY_CONNECTIVITY_FAILED'),
      nextStage: '',
      proxyGrade: 'BAD',
      signalStrength: String(connectivity.strength || ''),
      settleStage: 'connectivity',
      detectionSource: String(connectivity.source || ''),
      detail: {
        exitIpCheck: connectivity,
        primaryTargetCheck: null,
        secondaryTargetCheck: null,
        connectivity,
        exitIp: null,
        primaryTarget: null,
        secondaryTarget: null,
        resultConfirmation: null,
        classified,
        proxySummary: context?.proxySummary || null,
      },
    });
  }

  // Step 2: parallel target probes
  // exitIp / primary / secondary 明确并行执行，避免串行探测放大耗时。
  logStageProgress('proxy-precheck', '并行检查代理出口 IP / Dreamina 主目标 / Dreamina 副目标', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const enableSecondaryTarget = Boolean(runtime?.proxyEnableSecondaryTarget ?? true);
  const [exitIp, primaryTarget, secondaryTarget] = await Promise.all([
    checkProxyExitIp ? checkProxyExitIp(proxy, runtime, { ...context, connectivity }) : Promise.resolve(null),
    checkDreaminaPrimaryTarget ? checkDreaminaPrimaryTarget(proxy, runtime, { ...context, connectivity }) : Promise.resolve(null),
    enableSecondaryTarget && checkDreaminaSecondaryTarget
      ? checkDreaminaSecondaryTarget(proxy, runtime, { ...context, connectivity })
      : Promise.resolve({
          ok: false,
          skipped: true,
          state: 'DREAMINA_SECONDARY_TARGET_SKIPPED',
          source: 'secondary-target-disabled',
          value: 'disabled-by-runtime-policy',
          strength: 'weak',
          elapsedMs: 0,
          response: null,
        }),
  ]);

  // Step 3: business probes
  // 只在 transport/target 基础检查之后补首页业务健康信号，不在 shared 层引入策略循环。
  logStageProgress('proxy-precheck', '检查 Dreamina 首页 shell / 登录入口 affordance', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const [homepageShell, loginAffordance] = await Promise.all([
    checkDreaminaHomepageShell
      ? checkDreaminaHomepageShell(proxy, runtime, { ...context, connectivity, exitIp, primaryTarget, secondaryTarget })
      : Promise.resolve(null),
    checkDreaminaLoginAffordance
      ? checkDreaminaLoginAffordance(proxy, runtime, { ...context, connectivity, exitIp, primaryTarget, secondaryTarget })
      : Promise.resolve(null),
  ]);

  let browserSmoke = null;
  if (browserSmokeCheckDreaminaHomepage && context?.browserSmokePage) {
    logStageProgress('proxy-precheck', '执行浏览器级 Dreamina 首页白屏预检', {
      context: buildStageLogContext({ proxy, runtime, context }),
    });
    browserSmoke = await browserSmokeCheckDreaminaHomepage(context.browserSmokePage, runtime, {
      ...context,
      proxy,
      connectivity,
      exitIp,
      primaryTarget,
      secondaryTarget,
      homepageShell,
      loginAffordance,
    });
  }

  // Step 4: result confirmation
  // 由 adapter 统一综合 transport + targets + business probes 结果，shared 层只负责承接与收口。
  logStageProgress('proxy-precheck', '确认代理预检结果', {
    context: buildStageLogContext({ proxy, runtime, context }),
  });
  const resultConfirmation = confirmProxyPrecheckResult
    ? await confirmProxyPrecheckResult(proxy, runtime, { ...context, connectivity, exitIp, primaryTarget, secondaryTarget, homepageShell, loginAffordance, browserSmoke })
    : { ok: false, state: 'PROXY_PRECHECK_BAD', nextStage: '', proxyGrade: 'BAD', source: '', value: '', strength: '', settleStage: 'none' };

  if (resultConfirmation?.ok) {
    logStageSuccess('proxy-precheck', '代理预检成功', {
      context: buildStageLogContext({ proxy, runtime, context }),
      extra: [
        resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
        resultConfirmation?.proxyGrade ? `proxyGrade=${resultConfirmation.proxyGrade}` : '',
        resultConfirmation?.source ? `source=${resultConfirmation.source}` : '',
      ].filter(Boolean).concat([`durationMs=${formatDurationMs(stageTimer.elapsedMs())}`]).join(' | '),
    });
    // success 出口
    return normalizeProxyPrecheckResult({
      success: true,
      state: String(resultConfirmation.state || 'PROXY_PRECHECK_OK'),
      reason: String(resultConfirmation.state || 'PROXY_PRECHECK_OK'),
      nextStage: String(resultConfirmation.nextStage || 'proxy-precheck-complete'),
      proxyGrade: String(resultConfirmation.proxyGrade || 'OK'),
      signalStrength: String(resultConfirmation.strength || ''),
      settleStage: String(resultConfirmation.settleStage || 'none'),
      detectionSource: String(resultConfirmation.source || ''),
      stateChanged: typeof resultConfirmation.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
      retryCount: Number.isFinite(Number(resultConfirmation.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
      detail: {
        exitIpCheck: exitIp,
        primaryTargetCheck: primaryTarget,
        secondaryTargetCheck: secondaryTarget,
        connectivity,
        exitIp,
        primaryTarget,
        secondaryTarget,
        homepageShell,
        loginAffordance,
        resultConfirmation,
        classified: null,
        proxySummary: context?.proxySummary || null,
        browserSmoke,
        healthEvidence: {
          transportOk: Boolean(connectivity?.ok),
          exitIpOk: Boolean(exitIp?.ok),
          primaryOk: Boolean(primaryTarget?.ok),
          secondaryOk: Boolean(secondaryTarget?.ok),
          homepageShellOk: Boolean(homepageShell?.ok),
          loginAffordanceOk: Boolean(loginAffordance?.ok),
          browserSmokeOk: Boolean(browserSmoke?.ok),
        },
        capabilityGrade: String(resultConfirmation?.capabilityGrade || ''),
        businessGrade: String(resultConfirmation?.businessGrade || ''),
        healthScore: Number(resultConfirmation?.healthScore || 0),
      },
    });
  }

  const classified = classifyProxyPrecheckFailure
    ? classifyProxyPrecheckFailure({ state: resultConfirmation?.state || 'PROXY_PRECHECK_BAD', source: resultConfirmation?.source, value: resultConfirmation?.value })
    : null;

  logStageFail('proxy-precheck', '代理预检失败', {
    context: buildStageLogContext({ proxy, runtime, context }),
    extra: [
      resultConfirmation?.state ? `state=${resultConfirmation.state}` : '',
      resultConfirmation?.proxyGrade ? `proxyGrade=${resultConfirmation.proxyGrade}` : '',
      classified?.siteReason ? `classified=${classified.siteReason}` : '',
    ].filter(Boolean).join(' | '),
  });

  // confirmation failure 出口
  return normalizeProxyPrecheckResult({
    success: false,
    state: String(resultConfirmation?.state || 'PROXY_PRECHECK_BAD'),
    reason: classified?.siteReason || String(resultConfirmation?.state || 'PROXY_PRECHECK_BAD'),
    nextStage: '',
    proxyGrade: String(resultConfirmation?.proxyGrade || 'BAD'),
    signalStrength: String(resultConfirmation?.strength || ''),
    settleStage: String(resultConfirmation?.settleStage || 'none'),
    detectionSource: String(resultConfirmation?.source || ''),
    stateChanged: typeof resultConfirmation?.stateChanged === 'boolean' ? resultConfirmation.stateChanged : null,
    retryCount: Number.isFinite(Number(resultConfirmation?.retryCount)) ? Number(resultConfirmation.retryCount) : 0,
    detail: {
      exitIpCheck: exitIp,
      primaryTargetCheck: primaryTarget,
      secondaryTargetCheck: secondaryTarget,
      connectivity,
      exitIp,
      primaryTarget,
      secondaryTarget,
      homepageShell,
      loginAffordance,
      resultConfirmation,
      classified,
      proxySummary: context?.proxySummary || null,
      browserSmoke,
      healthEvidence: {
        transportOk: Boolean(connectivity?.ok),
        exitIpOk: Boolean(exitIp?.ok),
        primaryOk: Boolean(primaryTarget?.ok),
        secondaryOk: Boolean(secondaryTarget?.ok),
        homepageShellOk: Boolean(homepageShell?.ok),
        loginAffordanceOk: Boolean(loginAffordance?.ok),
        browserSmokeOk: Boolean(browserSmoke?.ok),
      },
      capabilityGrade: String(resultConfirmation?.capabilityGrade || ''),
      businessGrade: String(resultConfirmation?.businessGrade || ''),
      healthScore: Number(resultConfirmation?.healthScore || 0),
    },
  });
}

module.exports = {
  resolveAdapterMethod,
  normalizeProxyPrecheckResult,
  runProxyPrecheckChain,
};
