const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { waitForDreaminaCodeViaApi } = require('./firstmail-api');
const { loadDreaminaRegisterProfile, summarizeProfile } = require('./dreamina-register-profile-loader');
const { resolveDreaminaHomeUrl, detectDreaminaWhiteScreen, detectDreaminaFirstLoadDeadPage } = require('./dreamina-health');
const { logStage, logSuccess, logFail, logWarn, logInfo } = require('./logger');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const STORAGE_DIR = path.join(__dirname, 'storage');
const WINDOW_LAYOUT_SCRIPT = path.join(__dirname, 'window-layout.ps1');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

function createRegexFromPattern(pattern, fallbackFlags = 'i') {
  const text = String(pattern || '').trim();
  if (!text) return null;
  try {
    return new RegExp(text, fallbackFlags);
  } catch (error) {
    return null;
  }
}

function getProfileTextLocator(page, text, exact = false) {
  return page.getByText(String(text || ''), { exact });
}

function getProfilePatternLocator(page, pattern) {
  const regex = createRegexFromPattern(pattern, 'i');
  return regex ? page.getByText(regex).first() : page.locator('::-p-never-match');
}

async function detectPostVerificationFailure(page, profile, prefix, config) {
  const existingAccountPatterns = Array.isArray(profile?.existingAccountSignals) ? profile.existingAccountSignals : [];
  for (const pattern of existingAccountPatterns) {
    const locator = getProfilePatternLocator(page, pattern);
    if (await visible(locator)) {
      await capture(page, 'post-verification-existing-account', prefix, config);
      return 'ACCOUNT_ALREADY_EXISTS';
    }
  }

  const signupFailureRules = Array.isArray(profile?.signupFailureRules) ? profile.signupFailureRules : [];
  for (const rule of signupFailureRules) {
    const locator = getProfilePatternLocator(page, rule?.pattern || '');
    if (!(await visible(locator))) continue;
    const normalizedReason = String(rule?.reason || '').trim().toUpperCase();
    if (normalizedReason === 'VERIFICATION_CODE_RATE_LIMITED') {
      await capture(page, 'post-verification-rate-limited', prefix, config);
      return 'VERIFICATION_CODE_RATE_LIMITED';
    }
    if (normalizedReason === 'SIGNUP_REJECTED') {
      await capture(page, 'post-verification-signup-rejected', prefix, config);
      return 'SIGNUP_REJECTED_IP_BANNED';
    }
  }

  const wrongCodePatterns = Array.isArray(profile?.verification?.wrongCodePatterns) ? profile.verification.wrongCodePatterns : ['Wrong verification code\\. Try again\\.'];
  for (const pattern of wrongCodePatterns) {
    const locator = getProfilePatternLocator(page, pattern);
    if (await visible(locator)) {
      await capture(page, 'post-verification-wrong-code', prefix, config);
      return 'WRONG_VERIFICATION_CODE';
    }
  }

  return '';
}

function getVerificationInputCandidates(page, profile) {
  // Dreamina 验证码控件定位结论（2026-04-11）：
  // 1) 候选池一旦放宽到通用 textbox / 泛化 input / 任意可见 div，极易误命中非验证码元素（已实测命中过 lv-menu-item）。
  // 2) 一旦 codeInput 选错，后续 hidden input 注入 / wrapper 键盘输入 / fallback keyboard.type 都会全部打空，表面看像“取到码但不填写”。
  // 3) 因此这里必须保持 Dreamina 专用白名单，只允许真实 6 位 input、verification wrapper、focus 格进入候选池；不要回退到宽泛候选策略。
  const selectors = Array.isArray(profile?.verification?.inputSelectors) && profile.verification.inputSelectors.length
    ? profile.verification.inputSelectors
    : [
        "input[maxlength='6'][autocomplete='one-time-code']",
        "input[autocomplete='one-time-code'][inputmode='numeric']",
        ".verification_code_input-wrapper input[maxlength='6']",
        ".verification_code_input-wrapper",
        "[class*='verification_code_input-wrapper']",
        ".verification_code_input-number-focus",
        "[class*='verification_code_input-number-focus']",
      ];
  const locators = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    locators.push(locator.first());
  }
  return locators;
}

function randomBirthDate(startYear = 1980, endYear = 2008) {
  const start = new Date(`${startYear}-01-01T00:00:00`);
  const end = new Date(`${endYear}-12-31T00:00:00`);
  const randomTime = start.getTime() + Math.random() * (end.getTime() - start.getTime());
  const date = new Date(randomTime);
  const year = String(date.getFullYear());
  const monthIndex = date.getMonth();
  const day = String(date.getDate());
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return { year, month: monthNames[monthIndex], day };
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

function resolveRunMode(config = {}) {
  return String(config.runMode || 'run').trim().toLowerCase();
}

function isTestMode(config = {}) {
  return resolveRunMode(config) === 'test';
}

function shouldCaptureScreenshots(config = {}) {
  const runMode = resolveRunMode(config);
  if (runMode === 'test' && typeof config.testEnableScreenshots === 'boolean') return config.testEnableScreenshots;
  if (runMode === 'run' && typeof config.runEnableScreenshots === 'boolean') return config.runEnableScreenshots;
  if (typeof config.enableScreenshots === 'boolean') return config.enableScreenshots;
  return isTestMode(config);
}

function resolveSlowMo(config = {}) {
  if (isTestMode(config)) return Number(config.testSlowMo ?? config.slowMo ?? 120);
  return Number(config.runSlowMo ?? 0);
}

function resolveHumanPauseRange(config = {}) {
  if (isTestMode(config)) {
    return { min: Number(config.testHumanPauseMinMs ?? 800), max: Number(config.testHumanPauseMaxMs ?? 1800) };
  }
  return { min: Number(config.runHumanPauseMinMs ?? 0), max: Number(config.runHumanPauseMaxMs ?? 0) };
}

function resolveModeWait(config = {}, runKey, testKey, fallbackMs) {
  if (isTestMode(config)) return Number(config[testKey] ?? fallbackMs);
  return Number(config[runKey] ?? 0);
}

function resolveModeTimeout(config = {}, runKey, testKey, fallbackMs) {
  if (isTestMode(config)) return Number(config[testKey] ?? fallbackMs);
  return Number(config[runKey] ?? fallbackMs);
}

function resolveLoginSignalStages(config = {}) {
  const fallback = [
    { seconds: 20, intervalMs: 1000 },
    { seconds: 20, intervalMs: 1500 },
    { seconds: 20, intervalMs: 2000 },
  ];
  const raw = isTestMode(config) ? config.testLoginSignalStages : config.runLoginSignalStages;
  const stages = Array.isArray(raw) ? raw : fallback;
  const normalized = stages
    .map(item => ({
      seconds: Number(item?.seconds || 0),
      intervalMs: Number(item?.intervalMs || 0),
    }))
    .filter(item => item.seconds > 0 && item.intervalMs > 0);
  return normalized.length ? normalized : fallback;
}

function resolveBlockedResourceTypes(config = {}) {
  const raw = isTestMode(config) ? config.testBlockResourceTypes : config.runBlockResourceTypes;
  const list = Array.isArray(raw) ? raw : [];
  return new Set(list.map(item => String(item || '').trim().toLowerCase()).filter(Boolean));
}

function resolveDreaminaRecoveryConfig(config = {}) {
  if (isTestMode(config)) {
    return {
      maxRecoveries: Number(config.testDreaminaMaxRecoveries ?? config.dreaminaMaxRecoveries ?? 3),
      recoveryBonusMs: Number(config.testDreaminaRecoveryBonusMs ?? config.dreaminaRecoveryBonusMs ?? 15000),
    };
  }
  return {
    maxRecoveries: Number(config.runDreaminaMaxRecoveries ?? 1),
    recoveryBonusMs: Number(config.runDreaminaRecoveryBonusMs ?? 5000),
  };
}

function getDreaminaHomeUrl(config = {}) {
  return resolveDreaminaHomeUrl(config);
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
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINDOW_LAYOUT_SCRIPT, '-Pid', String(pid), '-X', String(windowBounds.x), '-Y', String(windowBounds.y), '-Width', String(windowBounds.width), '-Height', String(windowBounds.height), '-Label', `${workerId || 'NA'}-${account?.email || 'UNKNOWN'}`];
    execFile('powershell.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) logWarn(`线程${workerId || 'NA'} 二次摆窗失败：${error.message}`);
      const output = `${stdout || ''}${stderr || ''}`.trim();
      if (output) logInfo(`线程${workerId || 'NA'} 二次摆窗结果：${output}`);
      resolve();
    });
  });
}

