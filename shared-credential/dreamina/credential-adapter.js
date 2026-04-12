'use strict';

const fs = require('fs');
const path = require('path');

/**
 * credential-adapter.js
 *
 * 这个文件是 Dreamina 在阶段 2（credential submit）里的站点适配层。
 *
 * 它负责：
 * - Dreamina credential form ready 判断
 * - Dreamina email / password 填写
 * - Dreamina Continue / Submit 点击
 * - Dreamina 提交结果确认
 * - Dreamina 阶段 2 失败分类
 *
 * 它不负责：
 * - 首页打开
 * - 登录入口切换
 * - 验证码阶段
 * - birthday / profile completion
 * - session / storage
 */

/**
 * Dreamina 阶段 2 profile 文件路径。
 *
 * 作用：
 * - 让 adapter 的 selector / text / signal 尽量从 profile 读取
 * - 避免把阶段 2 细节全写死在 JS 代码里
 */
const DREAMINA_CREDENTIAL_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-credential-profile.json');
let dreaminaCredentialProfileCache = null;

/**
 * 读取 Dreamina 阶段 2 profile。
 *
 * 作用：
 * - 读取 JSON 配置
 * - 统一供本文件内部方法使用
 */
function loadDreaminaCredentialProfile(options = {}) {
  const forceReload = Boolean(options?.forceReload);
  if (!forceReload && dreaminaCredentialProfileCache) return dreaminaCredentialProfileCache;
  const raw = fs.readFileSync(DREAMINA_CREDENTIAL_PROFILE_PATH, 'utf8');
  dreaminaCredentialProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  return dreaminaCredentialProfileCache;
}

/**
 * 判断 locator 是否可见。
 *
 * 作用：
 * - 统一所有阶段 2 可见性判断
 * - 避免每个方法都重复写 `.isVisible().catch(...)`
 */
async function isVisible(locator) {
  return await locator.isVisible().catch(() => false);
}

/**
 * 从多个 selector 中找到第一个可见 locator。
 *
 * 作用：
 * - 用于 email / password / submit / success signal / failure signal 的候选扫描
 */
async function findFirstVisibleBySelectors(page, selectors = []) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) {
      return {
        ok: true,
        selector,
        locator,
      };
    }
  }

  return {
    ok: false,
    selector: '',
    locator: null,
  };
}

/**
 * 从多个文本中找到第一个可见 locator。
 *
 * 作用：
 * - 用于按钮文本、成功文本、失败文本匹配
 */
async function findFirstVisibleByTexts(page, texts = []) {
  for (const text of texts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    if (await isVisible(locator)) {
      return {
        ok: true,
        text,
        locator,
      };
    }
  }

  return {
    ok: false,
    text: '',
    locator: null,
  };
}

