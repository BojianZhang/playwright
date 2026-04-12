'use strict';

const { chromium } = require('playwright');
const { loadLocalProxies, summarizeProxy } = require('../shared-proxy-precheck/local-proxy-loader');

// ==============================
// Dreamina 主链编排层：阶段公共 runner 引入
// ==============================

// 阶段 0：proxy-precheck 公共骨架。
const { runProxyPrecheckChain } = require('../shared-proxy-precheck/stages/proxy-precheck');
// 阶段 1：entry 公共骨架。
const { runEntryStage } = require('../shared-entry/stages/entry');

// 阶段 2：credential submit 公共骨架。
const { runCredentialSubmitStage } = require('../shared-credential/stages/credential-submit');
// 阶段 3：verification submit 公共骨架。
const { runVerificationSubmitStage } = require('../shared-verification/stages/verification-submit');
// 阶段 4：profile completion submit 公共骨架。
const { runProfileCompletionSubmitStage } = require('../shared-profile-completion/stages/profile-completion-submit');
// 阶段 5：post-auth-ready 公共骨架。
const { runPostAuthReadyStage } = require('../shared-post-auth-ready/stages/post-auth-ready');
// 阶段 6：account-delivery 公共骨架。
const { runAccountDeliveryStage } = require('../shared-account-delivery/stages/account-delivery');

// ==============================
// Dreamina 主链编排层：各阶段 Dreamina adapter 引入
// ==============================

// 阶段 0：Dreamina proxy-precheck adapter。
const dreaminaProxyPrecheckAdapter = require('../shared-proxy-precheck/dreamina/proxy-precheck-adapter');
// 阶段 1：Dreamina entry adapter。
const dreaminaEntrySiteAdapter = require('../shared-entry/dreamina/adapter');

function buildDreaminaEntryStageAdapter(siteAdapter = {}) {
  return {
    async openEntryPage(page, runtime = {}, context = {}) {
      const result = typeof siteAdapter.waitForDreaminaReady === 'function'
        ? await siteAdapter.waitForDreaminaReady(page, runtime, context)
        : null;

      if (result?.ok) {
        return {
          ok: true,
          state: 'ENTRY_PAGE_OPENED',
          source: result.source || 'dreamina-ready',
          value: result.value || 'ENTRY_READY',
          strength: result.strength || 'strong',
          stateChanged: true,
        };
      }

      if (result) {
        return {
          ok: false,
          state: String(result.state || 'ENTRY_PAGE_OPEN_FAILED'),
          source: result.source || 'dreamina-ready',
          value: result.value || '',
          strength: result.strength || '',
          stateChanged: typeof result.stateChanged === 'boolean' ? result.stateChanged : null,
        };
      }

      return {
        ok: false,
        state: 'ENTRY_PAGE_OPEN_FAILED',
        source: 'dreamina-ready',
        value: 'ENTRY_ADAPTER_RETURNED_EMPTY',
        strength: '',
        stateChanged: null,
      };
    },

    async checkEntryHealth(page, runtime = {}, context = {}) {
      return {
        ok: true,
        state: 'ENTRY_HEALTH_OK',
        source: 'delegated',
        value: 'DELEGATED_TO_DREAMINA_READY',
        strength: 'weak',
        stateChanged: null,
      };
    },

    async waitForEntryReady(page, runtime = {}, context = {}) {
      if (typeof siteAdapter.ensureDreaminaLoginGate !== 'function') {
        return {
          ok: false,
          state: 'ENTRY_ADAPTER_METHOD_MISSING',
          source: 'adapter',
          value: 'ensureDreaminaLoginGate',
          strength: '',
        };
      }

      const gateResult = await siteAdapter.ensureDreaminaLoginGate(page, runtime, context);
      if (gateResult?.ok) {
        return {
          ok: true,
          state: 'ENTRY_READY',
          source: gateResult.state || gateResult.source || 'login-gate',
          value: gateResult.reason || gateResult.state || 'LOGIN_GATE_READY',
          strength: 'strong',
          stateChanged: true,
        };
      }

      return {
        ok: false,
        state: 'ENTRY_NOT_READY',
        source: gateResult?.state || gateResult?.source || 'login-gate',
        value: gateResult?.reason || gateResult?.state || '',
        strength: '',
      };
    },

    classifyEntryFailure(input = {}) {
      const classified = typeof siteAdapter.classifyDreaminaLoginGateFailure === 'function'
        ? siteAdapter.classifyDreaminaLoginGateFailure(input)
        : null;

      return {
        reason: String(input.reason || input.state || 'ENTRY_NOT_READY').trim().toUpperCase(),
        siteReason: classified?.siteReason || 'DREAMINA_ENTRY_NOT_READY',
        hardFailure: Boolean(classified?.hardFailure),
      };
    },
  };
}