function logTaskStage(stageNo, account, proxy, current, extra = '') {
  const suffix = extra ? ` | ${extra}` : '';
  logStage(`阶段${stageNo} | 账号=${account.email} | 代理=${proxy?.server || 'NO_PROXY'} | 当前=${current}${suffix}`);
}

function createStageTimer() {
  const marks = new Map();
  const durations = {};
  return {
    mark(name) {
      marks.set(name, Date.now());
    },
    end(name, outputKey = name) {
      const startedAt = marks.get(name);
      if (!startedAt) return 0;
      const durationMs = Date.now() - startedAt;
      durations[outputKey] = durationMs;
      return durationMs;
    },
    snapshot() {
      return { ...durations };
    },
  };
}

function formatStageTimings(timings = {}) {
  return Object.entries(timings)
    .map(([key, value]) => `${key}=${Number(value || 0)}ms`)
    .join(' | ');
}

async function capture(page, name, prefix, config = {}) {
  if (!shouldCaptureScreenshots(config)) return '';
  const filePath = path.join(SCREENSHOT_DIR, `${prefix}-${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  return filePath;
}

async function humanPause(page, config = {}, min, max) {
  const range = resolveHumanPauseRange(config);
  const finalMin = Number(min ?? range.min ?? 0);
  const finalMax = Number(max ?? range.max ?? finalMin);
  const safeMin = Math.max(0, finalMin);
  const safeMax = Math.max(safeMin, finalMax);
  const delay = safeMax === safeMin ? safeMin : Math.floor(safeMin + Math.random() * (safeMax - safeMin));
  if (delay <= 0) return;
  await page.waitForTimeout(delay);
}

async function visible(locator) {
  return await locator.isVisible().catch(() => false);
}

async function enterVerificationCode(page, codeInput, code, logInfoFn = logInfo) {
  const value = String(code || '').trim();
  if (!value) throw new Error('VERIFICATION_CODE_EMPTY');
  const verificationFlowStartedAt = Date.now();

  const readDreaminaVerificationState = async () => {
    return await page.evaluate(() => {
      const input = document.querySelector("input[maxlength='6'][autocomplete='one-time-code'], input[autocomplete='one-time-code'][inputmode='numeric'], .verification_code_input-wrapper input[maxlength='6']");
      const boxes = Array.from(document.querySelectorAll(".verification_code_input-number, [class*='verification_code_input-number']"));
      return {
        inputValue: input instanceof HTMLInputElement ? String(input.value || '') : '',
        activeTag: document.activeElement ? document.activeElement.tagName : '',
        activeClass: document.activeElement ? String(document.activeElement.className || '') : '',
        boxTexts: boxes.map(node => String(node.textContent || '').trim()),
      };
    }).catch(() => ({ inputValue: '', activeTag: '', activeClass: '', boxTexts: [] }));
  };

  const dreaminaInputCandidates = [
    page.locator("input[maxlength='6'][autocomplete='one-time-code']").first(),
    page.locator("input[autocomplete='one-time-code'][inputmode='numeric']").first(),
    page.locator(".verification_code_input-wrapper input[maxlength='6']").first(),
    codeInput,
  ];

  for (const candidate of dreaminaInputCandidates) {
    if (!candidate) continue;
    if (!(await visible(candidate))) continue;
    try {
      const specificCandidateStartedAt = Date.now();
      await candidate.click({ force: true }).catch(() => {});
      await candidate.focus().catch(() => {});
      await candidate.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await candidate.press('Backspace').catch(() => {});
      await candidate.fill(value).catch(async () => {
        await candidate.type(value, { delay: 60 }).catch(() => {});
      });
      await candidate.evaluate((node, verificationCode) => {
        if (!(node instanceof HTMLInputElement)) return;
        node.value = verificationCode;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, data: verificationCode, inputType: 'insertText' }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: verificationCode.slice(-1) || '' }));
      }, value).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      const state = await readDreaminaVerificationState();
      if (typeof logInfoFn === 'function') logInfoFn(`Dreamina 专用 input 注入结果 | active=${state.activeTag}.${state.activeClass} | inputValue=${state.inputValue || '[EMPTY]'} | boxTexts=${JSON.stringify(state.boxTexts || [])}`);
      if (typeof logInfoFn === 'function') logInfoFn(`enterVerificationCode.specificCandidateDone | elapsed=${Date.now() - specificCandidateStartedAt}ms`);
      const joinedBoxText = Array.isArray(state.boxTexts) ? state.boxTexts.join('') : '';
      if (state.inputValue === value || joinedBoxText.slice(0, value.length) === value) {
        if (typeof logInfoFn === 'function') logInfoFn(`enterVerificationCode.success | mode=dreamina-hidden-input | totalElapsed=${Date.now() - verificationFlowStartedAt}ms`);
        return 'dreamina-hidden-input';
      }
    } catch (error) {
      if (typeof logInfoFn === 'function') logInfoFn(`Dreamina 专用 input 注入异常，继续尝试下一个候选 | error=${error?.message || error}`);
    }
  }

  const wrapperCandidates = [
    page.locator('.verification_code_input-wrapper').first(),
    page.locator("[class*='verification_code_input-wrapper']").first(),
    page.locator("div[tabindex='0']").first(),
  ];

  for (const candidate of wrapperCandidates) {
    if (!candidate) continue;
    if (!(await visible(candidate))) continue;
    try {
      const wrapperCandidateStartedAt = Date.now();
      await candidate.click({ force: true }).catch(() => {});
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(value, { delay: 80 }).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      const state = await readDreaminaVerificationState();
      if (typeof logInfoFn === 'function') logInfoFn(`Dreamina 容器键盘注入结果 | active=${state.activeTag}.${state.activeClass} | inputValue=${state.inputValue || '[EMPTY]'} | boxTexts=${JSON.stringify(state.boxTexts || [])}`);
      if (typeof logInfoFn === 'function') logInfoFn(`enterVerificationCode.wrapperCandidateDone | elapsed=${Date.now() - wrapperCandidateStartedAt}ms`);
      const joinedBoxText = Array.isArray(state.boxTexts) ? state.boxTexts.join('') : '';
      if (state.inputValue === value || joinedBoxText.slice(0, value.length) === value) {
        if (typeof logInfoFn === 'function') logInfoFn(`enterVerificationCode.success | mode=dreamina-wrapper-keyboard | totalElapsed=${Date.now() - verificationFlowStartedAt}ms`);
        return 'dreamina-wrapper-keyboard';
      }
    } catch (error) {
      if (typeof logInfoFn === 'function') logInfoFn(`Dreamina 容器键盘注入异常，继续尝试下一个候选 | error=${error?.message || error}`);
    }
  }

  if (typeof logInfoFn === 'function') logInfoFn('Dreamina 专用方案未命中，回退到普通 keyboard.type');
  const fallbackStartedAt = Date.now();
  await codeInput.click().catch(() => {});
  await page.keyboard.type(value, { delay: 80 }).catch(async () => {
    await codeInput.fill?.(value).catch(() => {});
  });
  if (typeof logInfoFn === 'function') logInfoFn(`enterVerificationCode.fallbackDone | elapsed=${Date.now() - fallbackStartedAt}ms | totalElapsed=${Date.now() - verificationFlowStartedAt}ms`);
  return 'fallback-keyboard-type';
}

async function fetchVerificationCodeViaApi(account, proxy, config, log, triggeredAtMs) {
  logTaskStage(3, account, proxy, '通过 Firstmail API 拉验证码');
  return waitForDreaminaCodeViaApi({ account, config, log, accountLabel: account.email, proxyLabel: proxy?.server || 'NO_PROXY', triggeredAtMs });
}

async function preprocessDreaminaOverlays(page, log, prefix, config) {
  const overlayPassStartedAt = Date.now();
  const profile = loadDreaminaRegisterProfile();
  const buttonNames = Array.isArray(profile?.overlays?.buttonNames) ? profile.overlays.buttonNames : [];
  const extraSelectors = Array.isArray(profile?.overlays?.extraSelectors) ? profile.overlays.extraSelectors : [];
  const overlayCandidates = buttonNames.map(name => page.getByRole('button', { name })).concat([
    page.getByRole('button', { name: createRegexFromPattern(profile?.overlays?.buttonNamePattern, 'i') || /accept all|accept|i agree|got it|close|skip|not now|maybe later/i }),
    ...extraSelectors.map(selector => page.locator(selector).first()),
  ]);

  let handled = false;
  for (let i = 0; i < overlayCandidates.length; i++) {
    const candidate = overlayCandidates[i];
    const candidateScanStartedAt = Date.now();
    const candidateVisible = await visible(candidate);
    logInfo(`overlay.candidateScan | index=${i + 1}/${overlayCandidates.length} | visible=${candidateVisible ? 'Y' : 'N'} | elapsed=${Date.now() - candidateScanStartedAt}ms`);
    if (candidateVisible) {
      log(`处理 Dreamina 前置弹层候选 ${i + 1}`);
      logWarn(`检测到前置弹层，准备处理第 ${i + 1} 个候选`);
      await capture(page, `overlay-visible-${i + 1}`, prefix, config);
      await humanPause(page, config, 900, 1800);
      const clickStartedAt = Date.now();
      await candidate.click().catch(() => {});
      logInfo(`overlay.clickDone | index=${i + 1} | elapsed=${Date.now() - clickStartedAt}ms`);
      const postOverlayWaitMs = resolveModeWait(config, 'runPostOverlayWaitMs', 'testPostOverlayWaitMs', 1500);
      if (postOverlayWaitMs > 0) {
        const overlayWaitStartedAt = Date.now();
        await page.waitForTimeout(postOverlayWaitMs);
        logInfo(`overlay.postWaitDone | index=${i + 1} | elapsed=${Date.now() - overlayWaitStartedAt}ms | configured=${postOverlayWaitMs}ms`);
      }
      await capture(page, `overlay-dismissed-${i + 1}`, prefix, config);
      handled = true;
    }
  }
  logInfo(`overlay.passDone | handled=${handled ? 'Y' : 'N'} | totalElapsed=${Date.now() - overlayPassStartedAt}ms | candidates=${overlayCandidates.length}`);
  return handled;
}

async function hasDreaminaLoginSignals(page) {
  const profile = loadDreaminaRegisterProfile();
  const emailInput = page.getByRole('textbox', { name: profile?.loginSignals?.emailInputRoleName || 'Enter email' });
  const continueWithEmailButton = page.locator('div').filter({ hasText: new RegExp(`^${String(profile?.loginSignals?.continueWithEmailText || 'Continue with email').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).nth(1);
  const entryTexts = Array.isArray(profile?.loginSignals?.entryTexts) ? profile.loginSignals.entryTexts : ['Sign in', 'Log in', 'Login', 'Sign up'];
  const signInCandidates = entryTexts.map(text => page.getByText(text, { exact: false })).concat([
    page.getByRole('button', { name: createRegexFromPattern(profile?.loginSignals?.entryRolePattern, 'i') || /sign in|log in|login|sign up/i }),
    page.getByRole('link', { name: createRegexFromPattern(profile?.loginSignals?.entryRolePattern, 'i') || /sign in|log in|login|sign up/i }),
    page.locator(`text=/${profile?.loginSignals?.entryRolePattern || 'sign in|log in|login|sign up'}/i`).first(),
  ]);

  if (await visible(emailInput)) return { found: true, label: 'Enter email 输入框' };
  if (await visible(continueWithEmailButton)) return { found: true, label: 'Continue with email 按钮' };
  for (const candidate of signInCandidates) {
    if (await visible(candidate.first())) return { found: true, label: 'Sign in / Log in / Sign up 入口' };
  }
  return { found: false, label: '' };
}

async function recoverDreaminaErrorModal(page, log, prefix, account, proxy, config) {
  const refreshButton = page.getByRole('button', { name: /refresh/i }).first();
  const errorText = page.getByText(/something went wrong/i).first();
  const retryText = page.getByText(/refresh the page and try again/i).first();
  const hasError = await visible(errorText) || await visible(retryText) || await visible(refreshButton);
  if (!hasError) return false;
  logTaskStage(2, account, proxy, '检测到异常弹窗', '准备刷新页面恢复');
  logWarn('Dreamina 页面出现 Something went wrong / Refresh 弹窗，准备自动恢复');
  await capture(page, 'dreamina-error-modal', prefix, config);
  if (await visible(refreshButton)) {
    await humanPause(page, config, 800, 1500);
    await refreshButton.click().catch(() => {});
    const postErrorRecoveryWaitMs = resolveModeWait(config, 'runPostErrorRecoveryWaitMs', 'testPostErrorRecoveryWaitMs', 4000);
    if (postErrorRecoveryWaitMs > 0) await page.waitForTimeout(postErrorRecoveryWaitMs);
  } else {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
    const postErrorRecoveryWaitMs = resolveModeWait(config, 'runPostErrorRecoveryWaitMs', 'testPostErrorRecoveryWaitMs', 4000);
    if (postErrorRecoveryWaitMs > 0) await page.waitForTimeout(postErrorRecoveryWaitMs);
  }
  await capture(page, 'dreamina-error-modal-recovered', prefix, config);
  return true;
}

async function waitForDreaminaLoginSignals(page, log, prefix, account, proxy, options = {}) {
  const stages = [{ seconds: 20, intervalMs: 1000 }, { seconds: 20, intervalMs: 1500 }, { seconds: 20, intervalMs: 2000 }];
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
      await preprocessDreaminaOverlays(page, log, prefix, options.config);
      const recovered = await recoverDreaminaErrorModal(page, log, prefix, account, proxy, options.config);
      if (recovered) {
        recoveryCount += 1;
        recoveryBonusLeftMs += recoveryBonusMs;
        logWarn(`Dreamina 异常恢复次数：${recoveryCount}/${maxRecoveries} | 本次顺延 ${Math.round(recoveryBonusMs / 1000)} 秒 | 剩余顺延 ${Math.round(recoveryBonusLeftMs / 1000)} 秒`);
        if (recoveryCount > maxRecoveries) throw new Error(`Dreamina 异常恢复次数超限：${recoveryCount}/${maxRecoveries}`);
        await preprocessDreaminaOverlays(page, log, prefix, options.config);
      }
      const signal = await hasDreaminaLoginSignals(page);
      if (signal.found) {
        logSuccess(`Dreamina 登录信号已出现：${signal.label}（第 ${round} 轮，已等待 ${Math.round(elapsedMs / 1000)} 秒，恢复 ${recoveryCount} 次）`);
        return signal;
      }
      if (round % 5 === 0) {
        logInfo(`Dreamina 登录入口仍未出现：已等待 ${Math.round(elapsedMs / 1000)} 秒，当前间隔=${intervalMs}ms，恢复次数=${recoveryCount}/${maxRecoveries}，剩余顺延=${Math.round(recoveryBonusLeftMs / 1000)}秒`);
        await capture(page, `dreamina-wait-login-${round}`, prefix, options.config);
      }
      await page.waitForTimeout(intervalMs);
      elapsedMs += intervalMs;
    }
  }

  while (recoveryBonusLeftMs > 0) {
    round += 1;
    await preprocessDreaminaOverlays(page, log, prefix, options.config);
    const recovered = await recoverDreaminaErrorModal(page, log, prefix, account, proxy, options.config);
    if (recovered) {
      recoveryCount += 1;
      recoveryBonusLeftMs += recoveryBonusMs;
      logWarn(`Dreamina 异常恢复次数：${recoveryCount}/${maxRecoveries} | 本次顺延 ${Math.round(recoveryBonusMs / 1000)} 秒 | 剩余顺延 ${Math.round(recoveryBonusLeftMs / 1000)} 秒`);
      if (recoveryCount > maxRecoveries) throw new Error(`Dreamina 异常恢复次数超限：${recoveryCount}/${maxRecoveries}`);
      await preprocessDreaminaOverlays(page, log, prefix, options.config);
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
      await capture(page, `dreamina-wait-login-bonus-${round}`, prefix, options.config);
    }
  }
  return { found: false, label: '' };
}

