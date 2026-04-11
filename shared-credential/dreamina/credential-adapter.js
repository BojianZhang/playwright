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

/**
 * 读取 Dreamina 阶段 2 profile。
 *
 * 作用：
 * - 读取 JSON 配置
 * - 统一供本文件内部方法使用
 */
function loadDreaminaCredentialProfile() {
  const raw = fs.readFileSync(DREAMINA_CREDENTIAL_PROFILE_PATH, 'utf8');
  return JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
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

  if (emailField.ok && passwordField.ok && submit.ok) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.waitForFormReady | email=${emailField.selector} | password=${passwordField.selector} | submit=${submit.source}:${submit.value}`);
    }
    return {
      ok: true,
      state: 'FORM_READY',
      emailField,
      passwordField,
      submit,
    };
  }

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.waitForFormReady | not-ready | email=${emailField.ok ? 'Y' : 'N'} | password=${passwordField.ok ? 'Y' : 'N'} | submit=${submit.ok ? 'Y' : 'N'}`);
  }

  return {
    ok: false,
    state: 'FORM_NOT_READY',
    emailField,
    passwordField,
    submit,
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
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();

  return {
    url: page.url(),
    hasSuccessSelector: Boolean(successBySelector.ok),
    hasSuccessText: Boolean(successByText.ok),
    hasExistingAccount: Boolean(existingAccount.ok),
    hasRejected: Boolean(rejected.ok),
    hasRateLimited: Boolean(rateLimited.ok),
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
  if (before.hasSuccessSelector !== after.hasSuccessSelector) return true;
  if (before.hasSuccessText !== after.hasSuccessText) return true;
  if (before.hasExistingAccount !== after.hasExistingAccount) return true;
  if (before.hasRejected !== after.hasRejected) return true;
  if (before.hasRateLimited !== after.hasRateLimited) return true;
  if (before.bodyPreview !== after.bodyPreview) return true;
  if (Math.abs(Number(before.bodyTextLength || 0) - Number(after.bodyTextLength || 0)) >= 40) return true;
  return false;
}

/**
 * 提交 Dreamina credential form。
 *
 * 作用：
 * - 点击 Continue / Submit
 * - 提交后做一次很轻的等待，给页面一点切换时间
 * - 记录提交前后快照，为“NO_STATE_CHANGE”判断提供证据
 */
async function submitDreaminaCredentialForm(page, runtime = {}, context = {}) {
  const { logInfo = null, formReady = null } = context;
  const profile = loadDreaminaCredentialProfile();

  const submit = formReady?.submit?.ok
    ? formReady.submit
    : (() => null)();

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

  const beforeSnapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);

  await submitLocator.click({ timeout: 1500 }).catch(async () => {
    await submitLocator.click({ force: true, timeout: 1500 });
  });
  await page.waitForTimeout(700);

  const afterSnapshot = await captureDreaminaCredentialSubmitSnapshot(page, context);
  const hasStateChange = hasMeaningfulCredentialSubmitStateChange(beforeSnapshot, afterSnapshot);

  if (typeof logInfo === 'function') {
    logInfo(`dreamina.credential.submitForm | submit=${submitLabel} | stateChanged=${hasStateChange ? 'Y' : 'N'}`);
  }

  return {
    ok: true,
    state: 'FORM_SUBMITTED',
    submit: submitLabel,
    beforeSnapshot,
    afterSnapshot,
    hasStateChange,
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
 * - 先做提交后第一批安全检查
 * - 再做进入验证码阶段的强确认
 * - 再看 inline error
 * - 最后结合 submit 前后快照，区分 unknown 和 no-state-change
 *
 * 这是阶段 2 最核心的结果判断方法。
 */
async function confirmDreaminaCredentialSubmitResult(page, runtime = {}, context = {}) {
  const { logInfo = null, submitResult = null } = context;
  const profile = loadDreaminaCredentialProfile();

  /**
   * 第一批安全检查：高价值失败优先。
   */
  const immediateFailure = await runDreaminaCredentialImmediateFailureChecks(page, context);
  if (immediateFailure.hit) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.credential.confirmResult | immediate failure hit=${immediateFailure.state} | value=${immediateFailure.value}`);
    }
    return {
      ok: false,
      state: immediateFailure.state,
      nextStage: '',
      source: immediateFailure.source,
      value: immediateFailure.value,
    };
  }

  /**
   * 强确认：是否已经真正进入验证码阶段。
   */
  const verificationReady = await detectDreaminaVerificationStageReady(page, context);
  if (verificationReady.ok) {
    return verificationReady;
  }

  /**
   * 继续看通用 inline error。
   */
  const inlineErrors = profile?.failureSignals?.inlineErrors || [];
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').toLowerCase();
  const inlineHit = inlineErrors.find(item => bodyText.includes(String(item || '').toLowerCase()));
  if (inlineHit) {
    return {
      ok: false,
      state: 'INLINE_ERROR_VISIBLE',
      nextStage: '',
      source: 'bodyText',
      value: inlineHit,
    };
  }

  /**
   * 最后一层：如果 submit 前后根本没状态变化，明确打成 NO_STATE_CHANGE。
   */
  if (submitResult && submitResult.hasStateChange === false) {
    return {
      ok: false,
      state: 'CREDENTIAL_SUBMIT_NO_STATE_CHANGE',
      nextStage: '',
      source: 'snapshot',
      value: 'SUBMIT_NO_STATE_CHANGE',
    };
  }

  return {
    ok: false,
    state: 'CREDENTIAL_SUBMIT_RESULT_UNKNOWN',
    nextStage: '',
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
  } else if (reason === 'CREDENTIAL_SUBMIT_NO_STATE_CHANGE') {
    siteReason = 'DREAMINA_CREDENTIAL_SUBMIT_NO_STATE_CHANGE';
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
  waitForDreaminaCredentialFormReady,
  fillDreaminaCredentialEmail,
  fillDreaminaCredentialPassword,
  captureDreaminaCredentialSubmitSnapshot,
  hasMeaningfulCredentialSubmitStateChange,
  submitDreaminaCredentialForm,
  runDreaminaCredentialImmediateFailureChecks,
  detectDreaminaVerificationStageReady,
  confirmDreaminaCredentialSubmitResult,
  classifyDreaminaCredentialSubmitFailure,
};
