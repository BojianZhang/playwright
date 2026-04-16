// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— S2 Dreamina
//
// 文件定位：Dreamina/0.0.3/S2-credential/credential-adapter.js
// 平台绑定：Dreamina（仅服务于 Dreamina 注册流程，非通用 adapter）
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 填写邮箱和密码并提交 Dreamina 注册表单，处理防抖/密码策略等异常。
// ✅ 负责 —— Dreamina 特有的 CSS 选择器、文案匹配、交互序列定义。
// ✅ 负责 —— 从 profiles/ 加载当前阶段的 Dreamina 配置（profile JSON）。
// ❌ 不负责 —— 阶段调度、重试策略、日志格式化（由框架层 shared-credential/stages/credential-submit.js 负责）。
// ❌ 不负责 —— 跨阶段状态传递（由 Dreamina-register.js 主链持有并传入 options）。
// ❌ 不负责 —— 任何非 Dreamina 平台的逻辑（Platform-specific, not reusable）。
//
// 被调用方：shared-credential/stages/credential-submit.js（框架层通过 options.credential-adapter 或直接调用注入）
// profiles：Dreamina/0.0.3/S2-credential/profiles/
// ═══════════════════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const { isVisible, findFirstVisibleBySelectors, findFirstVisibleByTexts } = require('../../../shared-utils/locator');
const { loadJsonProfileWithCache } = require('../../../shared-utils/profile');
const { buildStepWaitList } = require('../../../shared-utils/timing');

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
// profile 缓存引用，由 shared-utils/profile.js 的 loadJsonProfileWithCache 统一管理。
const _credentialProfileCacheRef = { value: null };

/**
 * 读取 Dreamina 阶段 2 profile。
 *
 * 作用：
 * - 读取 JSON 配置
 * - 统一供本文件内部方法使用
 */
function loadDreaminaCredentialProfile(options = {}) {
  return loadJsonProfileWithCache(DREAMINA_CREDENTIAL_PROFILE_PATH, _credentialProfileCacheRef, options);
}

// ==============================
// 基础工具层
// 只负责 profile / 可见性 / 基础 selector-text 查找。
// 不负责 auth mode、submit、confirm、classify。
// ==============================

// isVisible / findFirstVisibleBySelectors / findFirstVisibleByTexts
// 已迁移至 shared-utils/locator.js，通过顶部 require 引入，此处不再重复定义。


// ==============================
// mode-routing 层
// 负责 register / signin / continue-with-email 的路由推进。
// 这一层只负责把页面推进到 credential form 入口态，不负责最终 submit 成败判定。
// ==============================

function resolveDreaminaCredentialIntent(runtime = {}, context = {}) {
  return String(runtime?.dreaminaAuthMode || '').trim().toLowerCase() === 'signin'
    ? { intent: 'signin', source: 'runtime' }
    : { intent: 'register', source: runtime?.dreaminaAuthMode ? 'runtime' : 'default' };
}

/**
 * route-to-form 入口动作。
 *
 * 边界：
 * - 只负责把登录层推进到 email/password form 所在层
 * - 不负责表单 ready 最终判定
 * - 不负责 submit 后结果判断
 */
async function ensureDreaminaContinueWithEmail(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const emailInput = page.locator("input[placeholder*='email' i], input[type='email'], input[role='textbox']").first();
  const passwordInput = page.locator("input[type='password']").first();
  const formReady = await isVisible(emailInput) && await isVisible(passwordInput);
  if (formReady) {
    return {
      ok: true,
      state: 'CONTINUE_WITH_EMAIL_ALREADY_RESOLVED',
      source: 'credential-form',
      signalStrength: 'strong',
      clicked: false,
    };
  }

  const continueEntry = await findFirstVisibleByTexts(page, ['Continue with email']);
  if (!continueEntry.ok || !continueEntry.locator) {
    return {
      ok: false,
      state: 'CONTINUE_WITH_EMAIL_NOT_FOUND',
      source: 'login-gate-layer',
      signalStrength: 'weak',
      clicked: false,
    };
  }

  await continueEntry.locator.click({ timeout: 1500 }).catch(async () => {
    await continueEntry.locator.click({ force: true, timeout: 1500 });
  });
  await page.waitForTimeout(Number(runtime?.credentialContinueWithEmailWaitMs || 1200));

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.ensureContinueWithEmail | clicked via=${continueEntry.text}`);
  }

  return {
    ok: true,
    state: 'CONTINUE_WITH_EMAIL_CLICKED',
    source: continueEntry.text,
    signalStrength: 'medium',
    clicked: true,
  };
}

async function confirmDreaminaSigninMode(page) {
  const signInHeader = await findFirstVisibleByTexts(page, ['Sign in', 'Welcome back']);
  const emailInput = page.locator("input[placeholder*='email' i], input[type='email'], input[role='textbox']").first();
  const passwordInput = page.locator("input[type='password']").first();
  const emailVisible = await isVisible(emailInput);
  const passwordVisible = await isVisible(passwordInput);
  return {
    ok: signInHeader.ok && emailVisible && passwordVisible,
    state: signInHeader.ok && emailVisible && passwordVisible ? 'AUTH_MODE_SIGNIN_CONFIRMED' : 'AUTH_MODE_SIGNIN_NOT_STABLE',
    authMode: signInHeader.ok ? 'signin' : 'unknown',
    signalStrength: signInHeader.ok ? 'strong' : 'weak',
    source: signInHeader.ok ? signInHeader.text : '',
  };
}

async function clickDreaminaRegisterEntry(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const signUpEntry = await findFirstVisibleByTexts(page, ['Sign up', "Don't have an account?"]);
  if (!signUpEntry.ok || !signUpEntry.locator) {
    return {
      ok: false,
      state: 'SIGNUP_SWITCH_NOT_FOUND',
      switched: false,
      authMode: 'unknown',
      signalStrength: 'weak',
    };
  }

  await signUpEntry.locator.click({ timeout: 1500 }).catch(async () => {
    await signUpEntry.locator.click({ force: true, timeout: 1500 });
  });
  await page.waitForTimeout(Number(runtime?.credentialSignupSwitchWaitMs || 1200));

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.clickRegisterEntry | clicked via=${signUpEntry.text}`);
  }

  return {
    ok: true,
    state: 'AUTH_MODE_SIGNUP_CLICKED',
    switched: true,
    authMode: 'signup',
    signalStrength: 'weak',
    source: signUpEntry.text,
  };
}

