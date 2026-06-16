'use strict';

const fs = require('fs');
const path = require('path');
const { loadLocalProxies, summarizeProxy } = require('./stages/S0-proxy-precheck/local-proxy-loader');
const {
  logStageStart,
  logStageProgress,
  logStageSuccess,
  logStageFail,
  summarizeStageResult,
  createStageTimer,
  formatDurationMs,
} = require('../lib/utils/stage-logger');
const { updateWorkerStatus } = require('../lib/utils/worker-status-tracker');
const { createBrowserRuntime } = require('../lib/browser-runtime/create-browser-runtime');

// ==============================
// Dreamina 主链编排层：阶段公共 runner 引入
// ==============================

// 阶段 0：proxy-precheck 公共骨架。
const { runProxyPrecheckChain } = require('../lib/stage-runners/proxy-precheck');
// 阶段 1：entry 公共骨架。
const { runEntryStage } = require('../lib/stage-runners/entry');

// 阶段 2：credential submit 公共骨架。
const { runCredentialSubmitStage } = require('../lib/stage-runners/credential-submit');
// 阶段 3：verification submit 公共骨架。
const { runVerificationSubmitStage } = require('../lib/stage-runners/verification-submit');
// 阶段 4：profile completion submit 公共骨架。
const { runProfileCompletionSubmitStage } = require('../lib/stage-runners/profile-completion-submit');
// 阶段 5：post-auth-ready 公共骨架。
const { runPostAuthReadyStage } = require('../lib/stage-runners/post-auth-ready');
// 阶段 6：account-delivery 公共骨架。
const { runAccountDeliveryStage } = require('../lib/stage-runners/account-delivery');
// 阶段 7/8 公共 runner（升级选套餐 / 收银台加卡支付）。
const { runUpgradeStage } = require('../lib/stage-runners/upgrade');
const { runPaymentStage } = require('../lib/stage-runners/payment');

// ==============================
// Dreamina 主链编排层：各阶段 Dreamina adapter 引入
// ==============================

// 阶段 0：Dreamina proxy-precheck adapter。
const dreaminaProxyPrecheckAdapter = require('./stages/S0-proxy-precheck/proxy-precheck-adapter');
// 阶段 1：Dreamina entry adapter（S1 门面，已从本文件抽出 ~1150 行胶水）。
const { dreaminaEntryAdapter } = require('./stages/S1-entry/entry-stage-adapter');

// 阶段 2：Dreamina credential adapter。
const dreaminaCredentialAdapter = require('./stages/S2-credential/credential-adapter');
// 阶段 3：Dreamina verification adapter。
const dreaminaVerificationAdapter = require('./stages/S3-verification/verification-adapter');
// 阶段 4：Dreamina profile completion adapter。
const dreaminaProfileCompletionAdapter = require('./stages/S4-profile-completion/profile-completion-adapter');
// 阶段 5：Dreamina post-auth-ready adapter。
const dreaminaPostAuthReadyAdapter = require('./stages/S5-post-auth-ready/post-auth-ready-adapter');
// 阶段 6：Dreamina account-delivery adapter。
const dreaminaAccountDeliveryAdapter = require('./stages/S6-account-delivery/account-delivery-adapter');
// 阶段 7：Dreamina upgrade adapter（升级/选套餐 → 收银台）。
const dreaminaUpgradeAdapter = require('./stages/S7-upgrade/upgrade-adapter');
// 阶段 8：Dreamina payment adapter（收银台加卡支付）。
const dreaminaPaymentAdapter = require('./stages/S8-payment/payment-adapter');

/**
 * 构造 Dreamina 六阶段注册表。
 *
 * 作用：
 * - 把“阶段名 -> 公共 runner -> Dreamina adapter”的映射一次性集中起来
 * - 避免主流程里散落一堆 require 与硬编码判断
 * - 后续如果某阶段 runner 或 adapter 发生替换，只需要改这里
 */
function buildDreaminaStageRegistry() {
  return {
    // 阶段 0：proxy-precheck
    proxyPrecheck: {
      // 当前注册表项所属阶段名。
      stage: 'proxy-precheck',
      // 代理预检公共 runner。
      run: runProxyPrecheckChain,
      // Dreamina 代理预检 adapter。
      adapter: dreaminaProxyPrecheckAdapter,
    },
    // 阶段 1：entry
    entry: {
      // 当前注册表项所属阶段名。
      stage: 'entry',
      // 阶段 1 公共 runner。
      run: runEntryStage,
      // Dreamina 阶段 1 adapter。
      adapter: dreaminaEntryAdapter,
    },
    // 阶段 2：credential-submit
    credential: {
      stage: 'credential-submit',
      run: runCredentialSubmitStage,
      adapter: dreaminaCredentialAdapter,
    },
    // 阶段 3：verification-submit
    verification: {
      stage: 'verification-submit',
      run: runVerificationSubmitStage,
      adapter: dreaminaVerificationAdapter,
    },
    // 阶段 4：profile-completion-submit
    profileCompletion: {
      stage: 'profile-completion-submit',
      run: runProfileCompletionSubmitStage,
      adapter: dreaminaProfileCompletionAdapter,
    },
    // 阶段 5：post-auth-ready
    postAuthReady: {
      stage: 'post-auth-ready',
      run: runPostAuthReadyStage,
      adapter: dreaminaPostAuthReadyAdapter,
    },
    // 阶段 7：upgrade（升级/选套餐 → 跳收银台）
    upgrade: {
      stage: 'upgrade',
      run: runUpgradeStage,
      adapter: dreaminaUpgradeAdapter,
    },
    // 阶段 8：payment（收银台加卡支付）
    payment: {
      stage: 'payment',
      run: runPaymentStage,
      adapter: dreaminaPaymentAdapter,
    },
    // 阶段 9：account-delivery
    accountDelivery: {
      stage: 'account-delivery',
      run: runAccountDeliveryStage,
      adapter: dreaminaAccountDeliveryAdapter,
    },
  };
}

/**
 * 构造 Dreamina 主链统一上下文。
 *
 * 作用：
 * - 统一整理浏览器、页面、账号、runtime、日志函数等主链基础输入
 * - 统一准备 `stageResults` 容器，让 6 个阶段共享前序结果
 * - 统一准备 meta，方便最后输出整条链的耗时与摘要
 */

function syncWorkerStageStatus(registerContext, patch = {}) {
  const workerId = registerContext?.stageLogContext?.workerId;
  if (!workerId) return;
  updateWorkerStatus(workerId, {
    status: patch.status || 'running-register-stage',
    account: registerContext?.account?.email || '',
    stage: patch.stage || '',
    step: patch.step || '',
    attempt: registerContext?.stageLogContext?.attempt || 0,
    proxy: registerContext?.proxy?.server || registerContext?.proxy?.raw || '',
    lastState: patch.lastState || '',
    lastReason: patch.lastReason || '',
  });
}

async function runDreaminaBrowserSmokePrecheck(options = {}) {
  const page = options?.page || null;
  if (!page || typeof dreaminaProxyPrecheckAdapter?.browserSmokeCheckDreaminaHomepage !== 'function') {
    return null;
  }
  return await dreaminaProxyPrecheckAdapter.browserSmokeCheckDreaminaHomepage(options?.proxy || {}, options?.runtime || {}, {
    page,
  }).catch(() => null);
}

