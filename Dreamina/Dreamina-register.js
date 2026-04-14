'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadLocalProxies, summarizeProxy } = require('../shared-proxy-precheck/local-proxy-loader');
const {
  logStageStart,
  logStageProgress,
  logStageSuccess,
  logStageFail,
  summarizeStageResult,
  createStageTimer,
  formatDurationMs,
} = require('../shared-stage-logger');
const { updateWorkerStatus } = require('../worker-status-tracker');

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
const dreaminaEntryTimelineAdapter = require('../shared-entry/dreamina/entry-adapter');

function buildDreaminaEntryStageAdapter(siteAdapter = {}, timelineAdapter = {}) {
  async function detectEntryDeadPage(page) {
    return await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const title = normalize(document.title || '');
      const bodyText = normalize(document.body?.innerText || '');
      const bodyHtml = String(document.body?.innerHTML || '');
      const rootChildCount = document.body?.children?.length || 0;
      const readyState = String(document.readyState || '');
      const bodyTextLength = bodyText.length;
      const bodyHtmlLength = bodyHtml.length;
      const whiteScreenLike = bodyTextLength === 0 && bodyHtmlLength < 2000;
      const deadPageLike = !title && bodyTextLength === 0 && rootChildCount <= 1;
      return {
        title,
        readyState,
        bodyTextLength,
        bodyHtmlLength,
        rootChildCount,
        whiteScreenLike,
        deadPageLike,
      };
    }).catch(() => ({
      title: '',
      readyState: '',
      bodyTextLength: 0,
      bodyHtmlLength: 0,
      rootChildCount: 0,
      whiteScreenLike: false,
      deadPageLike: false,
    }));
  }

  async function preprocessEntryOverlays(page) {
    const overlaySelectors = [
      'button[aria-label="Close"]',
      '[data-testid="close"]',
      '.close-button-bXf1SB',
      '.modal-close',
      '.dialog-close',
      '.popup-close',
    ];
    const overlayTexts = ['Accept all', 'Accept', 'I agree', 'Got it', 'Close', 'Skip', 'Not now', 'Maybe later'];

    for (const text of overlayTexts) {
      const button = page.getByRole('button', { name: text }).first();
      const visible = await button.isVisible().catch(() => false);
      if (visible) {
        await button.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
    }

    for (const selector of overlaySelectors) {
      const target = page.locator(selector).first();
      const visible = await target.isVisible().catch(() => false);
      if (visible) {
        await target.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
    }
  }

  async function prepareDreaminaLoginPage(page, runtime = {}, context = {}) {
    const currentUrl = String(page.url ? page.url() : '').trim();
    if (!/dreamina\.capcut\.com\/ai-tool\/login/i.test(currentUrl)) {
      return { ok: false, skipped: true, reason: 'NOT_LOGIN_PAGE' };
    }

    const checkboxLabel = page.locator('label.lv-checkbox.privacyCheck').first();
    const checkboxInput = page.locator('label.lv-checkbox.privacyCheck input[type="checkbox"]').first();
    const checkboxMask = page.locator('label.lv-checkbox.privacyCheck .lv-checkbox-mask').first();
    const signInText = page.getByText('Sign in').first();

    const signInVisible = await signInText.isVisible().catch(() => false);
    if (!signInVisible) {
      return { ok: false, skipped: true, reason: 'LOGIN_PAGE_SIGN_IN_NOT_VISIBLE' };
    }

    const getCheckboxState = async () => {
      const checkedByInput = await checkboxInput.isChecked().catch(() => false);
      const checkboxClass = await checkboxLabel.evaluate(node => String(node?.className || '')).catch(() => '');
      const checkedByLabelClass = /(^|\s)lv-checkbox-checked(\s|$)/.test(checkboxClass);
      return {
        checkedByInput,
        checkedByLabelClass,
        checkboxClass,
        checked: Boolean(checkedByInput || checkedByLabelClass),
      };
    };

    const waitForCheckboxReady = async () => {
      await checkboxLabel.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
      await checkboxMask.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);
      await page.waitForTimeout(Number(runtime?.dreaminaLoginCheckboxReadyWaitMs || 350)).catch(() => null);
    };

    const waitForCheckboxChecked = async () => {
      await page.waitForFunction(() => {
        const label = document.querySelector('label.lv-checkbox.privacyCheck');
        if (!label) return false;
        return String(label.className || '').includes('lv-checkbox-checked');
      }, { timeout: Number(runtime?.dreaminaLoginCheckboxCheckedTimeoutMs || 1600) }).catch(() => null);
      return await getCheckboxState();
    };

    await waitForCheckboxReady();
    const checkedBeforeState = await getCheckboxState();
    const checkedBefore = checkedBeforeState.checked;
    let checkboxClickTarget = '';
    let checkboxState = checkedBeforeState;

    if (!checkedBefore) {
      await checkboxMask.click({ timeout: 1500 }).catch(() => null);
      checkboxClickTarget = 'checkbox-mask';
      checkboxState = await waitForCheckboxChecked();
    }

    if (!checkboxState.checked) {
      await checkboxLabel.click({ timeout: 1500 }).catch(() => null);
      checkboxClickTarget = checkboxClickTarget || 'checkbox-label';
      checkboxState = await waitForCheckboxChecked();
    }

    if (!checkboxState.checked) {
      const box = await checkboxMask.boundingBox().catch(() => null);
      if (box && Number(box.width || 0) > 0 && Number(box.height || 0) > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 50 }).catch(() => null);
        checkboxClickTarget = checkboxClickTarget || 'checkbox-mask-center';
        checkboxState = await waitForCheckboxChecked();
      }
    }

    const checkedAfter = checkboxState.checked;
    const checkboxClassAfter = checkboxState.checkboxClass;
    const checkboxLabelChecked = checkboxState.checkedByLabelClass;
    if (!checkedAfter) {
      return { ok: false, skipped: true, reason: 'LOGIN_PAGE_CHECKBOX_NOT_CONFIRMED', checkedBefore, checkedAfter, checkboxLabelChecked, checkboxClassAfter, checkboxClickTarget };
    }

    await signInText.click({ timeout: 2000 }).catch(async () => {
      await signInText.click({ force: true, timeout: 2000 }).catch(() => null);
    });
    await page.waitForTimeout(Number(runtime?.dreaminaLoginSignInWaitMs || 800)).catch(() => null);

    return {
      ok: true,
      skipped: false,
      reason: 'LOGIN_PAGE_SIGN_IN_CLICKED',
      checkedBefore,
      checkedAfter,
      checkboxClickTarget,
    };
  }

  async function hasVisibleEntrySignals(page) {
    const signals = [
      page.getByText('Sign in').first(),
      page.getByText('Log in').first(),
      page.getByText('Login').first(),
      page.getByText('Sign up').first(),
      page.getByText('Continue with email').first(),
      page.getByText('Explore Create Assets').first(),
      page.getByText('Start Creating With AI Agent').first(),
      page.getByRole('button', { name: /sign in|log in|login|sign up|continue with email/i }).first(),
      page.getByRole('link', { name: /sign in|log in|login|sign up/i }).first(),
      page.locator("input[type='email']").first(),
      page.locator("input[placeholder*='email' i]").first(),
    ];

    for (const signal of signals) {
      if (await signal.isVisible().catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  async function observeDreaminaLoginPageAfterSignIn(page, runtime = {}, context = {}) {
    const settleWaitMs = Number(runtime?.dreaminaLoginPostClickSettleWaitMs || 1500);
    await page.waitForTimeout(settleWaitMs).catch(() => null);

    const modalVisible = await page.locator('.lv-modal-wrapper').first().isVisible().catch(() => false);
    const emailVisible = await page.locator("input[type='email']").first().isVisible().catch(() => false)
      || await page.locator("input[placeholder*='email' i]").first().isVisible().catch(() => false);
    const continueVisible = await page.getByText('Continue with email', { exact: false }).first().isVisible().catch(() => false);
    const googleVisible = await page.getByText('Continue with Google', { exact: false }).first().isVisible().catch(() => false);
    const tiktokVisible = await page.getByText('Continue with TikTok', { exact: false }).first().isVisible().catch(() => false);
    const facebookVisible = await page.getByText('Continue with Facebook', { exact: false }).first().isVisible().catch(() => false);

    if (emailVisible || continueVisible || modalVisible || googleVisible || tiktokVisible || facebookVisible) {
      return {
        ok: true,
        state: 'ENTRY_READY',
        source: 'login-page-post-click-observe',
        value: emailVisible
          ? 'EMAIL_GATE_VISIBLE'
          : (continueVisible
            ? 'CONTINUE_WITH_EMAIL_VISIBLE'
            : 'LOGIN_MODAL_VISIBLE'),
        strength: 'strong',
        stateChanged: true,
        detail: {
          readyTrace: {
            decision: 'login-page-post-click-signal-visible',
            modalVisible,
            emailVisible,
            continueVisible,
            googleVisible,
            tiktokVisible,
            facebookVisible,
          },
        },
      };
    }

    let lastGateResult = null;
    if (typeof siteAdapter?.confirmDreaminaLoginGate === 'function') {
      lastGateResult = await siteAdapter.confirmDreaminaLoginGate(page, runtime, context).catch(() => null);
      if (lastGateResult?.ok && lastGateResult?.state === 'EMAIL_GATE_READY') {
        return {
          ok: true,
          state: 'ENTRY_READY',
          source: 'login-page-post-click-observe',
          value: 'EMAIL_GATE_READY',
          strength: 'strong',
          stateChanged: true,
          detail: {
            readyTrace: {
              decision: 'login-page-post-click-gate-success',
              gateState: lastGateResult?.state || '',
              gateReason: lastGateResult?.value || lastGateResult?.reason || '',
              gateResult: lastGateResult,
            },
            loginSignal: lastGateResult?.detail?.loginSignal || null,
            signalTimeline: lastGateResult?.detail?.signalTimeline || null,
          },
        };
      }
    }

    return {
      ok: false,
      state: 'LOGIN_ENTRY_FAILED',
      source: 'login-page-post-click-observe',
      value: 'LOGIN_PAGE_POST_CLICK_SIGNAL_MISSING',
      strength: '',
      stateChanged: false,
      detail: {
        readyTrace: {
          decision: 'login-page-post-click-signal-missing',
          gateState: lastGateResult?.state || '',
          gateReason: lastGateResult?.value || lastGateResult?.reason || '',
          gateResult: lastGateResult,
          modalVisible,
          emailVisible,
          continueVisible,
          googleVisible,
          tiktokVisible,
          facebookVisible,
        },
      },
    };
  }

  async function recoverEntrySignals(page, runtime = {}) {
    await preprocessEntryOverlays(page);

    const firstObservationMs = Number(runtime?.entrySignalObservationMs || 3200);
    const secondObservationMs = Number(runtime?.entrySignalObservationAfterReloadMs || 6500);
    const observe = async totalMs => {
      const rounds = Math.max(1, Math.ceil(totalMs / 1000));
      for (let index = 0; index < rounds; index++) {
        if (await hasVisibleEntrySignals(page)) {
          return true;
        }
        await page.waitForTimeout(1000);
      }
      return await hasVisibleEntrySignals(page);
    };

    if (await observe(firstObservationMs)) {
      return true;
    }

    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: Number(runtime?.entryGotoTimeoutMs || runtime?.dreaminaNavigationTimeoutMs || 120000),
    }).catch(() => {});

    await preprocessEntryOverlays(page);
    return await observe(secondObservationMs);
  }

  async function captureEntryDebugSnapshot(page) {
    const snapshot = await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const toPlainClickable = element => {
        const rect = element.getBoundingClientRect();
        const text = normalize(element.innerText || element.textContent || '');
        const ariaLabel = normalize(element.getAttribute('aria-label') || '');
        const role = normalize(element.getAttribute('role') || '');
        const className = normalize(typeof element.className === 'string' ? element.className : '');
        const id = normalize(element.getAttribute('id') || '');
        const href = normalize(element.getAttribute('href') || '');
        const name = normalize(element.getAttribute('name') || '');
        const title = normalize(element.getAttribute('title') || '');
        const tag = String(element.tagName || '').toLowerCase();
        const summary = [text, ariaLabel, title, name, id, className].filter(Boolean).join(' | ');
        return {
          tag,
          role,
          text,
          ariaLabel,
          title,
          name,
          id,
          className,
          href,
          x: Number(Math.round(rect.left || 0)),
          y: Number(Math.round(rect.top || 0)),
          w: Number(Math.round(rect.width || 0)),
          h: Number(Math.round(rect.height || 0)),
          summary,
        };
      };

      const bodyText = normalize(document.body?.innerText || '');
      const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .filter(visible)
        .map(element => normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || ''))
        .filter(Boolean)
        .slice(0, 20);

      const clickableInventory = Array.from(document.querySelectorAll('button, [role="button"], a, [tabindex], input[type="button"], input[type="submit"]'))
        .filter(visible)
        .map(toPlainClickable)
        .filter(item => item && typeof item === 'object')
        .slice(0, 24);

      const headerClickables = clickableInventory
        .filter(item => item.y >= 0 && item.y <= 220)
        .slice(0, 12);

      const keywordClickables = clickableInventory
        .filter(item => /sign|login|log in|continue|email|account|profile|user|avatar/i.test(item.summary || ''))
        .slice(0, 12);

      const visibleInputs = Array.from(document.querySelectorAll('input, textarea'))
        .filter(visible)
        .map(element => ({
          tag: String(element.tagName || '').toLowerCase(),
          type: normalize(element.getAttribute('type') || ''),
          name: normalize(element.getAttribute('name') || ''),
          placeholder: normalize(element.getAttribute('placeholder') || ''),
          ariaLabel: normalize(element.getAttribute('aria-label') || ''),
          autocomplete: normalize(element.getAttribute('autocomplete') || ''),
        }))
        .slice(0, 20);

      return JSON.parse(JSON.stringify({
        url: String(window.location.href || ''),
        title: normalize(document.title || ''),
        bodyPreview: bodyText.slice(0, 500),
        visibleButtons,
        visibleInputs,
        clickableInventory,
        headerClickables,
        keywordClickables,
      }));
    }).catch(() => ({
      url: String(page?.url ? page.url() : ''),
      title: '',
      bodyPreview: '',
      visibleButtons: [],
      visibleInputs: [],
      clickableInventory: [],
      headerClickables: [],
      keywordClickables: [],
    }));

    return {
      url: String(snapshot?.url || ''),
      title: String(snapshot?.title || ''),
      bodyPreview: String(snapshot?.bodyPreview || ''),
      visibleButtons: Array.isArray(snapshot?.visibleButtons) ? snapshot.visibleButtons : [],
      visibleInputs: Array.isArray(snapshot?.visibleInputs) ? snapshot.visibleInputs : [],
      clickableInventory: Array.isArray(snapshot?.clickableInventory) ? snapshot.clickableInventory : [],
      headerClickables: Array.isArray(snapshot?.headerClickables) ? snapshot.headerClickables : [],
      keywordClickables: Array.isArray(snapshot?.keywordClickables) ? snapshot.keywordClickables : [],
    };
  }

  function isEntryPageLikelyUsableForFinalGrace(input = {}) {
    const timelineResult = input?.timelineResult && typeof input.timelineResult === 'object' ? input.timelineResult : null;
    const gateResult = input?.gateResult && typeof input.gateResult === 'object' ? input.gateResult : null;
    const signalTimeline = timelineResult?.detail?.signalTimeline || gateResult?.detail?.signalTimeline || null;
    const loginSignal = timelineResult?.detail?.loginSignal || gateResult?.detail?.loginSignal || null;
    const matchedKind = String(loginSignal?.kind || loginSignal?.label || '').trim().toLowerCase();
    const matchedValue = String(loginSignal?.value || timelineResult?.value || '').trim();
    const timelineText = signalTimeline && typeof signalTimeline === 'object'
      ? Object.keys(signalTimeline).join(' ')
      : '';
    const combinedText = `${matchedValue} ${timelineText}`;
    const gateReason = String(gateResult?.reason || '').trim().toUpperCase();

    if (/HTTP ERROR 5\d\d|该网页无法正常运作|目前无法处理此请求/i.test(combinedText)) {
      return false;
    }

    if (gateReason && gateReason !== 'LOGIN_ENTRY_NOT_FOUND') {
      return false;
    }

    return (
      matchedKind.includes('strong-text')
      || matchedKind === 'ready-text'
      || /Explore Create Assets|Start Creating With AI Agent|dreamina|capcut/i.test(combinedText)
    );
  }

  async function attemptFinalGraceLoginGate(page, runtime = {}, context = {}) {
    const finalGraceWaitMs = Number(runtime?.entryFinalGraceWaitMs || 2000);
    const finalGracePollMs = Number(runtime?.entryFinalGracePollMs || 400);
    const rounds = Math.max(1, Math.ceil(finalGraceWaitMs / Math.max(100, finalGracePollMs)));
    const trace = {
      enabled: finalGraceWaitMs > 0,
      finalGraceWaitMs,
      finalGracePollMs,
      rounds,
      matchedAtRound: 0,
      openAttempted: false,
      finalState: '',
      finalValue: '',
    };

    if (typeof siteAdapter.confirmDreaminaLoginGate !== 'function') {
      trace.finalState = 'adapter-method-missing';
      trace.finalValue = 'confirmDreaminaLoginGate';
      return { ok: false, trace, gateResult: null };
    }

    for (let round = 1; round <= rounds; round++) {
      if (typeof siteAdapter.preprocessDreaminaEntryOverlays === 'function') {
        await siteAdapter.preprocessDreaminaEntryOverlays(page, runtime, context).catch(() => null);
      }
      const gateResult = await siteAdapter.confirmDreaminaLoginGate(page, runtime, context).catch(() => null);
      if (gateResult?.ok && gateResult?.state === 'EMAIL_GATE_READY') {
        trace.matchedAtRound = round;
        trace.finalState = String(gateResult?.state || '');
        trace.finalValue = String(gateResult?.value || '');
        return { ok: true, trace, gateResult };
      }
      if (round < rounds) {
        await page.waitForTimeout(finalGracePollMs).catch(() => null);
      }
    }

    if (typeof siteAdapter.openDreaminaLoginEntry === 'function') {
      trace.openAttempted = true;
      await siteAdapter.openDreaminaLoginEntry(page, runtime, context).catch(() => null);
      if (typeof siteAdapter.preprocessDreaminaEntryOverlays === 'function') {
        await siteAdapter.preprocessDreaminaEntryOverlays(page, runtime, context).catch(() => null);
      }
      const gateResult = await siteAdapter.confirmDreaminaLoginGate(page, runtime, context).catch(() => null);
      trace.finalState = String(gateResult?.state || '');
      trace.finalValue = String(gateResult?.value || '');
      if (gateResult?.ok && gateResult?.state === 'EMAIL_GATE_READY') {
        return { ok: true, trace, gateResult, resolvedBy: 'open-entry' };
      }
      return { ok: false, trace, gateResult, resolvedBy: 'open-entry' };
    }

    trace.finalState = 'open-entry-missing';
    trace.finalValue = 'openDreaminaLoginEntry';
    return { ok: false, trace, gateResult: null, resolvedBy: 'none' };
  }

  return {
    async openEntryPage(page, runtime = {}, context = {}) {
      const entryUrl = String(runtime?.dreaminaEntryUrl || runtime?.entryUrl || 'https://dreamina.capcut.com/ai-tool/login').trim();
      const gotoTimeout = Number(runtime?.entryGotoTimeoutMs || runtime?.dreaminaNavigationTimeoutMs || 120000);

      const attemptGoto = async (targetUrl, sourceLabel) => {
        try {
          await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: gotoTimeout,
          });

          const deadPageSnapshot = await detectEntryDeadPage(page);
          if (deadPageSnapshot.whiteScreenLike || deadPageSnapshot.deadPageLike) {
            return {
              ok: false,
              state: 'ENTRY_PAGE_OPEN_FAILED',
              source: sourceLabel,
              value: deadPageSnapshot.whiteScreenLike ? 'DREAMINA_WHITE_SCREEN' : 'DREAMINA_FIRST_LOAD_DEAD_PAGE',
              strength: 'strong',
              stateChanged: false,
              detail: {
                targetUrl,
                deadPageSnapshot,
              },
            };
          }

          return {
            ok: true,
            state: 'ENTRY_PAGE_OPENED',
            source: sourceLabel,
            value: targetUrl,
            strength: sourceLabel === 'goto-public-entry' ? 'strong' : 'medium',
            stateChanged: true,
            detail: {
              targetUrl,
              deadPageSnapshot,
            },
          };
        } catch (error) {
          const message = String(error?.message || targetUrl);
          const deadPageSnapshot = await detectEntryDeadPage(page);
          const isTimeout = /Timeout\s+\d+ms\s+exceeded/i.test(message);
          const isHttpResponseCodeFailure = /ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message);
          const pageLooksUsable = !deadPageSnapshot.whiteScreenLike
            && !deadPageSnapshot.deadPageLike
            && (Number(deadPageSnapshot.bodyTextLength || 0) >= 40 || Number(deadPageSnapshot.bodyHtmlLength || 0) >= 4000);

          if (isHttpResponseCodeFailure && pageLooksUsable) {
            return {
              ok: true,
              state: 'ENTRY_PAGE_OPENED',
              source: `${sourceLabel}-http-fallback`,
              value: targetUrl,
              strength: 'medium',
              stateChanged: true,
              detail: {
                targetUrl,
                gotoWarning: message,
                deadPageSnapshot,
              },
            };
          }

          return {
            ok: false,
            state: 'ENTRY_PAGE_OPEN_FAILED',
            source: sourceLabel,
            value: isTimeout ? 'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT' : message,
            strength: 'strong',
            stateChanged: false,
            detail: {
              targetUrl,
              deadPageSnapshot,
            },
          };
        }
      };

      const assessLoginEntryAffordance = async () => {
        if (typeof siteAdapter.detectDreaminaLoginEntrySignals !== 'function') {
          return null;
        }
        await preprocessEntryOverlays(page).catch(() => null);
        return await siteAdapter.detectDreaminaLoginEntrySignals(page, runtime, context).catch(() => null);
      };

      let loginEntryResult = await attemptGoto(entryUrl, 'goto-login-entry');
      if (!loginEntryResult?.ok) {
        return loginEntryResult;
      }

      const loginPagePrepareResult = await prepareDreaminaLoginPage(page, runtime, context).catch(() => null);
      loginEntryResult = {
        ...loginEntryResult,
        detail: {
          ...(loginEntryResult?.detail || {}),
          loginPagePrepareResult,
          strategy: 'login-entry-checkbox-then-sign-in',
        },
      };

      const loginEntrySignal = await assessLoginEntryAffordance();
      return {
        ...loginEntryResult,
        detail: {
          ...(loginEntryResult?.detail || {}),
          loginEntrySignal,
        },
      };
    },

    async checkEntryHealth(page, runtime = {}, context = {}) {
      const currentUrl = String(page.url ? page.url() : '').trim();
      const loginCheckboxVisible = await page.locator('.lv-checkbox-mask').first().isVisible().catch(() => false);
      const loginSignInVisible = await page.getByText('Sign in', { exact: false }).first().isVisible().catch(() => false);
      if (/dreamina\.capcut\.com\/ai-tool\/login/i.test(currentUrl) && loginCheckboxVisible && loginSignInVisible) {
        return {
          ok: true,
          state: 'ENTRY_HEALTH_OK',
          source: 'dreamina-login-page',
          value: 'LOGIN_PAGE_VISIBLE',
          strength: 'strong',
          stateChanged: null,
          healthTrace: {
            decision: 'login-page-short-circuit',
            source: 'dreamina-login-page',
            value: 'LOGIN_PAGE_VISIBLE',
            strength: 'strong',
            detail: {
              currentUrl,
              loginCheckboxVisible,
              loginSignInVisible,
            },
            timing: {
              waitForDreaminaReadyMs: 0,
            },
          },
        };
      }

      if (typeof siteAdapter.waitForDreaminaReady !== 'function') {
        return {
          ok: false,
          state: 'ENTRY_HEALTH_FAILED',
          source: 'adapter',
          value: 'waitForDreaminaReady',
          strength: '',
          stateChanged: null,
          healthTrace: {
            decision: 'adapter-method-missing',
            missingMethod: 'waitForDreaminaReady',
          },
        };
      }

      const healthStartMs = Date.now();
      const readyResult = await siteAdapter.waitForDreaminaReady(page, runtime, context);
      const waitForDreaminaReadyMs = Math.max(0, Date.now() - healthStartMs);
      const healthTrace = {
        decision: readyResult?.ok ? 'ready-signal-found' : 'ready-signal-missing',
        source: String(readyResult?.source || ''),
        value: String(readyResult?.value || ''),
        strength: String(readyResult?.strength || ''),
        detail: readyResult?.detail && typeof readyResult.detail === 'object' ? readyResult.detail : null,
        timing: {
          waitForDreaminaReadyMs,
        },
      };
      const waitRounds = Array.isArray(healthTrace?.detail?.waitTrace?.rounds) ? healthTrace.detail.waitTrace.rounds : [];
      const bodyPreviewText = waitRounds.map(round => String(round?.observedBodyPreview || '')).join(' ');
      const hasHardHttpErrorPreview = /HTTP ERROR 5\d\d|该网页无法正常运作|目前无法处理此请求/i.test(bodyPreviewText);
      if (hasHardHttpErrorPreview) {
        return {
          ok: false,
          state: 'ENTRY_HEALTH_FAILED',
          source: 'http-error-preview',
          value: 'DREAMINA_HTTP_ERROR_PAGE',
          strength: 'strong',
          stateChanged: null,
          healthTrace,
        };
      }
      if (readyResult?.ok) {
        return {
          ok: true,
          state: 'ENTRY_HEALTH_OK',
          source: readyResult.source || 'dreamina-ready',
          value: readyResult.value || 'READY_SIGNAL_FOUND',
          strength: readyResult.strength || 'weak',
          stateChanged: null,
          healthTrace,
        };
      }

      return {
        ok: false,
        state: 'ENTRY_HEALTH_FAILED',
        source: 'dreamina-ready',
        value: 'READY_SIGNAL_MISSING',
        strength: '',
        stateChanged: null,
        healthTrace,
      };
    },

    async waitForEntryReady(page, runtime = {}, context = {}) {
      const phaseTrace = {
        timelineWaitMs: 0,
        ensureGateMs: 0,
        recoverSignalsMs: 0,
        reensureGateMs: 0,
        debugSnapshotMs: 0,
        resolvedPath: '',
        recoveredSignals: false,
        gateResolvedState: '',
        gateResolvedReason: '',
      };

      const loginPagePrepareResult = context?.openEntryPageResult?.detail?.loginPagePrepareResult || null;
      if (loginPagePrepareResult?.ok && loginPagePrepareResult?.reason === 'LOGIN_PAGE_SIGN_IN_CLICKED') {
        const observeStartedAt = Date.now();
        const observedResult = await observeDreaminaLoginPageAfterSignIn(page, runtime, context);
        phaseTrace.timelineWaitMs = Math.max(0, Date.now() - observeStartedAt);
        phaseTrace.resolvedPath = observedResult?.ok ? 'login-page-post-click-success' : 'login-page-post-click-failed';
        phaseTrace.gateResolvedState = String(observedResult?.detail?.readyTrace?.gateState || observedResult?.state || '');
        phaseTrace.gateResolvedReason = String(observedResult?.detail?.readyTrace?.gateReason || observedResult?.value || '');
        return {
          ...observedResult,
          detail: {
            ...(observedResult?.detail || {}),
            readyTrace: {
              ...((observedResult?.detail && observedResult.detail.readyTrace) || {}),
              waitForEntryReadyPhaseTrace: {
                ...phaseTrace,
                resolvedPath: phaseTrace.resolvedPath,
              },
              loginPagePrepareResult,
            },
          },
        };
      }

      const timelineStartedAt = Date.now();
      const timelineResult = typeof timelineAdapter.waitForEntryReady === 'function'
        ? await timelineAdapter.waitForEntryReady(page, runtime, context)
        : (typeof siteAdapter.waitForEntryReady === 'function'
          ? await siteAdapter.waitForEntryReady(page, runtime, context)
          : null);
      phaseTrace.timelineWaitMs = Math.max(0, Date.now() - timelineStartedAt);

      if (typeof siteAdapter.ensureDreaminaLoginGate !== 'function') {
        return {
          ok: false,
          state: 'ENTRY_ADAPTER_METHOD_MISSING',
          source: 'adapter',
          value: 'ensureDreaminaLoginGate',
          strength: '',
          detail: {
            readyTrace: {
              decision: 'adapter-method-missing',
              missingMethod: 'ensureDreaminaLoginGate',
              confirmTrace: timelineResult?.detail?.confirmTrace || null,
              waitForEntryReadyPhaseTrace: {
                ...phaseTrace,
                resolvedPath: 'adapter-method-missing',
              },
            },
            loginSignal: timelineResult?.detail?.loginSignal || null,
            signalTimeline: timelineResult?.detail?.signalTimeline || null,
          },
        };
      }

      const ensureGateStartedAt = Date.now();
      let gateResult = await siteAdapter.ensureDreaminaLoginGate(page, runtime, context);
      phaseTrace.ensureGateMs = Math.max(0, Date.now() - ensureGateStartedAt);
      phaseTrace.gateResolvedState = String(gateResult?.state || '');
      phaseTrace.gateResolvedReason = String(gateResult?.reason || '');
      if (gateResult?.success) {
        return {
          ok: true,
          state: 'ENTRY_READY',
          source: gateResult.state || timelineResult?.source || 'login-gate',
          value: gateResult.reason || gateResult.state || timelineResult?.value || 'LOGIN_GATE_READY',
          strength: 'strong',
          stateChanged: true,
          detail: {
            readyTrace: {
              decision: 'gate-success',
              confirmTrace: timelineResult?.detail?.confirmTrace || null,
              gateState: gateResult?.state || '',
              gateReason: gateResult?.reason || '',
              gateResult,
              timelineResult,
              waitForEntryReadyPhaseTrace: {
                ...phaseTrace,
                resolvedPath: 'initial-gate-success',
              },
            },
            loginSignal: gateResult?.gateState || gateResult?.detail?.loginSignal || timelineResult?.detail?.loginSignal || null,
            signalTimeline: timelineResult?.detail?.signalTimeline
              || gateResult?.detail?.signalTimeline
              || gateResult?.detail?.loginSignal?.detail?.signalTimeline
              || gateResult?.detail?.loginSignal?.timelineSignals
              || null,
          },
        };
      }

      if (String(gateResult?.reason || '').trim().toUpperCase() === 'LOGIN_ENTRY_NOT_FOUND') {
        const timelineSignal = timelineResult?.detail?.loginSignal || null;
        const timelineMatchedKind = String(timelineSignal?.kind || timelineSignal?.label || '').trim().toLowerCase();
        const timelineMatchedValue = String(timelineSignal?.value || timelineResult?.value || '').trim();
        const signalTimeline = timelineResult?.detail?.signalTimeline || null;
        const fallbackTimelineText = signalTimeline && typeof signalTimeline === 'object'
          ? Object.keys(signalTimeline).join(' ')
          : '';
        const isStrongHomeReadySignal = (
          timelineMatchedKind.includes('strong-text')
          || timelineMatchedKind === 'ready-text'
          || /Explore Create Assets|Start Creating With AI Agent/i.test(fallbackTimelineText)
        ) && /Explore Create Assets|Start Creating With AI Agent/i.test(timelineMatchedValue || fallbackTimelineText);

        if (isStrongHomeReadySignal) {
          phaseTrace.gateResolvedState = 'HOME_READY_TEXT_VISIBLE';
          phaseTrace.gateResolvedReason = 'LOGIN_ENTRY_NOT_FOUND_BUT_HOME_READY';
        }

        const recoverSignalsStartedAt = Date.now();
        const recovered = await recoverEntrySignals(page, runtime);
        phaseTrace.recoverSignalsMs = Math.max(0, Date.now() - recoverSignalsStartedAt);
        phaseTrace.recoveredSignals = Boolean(recovered);
        if (recovered) {
          if (typeof siteAdapter.preprocessDreaminaEntryOverlays === 'function') {
            await siteAdapter.preprocessDreaminaEntryOverlays(page, runtime, context).catch(() => null);
          }
          if (typeof siteAdapter.confirmDreaminaLoginGate === 'function') {
            const recoveredGateState = await siteAdapter.confirmDreaminaLoginGate(page, runtime, context).catch(() => null);
            if (recoveredGateState?.ok && recoveredGateState?.state === 'EMAIL_GATE_READY') {
              phaseTrace.gateResolvedState = String(recoveredGateState?.state || '');
              phaseTrace.gateResolvedReason = 'LOGIN_GATE_READY_AFTER_SIGNAL_RECOVERY';
              return {
                ok: true,
                state: 'ENTRY_READY',
                source: recoveredGateState.state || timelineResult?.source || 'login-gate',
                value: recoveredGateState.value || recoveredGateState.state || timelineResult?.value || 'LOGIN_GATE_READY',
                strength: 'strong',
                stateChanged: true,
                detail: {
                  readyTrace: {
                    decision: 'gate-success-after-recover-confirm',
                    confirmTrace: timelineResult?.detail?.confirmTrace || null,
                    gateState: recoveredGateState?.state || '',
                    gateReason: recoveredGateState?.value || '',
                    recovered: true,
                    gateResult: recoveredGateState,
                    timelineResult,
                    waitForEntryReadyPhaseTrace: {
                      ...phaseTrace,
                      resolvedPath: 'recover-confirm-gate-success',
                    },
                  },
                  loginSignal: recoveredGateState?.detail?.loginSignal || timelineResult?.detail?.loginSignal || null,
                  signalTimeline: recoveredGateState?.detail?.signalTimeline || timelineResult?.detail?.signalTimeline || null,
                },
              };
            }
          }

          if (typeof siteAdapter.openDreaminaLoginEntry === 'function' && typeof siteAdapter.confirmDreaminaLoginGate === 'function') {
            await siteAdapter.openDreaminaLoginEntry(page, runtime, context).catch(() => null);
            const postRecoveryOpenGateState = await siteAdapter.confirmDreaminaLoginGate(page, runtime, context).catch(() => null);
            if (postRecoveryOpenGateState?.ok && postRecoveryOpenGateState?.state === 'EMAIL_GATE_READY') {
              phaseTrace.gateResolvedState = String(postRecoveryOpenGateState?.state || '');
              phaseTrace.gateResolvedReason = 'LOGIN_GATE_READY_AFTER_RECOVERY_OPEN';
              return {
                ok: true,
                state: 'ENTRY_READY',
                source: postRecoveryOpenGateState.state || timelineResult?.source || 'login-gate',
                value: postRecoveryOpenGateState.value || postRecoveryOpenGateState.state || timelineResult?.value || 'LOGIN_GATE_READY',
                strength: 'strong',
                stateChanged: true,
                detail: {
                  readyTrace: {
                    decision: 'gate-success-after-recovery-open',
                    confirmTrace: timelineResult?.detail?.confirmTrace || null,
                    gateState: postRecoveryOpenGateState?.state || '',
                    gateReason: postRecoveryOpenGateState?.value || '',
                    recovered: true,
                    gateResult: postRecoveryOpenGateState,
                    timelineResult,
                    waitForEntryReadyPhaseTrace: {
                      ...phaseTrace,
                      resolvedPath: 'recover-open-gate-success',
                    },
                  },
                  loginSignal: postRecoveryOpenGateState?.detail?.loginSignal || timelineResult?.detail?.loginSignal || null,
                  signalTimeline: postRecoveryOpenGateState?.detail?.signalTimeline || timelineResult?.detail?.signalTimeline || null,
                },
              };
            }
          }

          const reensureGateStartedAt = Date.now();
          gateResult = await siteAdapter.ensureDreaminaLoginGate(page, runtime, context);
          phaseTrace.reensureGateMs = Math.max(0, Date.now() - reensureGateStartedAt);
          phaseTrace.gateResolvedState = String(gateResult?.state || '');
          phaseTrace.gateResolvedReason = String(gateResult?.reason || '');
          if (gateResult?.success) {
            return {
              ok: true,
              state: 'ENTRY_READY',
              source: gateResult.state || timelineResult?.source || 'login-gate',
              value: gateResult.reason || gateResult.state || timelineResult?.value || 'LOGIN_GATE_READY',
              strength: 'strong',
              stateChanged: true,
              detail: {
                readyTrace: {
                  decision: 'gate-success-after-recover-signals',
                  confirmTrace: timelineResult?.detail?.confirmTrace || null,
                  gateState: gateResult?.state || '',
                  gateReason: gateResult?.reason || '',
                  recovered: true,
                  gateResult,
                  timelineResult,
                  waitForEntryReadyPhaseTrace: {
                    ...phaseTrace,
                    resolvedPath: 'recover-signals-gate-success',
                  },
                },
                loginSignal: gateResult?.gateState || gateResult?.detail?.loginSignal || timelineResult?.detail?.loginSignal || null,
                signalTimeline: timelineResult?.detail?.signalTimeline
                  || gateResult?.detail?.signalTimeline
                  || gateResult?.detail?.loginSignal?.detail?.signalTimeline
                  || gateResult?.detail?.loginSignal?.timelineSignals
                  || null,
              },
            };
          }

          if (String(gateResult?.reason || '').trim().toUpperCase() === 'LOGIN_ENTRY_NOT_FOUND'
            && isEntryPageLikelyUsableForFinalGrace({ timelineResult, gateResult })) {
            const finalGraceStartedAt = Date.now();
            const finalGraceResult = await attemptFinalGraceLoginGate(page, runtime, context);
            phaseTrace.finalGraceMs = Math.max(0, Date.now() - finalGraceStartedAt);
            phaseTrace.finalGraceTriggered = true;
            phaseTrace.finalGraceMatched = Boolean(finalGraceResult?.ok);
            phaseTrace.finalGraceTrace = finalGraceResult?.trace || null;
            if (finalGraceResult?.ok && finalGraceResult?.gateResult?.state === 'EMAIL_GATE_READY') {
              phaseTrace.gateResolvedState = String(finalGraceResult?.gateResult?.state || '');
              phaseTrace.gateResolvedReason = 'LOGIN_GATE_READY_AFTER_FINAL_GRACE';
              return {
                ok: true,
                state: 'ENTRY_READY',
                source: finalGraceResult.gateResult.state || timelineResult?.source || 'login-gate',
                value: finalGraceResult.gateResult.value || finalGraceResult.gateResult.state || timelineResult?.value || 'LOGIN_GATE_READY',
                strength: 'strong',
                stateChanged: true,
                detail: {
                  readyTrace: {
                    decision: 'gate-success-after-final-grace',
                    confirmTrace: timelineResult?.detail?.confirmTrace || null,
                    gateState: finalGraceResult?.gateResult?.state || '',
                    gateReason: finalGraceResult?.gateResult?.value || '',
                    recovered: true,
                    finalGrace: true,
                    finalGraceTrace: finalGraceResult?.trace || null,
                    gateResult: finalGraceResult?.gateResult,
                    timelineResult,
                    waitForEntryReadyPhaseTrace: {
                      ...phaseTrace,
                      resolvedPath: 'recover-final-grace-gate-success',
                    },
                  },
                  loginSignal: finalGraceResult?.gateResult?.detail?.loginSignal || gateResult?.detail?.loginSignal || timelineResult?.detail?.loginSignal || null,
                  signalTimeline: finalGraceResult?.gateResult?.detail?.signalTimeline
                    || timelineResult?.detail?.signalTimeline
                    || gateResult?.detail?.signalTimeline
                    || null,
                },
              };
            }
          }
        }
      }

      const debugSnapshotStartedAt = Date.now();
      const debugSnapshot = await captureEntryDebugSnapshot(page);
      phaseTrace.debugSnapshotMs = Math.max(0, Date.now() - debugSnapshotStartedAt);
      return {
        ok: false,
        state: gateResult?.state || timelineResult?.state || 'ENTRY_NOT_READY',
        source: gateResult?.state || gateResult?.source || timelineResult?.source || 'login-gate',
        value: gateResult?.reason || gateResult?.state || timelineResult?.value || '',
        strength: '',
        detail: {
          readyTrace: {
            decision: 'gate-failed',
            confirmTrace: timelineResult?.detail?.confirmTrace || null,
            gateState: gateResult?.state || '',
            gateReason: gateResult?.reason || '',
            gateResult,
            timelineResult,
            waitForEntryReadyPhaseTrace: {
              ...phaseTrace,
              resolvedPath: phaseTrace.recoveredSignals ? 'recover-signals-gate-failed' : 'initial-gate-failed',
            },
          },
          loginSignal: timelineResult?.detail?.loginSignal || gateResult?.detail?.loginSignal || null,
          signalTimeline: timelineResult?.detail?.signalTimeline
            || gateResult?.detail?.signalTimeline
            || gateResult?.detail?.loginSignal?.detail?.signalTimeline
            || null,
          gateResult,
          debugSnapshot,
        },
      };
    },

    classifyEntryFailure(input = {}) {
      const entryReason = String(input.reason || input.state || '').trim().toUpperCase();
      const gateReason = String(input.value || '').trim().toUpperCase();
      const gateState = String(input.source || '').trim().toUpperCase();
      const detail = input?.detail && typeof input.detail === 'object' ? input.detail : {};
      const readyTrace = detail?.readyTrace && typeof detail.readyTrace === 'object' ? detail.readyTrace : {};
      const signalTimeline = readyTrace?.signalTimeline && typeof readyTrace.signalTimeline === 'object'
        ? readyTrace.signalTimeline
        : detail?.signalTimeline && typeof detail.signalTimeline === 'object'
          ? detail.signalTimeline
          : {};
      const debugSnapshot = readyTrace?.debugSnapshot && typeof readyTrace.debugSnapshot === 'object'
        ? readyTrace.debugSnapshot
        : detail?.debugSnapshot && typeof detail.debugSnapshot === 'object'
          ? detail.debugSnapshot
          : {};
      const keywordClickables = Array.isArray(debugSnapshot?.keywordClickables) ? debugSnapshot.keywordClickables : [];
      const clickableInventory = Array.isArray(debugSnapshot?.clickableInventory) ? debugSnapshot.clickableInventory : [];
      const homeReadyOnly = Boolean(signalTimeline?.['text:Explore Create Assets'] || signalTimeline?.['text:Start Creating With AI Agent']);
      const hasLoginAffordance = keywordClickables.length > 0
        || clickableInventory.some(item => /sign in|log in|login|continue with email|email|account|profile|user|avatar/i.test(String(item?.summary || '')));

      if (entryReason === 'ENTRY_HEALTH_FAILED') {
        const classifiedEntry = typeof siteAdapter.classifyDreaminaEntryFailure === 'function'
          ? siteAdapter.classifyDreaminaEntryFailure({ reason: 'READY_SIGNAL_MISSING' })
          : null;

        return {
          reason: entryReason || 'ENTRY_HEALTH_FAILED',
          siteReason: classifiedEntry?.siteReason || 'DREAMINA_READY_SIGNAL_MISSING',
          hardFailure: Boolean(classifiedEntry?.hardFailure),
        };
      }

      if (entryReason === 'ENTRY_PAGE_OPEN_FAILED') {
        const openFailureValue = String(input.value || '').trim().toUpperCase();
        return {
          reason: entryReason,
          siteReason: openFailureValue === 'DREAMINA_WHITE_SCREEN'
            ? 'DREAMINA_WHITE_SCREEN'
            : openFailureValue === 'DREAMINA_FIRST_LOAD_DEAD_PAGE'
              ? 'DREAMINA_FIRST_LOAD_DEAD_PAGE'
              : openFailureValue === 'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT'
                ? 'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT'
                : 'DREAMINA_ENTRY_PAGE_OPEN_FAILED',
          hardFailure: true,
        };
      }

      if ((gateReason || entryReason) === 'LOGIN_ENTRY_NOT_FOUND' && homeReadyOnly && !hasLoginAffordance) {
        return {
          reason: gateReason || entryReason || 'LOGIN_ENTRY_NOT_FOUND',
          siteReason: 'DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY',
          hardFailure: false,
        };
      }

      const classifiedGate = typeof siteAdapter.classifyDreaminaLoginGateFailure === 'function'
        ? siteAdapter.classifyDreaminaLoginGateFailure({
            reason: gateReason || input.reason,
            state: gateState || input.state,
          })
        : null;

      return {
        reason: gateReason || entryReason || 'ENTRY_NOT_READY',
        siteReason: classifiedGate?.siteReason || 'DREAMINA_ENTRY_NOT_READY',
        hardFailure: Boolean(classifiedGate?.hardFailure),
      };
    },
  };
}