async function clickDreaminaSigninEntry(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const signInEntry = await findFirstVisibleByTexts(page, ['Sign in', 'Welcome back', 'Enter your password to sign in to your account']);
  if (!signInEntry.ok || !signInEntry.locator) {
    return {
      ok: false,
      state: 'SIGNIN_SWITCH_NOT_FOUND',
      switched: false,
      authMode: 'unknown',
      signalStrength: 'weak',
    };
  }

  await signInEntry.locator.click({ timeout: 1500 }).catch(async () => {
    await signInEntry.locator.click({ force: true, timeout: 1500 });
  });
  await page.waitForTimeout(Number(runtime?.credentialSigninSwitchWaitMs || 1200));

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.clickSigninEntry | clicked via=${signInEntry.text}`);
  }

  return {
    ok: true,
    state: 'AUTH_MODE_SIGNIN_CLICKED',
    switched: true,
    authMode: 'signin',
    signalStrength: 'weak',
    source: signInEntry.text,
  };
}

async function confirmDreaminaRegisterMode(page) {
  const signUpHeader = await findFirstVisibleByTexts(page, ['Sign up']);
  const emailInput = page.locator("input[placeholder*='email' i], input[type='email'], input[role='textbox']").first();
  const passwordInput = page.locator("input[type='password']").first();
  const emailVisible = await isVisible(emailInput);
  const passwordVisible = await isVisible(passwordInput);
  return {
    ok: signUpHeader.ok && emailVisible && passwordVisible,
    state: signUpHeader.ok && emailVisible && passwordVisible ? 'AUTH_MODE_SWITCHED_TO_SIGNUP' : 'AUTH_MODE_SIGNUP_NOT_STABLE',
    authMode: signUpHeader.ok ? 'signup' : 'unknown',
    signalStrength: signUpHeader.ok ? 'strong' : 'weak',
    source: signUpHeader.ok ? signUpHeader.text : '',
  };
}

async function ensureDreaminaSignupMode(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const intentResult = resolveDreaminaCredentialIntent(runtime, context);
  if (intentResult.intent === 'signin') {
    const signinMode = await confirmDreaminaSigninMode(page);
    return {
      ...signinMode,
      switched: false,
    };
  }

  const clicked = await clickDreaminaRegisterEntry(page, runtime, context);
  if (!clicked.ok) return clicked;
  const confirmed = await confirmDreaminaRegisterMode(page);

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.ensureSignupMode | intent=${intentResult.intent} | signupConfirmed=${confirmed.ok ? 'Y' : 'N'}`);
  }

  return {
    ...confirmed,
    switched: true,
  };
}