function buildDreaminaRegisterContext(options = {}) {
  // 解构主链输入。
  const {
    browser = null,
    context = null,
    page = null,
    browserSmokePage = null,
    account = {},
    proxy = null,
    proxyPrecheckResult = null,
    runtime = {},
    logInfo = null,
    workerId = null,
    attempt = null,
  } = options;

  // 构造 Dreamina 阶段注册表。
  const stageRegistry = buildDreaminaStageRegistry();

  // 返回统一主链上下文。
  return {
    // 当前主链所属站点。
    site: 'dreamina',
    // 浏览器对象。
    browser,
    // 浏览器上下文对象；这里用 browserContext 命名，避免和 context 混淆。
    browserContext: context,
    // 当前执行页面。
    page,
    // 代理预检专用轻量浏览器页。
    browserSmokePage,
    // 当前账号上下文。
    account,
    // 当前代理摘要或代理对象。
    proxy,
    // 当前代理预检结果；Dreamina-register 不负责运行它，但允许消费它。
    proxyPrecheckResult,
    // 主链 runtime。
    runtime,
    // 日志函数；没有则保持 null。
    logInfo: typeof logInfo === 'function' ? logInfo : null,
    // Dreamina 六阶段注册表。
    stageRegistry,
    // 阶段日志上下文。
    stageLogContext: {
      account: String(account?.email || '').trim(),
      proxy: String(proxy?.server || proxy?.raw || '').trim(),
      workerId,
      attempt,
    },
    // 各阶段结果容器；初始都为 null。
    stageResults: {
      proxyPrecheck: null,
      entry: null,
      credential: null,
      verification: null,
      profileCompletion: null,
      postAuthReady: null,
      upgrade: null,
      payment: null,
      accountDelivery: null,
    },
    // 主链元信息。
    meta: {
      startedAt: Date.now(),
    },
  };
}

/**
 * 运行 Dreamina 单阶段。
 *
 * 作用：
 * - 屏蔽“每个阶段怎么调”的重复样板
 * - 自动把 page/account/adapter/runtime/context 统一传给阶段公共 runner
 * - 自动把阶段结果写回 `context.stageResults`
 *
 * 注意：
 * - 这里只做 orchestration，不做阶段内部逻辑
 */
function buildProxyPrecheckSummary(proxyPrecheckResult) {
  const result = proxyPrecheckResult && typeof proxyPrecheckResult === 'object' ? proxyPrecheckResult : null;
  if (!result) return null;
  const detail = result.detail && typeof result.detail === 'object' ? result.detail : null;
  return {
    success: Boolean(result.success),
    state: String(result.state || '').trim(),
    reason: String(result.reason || result.state || '').trim(),
    signalStrength: String(result.signalStrength || '').trim(),
    detectionSource: String(result.detectionSource || '').trim(),
    proxyGrade: String(result.proxyGrade || '').trim(),
    resolvedIp: String(result.ip || result.detail && result.detail.exitIp && result.detail.exitIp.ip || '').trim(), // EVO-ExitIp: 代理出口 IP 字符串（由 checkProxyExitIp 解析）
    capabilityGrade: String(detail?.capabilityGrade || result.capabilityGrade || '').trim(),
    businessGrade: String(detail?.businessGrade || result.businessGrade || '').trim(),
    healthScore: Number(detail?.healthScore || result.healthScore || 0),
    healthEvidence: detail?.healthEvidence && typeof detail.healthEvidence === 'object'
      ? {
          transportOk: Boolean(detail.healthEvidence.transportOk),
          exitIpOk: Boolean(detail.healthEvidence.exitIpOk),
          primaryOk: Boolean(detail.healthEvidence.primaryOk),
          secondaryOk: Boolean(detail.healthEvidence.secondaryOk),
          homepageShellOk: Boolean(detail.healthEvidence.homepageShellOk),
          loginAffordanceOk: Boolean(detail.healthEvidence.loginAffordanceOk),
        }
      : null,
    homepageShell: detail?.homepageShell
      ? {
          ok: Boolean(detail.homepageShell.ok),
          state: String(detail.homepageShell.state || '').trim(),
          value: String(detail.homepageShell.value || '').trim(),
          evidence: detail.homepageShell.evidence && typeof detail.homepageShell.evidence === 'object'
            ? {
                title: String(detail.homepageShell.evidence.title || '').trim(),
                titleHit: String(detail.homepageShell.evidence.titleHit || '').trim(),
                shellTextHit: String(detail.homepageShell.evidence.shellTextHit || '').trim(),
                errorTextHit: String(detail.homepageShell.evidence.errorTextHit || '').trim(),
                bodyTextLength: Number(detail.homepageShell.evidence.bodyTextLength || 0),
              }
            : null,
        }
      : null,
    loginAffordance: detail?.loginAffordance
      ? {
          ok: Boolean(detail.loginAffordance.ok),
          state: String(detail.loginAffordance.state || '').trim(),
          value: String(detail.loginAffordance.value || '').trim(),
          evidence: detail.loginAffordance.evidence && typeof detail.loginAffordance.evidence === 'object'
            ? {
                textHit: String(detail.loginAffordance.evidence.textHit || '').trim(),
                selectorHintHit: String(detail.loginAffordance.evidence.selectorHintHit || '').trim(),
                affordanceCount: Number(detail.loginAffordance.evidence.affordanceCount || 0),
              }
            : null,
        }
      : null,
  };
}

function checkDreaminaRegisterPreconditions(registerContext = {}) {
  const proxy = registerContext?.proxy || null;
  const proxyPrecheckResult = registerContext?.proxyPrecheckResult || null;

  if (!proxy || typeof proxy !== 'object') {
    return {
      ok: false,
      state: 'DREAMINA_REGISTER_PROXY_MISSING',
      reason: 'DREAMINA_REGISTER_PROXY_MISSING',
      source: 'preconditions',
    };
  }

  // 这里保留外部硬拒绝兜底能力：如果外部已经明确传入失败的 precheckResult，
  // 主链可在真正进入 proxyPrecheck 阶段前直接拒绝启动。
  if (proxyPrecheckResult && proxyPrecheckResult.success === false) {
    return {
      ok: false,
      state: 'PROXY_PRECHECK_REJECTED',
      reason: String(proxyPrecheckResult.reason || proxyPrecheckResult.state || 'PROXY_PRECHECK_REJECTED').trim(),
      source: 'proxy-precheck',
    };
  }

  return {
    ok: true,
    state: 'DREAMINA_REGISTER_PRECONDITIONS_OK',
    reason: 'DREAMINA_REGISTER_PRECONDITIONS_OK',
    source: 'preconditions',
  };
}