function createPageDiagnostics(prefix) {
  return {
    prefix,
    consoleMessages: [],
    pageErrors: [],
    requestFailures: [],
    responseErrors: [],
  };
}

function pushLimited(list, item, limit = 40) {
  if (!Array.isArray(list)) return;
  list.push(item);
  if (list.length > limit) list.shift();
}

function attachPageDiagnostics(page, diagnostics) {
  if (!page || !diagnostics || page.__dreaminaDiagnosticsAttached) return diagnostics;
  page.__dreaminaDiagnosticsAttached = true;

  page.on('console', message => {
    const type = String(message?.type?.() || 'log').toUpperCase();
    const text = String(message?.text?.() || '').trim();
    if (!text) return;
    if (!/error|warning|failed|refused|blocked|cors|chunk|load/i.test(`${type} ${text}`)) return;
    pushLimited(diagnostics.consoleMessages, `[${type}] ${text}`);
  });

  page.on('pageerror', error => {
    pushLimited(diagnostics.pageErrors, String(error?.stack || error?.message || error || '').trim());
  });

  page.on('requestfailed', request => {
    const url = String(request?.url?.() || '');
    const failureText = String(request?.failure?.()?.errorText || '').trim();
    pushLimited(diagnostics.requestFailures, `${failureText || 'REQUEST_FAILED'} ${url}`.trim());
  });

  page.on('response', response => {
    try {
      const status = Number(response?.status?.() || 0);
      if (status >= 400) {
        const url = String(response?.url?.() || '');
        pushLimited(diagnostics.responseErrors, `HTTP_${status} ${url}`);
      }
    } catch (_) {}
  });

  return diagnostics;
}

