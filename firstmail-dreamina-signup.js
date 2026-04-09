const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ACCOUNT = {
  email: 'juliaswindler1945@zunestou.com',
  password: 'uergjgfgY!9904',
};

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const RUN_STATE = {
  lastStep: 'INIT',
};

function setStep(step) {
  RUN_STATE.lastStep = step;
  console.log(`[STEP] ${step}`);
}

function randomBirthDate(startYear = 1980, endYear = 2008) {
  const start = new Date(`${startYear}-01-01T00:00:00`);
  const end = new Date(`${endYear}-12-31T00:00:00`);
  const randomTime = start.getTime() + Math.random() * (end.getTime() - start.getTime());
  const date = new Date(randomTime);

  const year = String(date.getFullYear());
  const monthIndex = date.getMonth();
  const day = String(date.getDate());
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  return {
    year,
    month: monthNames[monthIndex],
    day,
  };
}

function logStep(message) {
  console.log(`[FLOW] ${message}`);
}

async function captureStep(page, name, fullPage = true) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage }).catch(() => {});
  console.log(`[SHOT] ${filePath}`);
  return filePath;
}

async function humanPause(page, min = 800, max = 1800) {
  const delay = Math.floor(min + Math.random() * (max - min));
  await page.waitForTimeout(delay);
}

async function visible(locator) {
  return await locator.isVisible().catch(() => false);
}