const dreaminaEntryAdapter = buildDreaminaEntryStageAdapter(dreaminaEntrySiteAdapter);
// 阶段 2：Dreamina credential adapter。
const dreaminaCredentialAdapter = require('../shared-credential/dreamina/credential-adapter');
// 阶段 3：Dreamina verification adapter。
const dreaminaVerificationAdapter = require('../shared-verification/dreamina/verification-adapter');
// 阶段 4：Dreamina profile completion adapter。
const dreaminaProfileCompletionAdapter = require('../shared-profile-completion/dreamina/profile-completion-adapter');
// 阶段 5：Dreamina post-auth-ready adapter。
const dreaminaPostAuthReadyAdapter = require('../shared-post-auth-ready/dreamina/post-auth-ready-adapter');
// 阶段 6：Dreamina account-delivery adapter。
const dreaminaAccountDeliveryAdapter = require('../shared-account-delivery/dreamina/account-delivery-adapter');

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
    // 阶段 6：account-delivery
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
function buildDreaminaRegisterContext(options = {}) {
  // 解构主链输入。
  const {
    browser = null,
    context = null,
    page = null,
    account = {},
    proxy = null,
    proxyPrecheckResult = null,
    runtime = {},
    logInfo = null,
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
    // 各阶段结果容器；初始都为 null。
    stageResults: {
      proxyPrecheck: null,
      entry: null,
      credential: null,
      verification: null,
      profileCompletion: null,
      postAuthReady: null,
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
  return {
    success: Boolean(result.success),
    state: String(result.state || '').trim(),
    reason: String(result.reason || result.state || '').trim(),
    signalStrength: String(result.signalStrength || '').trim(),
    detectionSource: String(result.detectionSource || '').trim(),
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

  // 如果注册表项不存在，就直接返回失败结构。
  if (!stageEntry) {
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

  // 执行阶段公共 runner。
  // 注意：proxyPrecheck 阶段的主输入是 proxy，不是 page/account 业务表单上下文。
  const result = stageKey === 'proxyPrecheck'
    ? await stageRunner({
        proxy: registerContext.proxy,
        adapter: stageEntry.adapter,
        runtime: registerContext.runtime,
        context: stageContext,
      })
    : await stageRunner({
        page: registerContext.page,
        account: registerContext.account,
        adapter: stageEntry.adapter,
        runtime: registerContext.runtime,
        context: stageContext,
      });

  // 把阶段结果写回 stageResults。
  registerContext.stageResults[stageKey] = result;

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
  // 全链阶段结果汇总。
  const stageResults = input.stageResults && typeof input.stageResults === 'object' ? input.stageResults : {};
  // 代理预检摘要；只做轻引用，不吞并完整 detail。
  const proxyPrecheckSummary = input.proxyPrecheckSummary && typeof input.proxyPrecheckSummary === 'object' ? input.proxyPrecheckSummary : null;
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
    deliveryPayload,
    stageResults,
    proxyPrecheckSummary,
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

  // 在正式进入 Dreamina 六阶段主链前，先做极轻的启动前校验。
  // 注意：Dreamina-register 不负责执行 proxy precheck，但如果外层已经传入失败的 proxyPrecheckResult，
  // 这里会拒绝继续启动，避免把明显坏代理再次交给正式注册链。
  const preconditions = checkDreaminaRegisterPreconditions(registerContext);
  if (!preconditions.ok) {
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
      return normalizeDreaminaRegisterResult({
        success: false,
        finalStage: stageResult?.stage || stageKey,
        finalState: stageResult?.state || 'DREAMINA_REGISTER_FLOW_FAILED',
        finalReason: stageResult?.reason || stageResult?.state || 'DREAMINA_REGISTER_FLOW_FAILED',
        nextStage: stageResult?.nextStage || '',
        account: registerContext.account,
        proxy: registerContext.proxy,
        deliveryPayload: registerContext.stageResults?.accountDelivery?.detail?.deliveryPayload?.payload || null,
        stageResults: registerContext.stageResults,
        proxyPrecheckSummary: buildProxyPrecheckSummary(registerContext.stageResults?.proxyPrecheck || registerContext.proxyPrecheckResult),
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
    meta: registerContext.meta,
  });
}

function parseCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  let proxyIndex = 0;
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

async function createDreaminaCliRuntime(options = {}) {
  const proxy = options?.proxy && typeof options.proxy === 'object' ? options.proxy : null;
  const headed = Boolean(options?.headed);
  const slowMo = Number.isFinite(Number(options?.slowMo)) ? Number(options.slowMo) : 0;

  const launchOptions = {
    headless: !headed,
    slowMo,
  };

  if (proxy?.server) {
    launchOptions.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
  };
}

async function runDreaminaRegisterCli(argv = []) {
  const { proxyIndex, headed, slowMo } = parseCliArgs(argv);
  const proxies = loadLocalProxies();
  const proxy = selectCliProxy(proxies, proxyIndex);

  if (!proxy) {
    const emptyResult = {
      success: false,
      site: 'dreamina',
      finalStage: 'preconditions',
      finalState: 'DREAMINA_REGISTER_PROXY_MISSING',
      finalReason: 'DREAMINA_REGISTER_PROXY_MISSING',
      nextStage: '',
      account: {},
      proxy: null,
      deliveryPayload: null,
      stageResults: {},
      proxyPrecheckSummary: null,
      meta: {
        cli: true,
        proxyIndex,
      },
    };
    console.log('[Dreamina Register] 未找到可用代理');
    console.log(JSON.stringify(emptyResult, null, 2));
    return emptyResult;
  }

  let cliRuntime = null;
  try {
    cliRuntime = await createDreaminaCliRuntime({
      proxy,
      headed,
      slowMo,
    });

    const result = await runDreaminaRegisterFlow({
      browser: cliRuntime.browser,
      context: cliRuntime.context,
      page: cliRuntime.page,
      proxy,
      account: {},
      runtime: {
        cli: true,
        headed,
        slowMo,
      },
      logInfo: null,
    });

    console.log(`[Dreamina Register] ProxyIndex=${proxyIndex} | Proxy=${summarizeProxy(proxy).id || 'N/A'} | FinalStage=${result.finalStage || 'UNKNOWN'} | FinalState=${result.finalState || 'UNKNOWN'} | Success=${result.success ? 'Y' : 'N'}`);
    console.log(JSON.stringify(result, null, 2));
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
  createDreaminaCliRuntime,
  runDreaminaRegisterCli,
};