async function dumpPageDiagnostics(page, diagnostics, account, proxy, prefix, reason = 'UNKNOWN') {
  if (!diagnostics) return '';
  const bodyText = (await page.locator('body').innerText().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  const html = await page.content().catch(() => '');
  const title = await page.title().catch(() => '');
  const payload = {
    reason,
    account: account?.email || '',
    proxy: proxy?.server || 'NO_PROXY',
    url: page.url(),
    title,
    bodyTextLength: bodyText.length,
    bodyPreview: bodyText.slice(0, 1000),
    htmlLength: String(html || '').length,
    consoleMessages: diagnostics.consoleMessages,
    pageErrors: diagnostics.pageErrors,
    requestFailures: diagnostics.requestFailures,
    responseErrors: diagnostics.responseErrors,
  };
  const filePath = path.join(STORAGE_DIR, `${sanitizeName(account?.email || 'unknown')}-${prefix}-diagnostics.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8').catch(() => {});
  return filePath;
}

async function openDreaminaWithRetry(page, log, prefix, account, proxy, config, maxAttempts = 3, diagnostics = null) {
  const targetUrl = getDreaminaHomeUrl(config);
  let lastOpenError = '';
  logTaskStage(2, account, proxy, '打开 Dreamina', targetUrl);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      log(`Dreamina 打开尝试 ${attempt}/${maxAttempts}`);
      logInfo(`阶段 2.${attempt}：尝试进入 Dreamina 首页：${targetUrl}`);

      const navStartedAt = Date.now();
      if (attempt === 1) await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      else await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      logInfo(`openDreamina.navDone | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - navStartedAt}ms | mode=${attempt === 1 ? 'goto' : 'reload'} | url=${page.url()}`);

      const captureStartedAt = Date.now();
      await capture(page, `dreamina-open-${attempt}`, prefix, config);
      logInfo(`openDreamina.captureDone | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - captureStartedAt}ms`);

      const whiteScreenCheckStartedAt = Date.now();
      if (await detectDreaminaWhiteScreen(page, account, proxy, prefix, config)) {
        const diagnosticsPath = await dumpPageDiagnostics(page, diagnostics, account, proxy, prefix, 'DREAMINA_WHITE_SCREEN');
        if (diagnosticsPath) logWarn(`白屏诊断已写出：${path.basename(diagnosticsPath)}`);
        throw new Error('DREAMINA_WHITE_SCREEN');
      }
      logInfo(`openDreamina.whiteScreenCheckDone | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - whiteScreenCheckStartedAt}ms`);

      const deadPageCheckStartedAt = Date.now();
      if (await detectDreaminaFirstLoadDeadPage(page, prefix, config, diagnostics)) {
        const diagnosticsPath = await dumpPageDiagnostics(page, diagnostics, account, proxy, prefix, 'DREAMINA_FIRST_LOAD_DEAD_PAGE');
        logWarn('Dreamina 首轮加载后仍无任何正常页面元素，且伴随资源/脚本失败证据，判定当前代理/页面死链');
        if (diagnosticsPath) {
          const diagName = path.basename(diagnosticsPath);
          logWarn(`死页诊断已写出：${diagName}`);
          throw new Error(`DREAMINA_FIRST_LOAD_DEAD_PAGE|debug=${diagName}`);
        }
        throw new Error('DREAMINA_FIRST_LOAD_DEAD_PAGE');
      }
      logInfo(`openDreamina.deadPageCheckDone | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - deadPageCheckStartedAt}ms`);

      const overlayStartedAt = Date.now();
      await preprocessDreaminaOverlays(page, log, prefix, config);
      logInfo(`openDreamina.overlayDone | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - overlayStartedAt}ms`);

      const recoveryConfig = resolveDreaminaRecoveryConfig(config);
      const loginSignalStages = resolveLoginSignalStages(config);
      logInfo(`openDreamina.loginSignalStages | mode=${resolveRunMode(config)} | stages=${JSON.stringify(loginSignalStages)}`);
      const waitSignalStartedAt = Date.now();
      const signal = await waitForDreaminaLoginSignals(page, log, prefix, account, proxy, {
        stages: loginSignalStages,
        maxRecoveries: recoveryConfig.maxRecoveries,
        recoveryBonusMs: recoveryConfig.recoveryBonusMs,
        config,
      });
      logInfo(`openDreamina.loginSignalDone | attempt=${attempt}/${maxAttempts} | elapsed=${Date.now() - waitSignalStartedAt}ms | found=${signal.found ? 'Y' : 'N'} | label=${signal.label || 'NA'}`);

      if (signal.found) {
        log(`Dreamina 登录信号出现：${signal.label}`);
        logInfo(`openDreamina.attemptReady | attempt=${attempt}/${maxAttempts} | totalElapsed=${Date.now() - attemptStartedAt}ms`);
        logSuccess('Dreamina 首页已进入可操作状态');
        return;
      }
    } catch (error) {
      lastOpenError = String(error?.message || 'UNKNOWN');
      log(`Dreamina 打开失败: ${error.message}`);
      logWarn(`Dreamina 打开异常，准备重试：${error.message} | attemptElapsed=${Date.now() - attemptStartedAt}ms`);
    }
  }
  throw new Error(`DREAMINA_OPEN_RETRY_EXHAUSTED|last=${lastOpenError || 'UNKNOWN'}`);
}

async function ensureDreaminaEmailLoginForm(page, log, prefix, account, proxy, config) {
  const profile = loadDreaminaRegisterProfile();
  const signupPhaseStartedAt = Date.now();
  logTaskStage(2, account, proxy, '进入邮箱注册表单');

  const overlayStartedAt = Date.now();
  await preprocessDreaminaOverlays(page, log, prefix, config);
  logInfo(`submitSignup.overlayPrepassDone | elapsed=${Date.now() - overlayStartedAt}ms`);

  const emailInput = page.getByRole('textbox', { name: profile?.signupForm?.emailInputRoleName || 'Enter email' });
  const emailVisibleStartedAt = Date.now();
  if (await visible(emailInput)) {
    logInfo(`submitSignup.emailInputAlreadyVisible | elapsed=${Date.now() - emailVisibleStartedAt}ms | totalElapsed=${Date.now() - signupPhaseStartedAt}ms`);
    return;
  }

  const continueWithEmailText = String(profile?.loginSignals?.continueWithEmailText || 'Continue with email');
  const continueWithEmailButton = page.locator('div').filter({ hasText: new RegExp(`^${continueWithEmailText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).nth(1);
  const continueVisibleStartedAt = Date.now();
  if (await visible(continueWithEmailButton)) {
    logInfo(`submitSignup.continueWithEmailVisible | elapsed=${Date.now() - continueVisibleStartedAt}ms`);
    logInfo('检测到 Continue with email，准备点击进入邮箱注册');
    await humanPause(page, config, 1000, 2000);
    const clickContinueStartedAt = Date.now();
    await continueWithEmailButton.click();
    logInfo(`submitSignup.clickContinueWithEmailDone | elapsed=${Date.now() - clickContinueStartedAt}ms`);
    const waitEmailStartedAt = Date.now();
    await emailInput.waitFor({ state: 'visible', timeout: 45000 });
    logInfo(`submitSignup.waitEmailInputDone | elapsed=${Date.now() - waitEmailStartedAt}ms | totalElapsed=${Date.now() - signupPhaseStartedAt}ms`);
    return;
  }

  const entryTexts = Array.isArray(profile?.loginSignals?.entryTexts) ? profile.loginSignals.entryTexts : ['Sign in', 'Log in', 'Login', 'Sign up'];
  const entryPattern = createRegexFromPattern(profile?.loginSignals?.entryRolePattern, 'i') || /sign in|log in|login|sign up/i;
  const signInCandidates = entryTexts.map(text => page.getByText(text, { exact: false })).concat([
    page.getByRole('button', { name: entryPattern }),
    page.getByRole('link', { name: entryPattern }),
    page.locator(`text=/${profile?.loginSignals?.entryRolePattern || 'sign in|log in|login|sign up'}/i`).first(),
  ]);

  const scanEntryStartedAt = Date.now();
  for (const candidate of signInCandidates) {
    const target = candidate.first();
    if (await visible(target)) {
      logInfo(`submitSignup.loginEntryVisible | elapsed=${Date.now() - scanEntryStartedAt}ms`);
      logInfo('检测到 Sign in / Log in / Sign up，准备点击进入注册入口');
      await humanPause(page, config, 1000, 2000);
      const clickEntryStartedAt = Date.now();
      await target.click();
      logInfo(`submitSignup.clickLoginEntryDone | elapsed=${Date.now() - clickEntryStartedAt}ms`);
      const postSignEntryWaitMs = resolveModeWait(config, 'runPostSignEntryWaitMs', 'testPostSignEntryWaitMs', 4000);
      if (postSignEntryWaitMs > 0) {
        const postEntryWaitStartedAt = Date.now();
        await page.waitForTimeout(postSignEntryWaitMs);
        logInfo(`submitSignup.postSignEntryWaitDone | elapsed=${Date.now() - postEntryWaitStartedAt}ms | configured=${postSignEntryWaitMs}ms`);
      } else {
        logInfo(`submitSignup.postSignEntryWaitSkipped | configured=${postSignEntryWaitMs}ms`);
      }
      const secondOverlayStartedAt = Date.now();
      await preprocessDreaminaOverlays(page, log, prefix, config);
      logInfo(`submitSignup.overlayPostEntryDone | elapsed=${Date.now() - secondOverlayStartedAt}ms`);
      const continueAfterEntryVisibleStartedAt = Date.now();
      if (await visible(continueWithEmailButton)) {
        logInfo(`submitSignup.continueWithEmailAfterEntryVisible | elapsed=${Date.now() - continueAfterEntryVisibleStartedAt}ms`);
        logInfo('点击后出现 Continue with email，继续进入邮箱注册');
        await humanPause(page, config, 1000, 2000);
        const clickContinueStartedAt = Date.now();
        await continueWithEmailButton.click();
        logInfo(`submitSignup.clickContinueWithEmailAfterEntryDone | elapsed=${Date.now() - clickContinueStartedAt}ms`);
      }
      const waitEmailStartedAt = Date.now();
      await emailInput.waitFor({ state: 'visible', timeout: 45000 });
      logInfo(`submitSignup.waitEmailInputDone | elapsed=${Date.now() - waitEmailStartedAt}ms | totalElapsed=${Date.now() - signupPhaseStartedAt}ms`);
      return;
    }
  }
  throw new Error('未找到 Dreamina 登录/注册入口');
}