async function extractVerificationCode(firstmailPage) {
  setStep('FIRSTMAIL_EXTRACT_CODE');
  await firstmailPage.waitForTimeout(5000);

  const bodyText = await firstmailPage.locator('body').innerText().catch(() => '');

  const contextualPatterns = [
    /verification code[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
    /your code[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
    /code[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
    /confirm[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
  ];

  for (const pattern of contextualPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      return match[1];
    }
  }

  const fallbackMatch = bodyText.match(/\b([A-Z0-9]{6})\b/);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }

  const preview = bodyText.slice(0, 1000);
  throw new Error(`未能从 Firstmail 当前页面正文中提取到验证码。正文预览：${preview}`);
}

async function hasDreaminaFramework(page) {
  const body = page.locator('body');
  const bodyVisible = await visible(body);
  const title = await page.title().catch(() => '');
  return bodyVisible || Boolean(title);
}

async function hasDreaminaLoginSignals(page) {
  const emailInput = page.getByRole('textbox', { name: 'Enter email' });
  const continueWithEmailButton = page.locator('div').filter({ hasText: /^Continue with email$/ }).nth(1);
  const signInCandidates = [
    page.getByText('Sign in'),
    page.getByText('Log in'),
    page.getByText('Login'),
    page.getByRole('button', { name: /sign in|log in|login/i }),
    page.getByRole('link', { name: /sign in|log in|login/i }),
    page.getByText('Sign up'),
  ];

  if (await visible(emailInput)) return true;
  if (await visible(continueWithEmailButton)) return true;

  for (const candidate of signInCandidates) {
    if (await visible(candidate.first())) {
      return true;
    }
  }

  return false;
}

async function observeDreaminaLoginSignals(page, totalWaitMs = 15000, intervalMs = 1000) {
  const rounds = Math.ceil(totalWaitMs / intervalMs);

  for (let i = 0; i < rounds; i++) {
    if (await hasDreaminaLoginSignals(page)) {
      logStep(`Dreamina 登录信号已出现（第 ${i + 1}/${rounds} 轮观察）`);
      return true;
    }

    logStep(`Dreamina 已打开但尚未出现登录信号，继续观察（第 ${i + 1}/${rounds} 轮）`);
    await page.waitForTimeout(intervalMs);
  }

  return await hasDreaminaLoginSignals(page);
}

async function preprocessDreaminaOverlays(page) {
  const overlayCandidates = [
    page.getByRole('button', { name: 'Accept all' }),
    page.getByRole('button', { name: 'Accept' }),
    page.getByRole('button', { name: 'I agree' }),
    page.getByRole('button', { name: 'Got it' }),
    page.getByRole('button', { name: 'Close' }),
    page.getByRole('button', { name: 'Skip' }),
    page.getByRole('button', { name: 'Not now' }),
    page.getByRole('button', { name: 'Maybe later' }),
    page.getByRole('button', { name: /accept all|accept|i agree|got it|close|skip|not now|maybe later/i }),
    page.locator('button[aria-label="Close"]').first(),
    page.locator('[data-testid="close"]').first(),
    page.locator('svg[aria-label="Close"]').first(),
    page.locator('.close-button-bXf1SB').first(),
    page.locator('.modal-close').first(),
    page.locator('.dialog-close').first(),
    page.locator('.popup-close').first(),
  ];

  let handled = false;

  for (let i = 0; i < overlayCandidates.length; i++) {
    const candidate = overlayCandidates[i];
    if (await visible(candidate)) {
      setStep(`DREAMINA_OVERLAY_${i + 1}`);
      logStep(`检测到 Dreamina 前置弹层/遮罩入口，第 ${i + 1} 个候选命中，先处理它`);
      await captureStep(page, `dreamina-overlay-visible-${i + 1}`);
      await humanPause(page, 1000, 2200);
      await candidate.click().catch(() => {});
      await page.waitForTimeout(2000);
      await captureStep(page, `dreamina-overlay-dismissed-${i + 1}`);
      handled = true;
    }
  }

  return handled;
}

async function openDreaminaWithRetry(page, maxAttempts = 3) {
  const targetUrl = 'https://dreamina.capcut.com/ai-tool/home';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      setStep(`DREAMINA_OPEN_ATTEMPT_${attempt}`);
      logStep(`Dreamina 第 ${attempt} 次打开尝试开始`);

      if (attempt === 1) {
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
      } else {
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
      }

      await captureStep(page, `dreamina-attempt-${attempt}-opened`);

      if (await hasDreaminaFramework(page)) {
        logStep(`Dreamina 第 ${attempt} 次已检测到页面框架`);
      }

      const overlayHandled = await preprocessDreaminaOverlays(page);
      if (overlayHandled) {
        logStep('Dreamina 前置弹层/遮罩已做统一预处理');
      }

      const ready = await observeDreaminaLoginSignals(page, 15000, 1000);
      if (ready) {
        await captureStep(page, `dreamina-attempt-${attempt}-ready`);
        logStep(`Dreamina 第 ${attempt} 次打开成功，已进入可操作状态`);
        return;
      }

      await captureStep(page, `dreamina-attempt-${attempt}-before-retry`);
      logStep(`Dreamina 第 ${attempt} 次已打开但登录信号未出现，准备重试/刷新`);
    } catch (error) {
      await captureStep(page, `dreamina-attempt-${attempt}-error`);
      logStep(`Dreamina 第 ${attempt} 次打开失败：${error.message}`);
    }
  }

  const title = await page.title().catch(() => 'UNKNOWN_TITLE');
  const url = page.url();
  throw new Error(`Dreamina 连续重试 ${maxAttempts} 次后仍未成功打开。title=${title} url=${url}`);
}