async function runDreaminaStage(stageKey, registerContext) {
  // 从主链上下文中读取 stageRegistry。
  const registry = registerContext?.stageRegistry || {};
  // 取出当前阶段注册表项。
  const stageEntry = registry?.[stageKey] || null;
  const logInfo = typeof registerContext?.logInfo === 'function' ? registerContext.logInfo : null;
  const stageName = stageEntry?.stage || stageKey;
  const stageLogContext = registerContext?.stageLogContext || {};

  // 如果注册表项不存在，就直接返回失败结构。
  if (!stageEntry) {
    logStageFail(stageKey, '阶段注册表项缺失', {
      logger: logInfo,
      context: stageLogContext,
      extra: `stageKey=${stageKey}`,
    });
    return {
      ok: false,
      stageKey,
      result: {
        success: false,
        stage: stageKey,
        state: 'DREAMINA_STAGE_REGISTRY_ENTRY_MISSING',
        reason: 'DREAMINA_STAGE_REGISTRY_ENTRY_MISSING',
        nextStage: '',
        signalStrength: '',
        settleStage: 'none',
        detectionSource: '',
        stateChanged: null,
        retryCount: 0,
        detail: null,
      },
    };
  }

  // 读取当前阶段公共 runner。
  const stageRunner = stageEntry.run;
  // 如果公共 runner 不存在，就直接返回失败结构。
  if (typeof stageRunner !== 'function') {
    logStageFail(stageName, '阶段 runner 缺失', {
      logger: logInfo,
      context: stageLogContext,
      extra: `stageKey=${stageKey}`,
    });
    return {
      ok: false,
      stageKey,
      result: {
        success: false,
        stage: stageEntry.stage || stageKey,
        state: 'DREAMINA_STAGE_RUNNER_MISSING',
        reason: 'DREAMINA_STAGE_RUNNER_MISSING',
        nextStage: '',
        signalStrength: '',
        settleStage: 'none',
        detectionSource: '',
        stateChanged: null,
        retryCount: 0,
        detail: {
          stageKey,
        },
      },
    };
  }

  // 组装传给阶段公共 runner 的 context。
  const stageContext = {
    // 继续下发日志函数。
    logInfo: registerContext.logInfo,
    // 把 browser/browserContext/page/account/runtime/stageResults 全部暴露给阶段。
    browser: registerContext.browser,
    browserContext: registerContext.browserContext,
    page: registerContext.page,
    account: registerContext.account,
    proxy: registerContext.proxy,
    proxyPrecheckResult: registerContext.proxyPrecheckResult,
    runtime: registerContext.runtime,
    stageResults: registerContext.stageResults,
    // 兼容部分阶段可能直接读取 context/account/page 等字段。
    ...registerContext.stageResults,
  };

  const stageTimer = createStageTimer();
  logStageStart(stageName, '阶段开始', {
    logger: logInfo,
    context: stageLogContext,
    extra: `stageKey=${stageKey}`,
  });
  syncWorkerStageStatus(registerContext, {
    status: 'running-register-stage',
    stage: stageName,
    step: 'stage-start',
  });

  // 执行阶段公共 runner。
  // 注意：proxyPrecheck 阶段的主输入是 proxy，不是 page/account 业务表单上下文。
  const result = stageKey === 'proxyPrecheck'
    ? await stageRunner({
        proxy: registerContext.proxy,
        adapter: stageEntry.adapter,
        runtime: registerContext.runtime,
        context: {
          ...stageContext,
          browserSmokePage: registerContext.browserSmokePage,
        },
      })
    : await stageRunner({
        page: registerContext.page,
        account: registerContext.account,
        adapter: stageEntry.adapter,
        runtime: registerContext.runtime,
        context: stageContext,
      });

  const stageDurationMs = stageTimer.elapsedMs();
  if (result && typeof result === 'object') {
    result.durationMs = stageDurationMs;
    result.detail = {
      ...(result.detail || {}),
      durationMs: stageDurationMs,
    };
  }

  // 把阶段结果写回 stageResults。
  registerContext.stageResults[stageKey] = result;

  const resultSummary = summarizeStageResult(result);
  if (resultSummary.success) {
    logStageSuccess(stageName, resultSummary.state || '阶段成功', {
      logger: logInfo,
      context: stageLogContext,
      extra: [
        resultSummary.reason ? `reason=${resultSummary.reason}` : '',
        resultSummary.nextStage ? `next=${resultSummary.nextStage}` : '',
        resultSummary.signalStrength ? `strength=${resultSummary.signalStrength}` : '',
        resultSummary.retryCount ? `retryCount=${resultSummary.retryCount}` : '',
        `durationMs=${formatDurationMs(stageDurationMs)}`,
      ].filter(Boolean).join(' | '),
    });
    syncWorkerStageStatus(registerContext, {
      status: 'running-register-stage',
      stage: stageName,
      step: 'stage-success',
      lastState: resultSummary.state || '阶段成功',
      lastReason: resultSummary.reason || resultSummary.state || '阶段成功',
    });
  } else {
    logStageFail(stageName, resultSummary.state || '阶段失败', {
      logger: logInfo,
      context: stageLogContext,
      extra: [
        resultSummary.reason ? `reason=${resultSummary.reason}` : '',
        resultSummary.detectionSource ? `source=${resultSummary.detectionSource}` : '',
        resultSummary.settleStage ? `settle=${resultSummary.settleStage}` : '',
        resultSummary.retryCount ? `retryCount=${resultSummary.retryCount}` : '',
        `durationMs=${formatDurationMs(stageDurationMs)}`,
      ].filter(Boolean).join(' | '),
    });
    syncWorkerStageStatus(registerContext, {
      status: 'running-register-stage',
      stage: stageName,
      step: 'stage-fail',
      lastState: resultSummary.state || '阶段失败',
      lastReason: resultSummary.reason || resultSummary.state || '阶段失败',
    });
  }

  // 返回统一单阶段执行结构。
  return {
    ok: Boolean(result?.success),
    stageKey,
    result,
  };
}

/**
 * 规范化 Dreamina 整条注册主链结果。
 *
 * 作用：
 * - 把不同失败点、不同阶段的原始结构收口成统一主链结果
 * - 让外层 runner/运维侧不用理解每个阶段的细节差异
 */
function normalizeDreaminaRegisterResult(input = {}) {
  // 统一 success。
  const success = Boolean(input.success);
  // site 固定为 dreamina。
  const site = 'dreamina';
  // 最终停留阶段。
  const finalStage = String(input.finalStage || '').trim();
  // 最终状态码。
  const finalState = String(input.finalState || 'UNKNOWN').trim();
  // 最终原因。
  const finalReason = String(input.finalReason || finalState).trim();
  // 下一阶段建议值。
  const nextStage = String(input.nextStage || '').trim();
  // 账号基础上下文。
  const account = input.account && typeof input.account === 'object' ? input.account : {};
  // 当前代理对象或代理摘要。
  const proxy = input.proxy && typeof input.proxy === 'object' ? input.proxy : null;
  // 第六阶段交付对象草案。
  const deliveryPayload = input.deliveryPayload && typeof input.deliveryPayload === 'object' ? input.deliveryPayload : null;
  // 当前最终失败/成功收口时提升到顶层的 detail，便于 batch runner 直接落盘。
  const detail = input.detail && typeof input.detail === 'object' ? input.detail : null;
  // 全链阶段结果汇总。
  const stageResults = input.stageResults && typeof input.stageResults === 'object' ? input.stageResults : {};
  // 代理预检摘要；只做轻引用，不吞并完整 detail。
  const proxyPrecheckSummary = input.proxyPrecheckSummary && typeof input.proxyPrecheckSummary === 'object' ? input.proxyPrecheckSummary : null;
  // 指纹摘要。
  const fingerprintSummary = input.fingerprintSummary && typeof input.fingerprintSummary === 'object' ? input.fingerprintSummary : null;
  // 双 IP 检测结果：Node 层预检 IP + 浏览器实际 IP。
  const ipCheck = input.ipCheck && typeof input.ipCheck === 'object' ? input.ipCheck : null;
  // 元信息。
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : null;

  return {
    success,
    site,
    finalStage,
    finalState,
    finalReason,
    nextStage,
    account,
    proxy,
    detail,
    deliveryPayload,
    stageResults,
    proxyPrecheckSummary,
    fingerprintSummary,
    ipCheck,
    meta,
  };
}