async function detectExistingAccount(page, prefix, config) {
  const profile = loadDreaminaRegisterProfile();
  const patterns = Array.isArray(profile?.existingAccountSignals?.patterns) ? profile.existingAccountSignals.patterns : [];
  const hints = Array.isArray(profile?.existingAccountSignals?.signInHints) ? profile.existingAccountSignals.signInHints : [];
  const emailErrorSelectors = [
    page.locator("[class*='error']").first(),
    page.locator("[class*='warning']").first(),
    page.locator(".lv_new_sign_in_panel_wide-tip").first(),
  ];

  for (const pattern of patterns) {
    const locator = getProfilePatternLocator(page, pattern);
    if (await visible(locator)) {
      await capture(page, 'dreamina-existing-account', prefix, config);
      return true;
    }
  }

  for (const hint of hints) {
    const locator = getProfilePatternLocator(page, hint);
    if (await visible(locator)) {
      await capture(page, 'dreamina-existing-account-hint', prefix, config);
      return true;
    }
  }

  for (const locator of emailErrorSelectors) {
    const text = (await locator.textContent().catch(() => '') || '').trim();
    if (/already exists|sign in to your account/i.test(text)) {
      await capture(page, 'dreamina-existing-account-inline', prefix, config);
      return true;
    }
  }

  return false;
}

async function detectSignupFailure(page, log, prefix, config) {
  if (await detectExistingAccount(page, prefix, config)) {
    log('检测到 Dreamina 已存在账号提示');
    logFail('注册页面出现已存在账号提示');
    return 'ACCOUNT_ALREADY_EXISTS';
  }

  const profile = loadDreaminaRegisterProfile();
  const rules = Array.isArray(profile?.signupFailureRules) ? profile.signupFailureRules : [];
  for (const rule of rules) {
    const locator = getProfilePatternLocator(page, rule.pattern);
    if (await visible(locator)) {
      await capture(page, `dreamina-signup-failed-${String(rule.reason || 'unknown').toLowerCase()}`, prefix, config);
      log(`检测到 Dreamina 注册失败提示：${rule.label || rule.reason}`);
      logFail(`注册页面出现失败提示：${rule.label || rule.reason}`);
      return String(rule.reason || '').trim();
    }
  }
  return '';
}

async function ensureBirthdayInputsReachable(page, account, proxy, prefix, timeoutMs = 20000, config = {}) {
  const profile = loadDreaminaRegisterProfile();
  const yearInput = page.getByRole('textbox', { name: profile?.birthday?.yearInputRoleName || 'Year' });
  const monthDropdown = page.getByText(profile?.birthday?.monthText || 'Month').last();
  const dayDropdown = page.getByText(profile?.birthday?.dayText || 'Day', { exact: true }).last();
  const birthdayNextButton = page.locator(profile?.birthday?.nextButtonSelector || 'button.lv_new_sign_in_panel_wide-birthday-next').first();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await visible(yearInput) && await visible(monthDropdown) && await visible(dayDropdown) && await visible(birthdayNextButton)) {
      return { yearInput, monthDropdown, dayDropdown, nextButton: birthdayNextButton };
    }
    await page.waitForTimeout(500);
  }
  logTaskStage(4, account, proxy, '生日页未就绪', `等待超时=${timeoutMs}ms`);
  logWarn('验证码提交后未能进入生日输入阶段，判定当前代理/链路不可用');
  await capture(page, 'dreamina-birthday-unreachable', prefix, config);
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
    const interestingCookies = cookies.filter(cookie => /sessionid|sid_|sid$|ttwid|passport|msToken/i.test(String(cookie?.name || ''))).map(cookie => `${cookie.name}@${cookie.domain}`);
    const hintText = interestingCookies.join(', ') || 'NO_INTERESTING_COOKIES';
    if (hintText !== lastHintText) {
      lastHintText = hintText;
      logTaskStage(5, account, proxy, '等待 sessionid cookie', hintText);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const debugPath = path.join(STORAGE_DIR, `${sanitizeName(account.email)}-${prefix}-session-cookie-timeout.json`);
  await fs.promises.writeFile(debugPath, JSON.stringify({ account: account.email, proxy: proxy?.server || 'NO_PROXY', reason: 'SESSIONID_COOKIE_NOT_FOUND', cookies: lastCookieSnapshot }, null, 2), 'utf8').catch(() => {});
  throw new Error(`SESSIONID_COOKIE_NOT_FOUND|debug=${path.basename(debugPath)}|seen=${lastHintText || 'NO_INTERESTING_COOKIES'}`);
}

async function saveStorageState(context, account, attempt) {
  const safeName = sanitizeName(account.email);
  const filePath = path.join(STORAGE_DIR, `${safeName}-attempt${attempt}.json`);
  await context.storageState({ path: filePath });
  return filePath;
}

