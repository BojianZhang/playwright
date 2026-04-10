const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { waitForDreaminaCodeViaApi } = require('./firstmail-api');
const { logStage, logSuccess, logFail, logWarn, logInfo } = require('./logger');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const STORAGE_DIR = path.join(__dirname, 'storage');
const WINDOW_LAYOUT_SCRIPT = path.join(__dirname, 'window-layout.ps1');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

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

function getRandomFingerprint() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
  ];

  const viewports = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 }
  ];

  const locales = ['en-US', 'en-GB'];
  const timezones = ['Asia/Shanghai', 'Asia/Singapore', 'America/New_York'];
  const colorSchemes = ['light', 'dark'];
  const scaleFactors = [1, 1.25];

  return {
    userAgent: userAgents[Math.floor(Math.random() * userAgents.length)],
    viewport: viewports[Math.floor(Math.random() * viewports.length)],
    locale: locales[Math.floor(Math.random() * locales.length)],
    timezoneId: timezones[Math.floor(Math.random() * timezones.length)],
    colorScheme: colorSchemes[Math.floor(Math.random() * colorSchemes.length)],
    deviceScaleFactor: scaleFactors[Math.floor(Math.random() * scaleFactors.length)],
  };
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

function makeLogger(prefix) {
  return (message) => console.log(`[${prefix}] ${message}`);
}

async function runPowerShellWindowLayout(browser, windowBounds, workerId, account) {
  if (!browser || !windowBounds || !fs.existsSync(WINDOW_LAYOUT_SCRIPT)) return;

  const processGetter = typeof browser.process === 'function' ? browser.process.bind(browser) : null;
  const browserProcess = processGetter ? processGetter() : null;
  const pid = browserProcess && typeof browserProcess.pid === 'number' ? browserProcess.pid : null;
  if (!pid) {
    logWarn(`线程${workerId || 'NA'} 无法获取浏览器进程 PID，跳过二次摆窗`);
    return;
  }

  await new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      WINDOW_LAYOUT_SCRIPT,
      '-Pid',
      String(pid),
      '-X',
      String(windowBounds.x),
      '-Y',
      String(windowBounds.y),
      '-Width',
      String(windowBounds.width),
      '-Height',
      String(windowBounds.height),
      '-Label',
      `${workerId || 'NA'}-${account?.email || 'UNKNOWN'}`,
    ];

    execFile('powershell.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        logWarn(`线程${workerId || 'NA'} 二次摆窗失败：${error.message}`);
      }
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (output) {
        logInfo(`线程${workerId || 'NA'} 二次摆窗结果：${output}`);
      }
      resolve();
    });
  });
}

function logTaskStage(stageNo, account, proxy, current, extra = '') {
  const suffix = extra ? ` | ${extra}` : '';
  logStage(`阶段${stageNo} | 账号=${account.email} | 代理=${proxy?.server || 'NO_PROXY'} | 当前=${current}${suffix}`);
}