async function ensureDreaminaEmailLoginForm(page) {
  setStep('DREAMINA_FIND_LOGIN_FORM');
  await preprocessDreaminaOverlays(page);

  const emailInput = page.getByRole('textbox', { name: 'Enter email' });
  if (await visible(emailInput)) {
    logStep('Dreamina 页面已直接出现邮箱输入框');
    await captureStep(page, 'dreamina-email-form-direct');
    return;
  }

  const continueWithEmailButton = page
    .locator('div')
    .filter({ hasText: /^Continue with email$/ })
    .nth(1);

  if (await visible(continueWithEmailButton)) {
    logStep('Dreamina 页面已出现 Continue with email，准备点击');
    await captureStep(page, 'dreamina-continue-with-email-visible');
    await humanPause(page, 1000, 2200);
    await continueWithEmailButton.click();
    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await captureStep(page, 'dreamina-email-form-after-continue');
    return;
  }

  const signInCandidates = [
    page.getByText('Sign in'),
    page.getByText('Log in'),
    page.getByText('Login'),
    page.getByText('Sign up'),
    page.getByRole('button', { name: /sign in|log in|login|sign up/i }),
    page.getByRole('link', { name: /sign in|log in|login|sign up/i }),
  ];

  for (const candidate of signInCandidates) {
    const target = candidate.first();
    if (await visible(target)) {
      logStep('Dreamina 已检测到登录/注册入口，准备点击');
      await captureStep(page, 'dreamina-login-entry-visible');
      await humanPause(page, 1000, 2200);
      await target.click();
      await page.waitForTimeout(2500);

      await preprocessDreaminaOverlays(page);

      if (await visible(continueWithEmailButton)) {
        logStep('点击入口后已出现 Continue with email，准备点击');
        await captureStep(page, 'dreamina-continue-with-email-after-login-entry');
        await humanPause(page, 1000, 2200);
        await continueWithEmailButton.click();
      }

      await emailInput.waitFor({ state: 'visible', timeout: 30000 });
      await captureStep(page, 'dreamina-email-form-final');
      return;
    }
  }

  const title = await page.title().catch(() => 'UNKNOWN_TITLE');
  const url = page.url();
  await captureStep(page, 'dreamina-login-entry-not-found');
  throw new Error(`未找到 Dreamina 登录入口。title=${title} url=${url}`);
}

async function findLatestDreaminaMail(firstmailPage) {
  const candidates = firstmailPage.locator('div').filter({ hasText: /Dreamina|dreamina@mail\./i });
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const item = candidates.nth(i);
    const text = await item.innerText().catch(() => '');
    if (/Dreamina/i.test(text) || /dreamina@mail\./i.test(text)) {
      return item;
    }
  }

  return null;
}