async function waitForVerificationCountdown(page, account, proxy, prefix, timeoutMs = 30000, config = {}) {
  const profile = loadDreaminaRegisterProfile();
  const countdownPatterns = Array.isArray(profile?.verification?.countdownPatterns) ? profile.verification.countdownPatterns : ['Resend code in\\s*\\d+s', 'resend code'];
  const countdownSelectors = Array.isArray(profile?.verification?.countdownClassSelectors) ? profile.verification.countdownClassSelectors : ["[class*='count'][class*='down']", "[class*='code-count']"];
  const countdownLocators = countdownPatterns.map(pattern => getProfilePatternLocator(page, pattern)).concat(countdownSelectors.map(selector => page.locator(selector).first()));
  const verificationInputCandidates = getVerificationInputCandidates(page, profile);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const locator of countdownLocators) {
      if (await visible(locator)) {
        const text = (await locator.textContent().catch(() => '') || '').trim();
        logTaskStage(3, account, proxy, '检测到验证码倒计时', text || 'Resend code in ...');
        await capture(page, 'verification-countdown-detected', prefix, config);
        return text || 'COUNTDOWN_VISIBLE';
      }
    }
    for (const locator of verificationInputCandidates) {
      if (await visible(locator)) {
        const placeholder = await locator.getAttribute('placeholder').catch(() => '');
        logTaskStage(3, account, proxy, '检测到验证码输入框', placeholder || 'verification input visible');
        await capture(page, 'verification-input-detected', prefix, config);
        return 'VERIFICATION_INPUT_VISIBLE';
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error('VERIFICATION_COUNTDOWN_NOT_FOUND');
}

async function waitForDreaminaPostRegisterReady(page, account, proxy, prefix, timeoutMs = 45000, config = {}) {
  const profile = loadDreaminaRegisterProfile();
  const selectors = Array.isArray(profile?.postRegisterReady?.selectors) ? profile.postRegisterReady.selectors : [];
  const texts = Array.isArray(profile?.postRegisterReady?.texts) ? profile.postRegisterReady.texts : [];
  const readyLocators = selectors.map(selector => page.locator(selector).first()).concat(texts.map(text => page.getByText(text, { exact: text === 'Canvas' ? true : false }).first()));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const locator of readyLocators) {
      if (await visible(locator)) {
        const text = (await locator.textContent().catch(() => '') || '').trim();
        logTaskStage(5, account, proxy, '检测到注册完成后的主页就绪信号', text || 'Dreamina home ready');
        await capture(page, 'dreamina-post-register-ready', prefix, config);
        return text || 'DREAMINA_HOME_READY';
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('DREAMINA_POST_REGISTER_READY_NOT_FOUND');
}

async function runRegisterTask({ account, proxy, config, attempt, workerId, windowBounds, resolvedExitIp, precheckLevel = '', proxySpeedTier = '' }) {
  const prefix = `${sanitizeName(account.email)}-attempt${attempt}`;
  const log = makeLogger(prefix);
  const stageTimer = createStageTimer();
  stageTimer.mark('total');
  let browser;
  let dreaminaPage;
  let context;
  try {
    const launchOptions = { headless: Boolean(config.headless), slowMo: resolveSlowMo(config) };
    if (!launchOptions.headless && windowBounds) {
      launchOptions.args = [`--window-size=${windowBounds.width},${windowBounds.height}`, `--window-position=${windowBounds.x},${windowBounds.y}`];
    }
    if (proxy) {
      launchOptions.proxy = { server: proxy.server, username: proxy.username, password: proxy.password };
    }

    browser = await chromium.launch(launchOptions);
    if (!Boolean(config.headless) && windowBounds) await runPowerShellWindowLayout(browser, windowBounds, workerId, account);

    const screenshotEnabled = shouldCaptureScreenshots(config);
    const pauseRange = resolveHumanPauseRange(config);
    const profileSummary = summarizeProfile(loadDreaminaRegisterProfile());
    logInfo(`运行模式：${resolveRunMode(config)} | 截图开关：${screenshotEnabled ? 'ON' : 'OFF'} | slowMo=${launchOptions.slowMo} | humanPause=${pauseRange.min}-${pauseRange.max}ms | dreaminaHomeUrl=${getDreaminaHomeUrl(config)} | precheck=${precheckLevel || 'NA'} | proxySpeedTier=${proxySpeedTier || 'UNKNOWN'}`);
    logInfo(`Dreamina Profile 摘要：entryTexts=${profileSummary.loginEntryTexts} | overlays=${profileSummary.overlayButtons} | signupFailures=${profileSummary.signupFailureRules} | verificationPatterns=${profileSummary.verificationCountdownPatterns} | verificationInputs=${profileSummary.verificationInputSelectors}`);

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

    const blockedResourceTypes = resolveBlockedResourceTypes(config);
    if (blockedResourceTypes.size) {
      await context.route('**/*', async route => {
        const resourceType = String(route.request().resourceType() || '').toLowerCase();
        if (blockedResourceTypes.has(resourceType)) {
          return route.abort();
        }
        return route.continue();
      });
      logInfo(`资源拦截已启用 | mode=${resolveRunMode(config)} | blocked=${Array.from(blockedResourceTypes).join(',')}`);
    } else {
      logInfo(`资源拦截未启用 | mode=${resolveRunMode(config)}`);
    }

    const exitIp = String(resolvedExitIp || 'UNKNOWN_EXIT_IP');
    logInfo(`当前浏览器模式：有头（headless=${Boolean(config.headless)}）`);
    logInfo(`当前线程：${workerId || 'NA'}`);
    logInfo(`当前账号：${account.email}`);
    logInfo(`当前代理：${proxy?.server || 'NO_PROXY'} | 代理速度档：${proxySpeedTier || 'UNKNOWN'} | 预检级别：${precheckLevel || 'NA'}`);
    logInfo(`当前出口IP：${exitIp}`);
    if (windowBounds) logInfo(`当前窗口：${windowBounds.width}x${windowBounds.height} @ (${windowBounds.x}, ${windowBounds.y})`);

    const birth = randomBirthDate(1980, 2008);
    const profile = loadDreaminaRegisterProfile();

    logTaskStage(1, account, proxy, '打开 Dreamina', `出口IP=${exitIp}`);
    log('开始打开 Dreamina');
    dreaminaPage = await context.newPage();
    const diagnostics = attachPageDiagnostics(dreaminaPage, createPageDiagnostics(prefix));
    stageTimer.mark('openDreamina');
    await openDreaminaWithRetry(dreaminaPage, log, prefix, account, proxy, config, 3, diagnostics);
    await ensureDreaminaEmailLoginForm(dreaminaPage, log, prefix, account, proxy, config);
    stageTimer.end('openDreamina');

    logTaskStage(2, account, proxy, '先进入 Sign up，再填写邮箱密码并 Continue');
    stageTimer.mark('submitSignup');
    const submitSignupStartedAt = Date.now();
    const dreaminaEmailInput = dreaminaPage.getByRole('textbox', { name: profile?.signupForm?.emailInputRoleName || 'Enter email' });
    const dreaminaPasswordInput = dreaminaPage.getByRole('textbox', { name: profile?.signupForm?.passwordInputRoleName || 'Enter password' });

    const signUpText = dreaminaPage.getByText(profile?.signupForm?.signUpText || 'Sign up');
    if (await visible(signUpText)) {
      logInfo('当前流程调整为：先点击 Sign up，再填写邮箱密码');
      await humanPause(dreaminaPage, config, 1000, 2200);
      const clickSignUpStartedAt = Date.now();
      await signUpText.click();
      logInfo(`submitSignup.clickSignUpDone | elapsed=${Date.now() - clickSignUpStartedAt}ms`);
    } else {
      logInfo('submitSignup.signUpClickSkipped | reason=signUpTextNotVisible');
    }

    const waitEmailStartedAt = Date.now();
    await dreaminaEmailInput.waitFor({ state: 'visible', timeout: 30000 });
    logInfo(`submitSignup.waitEmailInputDone | elapsed=${Date.now() - waitEmailStartedAt}ms`);
    const fillEmailStartedAt = Date.now();
    await dreaminaEmailInput.fill(account.email);
    logInfo(`submitSignup.fillEmailDone | elapsed=${Date.now() - fillEmailStartedAt}ms`);

    const waitPasswordStartedAt = Date.now();
    await dreaminaPasswordInput.waitFor({ state: 'visible', timeout: 30000 });
    logInfo(`submitSignup.waitPasswordInputDone | elapsed=${Date.now() - waitPasswordStartedAt}ms`);
    const fillPasswordStartedAt = Date.now();
    await dreaminaPasswordInput.fill(account.password);
    logInfo(`submitSignup.fillPasswordDone | elapsed=${Date.now() - fillPasswordStartedAt}ms`);

    const continueButton = dreaminaPage.getByRole('button', { name: profile?.signupForm?.continueButtonRoleName || 'Continue' });
    await continueButton.waitFor({ state: 'visible', timeout: 30000 });
    await humanPause(dreaminaPage, config, 1200, 2200);
    const verificationTriggeredAtMs = Date.now();
    const clickContinueStartedAt = Date.now();
    await continueButton.click();
    logInfo(`submitSignup.clickContinueDone | elapsed=${Date.now() - clickContinueStartedAt}ms | totalElapsed=${Date.now() - submitSignupStartedAt}ms`);

    const verificationWaitBudgetMs = Number(config.firstmailApiMaxPollAttempts || config.waitMailAttempts || 10) * Number(config.waitMailIntervalMs || 2500);
    logWarn(`Continue 已点击，后台并发预热 Firstmail API 拉码；若页面立即出现“不允许注册 / Try again later”，将优先按注册拒绝立即结束 | 预计最大等待≈${Math.round(verificationWaitBudgetMs / 1000)}秒`);
    const verificationCodePromise = fetchVerificationCodeViaApi(account, proxy, config, log, verificationTriggeredAtMs);

    logInfo(`=== NEW_FLOW_AFTER_CONTINUE === | url=${dreaminaPage.url()}`);
    logInfo(`Continue 后零检查直通：跳过所有额外判定，直接进入统一验证码页等待逻辑 | url=${dreaminaPage.url()}`);

    // Continue 后第一批安全检查（2026-04-11 回补版）：
    // 仅做一次、非循环、非阻塞快查，避免恢复旧的结果判定窗口后再次卡住主流程。
    // 当前只回补两个高价值硬失败：已存在账号 / Try again later。
    const quickFailureBodyText = await dreaminaPage.evaluate(() => String(document?.body?.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
    if (/An account with this email already exists|Enter your password to sign in to your account/i.test(quickFailureBodyText)) {
      stageTimer.end('submitSignup');
      stageTimer.end('total');
      const timings = stageTimer.snapshot();
      logInfo('Continue 后第一批安全检查命中已存在账号，当前浏览器立即结束');
      logInfo(`阶段耗时：${formatStageTimings(timings)}`);
      return { success: false, reason: 'ACCOUNT_ALREADY_EXISTS', timings };
    }
    if (/Couldn't sign up\. Try again later\.|Try again later/i.test(quickFailureBodyText)) {
      stageTimer.end('submitSignup');
      stageTimer.end('total');
      const timings = stageTimer.snapshot();
      logWarn('Continue 后第一批安全检查命中 Try again later，按当前 IP/代理已被拉黑处理，当前浏览器立即结束，不再等待验证码');
      logInfo(`阶段耗时：${formatStageTimings(timings)}`);
      return { success: false, reason: 'SIGNUP_REJECTED_IP_BANNED', timings };
    }
    logInfo('Continue 后第一批安全检查通过，继续进入统一验证码页等待逻辑');
    stageTimer.end('submitSignup');

    stageTimer.mark('waitVerificationStage');
    logInfo('即将进入 waitForVerificationCountdown，等待验证码页正式确认');
    const countdownText = await waitForVerificationCountdown(
      dreaminaPage,
      account,
      proxy,
      prefix,
      resolveModeTimeout(config, 'runVerificationCountdownWaitMs', 'testVerificationCountdownWaitMs', Number(config.verificationCountdownWaitMs || 30000)),
      config,
    );
    stageTimer.end('waitVerificationStage');
    logWarn(`已进入验证码页，直接接收后台预热中的 Firstmail API 拉码结果 | signal=${countdownText} | 预计最大等待≈${Math.round(verificationWaitBudgetMs / 1000)}秒`);
    log(`检测到验证码阶段信号，开始接收 Firstmail API 拉码结果：${countdownText}`);
    logTaskStage(3, account, proxy, '通过 Firstmail API 拉验证码', `${countdownText} | preheated=true | maxWait≈${Math.round(verificationWaitBudgetMs / 1000)}s`);
    await dreaminaPage.bringToFront();
    const codeInputCandidates = getVerificationInputCandidates(dreaminaPage, profile);
    logInfo(`开始选择验证码输入候选 | candidates=${codeInputCandidates.length}`);
    let codeInput = null;
    let codeInputIndex = -1;
    for (let i = 0; i < codeInputCandidates.length; i++) {
      const locator = codeInputCandidates[i];
      if (await visible(locator)) {
        codeInput = locator;
        codeInputIndex = i;
        break;
      }
    }
    if (!codeInput) throw new Error('VERIFICATION_INPUT_NOT_FOUND');
    const selectedCodeInputMeta = {
      index: codeInputIndex,
      className: await codeInput.evaluate(node => String(node.className || '')).catch(() => 'NA'),
      tagName: await codeInput.evaluate(node => String(node.tagName || '')).catch(() => 'NA'),
      type: await codeInput.getAttribute('type').catch(() => 'NA'),
      maxLength: await codeInput.getAttribute('maxlength').catch(() => 'NA'),
      autocomplete: await codeInput.getAttribute('autocomplete').catch(() => 'NA'),
      inputmode: await codeInput.getAttribute('inputmode').catch(() => 'NA'),
    };
    logInfo(`验证码输入候选命中 | ${JSON.stringify(selectedCodeInputMeta)}`);
    logInfo(`selectedVerificationTarget=${selectedCodeInputMeta.tagName || 'NA'}|class=${selectedCodeInputMeta.className || 'NA'}|type=${selectedCodeInputMeta.type || 'NA'}|maxLength=${selectedCodeInputMeta.maxLength || 'NA'}|autocomplete=${selectedCodeInputMeta.autocomplete || 'NA'}|inputmode=${selectedCodeInputMeta.inputmode || 'NA'}`);
    await codeInput.waitFor({ state: 'visible', timeout: 30000 });

    const verificationCodeRetryMaxAttempts = Math.max(1, Number(config.verificationCodeRetryMaxAttempts || 3));
    const usedCodes = new Set();
    let currentCodePromise = verificationCodePromise;
    let acceptedCodeResult = null;
    let birthdayFields = null;

    logTaskStage(4, account, proxy, '回填验证码和生日');
    stageTimer.mark('fetchVerificationCode');
    stageTimer.mark('submitCodeAndBirthday');
    const submitCodeAndBirthdayStartedAt = Date.now();

    for (let verificationTry = 1; verificationTry <= verificationCodeRetryMaxAttempts; verificationTry++) {
      const codeResult = await currentCodePromise;
      const code = String(codeResult?.code || '').trim();
      if (!code) {
        throw new Error('FIRSTMAIL_API_EMPTY_CODE');
      }
      if (usedCodes.has(code)) {
        logWarn(`本轮收到重复验证码，继续等待下一封 latest | code=${code} | try=${verificationTry}/${verificationCodeRetryMaxAttempts}`);
        currentCodePromise = fetchVerificationCodeViaApi(account, proxy, config, log, verificationTriggeredAtMs);
        continue;
      }

      usedCodes.add(code);
      acceptedCodeResult = codeResult;
      const messageSummary = [String(codeResult?.message?.subject || '').trim(), String(codeResult?.message?.snippet || codeResult?.message?.text || '').trim()].filter(Boolean).join(' | ').slice(0, 200);
      logSuccess(`验证码提取成功：${code}`);
      if (codeResult?.matchMode) logInfo(`验证码命中模式：${codeResult.matchMode}`);
      if (messageSummary) logInfo(`验证码来源邮件摘要：${messageSummary}`);
      if (codeResult?.messageTs) logInfo(`验证码来源邮件时间戳：${codeResult.messageTs} | 触发时间戳：${verificationTriggeredAtMs}`);

      const pageClosedBeforeFill = typeof dreaminaPage.isClosed === 'function' ? dreaminaPage.isClosed() : false;
      const visibleVerificationInputs = await dreaminaPage.locator("input[maxlength='1'], input[inputmode='numeric'], input[maxlength='6'], input[autocomplete='one-time-code']").evaluateAll((nodes) => {
        return nodes
          .map((node, index) => ({
            index,
            visible: !!(node instanceof HTMLElement && node.offsetParent),
            maxLength: String(node.getAttribute('maxlength') || ''),
            inputMode: String(node.getAttribute('inputmode') || ''),
            type: String(node.getAttribute('type') || ''),
            value: String(node.value || ''),
          }))
          .filter(item => item.visible);
      }).catch(() => []);
      logInfo(`即将进入回填验证码分支 | pageClosed=${pageClosedBeforeFill} | url=${dreaminaPage.url()} | visibleVerificationInputs=${visibleVerificationInputs.length}`);
      if (visibleVerificationInputs.length) {
        logInfo(`验证码输入框快照：${JSON.stringify(visibleVerificationInputs.slice(0, 8))}`);
      }

      logInfo(`准备回填验证码 | code=${code} | try=${verificationTry}/${verificationCodeRetryMaxAttempts}`);
      const enterVerificationStartedAt = Date.now();
      const verificationInputMode = await enterVerificationCode(dreaminaPage, codeInput, code, logInfo);
      const codeInputValue = await codeInput.inputValue().catch(() => '');
      const pageClosedAfterFill = typeof dreaminaPage.isClosed === 'function' ? dreaminaPage.isClosed() : false;
      logInfo(`验证码输入方式：${verificationInputMode} | 主输入框当前值：${codeInputValue || '[EMPTY]'} | pageClosedAfterFill=${pageClosedAfterFill}`);
      logInfo(`verificationFillStrategy=${verificationInputMode} | verificationCodeLength=${code.length} | verificationInputValueAfterFill=${codeInputValue || '[EMPTY]'}`);
      logInfo(`submitCodeAndBirthday.enterVerificationDone | elapsed=${Date.now() - enterVerificationStartedAt}ms | try=${verificationTry}/${verificationCodeRetryMaxAttempts}`);

      try {
        const waitBirthdayStartedAt = Date.now();
        birthdayFields = await ensureBirthdayInputsReachable(
          dreaminaPage,
          account,
          proxy,
          prefix,
          resolveModeTimeout(config, 'runBirthdayStageTimeoutMs', 'testBirthdayStageTimeoutMs', Number(config.birthdayStageTimeoutMs || 20000)),
          config,
        );
        logInfo(`submitCodeAndBirthday.waitBirthdayReadyDone | elapsed=${Date.now() - waitBirthdayStartedAt}ms | try=${verificationTry}/${verificationCodeRetryMaxAttempts}`);
        break;
      } catch (error) {
        const postVerificationFailure = await detectPostVerificationFailure(dreaminaPage, profile, prefix, config);
        logInfo(`postVerificationFailure=${postVerificationFailure || 'NONE'} | birthdayReachable=false | verificationTry=${verificationTry}/${verificationCodeRetryMaxAttempts}`);
        if (postVerificationFailure === 'WRONG_VERIFICATION_CODE') {
          if (verificationTry >= verificationCodeRetryMaxAttempts) {
            throw new Error(`WRONG_VERIFICATION_CODE|code=${code}|attempt=${codeResult.attempt || 'NA'}|messageTs=${codeResult.messageTs || 'NA'}|retry=${verificationTry}/${verificationCodeRetryMaxAttempts}`);
          }
          logWarn(`验证码已失效或填写错误，准备清空并继续轮询 latest 新验证码 | code=${code} | retry=${verificationTry}/${verificationCodeRetryMaxAttempts}`);
          await codeInput.fill('').catch(() => {});
          logInfo('验证码输入框已清空，等待下一条 latest 验证码');
          currentCodePromise = fetchVerificationCodeViaApi(account, proxy, config, log, verificationTriggeredAtMs);
          continue;
        }

        if (postVerificationFailure === 'VERIFICATION_CODE_RATE_LIMITED') {
          logWarn('birthdayUnreachableReclassified=VERIFICATION_CODE_RATE_LIMITED');
          throw new Error('VERIFICATION_CODE_RATE_LIMITED');
        }

        if (postVerificationFailure === 'SIGNUP_REJECTED_IP_BANNED') {
          logWarn('birthdayUnreachableReclassified=SIGNUP_REJECTED_IP_BANNED');
          throw new Error('SIGNUP_REJECTED_IP_BANNED');
        }

        if (postVerificationFailure === 'ACCOUNT_ALREADY_EXISTS') {
          logWarn('birthdayUnreachableReclassified=ACCOUNT_ALREADY_EXISTS');
          throw new Error('ACCOUNT_ALREADY_EXISTS');
        }

        logWarn(`birthdayUnreachableReclassified=${error.message || 'BIRTHDAY_STAGE_UNREACHABLE_AFTER_CODE'}`);
        throw new Error(error.message || 'BIRTHDAY_STAGE_UNREACHABLE_AFTER_CODE');
      }
    }

    stageTimer.end('fetchVerificationCode');

    if (!birthdayFields || !acceptedCodeResult) {
      throw new Error('VERIFICATION_CODE_RETRY_EXHAUSTED');
    }

    const fillBirthdayStartedAt = Date.now();
    await birthdayFields.yearInput.fill(birth.year);
    await birthdayFields.monthDropdown.click();
    await dreaminaPage.getByRole('option', { name: birth.month }).click();
    await birthdayFields.dayDropdown.click();
    await dreaminaPage.getByRole('option', { name: birth.day, exact: true }).click();
    logInfo(`submitCodeAndBirthday.fillBirthdayDone | elapsed=${Date.now() - fillBirthdayStartedAt}ms`);
    const clickBirthdayNextStartedAt = Date.now();
    await birthdayFields.nextButton.waitFor({ state: 'visible', timeout: 30000 });
    await birthdayFields.nextButton.click();
    logInfo(`submitCodeAndBirthday.clickBirthdayNextDone | elapsed=${Date.now() - clickBirthdayNextStartedAt}ms | totalElapsed=${Date.now() - submitCodeAndBirthdayStartedAt}ms`);
    stageTimer.end('submitCodeAndBirthday');

    stageTimer.mark('waitPostRegisterReady');
    const waitPostRegisterReadyStartedAt = Date.now();
    const readyText = await waitForDreaminaPostRegisterReady(
      dreaminaPage,
      account,
      proxy,
      prefix,
      resolveModeTimeout(config, 'runPostRegisterReadyTimeoutMs', 'testPostRegisterReadyTimeoutMs', Number(config.postRegisterReadyTimeoutMs || 45000)),
      config,
    );
    stageTimer.end('waitPostRegisterReady');
    logInfo(`postBirthdayNext.waitPostRegisterReadyDone | elapsed=${Date.now() - waitPostRegisterReadyStartedAt}ms | readyText=${readyText}`);
    stageTimer.mark('waitSessionCookie');
    const waitSessionCookieStartedAt = Date.now();
    const detectedSessionId = await waitForSessionIdCookie(
      context,
      account,
      proxy,
      prefix,
      resolveModeTimeout(config, 'runSessionIdCookieTimeoutMs', 'testSessionIdCookieTimeoutMs', Number(config.sessionIdCookieTimeoutMs || 60000)),
    );
    stageTimer.end('waitSessionCookie');
    logInfo(`postBirthdayNext.waitSessionCookieDone | elapsed=${Date.now() - waitSessionCookieStartedAt}ms | detected=${detectedSessionId || 'NA'}`);

    stageTimer.mark('saveStorageState');
    const finalStoragePath = path.join(STORAGE_DIR, `${sanitizeName(account.email)}-attempt${attempt}-user.json`);
    await context.storageState({ path: finalStoragePath });
    const userStorageState = JSON.parse(await fs.promises.readFile(finalStoragePath, 'utf8'));
    const storagePath = await saveStorageState(context, account, attempt);
    stageTimer.end('saveStorageState');
    stageTimer.end('total');
    const sessionId = await extractSessionIdFromStorageState(userStorageState) || detectedSessionId;
    const timings = stageTimer.snapshot();
    logTaskStage(5, account, proxy, '保存登录态', `${readyText} | userJson=${path.basename(finalStoragePath)}`);
    logSuccess('账号注册流程执行成功，已保存登录态');
    logInfo(`登录态文件：${storagePath}`);
    logInfo(`SessionID：${sessionId || '未提取到'}`);
    logInfo(`阶段耗时：${formatStageTimings(timings)}`);
    return { success: true, reason: 'SUCCESS', storagePath, sessionId, timings };
  } catch (error) {
    stageTimer.end('total');
    const timings = stageTimer.snapshot();
    logTaskStage(9, account, proxy, '任务异常');
    logFail(`任务异常：${error.message}`);
    logInfo(`阶段耗时：${formatStageTimings(timings)}`);
    if (dreaminaPage) await capture(dreaminaPage, 'failure-dreamina', prefix, config);
    return { success: false, reason: error.message || 'TASK_EXCEPTION', timings };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runRegisterTask };