async function ensureDreaminaSigninMode(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const confirmedBeforeSwitch = await confirmDreaminaSigninMode(page);
  if (confirmedBeforeSwitch?.ok) {
    return {
      ...confirmedBeforeSwitch,
      switched: false,
    };
  }

  const clicked = await clickDreaminaSigninEntry(page, runtime, context);
  if (!clicked.ok) return clicked;
  const confirmed = await confirmDreaminaSigninMode(page);

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.ensureSigninMode | signinConfirmed=${confirmed.ok ? 'Y' : 'N'}`);
  }

  return {
    ...confirmed,
    switched: true,
  };
}

// ==============================
// precheck hook 层
// 这是可选子流程，不是 credential submit 主链的固定步骤。
// 只在 shared stage optional hook 位调用，不应主导整个阶段 2。
// ==============================

/**
 * 可选 precheck subflow：检查账号是否已存在。
 *
 * 边界：
 * - 这是 hook subflow，不是 shared credential 主链
 * - 允许做 route-to-form、表单确认、email 观察，但不应承担 submit 主链职责
 */
async function precheckDreaminaAccountExists(page, account = {}, runtime = {}, context = {}) {
  const profile = loadDreaminaCredentialProfile();
  const continueWithEmailResult = await ensureDreaminaContinueWithEmail(page, runtime, context);
  if (!continueWithEmailResult?.ok) {
    return {
      ok: false,
      state: continueWithEmailResult?.state || 'EXISTS_PRECHECK_FORM_NOT_READY',
      reason: continueWithEmailResult?.state || 'EXISTS_PRECHECK_FORM_NOT_READY',
      source: 'continue-with-email',
      signalStrength: 'weak',
    };
  }

  const formReady = await waitForDreaminaCredentialFormReady(page, runtime, { ...context, continueWithEmailResult });
  if (!formReady?.ok || !formReady?.emailField?.locator) {
    return {
      ok: false,
      state: 'EXISTS_PRECHECK_FORM_NOT_READY',
      reason: 'EXISTS_PRECHECK_FORM_NOT_READY',
      source: 'form-ready',
      signalStrength: 'weak',
    };
  }

  const email = String(account?.email || '').trim();
  await formReady.emailField.locator.fill(email).catch(async () => {
    await formReady.emailField.locator.click({ timeout: 1000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(email, { delay: Number(runtime?.credentialEmailTypeDelayMs || 35) }).catch(() => {});
  });
  await formReady.emailField.locator.blur().catch(() => {});
  await page.waitForTimeout(Number(runtime?.existsPrecheckObserveMs || 1200));

  const existingAccount = await findFirstVisibleByTexts(page, profile?.failureSignals?.existingAccount || []);
  if (existingAccount.ok) {
    return {
      ok: true,
      state: 'ACCOUNT_ALREADY_EXISTS_PRECHECK',
      reason: 'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
      source: 'inline-text',
      signalStrength: 'strong',
      value: existingAccount.text,
    };
  }

  const inlineError = await findFirstVisibleByTexts(page, profile?.failureSignals?.inlineError || []);
  if (inlineError.ok) {
    return {
      ok: true,
      state: 'EXISTS_PRECHECK_INCONCLUSIVE',
      reason: 'DREAMINA_EXISTS_PRECHECK_INLINE_ERROR',
      source: 'inline-text',
      signalStrength: 'weak',
      value: inlineError.text,
    };
  }

  return {
    ok: true,
    state: 'ACCOUNT_NOT_EXISTS_PRECHECK_CLEAR',
    reason: 'ACCOUNT_NOT_EXISTS_PRECHECK_CLEAR',
    source: 'no-inline-existing-signal',
    signalStrength: 'weak',
  };
}

// ==============================
// form-ready 层
// 负责识别 credential form 是否已经稳定可用。
// 当前实现仍带少量 route-to-form 辅助，后续应继续收口边界。
// ==============================

async function waitForDreaminaCredentialFormReady(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const intentResult = resolveDreaminaCredentialIntent(runtime, context);
  const continueWithEmailResult = context?.continueWithEmailResult?.ok
    ? context.continueWithEmailResult
    : await ensureDreaminaContinueWithEmail(page, runtime, context);
  if (!continueWithEmailResult?.ok) {
    return {
      ok: false,
      state: continueWithEmailResult?.state || 'FORM_NOT_READY',
      continueWithEmailResult,
    };
  }

  let authModeResult = null;
  if (intentResult.intent === 'signin') {
    authModeResult = await ensureDreaminaSigninMode(page, runtime, {
      ...context,
      continueWithEmailResult,
      intentResult,
    });
  } else {
    authModeResult = await ensureDreaminaSignupMode(page, runtime, {
      ...context,
      continueWithEmailResult,
      intentResult,
    });
  }

  if (!authModeResult?.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.waitForFormReady | auth-mode-not-ready | intent=${intentResult.intent} | state=${authModeResult?.state || 'unknown'}`);
    }
    return {
      ok: false,
      state: authModeResult?.state || 'FORM_AUTH_MODE_NOT_READY',
      source: 'auth-mode-routing',
      signalStrength: authModeResult?.signalStrength || 'weak',
      continueWithEmailResult,
      intentResult,
      authModeResult,
    };
  }
  const primaryWaitMs = Number(runtime?.credentialFormPrimaryWaitMs || 300);
  const secondaryWaitMs = Number(runtime?.credentialFormSecondaryWaitMs || 900);
  const waitSteps = buildStepWaitList(0, primaryWaitMs, secondaryWaitMs);

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
        source: 'form-signals',
        signalStrength: 'strong',
        emailField,
        passwordField,
        submit,
        formSignals: {
          emailField: emailField?.selector || '',
          passwordField: passwordField?.selector || '',
          submitSource: submit?.source || '',
          submitValue: submit?.value || '',
        },
        waitStepMs: waitMs,
        continueWithEmailResult,
        intentResult,
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
    continueWithEmailResult,
    intentResult,
    authModeResult,
  };
}

// ==============================
// fill / action 层
// 只负责字段填写与点击动作，不负责最终结果判定。
// ==============================

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
    source: 'selector',
    signalStrength: 'strong',
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
  const { logInfo = null, formReady = null, passwordRefreshResult = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const passwordField = passwordRefreshResult?.passwordField?.ok
    ? passwordRefreshResult.passwordField
    : formReady?.passwordField?.ok
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
    source: 'selector',
    signalStrength: 'strong',
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
  const homeSignals = await findFirstVisibleByTexts(page, ['Explore', 'Create', 'Assets', 'Canvas', 'Start Creating With']);
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
    hasHomeSignals: Boolean(homeSignals.ok),
    bodyTextLength: bodyText.length,
    bodyPreview: bodyText.slice(0, 200),
  };
}