async function capture(page, name, prefix) {
  const filePath = path.join(SCREENSHOT_DIR, `${prefix}-${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  return filePath;
}

async function humanPause(page, min = 800, max = 1800) {
  const delay = Math.floor(min + Math.random() * (max - min));
  await page.waitForTimeout(delay);
}

async function visible(locator) {
  return await locator.isVisible().catch(() => false);
}

async function fetchVerificationCodeViaApi(account, proxy, config, log) {
  logTaskStage(3, account, proxy, '通过 Firstmail API 拉验证码');
  return waitForDreaminaCodeViaApi({
    account,
    config,
    log,
    accountLabel: account.email,
    proxyLabel: proxy?.server || 'NO_PROXY',
  });
}

async function preprocessDreaminaOverlays(page, log, prefix) {
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
  ];

  let handled = false;
  for (let i = 0; i < overlayCandidates.length; i++) {
    const candidate = overlayCandidates[i];
    if (await visible(candidate)) {
      log(`处理 Dreamina 前置弹层候选 ${i + 1}`);
      logWarn(`检测到前置弹层，准备处理第 ${i + 1} 个候选`);
      await capture(page, `overlay-visible-${i + 1}`, prefix);
      await humanPause(page, 900, 1800);
      await candidate.click().catch(() => {});
      await page.waitForTimeout(1500);
      await capture(page, `overlay-dismissed-${i + 1}`, prefix);
      handled = true;
    }
  }
  return handled;
}

async function hasDreaminaLoginSignals(page) {
  const emailInput = page.getByRole('textbox', { name: 'Enter email' });
  const continueWithEmailButton = page.locator('div').filter({ hasText: /^Continue with email$/ }).nth(1);
  const signInCandidates = [
    page.getByText('Sign in', { exact: false }),
    page.getByText('Log in', { exact: false }),
    page.getByText('Login', { exact: false }),
    page.getByText('Sign up', { exact: false }),
    page.getByRole('button', { name: /sign in|log in|login|sign up/i }),
    page.getByRole('link', { name: /sign in|log in|login|sign up/i }),
    page.locator('text=/sign in|log in|login|sign up/i').first(),
  ];

  if (await visible(emailInput)) return { found: true, label: 'Enter email 输入框' };
  if (await visible(continueWithEmailButton)) return { found: true, label: 'Continue with email 按钮' };
  for (const candidate of signInCandidates) {
    if (await visible(candidate.first())) {
      return { found: true, label: 'Sign in / Log in / Sign up 入口' };
    }
  }
  return { found: false, label: '' };
}

async function recoverDreaminaErrorModal(page, log, prefix, account, proxy) {
  const refreshButton = page.getByRole('button', { name: /refresh/i }).first();
  const errorText = page.getByText(/something went wrong/i).first();
  const retryText = page.getByText(/refresh the page and try again/i).first();

  const hasError = await visible(errorText) || await visible(retryText) || await visible(refreshButton);
  if (!hasError) return false;

  logTaskStage(2, account, proxy, '检测到异常弹窗', '准备刷新页面恢复');
  logWarn('Dreamina 页面出现 Something went wrong / Refresh 弹窗，准备自动恢复');
  await capture(page, 'dreamina-error-modal', prefix);

  if (await visible(refreshButton)) {
    await humanPause(page, 800, 1500);
    await refreshButton.click().catch(() => {});
    await page.waitForTimeout(4000);
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }

  await capture(page, 'dreamina-error-modal-recovered', prefix);
  return true;
}

async function waitForDreaminaLoginSignals(page, log, prefix, account, proxy, options = {}) {
  const stages = [
    { seconds: 20, intervalMs: 1000 },
    { seconds: 20, intervalMs: 1500 },
    { seconds: 20, intervalMs: 2000 },
  ];

  const maxRecoveries = Number(options.maxRecoveries || 3);
  const recoveryBonusMs = Number(options.recoveryBonusMs || 15000);
  const customStages = Array.isArray(options.stages) && options.stages.length ? options.stages : stages;
  const totalWaitMs = customStages.reduce((sum, item) => sum + (Number(item.seconds || 0) * Number(item.intervalMs || 0)), 0);
  logTaskStage(2, account, proxy, '等待登录入口出现', `自适应等待≈${Math.round(totalWaitMs / 1000)}秒 | 异常恢复上限=${maxRecoveries}次 | 每次恢复顺延=${Math.round(recoveryBonusMs / 1000)}秒`);

  let elapsedMs = 0;
  let round = 0;
  let recoveryCount = 0;
  let recoveryBonusLeftMs = 0;

  for (const stage of customStages) {
    const seconds = Number(stage.seconds || 0);
    const intervalMs = Number(stage.intervalMs || 1000);
    for (let i = 0; i < seconds; i++) {
      round += 1;
      await preprocessDreaminaOverlays(page, log, prefix);
      const recovered = await recoverDreaminaErrorModal(page, log, prefix, account, proxy);
      if (recovered) {
        recoveryCount += 1;
        recoveryBonusLeftMs += recoveryBonusMs;
        logWarn(`Dreamina 异常恢复次数：${recoveryCount}/${maxRecoveries} | 本次顺延 ${Math.round(recoveryBonusMs / 1000)} 秒 | 剩余顺延 ${Math.round(recoveryBonusLeftMs / 1000)} 秒`);
        if (recoveryCount > maxRecoveries) {
          throw new Error(`Dreamina 异常恢复次数超限：${recoveryCount}/${maxRecoveries}`);
        }
        await preprocessDreaminaOverlays(page, log, prefix);
      }

      const signal = await hasDreaminaLoginSignals(page);
      if (signal.found) {
        logSuccess(`Dreamina 登录信号已出现：${signal.label}（第 ${round} 轮，已等待 ${Math.round(elapsedMs / 1000)} 秒，恢复 ${recoveryCount} 次）`);
        return signal;
      }

      if (round % 5 === 0) {
        logInfo(`Dreamina 登录入口仍未出现：已等待 ${Math.round(elapsedMs / 1000)} 秒，当前间隔=${intervalMs}ms，恢复次数=${recoveryCount}/${maxRecoveries}，剩余顺延=${Math.round(recoveryBonusLeftMs / 1000)}秒`);
        await capture(page, `dreamina-wait-login-${round}`, prefix);
      }

      await page.waitForTimeout(intervalMs);
      elapsedMs += intervalMs;
    }
  }

  while (recoveryBonusLeftMs > 0) {
    round += 1;
    await preprocessDreaminaOverlays(page, log, prefix);
    const recovered = await recoverDreaminaErrorModal(page, log, prefix, account, proxy);
    if (recovered) {
      recoveryCount += 1;
      recoveryBonusLeftMs += recoveryBonusMs;
      logWarn(`Dreamina 异常恢复次数：${recoveryCount}/${maxRecoveries} | 本次顺延 ${Math.round(recoveryBonusMs / 1000)} 秒 | 剩余顺延 ${Math.round(recoveryBonusLeftMs / 1000)} 秒`);
      if (recoveryCount > maxRecoveries) {
        throw new Error(`Dreamina 异常恢复次数超限：${recoveryCount}/${maxRecoveries}`);
      }
      await preprocessDreaminaOverlays(page, log, prefix);
    }

    const signal = await hasDreaminaLoginSignals(page);
    if (signal.found) {
      logSuccess(`Dreamina 登录信号已出现：${signal.label}（第 ${round} 轮，已等待 ${Math.round(elapsedMs / 1000)} 秒，恢复 ${recoveryCount} 次，含顺延等待）`);
      return signal;
    }

    const bonusStepMs = Math.min(1500, recoveryBonusLeftMs);
    await page.waitForTimeout(bonusStepMs);
    elapsedMs += bonusStepMs;
    recoveryBonusLeftMs -= bonusStepMs;

    if (round % 5 === 0 || recoveryBonusLeftMs <= 0) {
      logInfo(`Dreamina 顺延等待中：已等待 ${Math.round(elapsedMs / 1000)} 秒，恢复次数=${recoveryCount}/${maxRecoveries}，剩余顺延=${Math.round(recoveryBonusLeftMs / 1000)}秒`);
      await capture(page, `dreamina-wait-login-bonus-${round}`, prefix);
    }
  }

  return { found: false, label: '' };
}

async function openDreaminaWithRetry(page, log, prefix, account, proxy, config, maxAttempts = 3) {
  const targetUrl = 'https://dreamina.capcut.com/ai-tool/home';
  logTaskStage(2, account, proxy, '打开 Dreamina');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`Dreamina 打开尝试 ${attempt}/${maxAttempts}`);
      logInfo(`阶段 2.${attempt}：尝试进入 Dreamina 首页`);
      if (attempt === 1) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      }

      await capture(page, `dreamina-open-${attempt}`, prefix);
      if (await detectDreaminaWhiteScreen(page, account, proxy, prefix)) {
        throw new Error('DREAMINA_WHITE_SCREEN');
      }
      await preprocessDreaminaOverlays(page, log, prefix);

      const signal = await waitForDreaminaLoginSignals(page, log, prefix, account, proxy, {
        stages: [
          { seconds: 20, intervalMs: 1000 },
          { seconds: 20, intervalMs: 1500 },
          { seconds: 20, intervalMs: 2000 },
        ],
        maxRecoveries: Number(config.dreaminaMaxRecoveries || 3),
        recoveryBonusMs: Number(config.dreaminaRecoveryBonusMs || 15000),
      });
      if (signal.found) {
        log(`Dreamina 登录信号出现：${signal.label}`);
        logSuccess('Dreamina 首页已进入可操作状态');
        return;
      }
    } catch (error) {
      log(`Dreamina 打开失败: ${error.message}`);
      logWarn(`Dreamina 打开异常，准备重试：${error.message}`);
    }
  }

  throw new Error('Dreamina 首页多次重试后仍不可用');
}

async function ensureDreaminaEmailLoginForm(page, log, prefix, account, proxy) {
  logTaskStage(2, account, proxy, '进入邮箱注册表单');
  await preprocessDreaminaOverlays(page, log, prefix);

  const emailInput = page.getByRole('textbox', { name: 'Enter email' });
  if (await visible(emailInput)) return;

  const continueWithEmailButton = page.locator('div').filter({ hasText: /^Continue with email$/ }).nth(1);
  if (await visible(continueWithEmailButton)) {
    logInfo('检测到 Continue with email，准备点击进入邮箱注册');
    await humanPause(page, 1000, 2000);
    await continueWithEmailButton.click();
    await emailInput.waitFor({ state: 'visible', timeout: 45000 });
    return;
  }

  const signInCandidates = [
    page.getByText('Sign in', { exact: false }),
    page.getByText('Log in', { exact: false }),
    page.getByText('Login', { exact: false }),
    page.getByText('Sign up', { exact: false }),
    page.getByRole('button', { name: /sign in|log in|login|sign up/i }),
    page.getByRole('link', { name: /sign in|log in|login|sign up/i }),
    page.locator('text=/sign in|log in|login|sign up/i').first(),
  ];

  for (const candidate of signInCandidates) {
    const target = candidate.first();
    if (await visible(target)) {
      logInfo('检测到 Sign in / Log in / Sign up，准备点击进入注册入口');
      await humanPause(page, 1000, 2000);
      await target.click();
      await page.waitForTimeout(4000);
      await preprocessDreaminaOverlays(page, log, prefix);

      if (await visible(continueWithEmailButton)) {
        logInfo('点击后出现 Continue with email，继续进入邮箱注册');
        await humanPause(page, 1000, 2000);
        await continueWithEmailButton.click();
      }

      await emailInput.waitFor({ state: 'visible', timeout: 45000 });
      return;
    }
  }

  throw new Error('未找到 Dreamina 登录/注册入口');
}

async function detectSignupFailure(page, log, prefix) {
  const explicitFailureRules = [
    {
      reason: 'ACCOUNT_ALREADY_EXISTS',
      label: '邮箱已存在',
      locator: page.getByText(/An account with this email already exists/i).first(),
    },
    {
      reason: 'SIGNUP_REJECTED',
      label: '注册失败：稍后重试',
      locator: page.getByText("Couldn't sign up. Try again later.").first(),
    },
    {
      reason: 'SIGNUP_REJECTED',
      label: '注册失败：请稍后重试',
      locator: page.getByText('Try again later').first(),
    },
    {
      reason: 'SIGNUP_REJECTED',
      label: '注册失败：页面异常',
      locator: page.getByText('Something went wrong').first(),
    },
    {
      reason: 'SIGNUP_REJECTED',
      label: '注册失败：尝试过多',
      locator: page.getByText('Too many attempts').first(),
    },
  ];

  for (const rule of explicitFailureRules) {
    if (await visible(rule.locator)) {
      await capture(page, `dreamina-signup-failed-${rule.reason.toLowerCase()}`, prefix);
      log(`检测到 Dreamina 注册失败提示：${rule.label}`);
      logFail(`注册页面出现失败提示：${rule.label}`);
      return rule.reason;
    }
  }

  return '';
}

async function detectDreaminaWhiteScreen(page, account, proxy, prefix) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const trimmedText = String(bodyText || '').replace(/\s+/g, ' ').trim();
  const html = await page.content().catch(() => '');
  const loginSignals = await hasDreaminaLoginSignals(page);
  const hasCanvas = await page.locator('canvas').count().catch(() => 0);
  const hasIframe = await page.locator('iframe').count().catch(() => 0);

  const bodySeemsBlank = !trimmedText || trimmedText.length < 20;
  const domSeemsThin = String(html || '').length < 1200;
  const hasVisibleAppSignals = loginSignals.found || hasCanvas > 0 || hasIframe > 0;

  if (bodySeemsBlank && domSeemsThin && !hasVisibleAppSignals) {
    logTaskStage(1, account, proxy, 'Dreamina 白屏检测命中', `bodyLen=${trimmedText.length} | htmlLen=${String(html || '').length}`);
    logWarn('Dreamina 页面疑似白屏/空白加载，判定为强失败');
    await capture(page, 'dreamina-white-screen', prefix);
    return true;
  }

  return false;
}

async function ensureBirthdayInputsReachable(page, account, proxy, prefix, timeoutMs = 20000) {
  const yearInput = page.getByRole('textbox', { name: 'Year' });
  const monthDropdown = page.getByText('Month').last();
  const dayDropdown = page.getByText('Day', { exact: true }).last();
  const birthdayNextButton = page.locator('button.lv_new_sign_in_panel_wide-birthday-next').first();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (
      await visible(yearInput) &&
      await visible(monthDropdown) &&
      await visible(dayDropdown) &&
      await visible(birthdayNextButton)
    ) {
      return {
        yearInput,
        monthDropdown,
        dayDropdown,
        nextButton: birthdayNextButton,
      };
    }
    await page.waitForTimeout(500);
  }

  logTaskStage(4, account, proxy, '生日页未就绪', `等待超时=${timeoutMs}ms`);
  logWarn('验证码提交后未能进入生日输入阶段，判定当前代理/链路不可用');
  await capture(page, 'dreamina-birthday-unreachable', prefix);
  throw new Error('DREAMINA_BIRTHDAY_STAGE_UNREACHABLE');
}

async function extractSessionIdFromStorageState(storageState) {
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  const hit = cookies.find(cookie => {
    const name = String(cookie?.name || '').toLowerCase();
    const domain = String(cookie?.domain || '').toLowerCase();
    const domainMatched = domain === '.capcut.com' || domain === 'dreamina.capcut.com' || domain.endsWith('.capcut.com');
    return name === 'sessionid' && domainMatched && cookie.value;
  });
  return hit ? `${hit.name}=${hit.value}` : '';
}

async function waitForSessionIdCookie(context, account, proxy, prefix, timeoutMs = 60000) {
  const start = Date.now();
  let lastCookieSnapshot = [];
  let lastHintText = '';

  while (Date.now() - start < timeoutMs) {
    const cookies = await context.cookies().catch(() => []);
    lastCookieSnapshot = cookies;

    const hit = cookies.find(cookie => {
      const name = String(cookie?.name || '').toLowerCase();
      const domain = String(cookie?.domain || '').toLowerCase();
      const domainMatched = domain === '.capcut.com' || domain === 'dreamina.capcut.com' || domain.endsWith('.capcut.com');
      return name === 'sessionid' && domainMatched && cookie.value;
    });
    if (hit) {
      logTaskStage(5, account, proxy, '检测到 sessionid cookie', `${hit.domain} | ${hit.name}`);
      return `${hit.name}=${hit.value}`;
    }

    const interestingCookies = cookies
      .filter(cookie => /sessionid|sid_|sid$|ttwid|passport|msToken/i.test(String(cookie?.name || '')))
      .map(cookie => `${cookie.name}@${cookie.domain}`);
    const hintText = interestingCookies.join(', ') || 'NO_INTERESTING_COOKIES';

    if (hintText !== lastHintText) {
      lastHintText = hintText;
      logTaskStage(5, account, proxy, '等待 sessionid cookie', hintText);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const debugPath = path.join(STORAGE_DIR, `${sanitizeName(account.email)}-${prefix}-session-cookie-timeout.json`);
  await fs.promises.writeFile(debugPath, JSON.stringify({
    account: account.email,
    proxy: proxy?.server || 'NO_PROXY',
    reason: 'SESSIONID_COOKIE_NOT_FOUND',
    cookies: lastCookieSnapshot,
  }, null, 2), 'utf8').catch(() => {});

  throw new Error(`SESSIONID_COOKIE_NOT_FOUND|debug=${path.basename(debugPath)}|seen=${lastHintText || 'NO_INTERESTING_COOKIES'}`);
}

async function saveStorageState(context, account, attempt) {
  const safeName = sanitizeName(account.email);
  const filePath = path.join(STORAGE_DIR, `${safeName}-attempt${attempt}.json`);
  await context.storageState({ path: filePath });
  return filePath;
}

async function waitForVerificationCountdown(page, account, proxy, prefix, timeoutMs = 30000) {
  const countdownLocators = [
    page.locator('text=/Resend code in\\s*\\d+s/i').first(),
    page.locator('text=/resend code/i').first(),
    page.locator('[class*="count"][class*="down"]').first(),
    page.locator('[class*="code-count"]').first(),
  ];
  const verificationInputCandidates = [
    page.locator('input[inputmode="numeric"]').first(),
    page.locator('input[maxlength="6"]').first(),
    page.getByRole('textbox').first(),
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const signupFailureReason = await detectSignupFailure(page, logInfo, prefix);
    if (signupFailureReason) {
      throw new Error(signupFailureReason);
    }

    for (const locator of countdownLocators) {
      if (await visible(locator)) {
        const text = (await locator.textContent().catch(() => '') || '').trim();
        logTaskStage(3, account, proxy, '检测到验证码倒计时', text || 'Resend code in ...');
        await capture(page, 'verification-countdown-detected', prefix);
        return text || 'COUNTDOWN_VISIBLE';
      }
    }

    for (const locator of verificationInputCandidates) {
      if (await visible(locator)) {
        const placeholder = await locator.getAttribute('placeholder').catch(() => '');
        logTaskStage(3, account, proxy, '检测到验证码输入框', placeholder || 'verification input visible');
        await capture(page, 'verification-input-detected', prefix);
        return 'VERIFICATION_INPUT_VISIBLE';
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error('VERIFICATION_COUNTDOWN_NOT_FOUND');
}

async function waitForDreaminaPostRegisterReady(page, account, proxy, prefix, timeoutMs = 45000) {
  const readyLocators = [
    page.locator('[class*="credit-display-container"]').first(),
    page.getByText("You haven't subscribed yet", { exact: false }).first(),
    page.getByText('Subscribe', { exact: false }).first(),
    page.getByText('Start Creating With AI Agent', { exact: false }).first(),
    page.getByText('Canvas', { exact: true }).first(),
    page.getByText('AI Image', { exact: false }).first(),
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const locator of readyLocators) {
      if (await visible(locator)) {
        const text = (await locator.textContent().catch(() => '') || '').trim();
        logTaskStage(5, account, proxy, '检测到注册完成后的主页就绪信号', text || 'Dreamina home ready');
        await capture(page, 'dreamina-post-register-ready', prefix);
        return text || 'DREAMINA_HOME_READY';
      }
    }
    await page.waitForTimeout(1000);
  }

  throw new Error('DREAMINA_POST_REGISTER_READY_NOT_FOUND');
}

async function runRegisterTask({ account, proxy, config, attempt, workerId, windowBounds, resolvedExitIp }) {
  const prefix = `${sanitizeName(account.email)}-attempt${attempt}`;
  const log = makeLogger(prefix);

  let browser;
  let dreaminaPage;
  let context;

  try {
    const launchOptions = {
      headless: Boolean(config.headless),
      slowMo: Number(config.slowMo || 120),
    };

    if (!launchOptions.headless && windowBounds) {
      launchOptions.args = [
        `--window-size=${windowBounds.width},${windowBounds.height}`,
        `--window-position=${windowBounds.x},${windowBounds.y}`,
      ];
    }

    if (proxy) {
      launchOptions.proxy = {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      };
    }

    browser = await chromium.launch(launchOptions);
    if (!Boolean(config.headless) && windowBounds) {
      await runPowerShellWindowLayout(browser, windowBounds, workerId, account);
    }

    const fingerprint = getRandomFingerprint();
    logInfo(`随机指纹：UA=${fingerprint.userAgent} | viewport=${fingerprint.viewport.width}x${fingerprint.viewport.height} | locale=${fingerprint.locale} | tz=${fingerprint.timezoneId} | color=${fingerprint.colorScheme} | scale=${fingerprint.deviceScaleFactor}`);

    context = await browser.newContext({
      viewport: fingerprint.viewport,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      userAgent: fingerprint.userAgent,
      colorScheme: fingerprint.colorScheme,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
      ignoreHTTPSErrors: true,
    });

    const exitIp = String(resolvedExitIp || 'UNKNOWN_EXIT_IP');
    logInfo(`当前浏览器模式：有头（headless=${Boolean(config.headless)}）`);
    logInfo(`当前线程：${workerId || 'NA'}`);
    logInfo(`当前账号：${account.email}`);
    logInfo(`当前代理：${proxy?.server || 'NO_PROXY'}`);
    logInfo(`当前出口IP：${exitIp}`);
    if (windowBounds) {
      logInfo(`当前窗口：${windowBounds.width}x${windowBounds.height} @ (${windowBounds.x}, ${windowBounds.y})`);
    }

    const birth = randomBirthDate(1980, 2008);

    logTaskStage(1, account, proxy, '打开 Dreamina', `出口IP=${exitIp}`);
    log('开始打开 Dreamina');
    dreaminaPage = await context.newPage();
    await openDreaminaWithRetry(dreaminaPage, log, prefix, account, proxy, config, 3);
    await ensureDreaminaEmailLoginForm(dreaminaPage, log, prefix, account, proxy);

    logTaskStage(2, account, proxy, '填写邮箱密码并提交');
    const dreaminaEmailInput = dreaminaPage.getByRole('textbox', { name: 'Enter email' });
    await dreaminaEmailInput.waitFor({ state: 'visible', timeout: 30000 });
    await dreaminaEmailInput.fill(account.email);

    const dreaminaPasswordInput = dreaminaPage.getByRole('textbox', { name: 'Enter password' });
    await dreaminaPasswordInput.waitFor({ state: 'visible', timeout: 30000 });
    await dreaminaPasswordInput.fill(account.password);

    const signUpText = dreaminaPage.getByText('Sign up');
    if (await visible(signUpText)) {
      await humanPause(dreaminaPage, 1000, 2200);
      await signUpText.click();
      await dreaminaPasswordInput.waitFor({ state: 'visible', timeout: 30000 });
      await dreaminaPasswordInput.fill(account.password);
    }

    const continueButton = dreaminaPage.getByRole('button', { name: 'Continue' });
    await continueButton.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, 1200, 2200);
    await continueButton.click();
    await dreaminaPage.waitForTimeout(3000);

    const signupFailureReason = await detectSignupFailure(dreaminaPage, log, prefix);
    if (signupFailureReason) {
      return { success: false, reason: signupFailureReason };
    }

    const countdownText = await waitForVerificationCountdown(dreaminaPage, account, proxy, prefix, Number(config.verificationCountdownWaitMs || 30000));
    log(`检测到验证码阶段信号，开始通过 Firstmail API 拉验证码：${countdownText}`);
    logTaskStage(3, account, proxy, '通过 Firstmail API 拉验证码', countdownText);
    const codeResult = await fetchVerificationCodeViaApi(account, proxy, config, log);
    const code = codeResult.code;
    const messageSummary = [
      String(codeResult?.message?.subject || '').trim(),
      String(codeResult?.message?.snippet || codeResult?.message?.text || '').trim(),
    ].filter(Boolean).join(' | ').slice(0, 200);
    logSuccess(`验证码提取成功：${code}`);
    if (messageSummary) {
      logInfo(`验证码来源邮件摘要：${messageSummary}`);
    }

    logTaskStage(4, account, proxy, '回填验证码和生日');
    await dreaminaPage.bringToFront();
    const codeInputCandidates = [
      dreaminaPage.locator('input[inputmode="numeric"]').first(),
      dreaminaPage.locator('input[maxlength="6"]').first(),
      dreaminaPage.getByRole('textbox').filter({ hasText: /^$/ }).first(),
      dreaminaPage.getByRole('textbox').first(),
    ];
    let codeInput = null;
    for (const locator of codeInputCandidates) {
      if (await visible(locator)) {
        codeInput = locator;
        break;
      }
    }
    if (!codeInput) {
      throw new Error('VERIFICATION_INPUT_NOT_FOUND');
    }
    await codeInput.waitFor({ state: 'visible', timeout: 30000 });
    await codeInput.fill(code);

    const birthdayFields = await ensureBirthdayInputsReachable(
      dreaminaPage,
      account,
      proxy,
      prefix,
      Number(config.birthdayStageTimeoutMs || 20000),
    ).catch(async (error) => {
      const wrongCodeText = dreaminaPage.getByText(/Wrong verification code\. Try again\./i).first();
      if (await visible(wrongCodeText)) {
        await capture(dreaminaPage, 'wrong-verification-code', prefix);
        throw new Error(`WRONG_VERIFICATION_CODE|code=${code}|attempt=${codeResult.attempt || 'NA'}`);
      }
      throw error;
    });

    const yearInput = birthdayFields.yearInput;
    await yearInput.fill(birth.year);

    const monthDropdown = birthdayFields.monthDropdown;
    await monthDropdown.click();
    await dreaminaPage.getByRole('option', { name: birth.month }).click();

    const dayDropdown = birthdayFields.dayDropdown;
    await dayDropdown.click();
    await dreaminaPage.getByRole('option', { name: birth.day, exact: true }).click();

    const nextButton = birthdayFields.nextButton;
    await nextButton.waitFor({ state: 'visible', timeout: 30000 });
    await nextButton.click();

    const readyText = await waitForDreaminaPostRegisterReady(
      dreaminaPage,
      account,
      proxy,
      prefix,
      Number(config.postRegisterReadyTimeoutMs || 45000),
    );

    const detectedSessionId = await waitForSessionIdCookie(
      context,
      account,
      proxy,
      prefix,
      Number(config.sessionIdCookieTimeoutMs || 60000),
    );

    const finalStoragePath = path.join(STORAGE_DIR, `${sanitizeName(account.email)}-attempt${attempt}-user.json`);
    await context.storageState({ path: finalStoragePath });
    const userStorageState = JSON.parse(await fs.promises.readFile(finalStoragePath, 'utf8'));

    const storagePath = await saveStorageState(context, account, attempt);
    const sessionId = await extractSessionIdFromStorageState(userStorageState) || detectedSessionId;
    logTaskStage(5, account, proxy, '保存登录态', `${readyText} | userJson=${path.basename(finalStoragePath)}`);
    logSuccess('账号注册流程执行成功，已保存登录态');
    logInfo(`登录态文件：${storagePath}`);
    logInfo(`SessionID：${sessionId || '未提取到'}`);

    return {
      success: true,
      reason: 'SUCCESS',
      storagePath,
      sessionId,
    };
  } catch (error) {
    logTaskStage(9, account, proxy, '任务异常');
    logFail(`任务异常：${error.message}`);
    if (dreaminaPage) await capture(dreaminaPage, 'failure-dreamina', prefix);
    return { success: false, reason: error.message || 'TASK_EXCEPTION' };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = { runRegisterTask };
