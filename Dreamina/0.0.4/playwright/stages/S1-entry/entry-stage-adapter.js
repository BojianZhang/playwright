'use strict';

// ═══════════════════════════════════════════════════════════════════════
// S1-ENTRY 门面（FACADE）— Dreamina 0.0.4
//
// 文件定位：Dreamina/0.0.4/playwright/stages/S1-entry/entry-stage-adapter.js
//
// 说明：
//   原 0.0.3 的 Dreamina-register.js 把 ~1150 行 `buildDreaminaEntryStageAdapter`
//   胶水逻辑内联在编排层，导致 register 变成 2549 行巨石。本门面把这段逻辑抽出，
//   作为 S1 的【唯一对外入口】，内部仍组合两份既有 adapter（adapter.js 站点适配器 +
//   entry-adapter.js 时间线适配器），行为与 0.0.3 逐字节一致（零回归）。
//
//   register/job-runner 只需 require 本文件拿到 `dreaminaEntryAdapter`（已构建）
//   或 `buildDreaminaEntryStageAdapter`（构造器）。
//
// 边界：本门面自包含——只依赖两个注入的 adapter 参数 + Playwright Page API，
//       不引用编排层的任何 helper。
// ═══════════════════════════════════════════════════════════════════════

const dreaminaEntrySiteAdapter = require('./adapter');
const dreaminaEntryTimelineAdapter = require('./entry-adapter');

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

  async function detectLoginAffordanceSnapshot(page) {
    const debugSnapshot = await captureEntryDebugSnapshot(page);
    const keywordClickables = Array.isArray(debugSnapshot?.keywordClickables) ? debugSnapshot.keywordClickables : [];
    const clickableInventory = Array.isArray(debugSnapshot?.clickableInventory) ? debugSnapshot.clickableInventory : [];
    const hasLoginAffordance = keywordClickables.length > 0
      || clickableInventory.some(item => /sign in|log in|login|continue with email|email|account|profile|user|avatar/i.test(String(item?.summary || '')));

    return {
      hasLoginAffordance,
      debugSnapshot,
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
      || /Continue with email|Sign in|Log in|Login|Sign up|input|email|dreamina|capcut/i.test(combinedText)
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
      const entryUrl = String(runtime?.dreaminaEntryUrl || runtime?.entryUrl || 'https://dreamina.capcut.com/ai-tool/home').trim();
      const gotoTimeout = Number(runtime?.entryGotoTimeoutMs || runtime?.dreaminaNavigationTimeoutMs || 20000);

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

      if (loginPagePrepareResult && loginPagePrepareResult.ok === false && loginPagePrepareResult.skipped !== true) {
        return {
          ok: false,
          state: 'ENTRY_PAGE_OPEN_FAILED',
          source: 'login-page-prepare',
          value: String(loginPagePrepareResult.reason || 'LOGIN_PAGE_PREPARE_FAILED'),
          strength: 'strong',
          stateChanged: false,
          detail: {
            ...(loginEntryResult?.detail || {}),
          },
        };
      }

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
        ) && /Explore Create Assets|Start Creating With AI Agent/i.test(timelineMatchedValue || fallbackTimelineText)
          && !/Continue with email|Sign in|Log in|Login|Sign up/i.test(timelineMatchedValue || fallbackTimelineText);

        const loginAffordanceSnapshot = await detectLoginAffordanceSnapshot(page);
        const earlyHomeShellWithoutLoginEntry = isStrongHomeReadySignal
          && !loginAffordanceSnapshot?.hasLoginAffordance
          && !isEntryPageLikelyUsableForFinalGrace({ timelineResult, gateResult });

        if (isStrongHomeReadySignal) {
          phaseTrace.gateResolvedState = 'HOME_READY_TEXT_VISIBLE';
          phaseTrace.gateResolvedReason = earlyHomeShellWithoutLoginEntry
            ? 'HOME_READY_WITHOUT_LOGIN_AFFORDANCE'
            : 'LOGIN_ENTRY_NOT_FOUND_BUT_HOME_READY';
        }

        if (earlyHomeShellWithoutLoginEntry) {
          phaseTrace.debugSnapshotMs = 0;
          return {
            ok: false,
            state: 'LOGIN_ENTRY_FAILED',
            source: 'LOGIN_ENTRY_FAILED',
            value: 'LOGIN_ENTRY_NOT_FOUND',
            strength: '',
            detail: {
              readyTrace: {
                decision: 'home-ready-without-login-affordance',
                confirmTrace: timelineResult?.detail?.confirmTrace || null,
                gateState: gateResult?.state || '',
                gateReason: gateResult?.reason || '',
                gateResult,
                timelineResult,
                waitForEntryReadyPhaseTrace: {
                  ...phaseTrace,
                  resolvedPath: 'home-ready-without-login-affordance',
                },
              },
              loginSignal: timelineResult?.detail?.loginSignal || gateResult?.detail?.loginSignal || null,
              signalTimeline: timelineResult?.detail?.signalTimeline
                || gateResult?.detail?.signalTimeline
                || gateResult?.detail?.loginSignal?.detail?.signalTimeline
                || null,
              gateResult,
              debugSnapshot: loginAffordanceSnapshot?.debugSnapshot || null,
            },
          };
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
            if (recoveredGateState?.ok && (
              recoveredGateState?.state === 'EMAIL_GATE_READY'
              || recoveredGateState?.state === 'LOGIN_GATE_LAYER_READY'
            )) {
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
                      resolvedPath: 'entry-ready-after-recover-confirm',
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
            if (postRecoveryOpenGateState?.ok && (
              postRecoveryOpenGateState?.state === 'EMAIL_GATE_READY'
              || postRecoveryOpenGateState?.state === 'LOGIN_GATE_LAYER_READY'
            )) {
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
                      resolvedPath: 'entry-ready-after-recovery-open',
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
                    resolvedPath: 'entry-ready-after-recover-signals',
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
            if (finalGraceResult?.ok && (
              finalGraceResult?.gateResult?.state === 'EMAIL_GATE_READY'
              || finalGraceResult?.gateResult?.state === 'LOGIN_GATE_LAYER_READY'
            )) {
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
              resolvedPath: phaseTrace.recoveredSignals ? 'entry-not-ready-after-recover-signals' : 'entry-not-ready-initial-gate',
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

const dreaminaEntryAdapter = buildDreaminaEntryStageAdapter(
  dreaminaEntrySiteAdapter,
  dreaminaEntryTimelineAdapter
);

module.exports = {
  buildDreaminaEntryStageAdapter,
  dreaminaEntryAdapter,
  dreaminaEntrySiteAdapter,
  dreaminaEntryTimelineAdapter,
};