const dreaminaEntryAdapter = buildDreaminaEntryStageAdapter(dreaminaEntrySiteAdapter, dreaminaEntryTimelineAdapter);
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
        context: stageContext,
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

  logStageProgress('entry', 'Dreamina 注册主链启动', {
    logger: logInfo,
    context: registerContext?.stageLogContext || {},
    extra: 'stageOrder=proxyPrecheck->entry->credential->verification->profileCompletion->postAuthReady->accountDelivery',
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

function sanitizeFileName(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeCliResultFile(result = {}, meta = {}) {
  const resultsDir = path.join(__dirname, 'results');
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
  const accountFilePath = path.join(__dirname, 'local-accounts.json');
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
  const filePath = path.join(__dirname, 'proxy-health.json');
  const parsed = readJsonFileSafe(filePath, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function saveProxyHealth(health = {}) {
  const filePath = path.join(__dirname, 'proxy-health.json');
  fs.writeFileSync(filePath, `${JSON.stringify(health, null, 2)}\n`, 'utf8');
}

function appendBadProxyRecord(proxy = null, reason = '') {
  if (!proxy || typeof proxy !== 'object') return;
  const filePath = path.join(__dirname, 'bad-proxies.txt');
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

  const launchOptions = {
    headless: !headed,
    slowMo,
  };

  if (headed && windowLayout?.enabled) {
    launchOptions.args = [
      ...(Array.isArray(launchOptions.args) ? launchOptions.args : []),
      `--window-position=${Number(windowLayout.x || 0)},${Number(windowLayout.y || 0)}`,
      `--window-size=${Number(windowLayout.width || 1440)},${Number(windowLayout.height || 900)}`,
    ];
  }

  if (proxy?.server) {
    launchOptions.proxy = {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: windowLayout?.viewport && Number(windowLayout.viewport.width) > 0 && Number(windowLayout.viewport.height) > 0
      ? {
          width: Number(windowLayout.viewport.width),
          height: Number(windowLayout.viewport.height),
        }
      : { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });

  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = String(request.resourceType() || '').trim().toLowerCase();
    if (blockedResourceTypes.includes(resourceType)) {
      await route.abort().catch(() => {});
      return;
    }
    await route.continue().catch(() => {});
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
  };
}

async function runDreaminaRegisterCli(argv = []) {
  const { proxyIndex, accountIndex, headed, slowMo } = parseCliArgs(argv);
  const proxies = loadLocalProxies();
  const accounts = loadLocalAccounts();
  const proxySelection = resolveCliProxySelection(proxies, proxyIndex);
  const proxy = proxySelection.proxy;
  const account = selectCliAccount(accounts, accountIndex);

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
    console.log('[Dreamina Register] 未找到可用账号，请检查 Dreamina/local-accounts.json');
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
    cliRuntime = await createDreaminaCliRuntime({
      proxy,
      headed,
      slowMo,
      blockedResourceTypes: ['image', 'media', 'font'],
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
        dreaminaEntryUrl: 'https://dreamina.capcut.com/ai-tool/login',
        entryGotoTimeoutMs: 120000,
        dreaminaNavigationTimeoutMs: 120000,
        firstLoadGraceWaitMs: 12000,
        dreaminaAuthMode: 'signup',
        credentialSignupSwitchWaitMs: 1200,
        verificationRetryMaxAttempts: 3,
        verificationResendWaitMs: 1800,
        firstmailApiMaxPollAttempts: 2,
        waitMailIntervalMs: 2500,
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
    result.meta = {
      ...(result.meta || {}),
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