/**
 * 运行 Dreamina 注册主链。
 *
 * 当前版本目标：
 * - 优先把 Dreamina 编排层顺序、字段、边界钉死
 * - 真正站点细节全部留给 6 个 shared stage + Dreamina adapters
 * - 任一阶段失败时立即停机收口
 */
async function runDreaminaRegisterFlow(options = {}) {
  // 第一步：构造主链统一上下文。
  const registerContext = buildDreaminaRegisterContext(options);
  // 解构日志函数，便于主链记录关键节点。
  const { logInfo = null } = registerContext;

  if (!registerContext.proxyPrecheckResult && registerContext.browserSmokePage) {
    const smokeResult = await runDreaminaBrowserSmokePrecheck({
      proxy: registerContext.proxy,
      runtime: registerContext.runtime,
      page: registerContext.browserSmokePage,
    });
    registerContext.preflightBrowserSmoke = smokeResult;
    if (smokeResult && smokeResult.ok === false && smokeResult.state === 'DREAMINA_BROWSER_SMOKE_BLANK_PAGE') {
      logStageFail('proxy-precheck', 'Dreamina 浏览器级首页白屏预检失败', {
        logger: logInfo,
        context: registerContext?.stageLogContext || {},
        extra: `reason=${smokeResult.value || smokeResult.state}`,
      });
      registerContext.meta.finishedAt = Date.now();
      registerContext.meta.durationMs = registerContext.meta.finishedAt - registerContext.meta.startedAt;
      registerContext.meta.successStageCount = 0;
      return normalizeDreaminaRegisterResult({
        success: false,
        finalStage: 'proxy-precheck',
        finalState: 'PROXY_PRECHECK_BAD',
        finalReason: 'DREAMINA_BROWSER_SMOKE_BLANK_PAGE',
        nextStage: '',
        account: registerContext.account,
        proxy: registerContext.proxy,
        detail: {
          browserSmoke: smokeResult,
        },
        deliveryPayload: null,
        stageResults: registerContext.stageResults,
        proxyPrecheckSummary: {
          success: false,
          state: 'PROXY_PRECHECK_BAD',
          reason: 'DREAMINA_BROWSER_SMOKE_BLANK_PAGE',
          proxyGrade: 'BAD',
          capabilityGrade: 'HTTP_REACHABLE_BUT_BLANK',
          businessGrade: 'BAD',
          healthScore: 0,
          browserSmoke: smokeResult,
        },
        meta: registerContext.meta,
      });
    }
  }

  logStageProgress('entry', 'Dreamina 注册主链启动', {
    logger: logInfo,
    context: registerContext?.stageLogContext || {},
    extra: 'stageOrder=proxyPrecheck->entry->credential->verification->profileCompletion->postAuthReady->upgrade->payment->accountDelivery',
  });

  // 在正式进入 Dreamina 六阶段主链前，先做极轻的启动前校验。
  // 注意：Dreamina-register 不负责执行 proxy precheck，但如果外层已经传入失败的 proxyPrecheckResult，
  // 这里会拒绝继续启动，避免把明显坏代理再次交给正式注册链。
  const preconditions = checkDreaminaRegisterPreconditions(registerContext);
  if (!preconditions.ok) {
    logStageFail('entry', 'Dreamina 注册主链启动前校验失败', {
      logger: logInfo,
      context: registerContext?.stageLogContext || {},
      extra: `reason=${preconditions.reason}`,
    });
    registerContext.meta.finishedAt = Date.now();
    registerContext.meta.durationMs = registerContext.meta.finishedAt - registerContext.meta.startedAt;
    registerContext.meta.successStageCount = 0;
    return normalizeDreaminaRegisterResult({
      success: false,
      finalStage: 'preconditions',
      finalState: preconditions.state,
      finalReason: preconditions.reason,
      nextStage: '',
      account: registerContext.account,
      proxy: registerContext.proxy,
      deliveryPayload: null,
      stageResults: registerContext.stageResults,
      proxyPrecheckSummary: buildProxyPrecheckSummary(registerContext.proxyPrecheckResult),
      meta: registerContext.meta,
    });
  }

  // 定义 Dreamina 当前主链顺序。
  // 当前总链已经升级为 7 阶段：先做 proxyPrecheck，再进入后续 6 个正式业务阶段。
  const stageOrder = [
    'proxyPrecheck',
    'entry',
    'credential',
    'verification',
    'profileCompletion',
    'postAuthReady',
    'upgrade',
    'payment',
    'accountDelivery',
  ];

  // 逐个阶段执行。
  for (const stageKey of stageOrder) {
    // 如果有日志函数，记录主链当前正在进入哪个阶段。
    if (typeof logInfo === 'function') logInfo(`dreamina.register.stage.start | stage=${stageKey}`);

    // 运行当前阶段。
    const stageExecution = await runDreaminaStage(stageKey, registerContext);
    // 当前阶段原始结果。
    const stageResult = stageExecution?.result || null;

    // 如果当前阶段失败，则立即停止后续阶段并收口。
    if (!stageExecution?.ok) {
      // 记录主链结束时间。
      registerContext.meta.finishedAt = Date.now();
      // 记录总耗时。
      registerContext.meta.durationMs = registerContext.meta.finishedAt - registerContext.meta.startedAt;
      // 记录已成功阶段数。
      registerContext.meta.successStageCount = Object.values(registerContext.stageResults).filter(item => item?.success).length;

      // 返回统一失败结构。
      logStageFail(stageResult?.stage || stageKey, 'Dreamina 注册主链失败收口', {
        logger: logInfo,
        context: registerContext?.stageLogContext || {},
        extra: [
          `finalStage=${stageResult?.stage || stageKey}`,
          `finalState=${stageResult?.state || 'DREAMINA_REGISTER_FLOW_FAILED'}`,
          `finalReason=${stageResult?.reason || stageResult?.state || 'DREAMINA_REGISTER_FLOW_FAILED'}`,
        ].join(' | '),
      });
      return normalizeDreaminaRegisterResult({
        success: false,
        finalStage: stageResult?.stage || stageKey,
        finalState: stageResult?.state || 'DREAMINA_REGISTER_FLOW_FAILED',
        finalReason: stageResult?.reason || stageResult?.state || 'DREAMINA_REGISTER_FLOW_FAILED',
        nextStage: stageResult?.nextStage || '',
        account: registerContext.account,
        proxy: registerContext.proxy,
        detail: stageResult?.detail || null,
        deliveryPayload: registerContext.stageResults?.accountDelivery?.detail?.deliveryPayload?.payload || null,
        stageResults: registerContext.stageResults,
        proxyPrecheckSummary: buildProxyPrecheckSummary(registerContext.stageResults?.proxyPrecheck || registerContext.proxyPrecheckResult),
        fingerprintSummary: buildFingerprintSummary(registerContext?.browserRuntime?.fingerprint?.summary || registerContext?.fingerprint?.summary || null),
        meta: registerContext.meta,
      });
    }

    // 如果有日志函数，记录当前阶段成功。
    if (typeof logInfo === 'function') logInfo(`dreamina.register.stage.success | stage=${stageKey} | state=${stageResult?.state || 'UNKNOWN'}`);
  }

  // 所有阶段都成功后，补齐主链元信息。
  registerContext.meta.finishedAt = Date.now();
  registerContext.meta.durationMs = registerContext.meta.finishedAt - registerContext.meta.startedAt;
  registerContext.meta.successStageCount = Object.values(registerContext.stageResults).filter(item => item?.success).length;

  logStageSuccess('account-delivery', 'Dreamina 注册主链完成', {
    logger: logInfo,
    context: registerContext?.stageLogContext || {},
    extra: `durationMs=${registerContext.meta.durationMs}`,
  });

  // 返回统一成功结构。
  return normalizeDreaminaRegisterResult({
    success: true,
    finalStage: 'account-delivery',
    finalState: registerContext.stageResults?.accountDelivery?.state || 'DELIVERY_COMPLETE',
    finalReason: registerContext.stageResults?.accountDelivery?.reason || registerContext.stageResults?.accountDelivery?.state || 'DELIVERY_COMPLETE',
    nextStage: registerContext.stageResults?.accountDelivery?.nextStage || 'delivery-complete',
    account: registerContext.account,
    proxy: registerContext.proxy,
    deliveryPayload: registerContext.stageResults?.accountDelivery?.detail?.deliveryPayload?.payload || null,
    stageResults: registerContext.stageResults,
    proxyPrecheckSummary: buildProxyPrecheckSummary(registerContext.proxyPrecheckResult),
    fingerprintSummary: buildFingerprintSummary(registerContext?.browserRuntime?.fingerprint?.summary || registerContext?.fingerprint?.summary || null),
    meta: registerContext.meta,
  });
}