async function ensureDreaminaSignupMode(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const preferSignup = runtime?.dreaminaAuthMode !== 'signin';
  if (!preferSignup) {
    return {
      ok: true,
      state: 'AUTH_MODE_SIGNIN_ALLOWED',
      switched: false,
      authMode: 'signin',
      signalStrength: 'weak',
    };
  }

  const signInHeader = await findFirstVisibleByTexts(page, ['Sign in', 'Welcome back']);
  const signUpEntry = await findFirstVisibleByTexts(page, ['Sign up', "Don't have an account?"]);
  const signUpHeader = await findFirstVisibleByTexts(page, ['Sign up']);
  const emailInput = page.locator("input[placeholder*='email' i], input[type='email'], input[role='textbox']").first();
  const passwordInput = page.locator("input[type='password']").first();
  const emailVisible = await isVisible(emailInput);
  const passwordVisible = await isVisible(passwordInput);

  if ((signUpHeader.ok && emailVisible && passwordVisible) || (!signInHeader.ok && emailVisible && passwordVisible)) {
    return {
      ok: true,
      state: 'AUTH_MODE_ALREADY_SIGNUP_LIKE',
      switched: false,
      authMode: 'signup',
      signalStrength: signUpHeader.ok ? 'strong' : 'weak',
      source: signUpHeader.ok ? signUpHeader.text : 'fields-visible',
    };
  }

  if (!signUpEntry.ok) {
    return {
      ok: false,
      state: 'SIGNUP_SWITCH_NOT_FOUND',
      switched: false,
      authMode: signInHeader.ok ? 'signin' : 'unknown',
      signalStrength: 'weak',
    };
  }

  await signUpEntry.locator.click({ timeout: 1500 }).catch(async () => {
    await signUpEntry.locator.click({ force: true, timeout: 1500 });
  });
  await page.waitForTimeout(Number(runtime?.credentialSignupSwitchWaitMs || 1200));

  const postSwitchHeader = await findFirstVisibleByTexts(page, ['Sign up']);
  const postSwitchEmailVisible = await isVisible(emailInput);
  const postSwitchPasswordVisible = await isVisible(passwordInput);

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.ensureSignupMode | switched via=${signUpEntry.text} | signupHeader=${postSwitchHeader.ok ? 'Y' : 'N'} | email=${postSwitchEmailVisible ? 'Y' : 'N'} | password=${postSwitchPasswordVisible ? 'Y' : 'N'}`);
  }

  return {
    ok: postSwitchHeader.ok || (postSwitchEmailVisible && postSwitchPasswordVisible),
    state: postSwitchHeader.ok || (postSwitchEmailVisible && postSwitchPasswordVisible) ? 'AUTH_MODE_SWITCHED_TO_SIGNUP' : 'AUTH_MODE_SIGNUP_NOT_STABLE',
    switched: true,
    source: signUpEntry.text,
    authMode: postSwitchHeader.ok || (postSwitchEmailVisible && postSwitchPasswordVisible) ? 'signup' : 'unknown',
    signalStrength: postSwitchHeader.ok ? 'strong' : 'weak',
  };
}

/**
 * 等待 Dreamina credential form ready。
 *
 * 作用：
 * - 确认 email input / password input / submit button 是否已经可用
 * - 这是阶段 2 的起点判断
 */
async function waitForDreaminaCredentialFormReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const authModeResult = await ensureDreaminaSignupMode(page, runtime, context);
  if (!authModeResult?.ok) {
    return {
      ok: false,
      state: authModeResult?.state || 'FORM_NOT_READY',
      authModeResult,
    };
  }
  const primaryWaitMs = Number(runtime?.credentialFormPrimaryWaitMs || 300);
  const secondaryWaitMs = Number(runtime?.credentialFormSecondaryWaitMs || 900);
  const waitSteps = [...new Set([0, primaryWaitMs, secondaryWaitMs].filter(ms => Number(ms) >= 0))];

  let lastResult = null;
  for (const waitMs of waitSteps) {
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const emailSelectors = profile?.fields?.email?.selectors || [];
    const passwordSelectors = profile?.fields?.password?.selectors || [];
    const submitSelectors = profile?.submit?.selectors || [];
    const submitTexts = profile?.submit?.texts || [];

    const emailField = await findFirstVisibleBySelectors(page, emailSelectors);
    const passwordField = await findFirstVisibleBySelectors(page, passwordSelectors);
    const submitBySelector = await findFirstVisibleBySelectors(page, submitSelectors);
    const submitByText = submitBySelector.ok ? { ok: false, text: '', locator: null } : await findFirstVisibleByTexts(page, submitTexts);

    const submit = submitBySelector.ok
      ? { ok: true, source: 'selector', value: submitBySelector.selector, locator: submitBySelector.locator }
      : submitByText.ok
        ? { ok: true, source: 'text', value: submitByText.text, locator: submitByText.locator }
        : { ok: false, source: '', value: '', locator: null };

    lastResult = {
      ok: false,
      state: 'FORM_NOT_READY',
      emailField,
      passwordField,
      submit,
      waitStepMs: waitMs,
    };

    if (emailField.ok && passwordField.ok && submit.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.credential.waitForFormReady | ready | waitStepMs=${waitMs} | email=${emailField.selector} | password=${passwordField.selector} | submit=${submit.source}:${submit.value}`);
      }
      return {
        ok: true,
        state: 'FORM_READY',
        emailField,
        passwordField,
        submit,
        waitStepMs: waitMs,
        authModeResult,
      };
    }

    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.waitForFormReady | not-ready | waitStepMs=${waitMs} | email=${emailField.ok ? 'Y' : 'N'} | password=${passwordField.ok ? 'Y' : 'N'} | submit=${submit.ok ? 'Y' : 'N'}`);
    }
  }

  return lastResult || {
    ok: false,
    state: 'FORM_NOT_READY',
    emailField: { ok: false, selector: '', locator: null },
    passwordField: { ok: false, selector: '', locator: null },
    submit: { ok: false, source: '', value: '', locator: null },
    waitStepMs: 0,
    authModeResult,
  };
}

/**
 * 填写 Dreamina email。
 *
 * 作用：
 * - 负责阶段 2 的 email 输入动作
 * - 只负责 fill，不负责提交
 */
async function fillDreaminaCredentialEmail(page, account, runtime = {}, context = {}) {
  const { logInfo = null, formReady = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const emailField = formReady?.emailField?.ok
    ? formReady.emailField
    : await findFirstVisibleBySelectors(page, profile?.fields?.email?.selectors || []);

  if (!emailField.ok || !emailField.locator) {
    return {
      ok: false,
      state: 'EMAIL_INPUT_NOT_FOUND',
      account: account?.email || '',
    };
  }

  await emailField.locator.fill(String(account?.email || ''));
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.fillEmail | selector=${emailField.selector} | email=${account?.email || ''}`);
  }

  return {
    ok: true,
    state: 'EMAIL_FILLED',
    selector: emailField.selector,
    account: account?.email || '',
  };
}