async function waitForDreaminaMail(firstmailPage, maxAttempts = 12, intervalMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    setStep(`FIRSTMAIL_WAIT_MAIL_${attempt}`);
    logStep(`第 ${attempt}/${maxAttempts} 次检查 Dreamina 验证邮件是否到达`);

    const mailItem = await findLatestDreaminaMail(firstmailPage);
    if (mailItem) {
      logStep('Dreamina 验证邮件已出现在列表中');
      await captureStep(firstmailPage, `firstmail-dreamina-mail-found-${attempt}`);
      return mailItem;
    }

    const listPreview = await firstmailPage.locator('body').innerText().catch(() => '');
    console.log(`[MAIL_PREVIEW_${attempt}] ${listPreview.slice(0, 800)}`);
    await captureStep(firstmailPage, `firstmail-mail-check-${attempt}`);

    await firstmailPage.reload({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    await firstmailPage.waitForTimeout(intervalMs);
  }

  throw new Error('等待 Dreamina 验证邮件超时，邮件始终未到达');
}

async function printFailureSummary(contextPages, error) {
  console.error('\n========== FAILURE SUMMARY ==========');
  console.error(`Last successful step marker: ${RUN_STATE.lastStep}`);
  console.error(`Error message: ${error?.message || error}`);
  console.error(`Screenshot directory: ${SCREENSHOT_DIR}`);

  for (let i = 0; i < contextPages.length; i++) {
    const page = contextPages[i];
    if (!page) continue;

    const title = await page.title().catch(() => 'UNKNOWN_TITLE');
    const url = page.url?.() || 'UNKNOWN_URL';
    console.error(`Page[${i}] title=${title}`);
    console.error(`Page[${i}] url=${url}`);

    await captureStep(page, `failure-page-${i + 1}`);
  }

  console.error('=====================================\n');
}

(async () => {
  let firstmailPage;
  let dreaminaPage;

  try {
    const browser = await chromium.launch({
      headless: false,
      slowMo: 120,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    });

    const birth = randomBirthDate(1980, 2008);

    // ========= 第一阶段：先登录 Firstmail =========
    setStep('FIRSTMAIL_LOGIN_START');
    logStep('开始登录 Firstmail');
    firstmailPage = await context.newPage();

    await firstmailPage.goto('https://firstmail.ltd/webmail/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await captureStep(firstmailPage, 'firstmail-login-page');

    const acceptButton = firstmailPage.getByRole('button', { name: 'To accept' });
    if (await visible(acceptButton)) {
      await humanPause(firstmailPage, 900, 1800);
      await acceptButton.click();
    }

    const emailAddressInput = firstmailPage.getByRole('textbox', { name: 'Email address' });
    await emailAddressInput.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(firstmailPage);
    await emailAddressInput.click();
    await humanPause(firstmailPage, 300, 800);
    await emailAddressInput.fill(ACCOUNT.email);

    const firstmailPasswordInput = firstmailPage.getByRole('textbox', { name: 'Password' });
    await firstmailPasswordInput.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(firstmailPage);
    await firstmailPasswordInput.click();
    await humanPause(firstmailPage, 300, 800);
    await firstmailPasswordInput.fill(ACCOUNT.password);
    await captureStep(firstmailPage, 'firstmail-login-form-filled');

    const rememberCheckboxArea = firstmailPage.locator('#login-form-desktop > .flex.items-center.justify-between > .flex');
    if (await visible(rememberCheckboxArea)) {
      await humanPause(firstmailPage, 800, 1600);
      await rememberCheckboxArea.click();
    }

    const loginWebmailButton = firstmailPage.getByRole('button', { name: 'Log in webmail' });
    await loginWebmailButton.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(firstmailPage, 1200, 2200);
    await loginWebmailButton.click();

    await firstmailPage.waitForURL(/\/webmail\/?/, { timeout: 60000 }).catch(() => {});
    await firstmailPage.waitForLoadState('domcontentloaded');
    await firstmailPage.waitForTimeout(5000);
    await captureStep(firstmailPage, 'firstmail-webmail-home');
    logStep('Firstmail 登录完成');

    // ========= 第二阶段：Firstmail 登录完成后，再打开 Dreamina =========
    setStep('DREAMINA_OPEN_START');
    logStep('开始打开 Dreamina');
    dreaminaPage = await context.newPage();

    await openDreaminaWithRetry(dreaminaPage, 3);
    await ensureDreaminaEmailLoginForm(dreaminaPage);

    const dreaminaEmailInput = dreaminaPage.getByRole('textbox', { name: 'Enter email' });
    await dreaminaEmailInput.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage);
    await dreaminaEmailInput.click();
    await humanPause(dreaminaPage, 300, 800);
    await dreaminaEmailInput.fill(ACCOUNT.email);

    const dreaminaPasswordInput = dreaminaPage.getByRole('textbox', { name: 'Enter password' });
    await dreaminaPasswordInput.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage);
    await dreaminaPasswordInput.click();
    await humanPause(dreaminaPage, 300, 800);
    await dreaminaPasswordInput.fill(ACCOUNT.password);
    await captureStep(dreaminaPage, 'dreamina-login-form-filled');

    const signUpText = dreaminaPage.getByText('Sign up');
    if (await visible(signUpText)) {
      setStep('DREAMINA_SIGNUP_CLICK');
      logStep('检测到 Dreamina 注册入口 Sign up，准备点击');
      await humanPause(dreaminaPage, 1000, 2200);
      await signUpText.click();
      await dreaminaPasswordInput.waitFor({ state: 'visible', timeout: 30000 });
      await humanPause(dreaminaPage, 300, 800);
      await dreaminaPasswordInput.fill(ACCOUNT.password);
      await captureStep(dreaminaPage, 'dreamina-signup-selected');
    }

    const continueButton = dreaminaPage.getByRole('button', { name: 'Continue' });
    await continueButton.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, 1200, 2200);
    await continueButton.click();

    await dreaminaPage.waitForLoadState('domcontentloaded');
    await dreaminaPage.waitForTimeout(3000);
    await captureStep(dreaminaPage, 'dreamina-after-continue');
    logStep('Dreamina 已提交邮箱/密码，开始等待验证码邮件');

    // ========= 第三阶段：回到 Firstmail 读取验证码邮件 =========
    setStep('FIRSTMAIL_BACK_TO_INBOX');
    await firstmailPage.bringToFront();
    await firstmailPage.goto('https://firstmail.ltd/webmail/', {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await firstmailPage.waitForTimeout(5000);
    await captureStep(firstmailPage, 'firstmail-before-mail-wait');

    const mailItem = await waitForDreaminaMail(firstmailPage, 12, 5000);
    await humanPause(firstmailPage, 1200, 2200);
    await mailItem.click();
    await captureStep(firstmailPage, 'firstmail-dreamina-mail-opened');

    const verificationCode = await extractVerificationCode(firstmailPage);
    logStep(`已提取验证码：${verificationCode}`);

    // ========= 第四阶段：回到 Dreamina 填验证码与生日 =========
    setStep('DREAMINA_FILL_CODE_AND_BIRTH');
    await dreaminaPage.bringToFront();

    const codeInput = dreaminaPage.getByRole('textbox').filter({ hasText: /^$/ }).first();
    await codeInput.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage);
    await codeInput.click();
    await humanPause(dreaminaPage, 300, 800);
    await codeInput.fill(verificationCode);
    await captureStep(dreaminaPage, 'dreamina-code-filled');

    const yearInput = dreaminaPage.getByRole('textbox', { name: 'Year' });
    await yearInput.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, 800, 1600);
    await yearInput.click();
    await humanPause(dreaminaPage, 300, 800);
    await yearInput.fill(birth.year);

    const monthDropdown = dreaminaPage.getByText('Month');
    await monthDropdown.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, 800, 1600);
    await monthDropdown.click();
    await humanPause(dreaminaPage, 500, 1200);
    await dreaminaPage.getByRole('option', { name: birth.month }).click();

    const dayDropdown = dreaminaPage.getByText('Day', { exact: true });
    await dayDropdown.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, 800, 1600);
    await dayDropdown.click();
    await humanPause(dreaminaPage, 500, 1200);
    await dreaminaPage.getByRole('option', { name: birth.day, exact: true }).click();
    await captureStep(dreaminaPage, 'dreamina-birth-filled');

    const nextButton = dreaminaPage.getByRole('button', { name: 'Next' });
    await nextButton.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, 1200, 2200);
    await nextButton.click();
    await captureStep(dreaminaPage, 'dreamina-after-next');

    const otherOption = dreaminaPage.getByText('Other (please specify)');
    if (await visible(otherOption)) {
      setStep('DREAMINA_SELECT_OTHER');
      await humanPause(dreaminaPage, 900, 1800);
      await otherOption.click();
      await captureStep(dreaminaPage, 'dreamina-other-selected');
    }

    const continueToDreaminaButton = dreaminaPage.getByRole('button', { name: 'Continue to Dreamina' });
    if (await visible(continueToDreaminaButton)) {
      setStep('DREAMINA_CONTINUE_TO_HOME');
      await humanPause(dreaminaPage, 1200, 2200);
      await continueToDreaminaButton.click();
      await captureStep(dreaminaPage, 'dreamina-continue-to-home');
    }

    const appDownloadImage = dreaminaPage.locator('.app-download-container-hnrVXj > img');
    if (await visible(appDownloadImage)) {
      setStep('DREAMINA_APP_POPUP');
      await humanPause(dreaminaPage, 900, 1800);
      await appDownloadImage.click();
      await captureStep(dreaminaPage, 'dreamina-app-download-popup');
    }

    const closePopupButton = dreaminaPage.locator('.close-button-bXf1SB > svg');
    if (await visible(closePopupButton)) {
      setStep('DREAMINA_CLOSE_POPUP');
      await humanPause(dreaminaPage, 900, 1800);
      await closePopupButton.click();
      await captureStep(dreaminaPage, 'dreamina-popup-closed');
    }

    setStep('FLOW_FINISHED');
    logStep(`流程完成，本次随机生日：${birth.year}-${birth.month}-${birth.day}`);
  } catch (error) {
    await printFailureSummary([firstmailPage, dreaminaPage], error);
    throw error;
  }
})();