function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function buildStageSummaryText(stageResults = {}) {
  const ordered = [
    ['proxyPrecheck', 'proxyPrecheck'],
    ['entry', 'entry'],
    ['credential', 'credential'],
    ['verification', 'verification'],
    ['profileCompletion', 'profileCompletion'],
    ['postAuthReady', 'postAuthReady'],
    ['upgrade', 'upgrade'],
    ['payment', 'payment'],
    ['accountDelivery', 'accountDelivery'],
  ];
  return ordered.map(([key, label]) => {
    const item = stageResults?.[key];
    if (!item) return `${label}=SKIP`;
    return `${label}=${String(item.state || (item.success ? 'OK' : 'UNKNOWN') || 'UNKNOWN')}`;
  }).join(', ');
}


function buildTimingSummaryText(result = {}) {
  const stageKeyMap = [
    ['proxyPrecheck', 'proxyPrecheck'],
    ['entry', 'entry'],
    ['credential', 'credential'],
    ['verification', 'verification'],
    ['profileCompletion', 'profileCompletion'],
    ['postAuthReady', 'postAuthReady'],
    ['upgrade', 'upgrade'],
    ['payment', 'payment'],
    ['accountDelivery', 'accountDelivery'],
  ];
  const parts = stageKeyMap.map(([key, label]) => {
    const item = result?.stageResults?.[key];
    const duration = item?.detail?.durationMs ?? item?.durationMs ?? null;
    if (Number.isFinite(Number(duration))) {
      return `${label}=${Math.max(0, Math.round(Number(duration)))}ms`;
    }
    return '';
  }).filter(Boolean);
  const total = Number(result?.meta?.durationMs || 0);
  if (Number.isFinite(total) && total > 0) {
    parts.push(`total=${Math.max(0, Math.round(total))}ms`);
  }
  return parts.join(', ');
}


function buildSlowestStageText(result = {}) {
  const stageKeyMap = [
    ['proxyPrecheck', 'proxyPrecheck'],
    ['entry', 'entry'],
    ['credential', 'credential'],
    ['verification', 'verification'],
    ['profileCompletion', 'profileCompletion'],
    ['postAuthReady', 'postAuthReady'],
    ['upgrade', 'upgrade'],
    ['payment', 'payment'],
    ['accountDelivery', 'accountDelivery'],
  ];
  let winner = null;
  for (const [key, label] of stageKeyMap) {
    const item = result?.stageResults?.[key];
    const duration = Number(item?.detail?.durationMs ?? item?.durationMs ?? NaN);
    if (!Number.isFinite(duration)) continue;
    if (!winner || duration > winner.durationMs) {
      winner = { label, durationMs: duration, state: String(item?.state || '') };
    }
  }
  if (!winner) return '';
  return `${winner.label}=${Math.max(0, Math.round(winner.durationMs))}ms${winner.state ? ` | state=${winner.state}` : ''}`;
}


function buildFailureSummaryText(result = {}) {
  if (result?.success) return '';
  const stage = String(result?.finalStage || 'UNKNOWN_STAGE');
  const reason = String(result?.finalReason || result?.finalState || 'UNKNOWN_REASON');
  return `FailureStage=${stage} | FailureReason=${reason}`;
}

function buildFingerprintSummary(input = null) {
  const summary = input && typeof input === 'object' ? input : {};
  return {
    userAgent: String(summary?.userAgent || ''),
    viewport: String(summary?.viewport || ''),
    locale: String(summary?.locale || ''),
    timezoneId: String(summary?.timezoneId || ''),
    acceptLanguage: String(summary?.acceptLanguage || ''),
    colorScheme: String(summary?.colorScheme || ''),
    deviceScaleFactor: Number(summary?.deviceScaleFactor || 0),
    randomEnabled: Boolean(summary?.randomEnabled),
    identityStable: Boolean(summary?.identityStable),
    identityKey: String(summary?.identityKey || ''),
    identityHash: String(summary?.identityHash || ''),
    identitySeed: String(summary?.identitySeed || ''),
    identityTtlBucket: summary?.identityTtlBucket === null || summary?.identityTtlBucket === undefined
      ? null
      : Number(summary.identityTtlBucket),
    countryCode: String(summary?.countryCode || ''),
    geoSource: String(summary?.geoSource || ''),
    storagePolicy: String(summary?.storagePolicy || ''),
  };
}

function resolveBrowserIdentityConfig(config = {}) {
  const browserIdentity = config?.browserIdentity && typeof config.browserIdentity === 'object'
    ? config.browserIdentity
    : {};
  const browserIdentityFromBrowser = config?.browser?.identity && typeof config.browser.identity === 'object'
    ? config.browser.identity
    : {};

  return {
    enabled: true,
    stableByProxy: true,
    stableFingerprintTtlMs: 6 * 60 * 60 * 1000,
    alignGeoWithProxy: true,
    includeAcceptLanguageHeader: true,
    clearStorageOnStart: true,
    ...browserIdentityFromBrowser,
    ...browserIdentity,
  };
}