/**
 * 填写 Dreamina password。
 *
 * 作用：
 * - 负责阶段 2 的 password 输入动作
 * - 只负责 fill，不负责提交
 */
async function fillDreaminaCredentialPassword(page, account, runtime = {}, context = {}) {
  const { logInfo = null, formReady = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const passwordField = formReady?.passwordField?.ok
    ? formReady.passwordField
    : await findFirstVisibleBySelectors(page, profile?.fields?.password?.selectors || []);

  if (!passwordField.ok || !passwordField.locator) {
    return {
      ok: false,
      state: 'PASSWORD_INPUT_NOT_FOUND',
    };
  }

  await passwordField.locator.fill(String(account?.password || ''));
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.fillPassword | selector=${passwordField.selector}`);
  }

  return {
    ok: true,
    state: 'PASSWORD_FILLED',
    selector: passwordField.selector,
  };
}

/**
 * 捕获阶段 2 提交前后的轻量状态快照。
 *
 * 作用：
 * - 用来判断 submit 后页面到底有没有发生有效变化
 * - 不做重 DOM diff，只抓阶段 2 最关心的几个状态
 */
async function captureDreaminaCredentialSubmitSnapshot(page, context = {}) {
  const profile = loadDreaminaCredentialProfile();
  const successBySelector = await findFirstVisibleBySelectors(page, profile?.successSignals?.selectors || []);
  const successByText = await findFirstVisibleByTexts(page, profile?.successSignals?.texts || []);
  const existingAccount = await findFirstVisibleByTexts(page, profile?.failureSignals?.existingAccount || []);
  const rejected = await findFirstVisibleByTexts(page, profile?.failureSignals?.rejected || []);
  const rateLimited = await findFirstVisibleByTexts(page, profile?.failureSignals?.rateLimited || []);
  const inlineErrors = await findFirstVisibleByTexts(page, profile?.failureSignals?.inlineErrors || []);
  const authTitle = await findFirstVisibleByTexts(page, ['Sign up', 'Sign in', 'Welcome back']);
  const emailField = await findFirstVisibleBySelectors(page, profile?.fields?.email?.selectors || []);
  const passwordField = await findFirstVisibleBySelectors(page, profile?.fields?.password?.selectors || []);
  const continueBySelector = await findFirstVisibleBySelectors(page, profile?.submit?.selectors || []);
  const continueByText = continueBySelector.ok ? { ok: false, text: '', locator: null } : await findFirstVisibleByTexts(page, profile?.submit?.texts || []);
  const continueLocator = continueBySelector.ok ? continueBySelector.locator : continueByText.locator;
  const continueText = continueBySelector.ok ? continueBySelector.selector : (continueByText.ok ? continueByText.text : '');
  const continueEnabled = continueLocator ? await continueLocator.isEnabled().catch(() => false) : false;
  const errorModal = await findFirstVisibleByTexts(page, ['Something went wrong', 'Refresh']);
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();

  return {
    url: page.url(),
    authTitle: authTitle.ok ? authTitle.text : '',
    authMode: authTitle.ok ? (/sign up/i.test(authTitle.text) ? 'signup' : 'signin') : 'unknown',
    emailVisible: Boolean(emailField.ok),
    passwordVisible: Boolean(passwordField.ok),
    continueVisible: Boolean(continueLocator),
    continueEnabled,
    continueText,
    verificationVisible: Boolean(successBySelector.ok || successByText.ok),
    hasSuccessSelector: Boolean(successBySelector.ok),
    hasSuccessText: Boolean(successByText.ok),
    hasExistingAccount: Boolean(existingAccount.ok),
    hasRejected: Boolean(rejected.ok),
    hasRateLimited: Boolean(rateLimited.ok),
    hasInlineError: Boolean(inlineErrors.ok),
    hasErrorModal: Boolean(errorModal.ok),
    bodyTextLength: bodyText.length,
    bodyPreview: bodyText.slice(0, 200),
  };
}

/**
 * 判断 submit 前后是否发生了足够明确的状态变化。
 *
 * 作用：
 * - 把“提交后无状态变化”从纯 unknown 里单独拆出来
 * - 后续更容易判断是 submit 没生效，还是结果判定不够
 */
function hasMeaningfulCredentialSubmitStateChange(before = null, after = null) {
  if (!before || !after) return false;
  if (before.url !== after.url) return true;
  if (before.authMode !== after.authMode) return true;
  if (before.authTitle !== after.authTitle) return true;
  if (before.continueEnabled !== after.continueEnabled) return true;
  if (before.verificationVisible !== after.verificationVisible) return true;
  if (before.hasSuccessSelector !== after.hasSuccessSelector) return true;
  if (before.hasSuccessText !== after.hasSuccessText) return true;
  if (before.hasExistingAccount !== after.hasExistingAccount) return true;
  if (before.hasRejected !== after.hasRejected) return true;
  if (before.hasRateLimited !== after.hasRateLimited) return true;
  if (before.hasInlineError !== after.hasInlineError) return true;
  if (before.hasErrorModal !== after.hasErrorModal) return true;
  if (before.bodyPreview !== after.bodyPreview) return true;
  if (Math.abs(Number(before.bodyTextLength || 0) - Number(after.bodyTextLength || 0)) >= 40) return true;
  return false;
}

/**
 * 编排 submit 后的分层等待节奏。
 *
 * 作用：
 * - 第一层短等待后先做快检
 * - 如果第一层没拿到结果，再做第二层保护等待
 * - 把等待阶段信息带回 confirm，避免把“只是稍慢”过早判成 unknown
 */
async function waitDreaminaCredentialSubmitSettlement(page, runtime = {}, context = {}) {
  const { logInfo = null } = context; // 读取日志函数，方便把等待节奏写进运行日志
  const primaryWaitMs = Number(runtime?.credentialSubmitPrimaryWaitMs || 400); // 第一层短等待：让 submit 后的页面先开始响应
  const secondaryWaitMs = Number(runtime?.credentialSubmitSecondaryWaitMs || 1200); // 第二层保护等待：给慢一点的验证码阶段更多稳定时间

  if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | primary wait start | ms=${primaryWaitMs}`); // 记录第一层等待开始，后面排日志能知道当前进入了哪一层
  await page.waitForTimeout(primaryWaitMs); // 先做第一层短等待，避免点击完立刻检查导致误判
  if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | primary wait end | ms=${primaryWaitMs}`); // 记录第一层等待结束，确认短等待已经跑完

  const primaryFailure = await runDreaminaCredentialImmediateFailureChecks(page, context); // 第一层等待后先做高价值失败快检，看是否已经出现已注册/被拒绝/限流
  if (primaryFailure.hit) { // 如果第一层就命中失败，就没必要继续等第二层了
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | primary failure hit=${primaryFailure.state}`); // 把第一层命中的失败直接打日志
    return {
      settled: true, // 标记 settlement 已经拿到明确结果
      stage: 'primary-failure', // 说明结果是在第一层等待后拿到的失败结果
      quickFailure: primaryFailure, // 保留第一层失败结果给 confirm 复用
      verificationReady: null, // 第一层失败命中时，不存在成功进入验证码阶段结果
    };
  }

  const primaryVerification = await detectDreaminaVerificationStageReady(page, context); // 第一层等待后再看是否已经进入验证码阶段
  if (primaryVerification.ok) { // 如果第一层就拿到成功信号，也直接结束 settlement
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | primary verification hit | strength=${primaryVerification.strength}`); // 记录第一层成功命中强度
    return {
      settled: true, // 标记 settlement 已经拿到明确结果
      stage: 'primary-success', // 说明结果是在第一层等待后拿到的成功结果
      quickFailure: null, // 第一层成功命中时，没有失败结果
      verificationReady: primaryVerification, // 保留第一层成功结果给 confirm 复用
    };
  }

  if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | secondary wait start | ms=${secondaryWaitMs}`); // 第一层没结果时，进入第二层保护等待
  await page.waitForTimeout(secondaryWaitMs); // 再给页面一段保护等待，覆盖慢一点的验证码阶段切换
  if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | secondary wait end | ms=${secondaryWaitMs}`); // 记录第二层等待结束，方便回溯“是不是等满了还没结果”

  const secondaryFailure = await runDreaminaCredentialImmediateFailureChecks(page, context); // 第二层等待后再次做失败快检，看看较慢出现的错误是否已经落地
  if (secondaryFailure.hit) { // 如果第二层才命中失败，也直接结束 settlement
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | secondary failure hit=${secondaryFailure.state}`); // 记录第二层命中的失败结果
    return {
      settled: true, // 标记 settlement 已经拿到明确结果
      stage: 'secondary-failure', // 说明失败是在第二层等待后命中的
      quickFailure: secondaryFailure, // 保留第二层失败结果给 confirm 使用
      verificationReady: null, // 第二层失败命中时，不存在成功结果
    };
  }

  const secondaryVerification = await detectDreaminaVerificationStageReady(page, context); // 第二层等待后再次检查验证码阶段成功信号
  if (secondaryVerification.ok) { // 如果第二层才出现成功信号，就在这里收口
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.settlement | secondary verification hit | strength=${secondaryVerification.strength}`); // 记录第二层成功命中强度
    return {
      settled: true, // 标记 settlement 已经拿到明确结果
      stage: 'secondary-success', // 说明成功是在第二层等待后命中的
      quickFailure: null, // 第二层成功命中时，没有失败结果
      verificationReady: secondaryVerification, // 保留第二层成功结果给 confirm 使用
    };
  }

  if (typeof logInfo === 'function') logInfo('dreamina.credential.settlement | no result after layered waits'); // 两层等待都没命中时，明确记一条日志，说明问题不是单纯“没等”
  return {
    settled: true, // 标记 settlement 流程已经跑完，即使还没拿到明确结果
    stage: 'no-result', // 说明两层等待都没有命中成功或高价值失败
    quickFailure: null, // 保留为空，表示没有命中失败结果
    verificationReady: null, // 保留为空，表示没有命中成功结果
  };
}

/**
 * 提交 Dreamina credential form。
 *
 * 作用：
 * - 点击 Continue / Submit
 * - 不在这里写完整结果判断，而是只负责点击和快照采集
 * - 把 settlement 结果一并带回，让 confirm 层知道分层等待是否已经跑过
 */
async function submitDreaminaCredentialForm(page, runtime = {}, context = {}) {
  const { logInfo = null, formReady = null } = context;
  const profile = loadDreaminaCredentialProfile();

  const submit = formReady?.submit?.ok ? formReady.submit : null;
  let submitLocator = submit?.locator || null;
  let submitLabel = submit?.value || '';

  if (!submitLocator) {
    const submitBySelector = await findFirstVisibleBySelectors(page, profile?.submit?.selectors || []);
    if (submitBySelector.ok) {
      submitLocator = submitBySelector.locator;
      submitLabel = submitBySelector.selector;
    }
  }
  if (!submitLocator) {
    const submitByText = await findFirstVisibleByTexts(page, profile?.submit?.texts || []);
    if (submitByText.ok) {
      submitLocator = submitByText.locator;
      submitLabel = submitByText.text;
    }
  }

  if (!submitLocator) {
    return {
      ok: false,
      state: 'SUBMIT_BUTTON_NOT_FOUND',
    };
  }

  const attempts = [];
  const runAttempt = async (mode, runner) => {
    const beforeSnapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);
    await runner();
    const settlementResult = await waitDreaminaCredentialSubmitSettlement(page, runtime, context);
    const afterSnapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);
    const hasStateChange = hasMeaningfulCredentialSubmitStateChange(beforeSnapshot, afterSnapshot);
    attempts.push({
      mode,
      beforeAuthMode: beforeSnapshot.authMode,
      afterAuthMode: afterSnapshot.authMode,
      continueEnabled: beforeSnapshot.continueEnabled,
      verificationVisible: afterSnapshot.verificationVisible,
      inlineError: afterSnapshot.hasInlineError,
      stateChanged: hasStateChange,
      settlementStage: settlementResult?.stage || '',
    });
    return { beforeSnapshot, afterSnapshot, settlementResult, hasStateChange };
  };

  const strategies = [
    {
      mode: 'click',
      run: async () => {
        await submitLocator.click({ timeout: 1500 }).catch(() => {});
      },
    },
    {
      mode: 'force-click',
      run: async () => {
        await submitLocator.click({ force: true, timeout: 1500 }).catch(() => {});
      },
    },
    {
      mode: 'enter-submit',
      run: async () => {
        const passwordField = formReady?.passwordField?.locator || page.locator("input[type='password']").first();
        await passwordField.focus().catch(() => {});
        await passwordField.press('Enter').catch(() => {});
      },
    },
  ];

  let finalResult = null;
  for (const strategy of strategies) {
    finalResult = await runAttempt(strategy.mode, strategy.run);
    if (finalResult.hasStateChange || finalResult.settlementResult?.quickFailure?.hit || finalResult.settlementResult?.verificationReady?.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.credential.submitForm | submit=${submitLabel} | mode=${strategy.mode} | settlementStage=${finalResult.settlementResult?.stage || ''} | stateChanged=${finalResult.hasStateChange ? 'Y' : 'N'}`);
      }
      return {
        ok: true,
        state: 'FORM_SUBMITTED',
        submit: submitLabel,
        submitMode: strategy.mode,
        beforeSnapshot: finalResult.beforeSnapshot,
        afterSnapshot: finalResult.afterSnapshot,
        hasStateChange: finalResult.hasStateChange,
        settlementResult: finalResult.settlementResult,
        attempts,
      };
    }
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.submitForm | submit=${submitLabel} | mode=all | settlementStage=${finalResult?.settlementResult?.stage || ''} | stateChanged=${finalResult?.hasStateChange ? 'Y' : 'N'}`);
  }

  return {
    ok: true,
    state: 'FORM_SUBMITTED',
    submit: submitLabel,
    submitMode: finalResult ? attempts[attempts.length - 1]?.mode || '' : '',
    beforeSnapshot: finalResult?.beforeSnapshot || null,
    afterSnapshot: finalResult?.afterSnapshot || null,
    hasStateChange: Boolean(finalResult?.hasStateChange),
    settlementResult: finalResult?.settlementResult || null,
    attempts,
  };
}

/**
 * 提交后第一批安全检查。
 *
 * 作用：
 * - 优先识别旧链里已经证明很值的高价值失败
 * - 避免把“已存在账号 / 被拒绝 / 限流”误看成只是没进验证码阶段
 */
async function runDreaminaCredentialImmediateFailureChecks(page, context = {}) {
  const profile = loadDreaminaCredentialProfile();

  const existingAccount = await findFirstVisibleByTexts(page, profile?.failureSignals?.existingAccount || []);
  if (existingAccount.ok) {
    return {
      hit: true,
      state: 'ACCOUNT_ALREADY_EXISTS',
      source: 'text',
      value: existingAccount.text,
    };
  }

  const rejected = await findFirstVisibleByTexts(page, profile?.failureSignals?.rejected || []);
  if (rejected.ok) {
    return {
      hit: true,
      state: 'SIGNUP_REJECTED',
      source: 'text',
      value: rejected.text,
    };
  }

  const rateLimited = await findFirstVisibleByTexts(page, profile?.failureSignals?.rateLimited || []);
  if (rateLimited.ok) {
    return {
      hit: true,
      state: 'RATE_LIMITED',
      source: 'text',
      value: rateLimited.text,
    };
  }

  return {
    hit: false,
    state: '',
    source: '',
    value: '',
  };
}

/**
 * 检测 Dreamina 是否已经强确认进入验证码阶段。
 *
 * 作用：
 * - 比单纯 success text 更强
 * - 优先确认验证码输入框 / one-time-code 输入框这类强信号
 */
async function detectDreaminaVerificationStageReady(page, context = {}) {
  const { logInfo = null } = context;
  const profile = loadDreaminaCredentialProfile();

  const successBySelector = await findFirstVisibleBySelectors(page, profile?.successSignals?.selectors || []);
  if (successBySelector.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.detectVerificationStageReady | strong selector hit=${successBySelector.selector}`);
    }
    return {
      ok: true,
      state: 'CREDENTIAL_SUBMIT_OK',
      nextStage: 'verification',
      source: 'selector',
      value: successBySelector.selector,
      strength: 'strong',
    };
  }

  const successByText = await findFirstVisibleByTexts(page, profile?.successSignals?.texts || []);
  if (successByText.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.detectVerificationStageReady | weak text hit=${successByText.text}`);
    }
    return {
      ok: true,
      state: 'CREDENTIAL_SUBMIT_OK',
      nextStage: 'verification',
      source: 'text',
      value: successByText.text,
      strength: 'weak',
    };
  }

  return {
    ok: false,
    state: 'VERIFICATION_STAGE_NOT_READY',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 确认 Dreamina credential submit 结果。
 *
 * 作用：
 * - 优先复用 submit 后的 settlement 结果，避免重复无意义等待
 * - settlement 没拿到结果时，再看 inline error / no-state-change / unknown
 *
 * 这是阶段 2 最核心的结果判断方法。
 */
async function confirmDreaminaCredentialSubmitResult(page, runtime = {}, context = {}) {
  const { logInfo = null, submitResult = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const settlementResult = submitResult?.settlementResult || null; // 先拿 submit 阶段已经跑过的 settlement 结果，避免确认层再重复组织等待

  if (settlementResult?.quickFailure?.hit) { // 如果 settlement 已经命中高价值失败，这里直接复用，不再重复检查同一批失败
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | settlement failure hit=${settlementResult.quickFailure.state} | stage=${settlementResult.stage}`); // 记录失败是在第几层等待命中的
    return {
      ok: false,
      state: settlementResult.quickFailure.state,
      nextStage: '',
      source: settlementResult.quickFailure.source,
      value: settlementResult.quickFailure.value,
      strength: 'strong',
      settleStage: settlementResult.stage,
    };
  }

  if (settlementResult?.verificationReady?.ok) { // 如果 settlement 已经命中验证码阶段成功信号，就直接把成功结果返回
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | settlement verification hit | stage=${settlementResult.stage}`); // 把成功命中的等待阶段也写进日志
    return {
      ...settlementResult.verificationReady,
      settleStage: settlementResult.stage,
      strength: settlementResult.verificationReady?.strength || '',
    };
  }

  const inlineErrors = profile?.failureSignals?.inlineErrors || []; // 取出 profile 里的通用 inline error 关键字，作为 settlement 之后的补充检查
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').toLowerCase(); // 读取 body 文本，用于做通用 inline error 扫描
  const inlineHit = inlineErrors.find(item => bodyText.includes(String(item || '').toLowerCase())); // 在 body 文本里查找是否出现已知内联错误
  if (inlineHit) { // 如果页面上已经出现内联错误，就明确返回这类失败，不再落到更粗的 unknown
    return {
      ok: false,
      state: 'INLINE_ERROR_VISIBLE',
      nextStage: '',
      source: 'bodyText',
      value: inlineHit,
      strength: 'weak',
      settleStage: settlementResult?.stage || 'inline-check',
    };
  }

  if (submitResult && submitResult.hasStateChange === false) { // 如果 settlement 跑完后页面仍然没有有意义变化，就明确归类成 no-state-change
    return {
      ok: false,
      state: 'CREDENTIAL_SUBMIT_NO_STATE_CHANGE',
      nextStage: '',
      source: 'snapshot',
      value: 'SUBMIT_NO_STATE_CHANGE',
      strength: 'weak',
      settleStage: settlementResult?.stage || 'snapshot-check',
    };
  }

  if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | unknown after settlement | stage=${settlementResult?.stage || 'none'}`); // 记录已经经过 settlement 但仍未能判定，方便后续补 signal 而不是误怀疑等待
  return {
    ok: false,
    state: 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: settlementResult?.stage || 'none',
  };
}