async function observeDreaminaCredentialFollowup(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const followupWaitMs = Number(runtime?.credentialSubmitFollowupObserveMs || 900);
  if (followupWaitMs > 0) {
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.followup | observe start | ms=${followupWaitMs}`);
    await page.waitForTimeout(followupWaitMs);
  }
  const snapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.followup | snapshot | authMode=${snapshot.authMode} | authTitle=${snapshot.authTitle || 'none'} | verification=${snapshot.verificationVisible ? 'Y' : 'N'} | home=${snapshot.hasHomeSignals ? 'Y' : 'N'}`);
  }
  return {
    ok: true,
    state: 'CREDENTIAL_SUBMIT_FOLLOWUP_OBSERVED',
    waitMs: followupWaitMs,
    snapshot,
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
  if (before.emailVisible !== after.emailVisible) return true;
  if (before.passwordVisible !== after.passwordVisible) return true;
  if (before.continueVisible !== after.continueVisible) return true;
  if (before.continueEnabled !== after.continueEnabled) return true;
  if (before.continueText !== after.continueText) return true;
  if (before.verificationVisible !== after.verificationVisible) return true;
  if (before.hasSuccessSelector !== after.hasSuccessSelector) return true;
  if (before.hasSuccessText !== after.hasSuccessText) return true;
  if (before.hasExistingAccount !== after.hasExistingAccount) return true;
  if (before.hasRejected !== after.hasRejected) return true;
  if (before.hasRateLimited !== after.hasRateLimited) return true;
  if (before.hasInlineError !== after.hasInlineError) return true;
  if (before.hasErrorModal !== after.hasErrorModal) return true;
  if (before.hasHomeSignals !== after.hasHomeSignals) return true;
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
 *
 * 边界：
 * - 固定 primary + secondary 两层等待，不继续扩成第三层
 * - 不负责再次 submit / retry / recovery
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
// ==============================
// submit / confirm / classify 层
// 负责提交表单、确认结果、归一化失败原因。
// 这是阶段 2 真正的收口层，也是最需要警惕策略膨胀的区域。
// ==============================

/**
 * 解析阶段 2 submit target。
 *
 * 边界：
 * - 只负责定位 submit 按钮/入口
 * - 不负责点击、不负责 settlement、不负责策略 fallback
 */
async function resolveDreaminaCredentialSubmitTarget(page, runtime = {}, context = {}) {
  const { formReady = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const submit = formReady?.submit?.ok ? formReady.submit : null;

  if (submit?.locator) {
    return {
      ok: true,
      source: 'form-ready',
      submit,
      submitLocator: submit.locator,
      submitLabel: submit.value || '',
    };
  }

  const submitBySelector = await findFirstVisibleBySelectors(page, profile?.submit?.selectors || []);
  if (submitBySelector.ok) {
    return {
      ok: true,
      source: 'selector',
      submit: { ok: true, source: 'selector', value: submitBySelector.selector, locator: submitBySelector.locator },
      submitLocator: submitBySelector.locator,
      submitLabel: submitBySelector.selector,
    };
  }

  const submitByText = await findFirstVisibleByTexts(page, profile?.submit?.texts || []);
  if (submitByText.ok) {
    return {
      ok: true,
      source: 'text',
      submit: { ok: true, source: 'text', value: submitByText.text, locator: submitByText.locator },
      submitLocator: submitByText.locator,
      submitLabel: submitByText.text,
    };
  }

  return {
    ok: false,
    source: '',
    submit: null,
    submitLocator: null,
    submitLabel: '',
  };
}

/**
 * 执行单次 submit attempt。
 *
 * 边界：
 * - 只跑一次 submit 动作 + 一次 settlement + 前后快照对比
 * - 不决定是否进入下一个策略
 * - 不负责最终阶段结果归一化
 */
async function runDreaminaCredentialSubmitAttempt(page, runtime = {}, context = {}) {
  const { mode = '', runner = null } = context;
  const beforeSnapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);
  if (typeof runner === 'function') {
    await runner();
  }
  const settlementResult = await waitDreaminaCredentialSubmitSettlement(page, runtime, context);
  const afterSnapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);
  const hasStateChange = hasMeaningfulCredentialSubmitStateChange(beforeSnapshot, afterSnapshot);

  return {
    mode,
    beforeSnapshot,
    afterSnapshot,
    settlementResult,
    hasStateChange,
    attemptSummary: {
      mode,
      beforeAuthMode: beforeSnapshot?.authMode || '',
      afterAuthMode: afterSnapshot?.authMode || '',
      beforeEmailVisible: beforeSnapshot?.emailVisible,
      afterEmailVisible: afterSnapshot?.emailVisible,
      beforePasswordVisible: beforeSnapshot?.passwordVisible,
      afterPasswordVisible: afterSnapshot?.passwordVisible,
      beforeContinueVisible: beforeSnapshot?.continueVisible,
      afterContinueVisible: afterSnapshot?.continueVisible,
      beforeContinueEnabled: beforeSnapshot?.continueEnabled,
      afterContinueEnabled: afterSnapshot?.continueEnabled,
      beforeContinueText: beforeSnapshot?.continueText || '',
      afterContinueText: afterSnapshot?.continueText || '',
      beforeHomeSignals: beforeSnapshot?.hasHomeSignals,
      afterHomeSignals: afterSnapshot?.hasHomeSignals,
      verificationVisible: afterSnapshot?.verificationVisible,
      inlineError: afterSnapshot?.hasInlineError,
      stateChanged: hasStateChange,
      settlementStage: settlementResult?.stage || '',
    },
  };
}

/**
 * 执行固定 submit strategies。
 *
 * 边界：
 * - 只负责按固定顺序跑 submit 策略并在命中后停止
 * - 每个策略最多执行一次，不允许递归/嵌套策略
 * - 不负责 selector 解析，也不负责最终 confirm/classify
 */
async function runDreaminaCredentialSubmitStrategies(page, runtime = {}, context = {}) {
  const { logInfo = null, formReady = null, submitLocator = null, submitLabel = '' } = context;
  const attempts = [];
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
    finalResult = await runDreaminaCredentialSubmitAttempt(page, runtime, {
      ...context,
      mode: strategy.mode,
      runner: strategy.run,
    });
    attempts.push(finalResult.attemptSummary);
    if (finalResult.hasStateChange || finalResult.settlementResult?.quickFailure?.hit || finalResult.settlementResult?.verificationReady?.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.credential.submitForm | submit=${submitLabel} | mode=${strategy.mode} | settlementStage=${finalResult.settlementResult?.stage || ''} | stateChanged=${finalResult.hasStateChange ? 'Y' : 'N'}`);
      }
      return {
        matched: true,
        finalResult,
        attempts,
        submitMode: strategy.mode,
      };
    }
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.submitForm | submit=${submitLabel} | mode=all | settlementStage=${finalResult?.settlementResult?.stage || ''} | stateChanged=${finalResult?.hasStateChange ? 'Y' : 'N'}`);
  }

  return {
    matched: false,
    finalResult,
    attempts,
    submitMode: finalResult ? attempts[attempts.length - 1]?.mode || '' : '',
  };
}

/**
 * Dreamina 阶段 2 submit 主入口。
 *
 * 边界：
 * - 当前只负责串联 target 解析、strategy runner 与统一返回
 * - 不直接承担 confirm / classify 主职责
 */