function sanitizeFileName(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeCliResultFile(result = {}, meta = {}) {
  const resultsDir = path.join(__dirname, '..', 'data', 'results');
  const successDir = path.join(resultsDir, 'success');
  const failedDir = path.join(resultsDir, 'failed');
  const latestDir = path.join(resultsDir, 'latest');
  const indexFile = path.join(latestDir, 'dreamina-cli-index.json');
  ensureDir(resultsDir);
  ensureDir(successDir);
  ensureDir(failedDir);
  ensureDir(latestDir);

  const accountEmail = sanitizeFileName(result?.account?.email || meta?.accountEmail || 'unknown-account');
  const stage = sanitizeFileName(result?.finalStage || 'unknown-stage');
  const state = sanitizeFileName(result?.finalState || 'unknown-state');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bucketDir = result?.success ? successDir : failedDir;
  const fileName = `dreamina-cli-${accountEmail}-${stage}-${state}-${stamp}.json`;
  const filePath = path.join(bucketDir, fileName);
  await fs.promises.writeFile(filePath, JSON.stringify(result, null, 2), 'utf8');

  const latestByAccount = path.join(latestDir, `dreamina-cli-${accountEmail}-latest.json`);
  const latestOverall = path.join(latestDir, 'dreamina-cli-latest.json');
  await fs.promises.writeFile(latestByAccount, JSON.stringify(result, null, 2), 'utf8');
  await fs.promises.writeFile(latestOverall, JSON.stringify(result, null, 2), 'utf8');

  let indexData = [];
  try {
    const existing = await fs.promises.readFile(indexFile, 'utf8');
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed)) indexData = parsed;
  } catch (_) {}

  const entry = {
    timestamp: new Date().toISOString(),
    account: result?.account?.email || meta?.accountEmail || '',
    success: Boolean(result?.success),
    finalStage: String(result?.finalStage || ''),
    finalState: String(result?.finalState || ''),
    finalReason: String(result?.finalReason || ''),
    stageSummary: buildStageSummaryText(result?.stageResults || {}),
    slowestStage: buildSlowestStageText(result),
    durationMs: Number(result?.meta?.durationMs || 0),
    fingerprintSummary: buildFingerprintSummary(result?.fingerprintSummary || result?.meta?.fingerprintSummary || null),
    resultFile: filePath,
    latestResultFile: latestByAccount,
  };

  indexData.unshift(entry);
  indexData = indexData.slice(0, 50);
  await fs.promises.writeFile(indexFile, JSON.stringify(indexData, null, 2), 'utf8');

  return {
    filePath,
    latestByAccount,
    latestOverall,
    indexFile,
  };
}

function parseCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  let proxyIndex = 0;
  let accountIndex = 0;
  let headed = false;
  let slowMo = 0;

  for (let index = 0; index < args.length; index++) {
    const token = String(args[index] || '').trim();
    if (!token) continue;
    if (token === '--proxy-index') {
      proxyIndex = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }
    if (token === '--account-index') {
      accountIndex = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }
    if (token === '--headed') {
      headed = true;
      continue;
    }
    if (token === '--headless') {
      headed = false;
      continue;
    }
    if (token === '--slow-mo') {
      slowMo = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }
    if (/^\d+$/.test(token)) {
      proxyIndex = Number(token);
    }
  }

  return {
    proxyIndex: Number.isFinite(proxyIndex) ? proxyIndex : 0,
    accountIndex: Number.isFinite(accountIndex) ? accountIndex : 0,
    headed,
    slowMo: Number.isFinite(slowMo) ? slowMo : 0,
  };
}

function selectCliProxy(proxies = [], proxyIndex = 0) {
  const list = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
  if (!list.length) return null;
  const normalizedIndex = Math.max(0, Math.min(Number(proxyIndex) || 0, list.length - 1));
  return list[normalizedIndex] || null;
}

function shouldSkipProxyHealthRecord(record = {}) {
  if (!record || typeof record !== 'object') return false;
  const status = String(record.status || '').trim().toLowerCase();
  const bucket = String(record.lastBucket || '').trim().toLowerCase();
  const reason = String(record.lastReason || '').trim().toUpperCase();
  const failCount = Number(record.failCount || 0);

  if (status === 'bad') return true;
  if (status === 'unstable') return true;
  if (failCount >= 3 && bucket === 'entry') return true;
  if (failCount >= 4 && /READY_SIGNAL_MISSING|ENTRY_NOT_READY|ENTRY_HEALTH_FAILED/.test(reason)) return true;
  return false;
}

function resolveCliProxySelection(proxies = [], requestedProxyIndex = 0) {
  const list = Array.isArray(proxies) ? proxies.filter(Boolean) : [];
  if (!list.length) {
    return {
      proxy: null,
      requestedProxyIndex,
      selectedProxyIndex: -1,
      skippedProxyIds: [],
    };
  }

  const health = loadProxyHealth();
  const requestedIndex = Math.max(0, Math.min(Number(requestedProxyIndex) || 0, list.length - 1));
  const skippedProxyIds = [];

  for (let offset = 0; offset < list.length; offset++) {
    const index = (requestedIndex + offset) % list.length;
    const candidate = list[index];
    const proxyId = String(summarizeProxy(candidate).id || candidate.id || candidate.raw || '').trim();
    const record = proxyId ? health[proxyId] : null;
    if (shouldSkipProxyHealthRecord(record)) {
      if (proxyId) skippedProxyIds.push(proxyId);
      continue;
    }

    return {
      proxy: candidate,
      requestedProxyIndex: requestedIndex,
      selectedProxyIndex: index,
      skippedProxyIds,
      exhaustedHealthyCandidates: false,
    };
  }

  return {
    proxy: null,
    requestedProxyIndex: requestedIndex,
    selectedProxyIndex: -1,
    skippedProxyIds,
    exhaustedHealthyCandidates: skippedProxyIds.length >= list.length,
  };
}

function loadLocalAccounts() {
  const accountFilePath = path.join(__dirname, '..', 'account-state', 'local-accounts.json');
  if (!fs.existsSync(accountFilePath)) return [];

  const raw = fs.readFileSync(accountFilePath, 'utf8');
  const parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '').replace(/^\uFEFF/, ''));
  } catch (error) {
    return fallback;
  }
}