/**
 * 对 Dreamina 阶段 2 失败做分类。
 *
 * 作用：
 * - 将阶段 2 的失败 reason 收敛成 Dreamina 专属语义
 */
function classifyDreaminaCredentialSubmitFailure(input = {}) {
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  let siteReason = reason;

  if (reason === 'FORM_NOT_READY') {
    siteReason = 'DREAMINA_CREDENTIAL_FORM_NOT_READY';
  } else if (reason === 'AUTH_MODE_SIGNUP_NOT_STABLE') {
    siteReason = 'DREAMINA_CREDENTIAL_AUTH_MODE_NOT_STABLE';
  } else if (reason === 'EMAIL_INPUT_NOT_FOUND') {
    siteReason = 'DREAMINA_EMAIL_INPUT_NOT_FOUND';
  } else if (reason === 'PASSWORD_INPUT_NOT_FOUND') {
    siteReason = 'DREAMINA_PASSWORD_INPUT_NOT_FOUND';
  } else if (reason === 'SUBMIT_BUTTON_NOT_FOUND') {
    siteReason = 'DREAMINA_SUBMIT_BUTTON_NOT_FOUND';
  } else if (reason === 'ACCOUNT_ALREADY_EXISTS') {
    siteReason = 'DREAMINA_ACCOUNT_ALREADY_EXISTS';
  } else if (reason === 'SIGNUP_REJECTED') {
    siteReason = 'DREAMINA_SIGNUP_REJECTED';
  } else if (reason === 'RATE_LIMITED') {
    siteReason = 'DREAMINA_RATE_LIMITED';
  } else if (reason === 'INLINE_ERROR_VISIBLE') {
    siteReason = 'DREAMINA_INLINE_ERROR_VISIBLE';
  } else if (reason === 'SIGNUP_SWITCH_NOT_FOUND') {
    siteReason = 'DREAMINA_SIGNUP_SWITCH_NOT_FOUND';
  } else if (reason === 'CREDENTIAL_SUBMIT_NO_STATE_CHANGE') {
    siteReason = 'DREAMINA_CREDENTIAL_NO_STATE_CHANGE_AFTER_ALL_STRATEGIES';
  } else if (reason === 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN') {
    siteReason = 'DREAMINA_CREDENTIAL_SUBMIT_RESULT_UNKNOWN';
  }

  return {
    reason,
    siteReason,
    hardFailure: reason === 'SIGNUP_REJECTED',
  };
}

module.exports = {
  loadDreaminaCredentialProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  ensureDreaminaSignupMode,
  waitForDreaminaCredentialFormReady,
  fillDreaminaCredentialEmail,
  fillDreaminaCredentialPassword,
  captureDreaminaCredentialSubmitSnapshot,
  hasMeaningfulCredentialSubmitStateChange,
  waitDreaminaCredentialSubmitSettlement,
  submitDreaminaCredentialForm,
  runDreaminaCredentialImmediateFailureChecks,
  detectDreaminaVerificationStageReady,
  confirmDreaminaCredentialSubmitResult,
  classifyDreaminaCredentialSubmitFailure,
};