async function submitDreaminaCredentialForm(page, runtime = {}, context = {}) {
  const submitTarget = await resolveDreaminaCredentialSubmitTarget(page, runtime, context);
  const submitLocator = submitTarget?.submitLocator || null;
  const submitLabel = submitTarget?.submitLabel || '';

  if (!submitLocator) {
    return {
      ok: false,
      state: 'SUBMIT_BUTTON_NOT_FOUND',
    };
  }

  const strategyResult = await runDreaminaCredentialSubmitStrategies(page, runtime, {
    ...context,
    submitLocator,
    submitLabel,
  });
  const finalResult = strategyResult?.finalResult || null;
  const attempts = strategyResult?.attempts || [];
  const submitMode = strategyResult?.submitMode || '';

  return {
    ok: true,
    state: 'FORM_SUBMITTED',
    source: 'submit-action',
    signalStrength: finalResult?.hasStateChange ? 'medium' : 'weak',
    settleStage: finalResult?.settlementResult?.stage || '',
    submit: submitLabel,
    submitMode,
    beforeSnapshot: finalResult?.beforeSnapshot || null,
    afterSnapshot: finalResult?.afterSnapshot || null,
    hasStateChange: Boolean(finalResult?.hasStateChange),
    settlementResult: finalResult?.settlementResult || null,
    stateTrace: ['FORM_READY', 'EMAIL_FILLED', 'PASSWORD_FILLED', 'FORM_SUBMITTED'],
    formSignals: {
      submitLabel,
      submitMode,
    },
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
/**
 * 提交结果确认主入口。
 *
 * 边界：
 * - 负责把 submit 后的页面状态归一化成“成功 / 已存在 / 无状态变化 / 其他失败”
 * - 如果内部存在多策略确认，必须保持有上限、可解释、不可递归叠加
 * - 不应再次承担 route-to-form / mode-routing / precheck 主职责
 */
async function handleDreaminaExistingAccountSigninFallback(page, runtime = {}, context = {}) {
  const { logInfo = null } = context;
  const signinMode = await ensureDreaminaSigninMode(page, runtime, context);
  if (!signinMode?.ok) {
    return {
      ok: false,
      handled: false,
      state: 'ACCOUNT_ALREADY_EXISTS',
      nextStage: '',
      source: 'signin-fallback',
      value: 'SIGNIN_MODE_NOT_READY',
      strength: 'weak',
      detail: {
        fallbackType: 'existing-account-signin',
        signinMode,
      },
    };
  }

  const passwordRefreshed = await refreshDreaminaPasswordFieldAfterPrecheck(page, runtime, context).catch(() => null);
  const passwordField = passwordRefreshed?.passwordField?.ok
    ? passwordRefreshed.passwordField.locator
    : page.locator("input[type='password']").first();
  const emailField = page.locator("input[placeholder*='email' i], input[type='email'], input[role='textbox']").first();
  await emailField.fill(String(context?.account?.email || '')).catch(() => {});
  await passwordField.fill(String(context?.account?.password || '')).catch(() => {});

  const signinSubmitResult = await submitDreaminaCredentialForm(page, runtime, {
    ...context,
    formReady: null,
  });
  const signinSettlement = signinSubmitResult?.settlementResult || null;

  if (signinSettlement?.verificationReady?.ok) {
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | exists fallback signin hit verification | stage=${signinSettlement.stage}`);
    return {
      ok: true,
      handled: true,
      state: 'EXISTS_ACCOUNT_SIGNIN_OK',
      nextStage: 'post-auth-ready',
      source: 'signin-fallback',
      value: 'ACCOUNT_ALREADY_EXISTS_LOGIN_OK',
      strength: 'strong',
      settleStage: signinSettlement.stage,
      stateTrace: ['FORM_READY', 'EMAIL_FILLED', 'PASSWORD_FILLED', 'FORM_SUBMITTED', 'EXISTS_ACCOUNT_SIGNIN_OK'],
      formSignals: {
        submitMode: signinSubmitResult?.submitMode || '',
        submitLabel: signinSubmitResult?.submit || '',
      },
      detail: {
        fallbackType: 'existing-account-signin',
        signinMode,
        passwordRefreshed,
        signinSubmitResult,
        signinSettlement,
      },
    };
  }

  return {
    ok: false,
    handled: false,
    state: 'ACCOUNT_ALREADY_EXISTS',
    nextStage: '',
    source: 'signin-fallback',
    value: 'ACCOUNT_ALREADY_EXISTS_LOGIN_NOT_CONFIRMED',
    strength: 'weak',
    settleStage: signinSettlement?.stage || '',
    detail: {
      fallbackType: 'existing-account-signin',
      signinMode,
      passwordRefreshed,
      signinSubmitResult,
      signinSettlement,
    },
  };
}

async function detectDirectDreaminaCredentialOutcome(page, runtime = {}, context = {}) {
  const { submitResult = null } = context;
  const profile = loadDreaminaCredentialProfile();
  const settlementResult = submitResult?.settlementResult || null;
  const inlineErrors = profile?.failureSignals?.inlineErrors || [];
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').toLowerCase();
  const inlineHit = inlineErrors.find(item => bodyText.includes(String(item || '').toLowerCase()));
  if (inlineHit) {
    return {
      ok: false,
      handled: true,
      state: 'INLINE_ERROR_VISIBLE',
      nextStage: '',
      source: 'bodyText',
      value: inlineHit,
      strength: 'weak',
      settleStage: settlementResult?.stage || 'inline-check',
    };
  }

  return {
    ok: false,
    handled: false,
  };
}

async function resolveDreaminaAmbiguousCredentialOutcome(page, runtime = {}, context = {}) {
  const { logInfo = null, submitResult = null } = context;
  const settlementResult = submitResult?.settlementResult || null;
  const afterSnapshot = submitResult?.afterSnapshot || null;

  const resolveSnapshotVerificationReady = (snapshot = null, scenario = 'snapshot-direct') => {
    if (!snapshot) return null;
    const verificationReady = Boolean(
      snapshot.verificationVisible
      || snapshot.hasSuccessSelector
      || snapshot.hasSuccessText
    );
    if (!verificationReady) return null;
    return {
      ok: true,
      handled: true,
      state: 'CREDENTIAL_SUBMIT_OK',
      nextStage: 'verification',
      source: 'snapshot-verification-ready',
      value: snapshot.hasSuccessSelector
        ? 'SNAPSHOT_SUCCESS_SELECTOR_VISIBLE'
        : snapshot.hasSuccessText
          ? 'SNAPSHOT_SUCCESS_TEXT_VISIBLE'
          : 'SNAPSHOT_VERIFICATION_VISIBLE',
      strength: 'weak',
      settleStage: settlementResult?.stage || 'snapshot-check',
      stateTrace: ['FORM_READY', 'EMAIL_FILLED', 'PASSWORD_FILLED', 'FORM_SUBMITTED', 'CREDENTIAL_SUBMIT_OK'],
      formSignals: {
        submitMode: submitResult?.submitMode || '',
        submitLabel: submitResult?.submit || '',
      },
      detail: {
        resolutionType: 'snapshot-verification-ready',
        scenario,
        snapshot,
      },
    };
  };

  const resolveFollowupVerificationReady = async () => {
    const followupVerification = await detectDreaminaVerificationStageReady(page, context).catch(() => null);
    if (followupVerification?.ok) {
      return {
        ok: true,
        handled: true,
        state: followupVerification.state || 'CREDENTIAL_SUBMIT_OK',
        nextStage: followupVerification.nextStage || 'verification',
        source: 'followup-verification-ready',
        value: followupVerification.value || 'FOLLOWUP_VERIFICATION_READY',
        strength: followupVerification.strength || 'weak',
        settleStage: settlementResult?.stage || 'followup-check',
        stateTrace: ['FORM_READY', 'EMAIL_FILLED', 'PASSWORD_FILLED', 'FORM_SUBMITTED', followupVerification.state || 'CREDENTIAL_SUBMIT_OK'],
        formSignals: {
          submitMode: submitResult?.submitMode || '',
          submitLabel: submitResult?.submit || '',
        },
        detail: {
          resolutionType: 'followup-verification-ready',
          followupVerification,
        },
      };
    }
    return null;
  };

  const directSnapshotVerificationReadyResult = resolveSnapshotVerificationReady(afterSnapshot, 'after-submit-snapshot');
  if (directSnapshotVerificationReadyResult) {
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | direct snapshot verification ready | stage=${settlementResult?.stage || 'none'}`);
    return directSnapshotVerificationReadyResult;
  }

  const signupOverlayStillOpen = Boolean(
    afterSnapshot
    && afterSnapshot.authMode === 'signup'
    && afterSnapshot.emailVisible
    && afterSnapshot.passwordVisible
    && afterSnapshot.continueVisible
    && afterSnapshot.continueEnabled
    && !afterSnapshot.verificationVisible
    && !afterSnapshot.hasSuccessSelector
    && !afterSnapshot.hasSuccessText
    && !afterSnapshot.hasExistingAccount
    && !afterSnapshot.hasRejected
    && !afterSnapshot.hasRateLimited
    && !afterSnapshot.hasInlineError
    && !afterSnapshot.hasErrorModal
  );
  if (signupOverlayStillOpen) {
    const followupObservation = await observeDreaminaCredentialFollowup(page, runtime, context).catch(() => null);
    const followupSnapshot = followupObservation?.snapshot || null;
    const followupRecovered = Boolean(
      followupSnapshot
      && (
        followupSnapshot.verificationVisible
        || followupSnapshot.hasExistingAccount
        || followupSnapshot.hasRejected
        || followupSnapshot.hasRateLimited
        || followupSnapshot.hasInlineError
        || followupSnapshot.hasErrorModal
        || followupSnapshot.authMode !== 'signup'
        || !followupSnapshot.emailVisible
        || !followupSnapshot.passwordVisible
        || !followupSnapshot.continueVisible
      )
    );

    const followupSnapshotVerificationReadyResult = resolveSnapshotVerificationReady(followupSnapshot, 'followup-snapshot-signup-still-open');
    if (followupSnapshotVerificationReadyResult) {
      if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | followup recovered verification after signup-still-open | stage=${settlementResult?.stage || 'none'}`);
      return {
        ...followupSnapshotVerificationReadyResult,
        source: 'followup-snapshot',
        value: 'FOLLOWUP_VERIFICATION_VISIBLE',
        settleStage: settlementResult?.stage || 'followup-check',
        detail: {
          resolutionType: 'followup-observation',
          scenario: 'signup-overlay-still-open',
          afterSnapshot,
          followupObservation,
          followupSnapshot,
        },
      };
    }

    const followupVerificationReadyResult = await resolveFollowupVerificationReady();
    if (followupVerificationReadyResult) {
      if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | followup verification ready after signup-still-open | stage=${settlementResult?.stage || 'none'}`);
      return followupVerificationReadyResult;
    }

    if (!followupRecovered) {
      if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | signup overlay still open after submit | stage=${settlementResult?.stage || 'none'} | followup=same-open`);
      return {
        ok: false,
        handled: true,
        state: 'CREDENTIAL_SUBMIT_STALLED_ON_SIGNUP',
        nextStage: '',
        source: 'snapshot',
        value: 'SIGNUP_OVERLAY_STILL_OPEN',
        strength: 'weak',
        settleStage: settlementResult?.stage || 'snapshot-check',
        detail: {
          resolutionType: 'followup-observation',
          scenario: 'signup-overlay-still-open',
          afterSnapshot,
          followupObservation,
          followupSnapshot,
        },
      };
    }

    if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | signup overlay changed after followup | stage=${settlementResult?.stage || 'none'}`);
  }

  const signupContinueDisabledWithoutOutcome = Boolean(
    afterSnapshot
    && afterSnapshot.authMode === 'signup'
    && afterSnapshot.emailVisible
    && afterSnapshot.passwordVisible
    && afterSnapshot.continueVisible
    && !afterSnapshot.continueEnabled
    && !afterSnapshot.verificationVisible
    && !afterSnapshot.hasSuccessSelector
    && !afterSnapshot.hasSuccessText
    && !afterSnapshot.hasExistingAccount
    && !afterSnapshot.hasRejected
    && !afterSnapshot.hasRateLimited
    && !afterSnapshot.hasInlineError
    && !afterSnapshot.hasErrorModal
    && afterSnapshot.hasHomeSignals
  );
  if (signupContinueDisabledWithoutOutcome) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.confirmResult | signup continue disabled without verification or explicit failure | stage=${settlementResult?.stage || 'none'}`);
    }
    return {
      ok: false,
      handled: true,
      state: 'CREDENTIAL_SUBMIT_STUCK_SIGNUP_CONTINUE_DISABLED',
      nextStage: '',
      source: 'snapshot',
      value: 'SIGNUP_CONTINUE_DISABLED_NO_RESULT',
      strength: 'weak',
      settleStage: settlementResult?.stage || 'snapshot-check',
      detail: {
        resolutionType: 'snapshot-direct',
        scenario: 'signup-continue-disabled-without-outcome',
        afterSnapshot,
      },
    };
  }

  const followupObservation = await observeDreaminaCredentialFollowup(page, runtime, context).catch(() => null);
  const followupSnapshot = followupObservation?.snapshot || null;
  const signupOverlayDismissedWithoutOutcome = Boolean(
    afterSnapshot
    && afterSnapshot.authMode === 'signup'
    && !afterSnapshot.emailVisible
    && !afterSnapshot.passwordVisible
    && !afterSnapshot.continueVisible
    && !afterSnapshot.verificationVisible
    && !afterSnapshot.hasSuccessSelector
    && !afterSnapshot.hasSuccessText
    && !afterSnapshot.hasExistingAccount
    && !afterSnapshot.hasRejected
    && !afterSnapshot.hasRateLimited
    && !afterSnapshot.hasInlineError
    && !afterSnapshot.hasErrorModal
  );
  const followupStillDismissedWithoutOutcome = Boolean(
    followupSnapshot
    && followupSnapshot.authMode === 'signup'
    && !followupSnapshot.emailVisible
    && !followupSnapshot.passwordVisible
    && !followupSnapshot.continueVisible
    && !followupSnapshot.verificationVisible
    && !followupSnapshot.hasSuccessSelector
    && !followupSnapshot.hasSuccessText
    && !followupSnapshot.hasExistingAccount
    && !followupSnapshot.hasRejected
    && !followupSnapshot.hasRateLimited
    && !followupSnapshot.hasInlineError
    && !followupSnapshot.hasErrorModal
  );
  if (signupOverlayDismissedWithoutOutcome) {
    const followupDismissedVerificationReadyResult = resolveSnapshotVerificationReady(followupSnapshot, 'followup-snapshot-dismissed-without-outcome');
    if (followupDismissedVerificationReadyResult) {
      if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | followup recovered verification after initial dismiss | stage=${settlementResult?.stage || 'none'}`);
      return {
        ...followupDismissedVerificationReadyResult,
        source: 'followup-snapshot',
        value: 'FOLLOWUP_VERIFICATION_VISIBLE',
        settleStage: settlementResult?.stage || 'followup-check',
        detail: {
          resolutionType: 'followup-observation',
          scenario: 'signup-overlay-dismissed-without-outcome',
          afterSnapshot,
          followupObservation,
          followupSnapshot,
        },
      };
    }

    const followupVerificationReadyResult = await resolveFollowupVerificationReady();
    if (followupVerificationReadyResult) {
      if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | followup verification ready after initial dismiss | stage=${settlementResult?.stage || 'none'}`);
      return followupVerificationReadyResult;
    }

    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.confirmResult | signup overlay dismissed without verification or failure | stage=${settlementResult?.stage || 'none'} | followup=${followupStillDismissedWithoutOutcome ? 'same-dismissed' : 'changed'}`);
    }
    return {
      ok: false,
      handled: true,
      state: 'CREDENTIAL_SUBMIT_DISMISSED_WITHOUT_OUTCOME',
      nextStage: '',
      source: 'snapshot',
      value: 'SIGNUP_OVERLAY_DISMISSED_NO_RESULT',
      strength: 'weak',
      settleStage: settlementResult?.stage || 'snapshot-check',
      detail: {
        resolutionType: 'followup-observation',
        scenario: 'signup-overlay-dismissed-without-outcome',
        afterSnapshot,
        followupObservation,
        followupSnapshot,
        followupStillDismissedWithoutOutcome,
      },
    };
  }

  if (submitResult && submitResult.hasStateChange === false) {
    if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | no state change after followup | stage=${settlementResult?.stage || 'none'}`);
    return {
      ok: false,
      handled: true,
      state: 'CREDENTIAL_SUBMIT_NO_STATE_CHANGE',
      nextStage: '',
      source: 'snapshot-followup',
      value: 'SUBMIT_NO_STATE_CHANGE_AFTER_FOLLOWUP',
      strength: 'weak',
      settleStage: settlementResult?.stage || 'followup-check',
      detail: {
        resolutionType: 'no-state-change-after-followup',
        afterSnapshot,
      },
    };
  }

  return {
    ok: false,
    handled: false,
  };
}

async function confirmDreaminaCredentialSubmitResult(page, runtime = {}, context = {}) {
  const { logInfo = null, submitResult = null } = context;
  const settlementResult = submitResult?.settlementResult || null; // 先拿 submit 阶段已经跑过的 settlement 结果，避免确认层再重复组织等待

  if (settlementResult?.quickFailure?.hit) { // 如果 settlement 已经命中高价值失败，这里直接复用，不再重复检查同一批失败
    if (settlementResult.quickFailure.state === 'ACCOUNT_ALREADY_EXISTS') {
      const signinFallbackResult = await handleDreaminaExistingAccountSigninFallback(page, runtime, context);
      if (signinFallbackResult?.handled) {
        return signinFallbackResult;
      }
    }
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
      stateTrace: ['FORM_READY', 'EMAIL_FILLED', 'PASSWORD_FILLED', 'FORM_SUBMITTED', settlementResult.verificationReady?.state || 'CREDENTIAL_SUBMIT_OK'],
      formSignals: {
        submitMode: submitResult?.submitMode || '',
        submitLabel: submitResult?.submit || '',
      },
    };
  }

  const directOutcome = await detectDirectDreaminaCredentialOutcome(page, runtime, context);
  if (directOutcome?.handled) {
    return directOutcome;
  }

  const ambiguousOutcome = await resolveDreaminaAmbiguousCredentialOutcome(page, runtime, context);
  if (ambiguousOutcome?.handled) {
    return ambiguousOutcome;
  }

  if (typeof logInfo === 'function') logInfo(`dreamina.credential.confirmResult | unknown after settlement | stage=${settlementResult?.stage || 'none'}`);
  return {
    ok: false,
    state: 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: settlementResult?.stage || 'none',
  };

/**
 * 对 Dreamina 阶段 2 失败做分类。
 *
 * 作用：
 * - 将阶段 2 的失败 reason 收敛成 Dreamina 专属语义
 */
}

/**
 * 失败分类层。
 *
 * 边界：
 * - 只负责把原始事实态归一为稳定 reason bucket
 * - 不负责重新执行 submit / click / wait / retry
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
  } else if (reason === 'CREDENTIAL_SUBMIT_STALLED_ON_SIGNUP') {
    siteReason = 'DREAMINA_CREDENTIAL_STALLED_ON_SIGNUP';
  } else if (reason === 'CREDENTIAL_SUBMIT_DISMISSED_WITHOUT_OUTCOME') {
    siteReason = 'DREAMINA_CREDENTIAL_DISMISSED_WITHOUT_OUTCOME';
  } else if (reason === 'CREDENTIAL_SUBMIT_STUCK_SIGNUP_CONTINUE_DISABLED') {
    siteReason = 'DREAMINA_CREDENTIAL_STUCK_SIGNUP_CONTINUE_DISABLED';
  } else if (reason === 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN') {
    siteReason = 'DREAMINA_CREDENTIAL_SUBMIT_RESULT_UNKNOWN';
  }

  return {
    reason,
    siteReason,
    hardFailure: reason === 'SIGNUP_REJECTED',
  };
}

async function refreshDreaminaPasswordFieldAfterPrecheck(page, runtime = {}, context = {}) {
  const profile = loadDreaminaCredentialProfile();
  const passwordSelectors = profile?.fields?.password?.selectors || [];
  const primaryWaitMs = Number(runtime?.credentialPasswordRefreshPrimaryWaitMs || 300);
  const secondaryWaitMs = Number(runtime?.credentialPasswordRefreshSecondaryWaitMs || 1200);
  const waitSteps = buildStepWaitList(0, primaryWaitMs, secondaryWaitMs);

  let lastResult = null;
  for (const waitMs of waitSteps) {
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }
    const passwordField = await findFirstVisibleBySelectors(page, passwordSelectors);
    lastResult = {
      ok: false,
      state: 'PASSWORD_FIELD_REFRESH_NOT_READY',
      waitStepMs: waitMs,
      passwordField,
    };
    if (passwordField.ok) {
      return {
        ok: true,
        state: 'PASSWORD_FIELD_REFRESHED',
        waitStepMs: waitMs,
        passwordField,
      };
    }
  }

  return lastResult || {
    ok: false,
    state: 'PASSWORD_FIELD_REFRESH_NOT_READY',
    passwordField: { ok: false, selector: '', locator: null },
  };
}

module.exports = {
  loadDreaminaCredentialProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  resolveDreaminaCredentialIntent,
  clickDreaminaRegisterEntry,
  confirmDreaminaRegisterMode,
  confirmDreaminaSigninMode,
  ensureDreaminaSignupMode,
  clickDreaminaSigninEntry,
  ensureDreaminaSigninMode,
  precheckDreaminaAccountExists,
  refreshDreaminaPasswordFieldAfterPrecheck,
  waitForDreaminaCredentialFormReady,
  fillDreaminaCredentialEmail,
  fillDreaminaCredentialPassword,
  captureDreaminaCredentialSubmitSnapshot,
  hasMeaningfulCredentialSubmitStateChange,
  waitDreaminaCredentialSubmitSettlement,
  resolveDreaminaCredentialSubmitTarget,
  runDreaminaCredentialSubmitAttempt,
  runDreaminaCredentialSubmitStrategies,
  submitDreaminaCredentialForm,
  runDreaminaCredentialImmediateFailureChecks,
  detectDreaminaVerificationStageReady,
  detectDirectDreaminaCredentialOutcome,
  handleDreaminaExistingAccountSigninFallback,
  resolveDreaminaAmbiguousCredentialOutcome,
  confirmDreaminaCredentialSubmitResult,
  classifyDreaminaCredentialSubmitFailure,
};