function loadProxyHealth() {
  const filePath = path.join(__dirname, '..', 'data', 'proxy-health.json');
  const parsed = readJsonFileSafe(filePath, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function saveProxyHealth(health = {}) {
  const filePath = path.join(__dirname, '..', 'data', 'proxy-health.json');
  fs.writeFileSync(filePath, `${JSON.stringify(health, null, 2)}\n`, 'utf8');
}

function appendBadProxyRecord(proxy = null, reason = '') {
  if (!proxy || typeof proxy !== 'object') return;
  const filePath = path.join(__dirname, 'stages', 'S0-proxy-precheck', 'data', 'bad-proxies.txt');
  const line = String(proxy.raw || `${proxy.host || ''}:${proxy.port || ''}`).trim();
  if (!line) return;

  const existing = fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  if (existing.split(/\r?\n/).includes(line)) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(filePath, `${prefix}${line}\n`, 'utf8');
}

function resolveProxyDisposition(result = {}, currentRecord = null) {
  const finalStage = String(result?.finalStage || '').trim().toLowerCase();
  const finalReason = String(result?.finalReason || result?.finalState || '').trim().toUpperCase();
  const finalState = String(result?.finalState || '').trim().toUpperCase();
  const previousFailCount = Number(currentRecord?.failCount || 0);

  if (finalStage === 'proxy-precheck' && /407|PROXY_CONNECTIVITY_FAILED|DREAMINA_PROXY_CONNECTIVITY_FAILED/.test(finalReason)) {
    return {
      status: 'bad',
      reason: finalReason || finalState || 'PROXY_PRECHECK_FAILED',
      bucket: 'proxy-precheck',
    };
  }

  if (finalStage === 'entry' && /DREAMINA_WHITE_SCREEN|DREAMINA_FIRST_LOAD_DEAD_PAGE|DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT|DREAMINA_ENTRY_PAGE_OPEN_FAILED/.test(finalReason)) {
    return {
      status: 'bad',
      reason: finalReason || finalState || 'ENTRY_FAILED',
      bucket: 'entry',
    };
  }

  if (finalStage === 'entry' && /DREAMINA_READY_SIGNAL_MISSING|ENTRY_NOT_READY/.test(finalReason) && previousFailCount >= 2) {
    return {
      status: 'unstable',
      reason: finalReason || finalState || 'ENTRY_UNSTABLE',
      bucket: 'entry',
    };
  }

  if (result?.success) {
    return {
      status: 'healthy',
      reason: 'SUCCESS',
      bucket: 'success',
    };
  }

  return {
    status: 'observe',
    reason: finalReason || finalState || 'UNKNOWN',
    bucket: finalStage || 'unknown',
  };
}

function recordProxyHealth(result = {}, proxy = null) {
  if (!proxy || typeof proxy !== 'object') return null;

  const proxyId = String(summarizeProxy(proxy).id || proxy.id || proxy.raw || '').trim();
  if (!proxyId) return null;

  const health = loadProxyHealth();
  const current = health[proxyId] && typeof health[proxyId] === 'object' ? health[proxyId] : {};
  const disposition = resolveProxyDisposition(result, current);
  const next = {
    proxyId,
    status: disposition.status,
    lastReason: disposition.reason,
    lastBucket: disposition.bucket,
    failCount: disposition.status === 'healthy' ? 0 : Number(current.failCount || 0) + 1,
    successCount: disposition.status === 'healthy' ? Number(current.successCount || 0) + 1 : Number(current.successCount || 0),
    lastRaw: String(proxy.raw || '').trim(),
    lastUpdatedAt: Date.now(),
  };

  health[proxyId] = next;
  saveProxyHealth(health);

  if (disposition.status === 'bad') {
    appendBadProxyRecord(proxy, disposition.reason);
  }

  return next;
}

function selectCliAccount(accounts = [], accountIndex = 0) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  if (!list.length) return null;
  const normalizedIndex = Math.max(0, Math.min(Number(accountIndex) || 0, list.length - 1));
  const account = list[normalizedIndex] || null;
  if (!account) return null;

  return {
    email: String(account.email || '').trim(),
    password: String(account.password || ''),
  };
}

async function createDreaminaCliRuntime(options = {}) {
  const proxy = options?.proxy && typeof options.proxy === 'object' ? options.proxy : null;
  const headed = Boolean(options?.headed);
  const slowMo = Number.isFinite(Number(options?.slowMo)) ? Number(options.slowMo) : 0;
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;
  const blockedResourceTypes = Array.isArray(options?.blockedResourceTypes)
    ? options.blockedResourceTypes.map(item => String(item || '').trim().toLowerCase()).filter(Boolean)
    : ['image', 'media', 'font'];

  return await createBrowserRuntime({
    runtime: options?.runtime || {},
    proxy,
    account: options?.account || null,
    browserIdentity: options?.browserIdentity || null,
    headed,
    slowMo,
    windowLayout,
    blockedResourceTypes,
    browserIpCheckTimeoutMs: Number(options?.browserIpCheckTimeoutMs) || 8000,
  });
}

async function runDreaminaRegisterCli(argv = []) {
  // 支付相关旗标(--dry-run/--plan/--tab/--no-upgrade/--no-billing/--amount)→ env 覆盖。
  require('./cli-billing-flags').applyBillingFlags(argv);
  const { proxyIndex, accountIndex, headed, slowMo } = parseCliArgs(argv);
  const proxies = loadLocalProxies();
  const accounts = loadLocalAccounts();
  const proxySelection = resolveCliProxySelection(proxies, proxyIndex);
  const proxy = proxySelection.proxy;
  const account = selectCliAccount(accounts, accountIndex);

  // 读 config.json （单跑 CLI 与 batch-runner 保持一致）
  let _cliConfig = {};
  try {
    _cliConfig = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'config.json'), 'utf8'));
  } catch (_) {}
  const _credentialCfg = (_cliConfig && _cliConfig.credential) || {};
  // skipExistsPrecheckAfterEmail 默认 true（不在填完邮筱后多距一步检查账号是否已存在）
  const _skipExistsPrecheck = _credentialCfg.skipExistsPrecheckAfterEmail !== false;

  if (!proxy) {
    const noHealthyProxy = Boolean(proxySelection?.exhaustedHealthyCandidates);
    const emptyResult = {
      success: false,
      site: 'dreamina',
      finalStage: 'preconditions',
      finalState: noHealthyProxy ? 'DREAMINA_REGISTER_NO_HEALTHY_PROXY_AVAILABLE' : 'DREAMINA_REGISTER_PROXY_MISSING',
      finalReason: noHealthyProxy ? 'DREAMINA_REGISTER_NO_HEALTHY_PROXY_AVAILABLE' : 'DREAMINA_REGISTER_PROXY_MISSING',
      nextStage: '',
      account: {},
      proxy: null,
      deliveryPayload: null,
      stageResults: {},
      proxyPrecheckSummary: null,
      meta: {
        cli: true,
        proxyIndex,
        selectedProxyIndex: proxySelection.selectedProxyIndex,
        skippedProxyIds: proxySelection.skippedProxyIds,
        exhaustedHealthyCandidates: proxySelection.exhaustedHealthyCandidates,
        accountIndex,
      },
    };
    const resultFiles = await writeCliResultFile(emptyResult, {});
    console.log(noHealthyProxy ? '[Dreamina Register] 当前没有健康代理可用，请补充新代理或清理 bad/unstable 代理记录' : '[Dreamina Register] 未找到可用代理');
    console.log(`[Dreamina Register] Result file: ${resultFiles.filePath}`);
    console.log(`[Dreamina Register] Latest file: ${resultFiles.latestByAccount}`);
    console.log(`[Dreamina Register] Index file: ${resultFiles.indexFile}`);
    emptyResult.meta = {
      ...(emptyResult.meta || {}),
      resultFile: resultFiles.filePath,
      latestResultFile: resultFiles.latestByAccount,
      latestOverallResultFile: resultFiles.latestOverall,
      resultIndexFile: resultFiles.indexFile,
    };
    return emptyResult;
  }

  if (!account?.email || !account?.password) {
    const emptyResult = {
      success: false,
      site: 'dreamina',
      finalStage: 'preconditions',
      finalState: 'DREAMINA_REGISTER_ACCOUNT_MISSING',
      finalReason: 'DREAMINA_REGISTER_ACCOUNT_MISSING',
      nextStage: '',
      account: account || {},
      proxy,
      deliveryPayload: null,
      stageResults: {},
      proxyPrecheckSummary: null,
      meta: {
        cli: true,
        proxyIndex,
        selectedProxyIndex: proxySelection.selectedProxyIndex,
        skippedProxyIds: proxySelection.skippedProxyIds,
        accountIndex,
      },
    };
    const resultFiles = await writeCliResultFile(emptyResult, {});
    console.log('[Dreamina Register] 未找到可用账号，请检查 Dreamina/0.0.3/account-state/local-accounts.json');
    console.log(`[Dreamina Register] Result file: ${resultFiles.filePath}`);
    console.log(`[Dreamina Register] Latest file: ${resultFiles.latestByAccount}`);
    console.log(`[Dreamina Register] Index file: ${resultFiles.indexFile}`);
    emptyResult.meta = {
      ...(emptyResult.meta || {}),
      resultFile: resultFiles.filePath,
      latestResultFile: resultFiles.latestByAccount,
      latestOverallResultFile: resultFiles.latestOverall,
      resultIndexFile: resultFiles.indexFile,
    };
    return emptyResult;
  }

  let cliRuntime = null;
  try {
    const browserIdentity = resolveBrowserIdentityConfig(_cliConfig || {});
    cliRuntime = await createDreaminaCliRuntime({
      proxy,
      account,
      headed,
      slowMo,
      blockedResourceTypes: ['image', 'media', 'font'],
      browserIdentity,
      runtime: {
        browserIdentity,
        proxyCountryCode: String(proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
        proxyCountryName: String(proxy?.countryName || proxy?.proxyCountryName || '').trim(),
        countryCode: String(account?.countryCode || proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
        countryName: String(account?.countryName || proxy?.countryName || proxy?.proxyCountryName || '').trim(),
      },
    });

    const result = await runDreaminaRegisterFlow({
      browser: cliRuntime.browser,
      context: cliRuntime.context,
      page: cliRuntime.page,
      proxy,
      account,
      runtime: {
        cli: true,
        headed,
        slowMo,
        accountIndex,
        requestedProxyIndex: proxySelection.requestedProxyIndex,
        selectedProxyIndex: proxySelection.selectedProxyIndex,
        skippedProxyIds: proxySelection.skippedProxyIds,
        dreaminaHomeUrl: 'https://dreamina.capcut.com/ai-tool/home',
        dreaminaEntryUrl: 'https://dreamina.capcut.com/ai-tool/home',
        entryGotoTimeoutMs: 120000,
        dreaminaNavigationTimeoutMs: 120000,
        firstLoadGraceWaitMs: 12000,
        dreaminaAuthMode: 'signup',
        credentialSignupSwitchWaitMs: 1200,
        skipCredentialExistsPrecheckAfterEmail: _skipExistsPrecheck, // 与 batch-runner 保持一致，默认跳过此预检
        verificationRetryMaxAttempts: 2,   // initial轮 + 1次resend后重试
        verificationResendWaitMs: 2000,    // 点击Resend后等页面响应
        firstmailApiMaxPollAttempts: 12,   // 12次 × 3s = 36s预算/轮
        waitMailIntervalMs: 3000,          // 轮询间隔3s
        firstmailRecentMessageScanLimit: 8,
        firstmailPollJitterMinMs: 0,
        firstmailPollJitterMaxMs: 0,
        readyTextSignals: [
          'Continue with email',
          'Sign in',
          'Log in',
          'Login',
          'Sign up',
          'Create realistic talk',
          'Start Creating With AI Agent',
          'AI Image',
          'Canvas',
        ],
        readySelectors: [
          'input[role="textbox"]',
          'input[type="email"]',
          '[class*="credit-display-container"]',
          '[class*="login"] button',
          '[class*="signin"] button',
          '[class*="sign-in"] button',
          '[class*="signup"] button',
          '[class*="sign-up"] button',
        ],
        readyBodyPatterns: [
          'dreamina',
          'capcut',
          'continue with email',
          'sign in',
          'sign up',
          'create realistic talk',
          'ai image',
          'canvas',
        ],
      },
      logInfo: null,
    });

    const proxyHealthRecord = recordProxyHealth(result, proxy);
    if (proxyHealthRecord) {
      result.meta = {
        ...(result.meta || {}),
        requestedProxyIndex: proxySelection.requestedProxyIndex,
        selectedProxyIndex: proxySelection.selectedProxyIndex,
        skippedProxyIds: proxySelection.skippedProxyIds,
        exhaustedHealthyCandidates: proxySelection.exhaustedHealthyCandidates,
        proxyDisposition: proxyHealthRecord,
        fingerprintSummary: buildFingerprintSummary(cliRuntime?.fingerprint?.summary || null),
      };
    }

    const resultFiles = await writeCliResultFile(result, {
      accountEmail: account.email,
    });
    const stageSummary = buildStageSummaryText(result?.stageResults || {});
    const timingSummary = buildTimingSummaryText(result);
    const slowestStage = buildSlowestStageText(result);
    const failureSummary = buildFailureSummaryText(result);
    console.log(`[Dreamina Register] Success=${result.success ? 'Y' : 'N'} | Account=${account.email} | Proxy=${summarizeProxy(proxy).id || 'N/A'} | FinalStage=${result.finalStage || 'UNKNOWN'} | FinalState=${result.finalState || 'UNKNOWN'}`);
    if (failureSummary) console.log(`[Dreamina Register] ${failureSummary}`);
    console.log(`[Dreamina Register] StageSummary: ${stageSummary}`);
    if (timingSummary) console.log(`[Dreamina Register] TimingSummary: ${timingSummary}`);
    if (slowestStage) console.log(`[Dreamina Register] SlowestStage: ${slowestStage}`);
    console.log(`[Dreamina Register] Result file: ${resultFiles.filePath}`);
    console.log(`[Dreamina Register] Latest file: ${resultFiles.latestByAccount}`);
    console.log(`[Dreamina Register] Index file: ${resultFiles.indexFile}`);
    result.fingerprintSummary = buildFingerprintSummary(cliRuntime?.fingerprint?.summary || result?.fingerprintSummary || result?.meta?.fingerprintSummary || null);
    result.meta = {
      ...(result.meta || {}),
      fingerprintSummary: buildFingerprintSummary(cliRuntime?.fingerprint?.summary || result?.fingerprintSummary || result?.meta?.fingerprintSummary || null),
      resultFile: resultFiles.filePath,
      latestResultFile: resultFiles.latestByAccount,
      latestOverallResultFile: resultFiles.latestOverall,
      resultIndexFile: resultFiles.indexFile,
    };
    return result;
  } finally {
    if (cliRuntime?.context && typeof cliRuntime.context.close === 'function') {
      await cliRuntime.context.close().catch(() => {});
    }
    if (cliRuntime?.browser && typeof cliRuntime.browser.close === 'function') {
      await cliRuntime.browser.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  runDreaminaRegisterCli(process.argv.slice(2))
    .then(result => {
      process.exit(result?.success ? 0 : 1);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  buildDreaminaStageRegistry,
  buildDreaminaRegisterContext,
  buildProxyPrecheckSummary,
  checkDreaminaRegisterPreconditions,
  runDreaminaStage,
  normalizeDreaminaRegisterResult,
  runDreaminaRegisterFlow,
  parseCliArgs,
  selectCliProxy,
  loadLocalAccounts,
  selectCliAccount,
  loadProxyHealth,
  shouldSkipProxyHealthRecord,
  resolveCliProxySelection,
  resolveProxyDisposition,
  recordProxyHealth,
  createDreaminaCliRuntime,
  runDreaminaRegisterCli,
};
