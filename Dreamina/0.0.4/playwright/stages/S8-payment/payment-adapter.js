'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 内容层（CONTENT LAYER）— S8 payment adapter（Dreamina 收银台加卡支付）
//
// 文件定位：Dreamina/0.0.4/playwright/stages/S8-payment/payment-adapter.js
//
// 职责：在 S7 交付的 cashierPage（cashier.pipopayment.us）上：
//   选「Credit/debit card」→ 取卡池卡 → 填卡(billing/card-fill) →
//   [realCharge] 点 Pay → 判定结果 → 回报卡池(report) + 写台账(billing-ledger) →
//   declined 换下一张卡(maxCardTries)；dry-run 只填不点 Pay（零成本验选择器）。
// 只做编排；调度/日志/归一化在 lib/stage-runners/payment.js。
//
// 配置来源：config/config.json 的 billing 节（env 覆盖：DREAMINA_REAL_CHARGE 等；
//   CLI --dry-run 会设 DREAMINA_REAL_CHARGE=0）。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { loadJsonProfileWithCache } = require('../../../lib/utils/profile');
const { findFirstVisibleBySelectors, tryClickLocator } = require('../../../lib/utils/locator');
const sels = require('../../../billing/card-fill/selectors');
const cardPool = require('../../../billing/card-pool');
const cardFill = require('../../../billing/card-fill');
const ledger = require('../../../billing/billing-ledger');
const { generateAddress } = require('../../../billing/address-gen');

const PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-payment-profile.json');
let _profileCache = {};
function loadProfile() { return loadJsonProfileWithCache(PROFILE_PATH, _profileCache) || {}; }

let _cfgCache = null;
function loadBillingConfig() {
  if (_cfgCache) return _cfgCache;
  let cfg = {};
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'config.json'), 'utf8');
    cfg = (JSON.parse(raw) || {}).billing || {};
  } catch (_e) { cfg = {}; }
  const env = process.env;
  const bool = (v, d) => (v === undefined ? d : !(v === '0' || String(v).toLowerCase() === 'false'));
  const cashier = cfg.cashier || {};
  _cfgCache = {
    enabled: bool(env.DREAMINA_BILLING_ENABLED, cfg.enabled !== false),
    realCharge: bool(env.DREAMINA_REAL_CHARGE, cfg.realCharge !== false),
    amount: Number(env.DREAMINA_BILLING_AMOUNT || cfg.amount || 0),
    engine: env.DREAMINA_CARD_FILL_ENGINE || cfg.cardFillEngine || 'playwright,osinput',
    saveCard: bool(env.DREAMINA_SAVE_CARD, Boolean(cfg.saveCard)),
    maxCardTries: Number(env.DREAMINA_MAX_CARD_TRIES || cfg.maxCardTries || 3),
    urlPattern: (cashier.urlPattern || 'cashier.pipopayment.us'),
    fieldsWaitMs: Number(cashier.fieldsWaitMs || 8000),
    payClickTimeoutMs: Number(cashier.payClickTimeoutMs || 15000),
    outcomeTimeoutMs: Number(cashier.outcomeTimeoutMs || 45000),
  };
  return _cfgCache;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 解析 S7 交付的收银台页（优先 stageResults.upgrade.detail.cashierPage；否则当前页若已在收银台）。
function resolveCashierPage(page, context, urlPattern) {
  const re = new RegExp(escRe(urlPattern), 'i');
  const fromUpgrade = context && context.stageResults && context.stageResults.upgrade
    && context.stageResults.upgrade.detail && context.stageResults.upgrade.detail.cashierPage;
  if (fromUpgrade && typeof fromUpgrade.url === 'function') return fromUpgrade;
  if (page && typeof page.url === 'function' && re.test(String(page.url() || ''))) return page;
  // 扫一遍 context 内已开标签页
  const ctx = (context && context.browserContext) || (page && typeof page.context === 'function' ? page.context() : null);
  if (ctx && typeof ctx.pages === 'function') {
    for (const p of ctx.pages()) { if (re.test(String(p.url() || ''))) return p; }
  }
  return null;
}

async function selectCreditCardMethod(cp, log) {
  const radio = await findFirstVisibleBySelectors(cp, sels.methodCard || []);
  if (radio) { await tryClickLocator(radio, 'method:card', { logInfo: log }); await cp.waitForTimeout(500).catch(() => {}); return true; }
  return false;
}

async function waitForCardFields(cp, deadlineMs) {
  const end = Date.now() + Math.max(0, deadlineMs);
  while (Date.now() < end) {
    const f = await findFirstVisibleBySelectors(cp, sels.number || []);
    if (f) return true;
    await cp.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function maybeToggleSaveCard(cp, want, log) {
  const box = await findFirstVisibleBySelectors(cp, sels.saveCard || []);
  if (!box) return;
  const checked = await box.isChecked().catch(() => null);
  if (checked === null) return;
  if (Boolean(checked) !== Boolean(want)) { await tryClickLocator(box, 'save-card', { logInfo: log }); }
}

async function textPresent(cp, texts) {
  for (const t of (texts || [])) {
    if (await cp.getByText(t, { exact: false }).first().isVisible().catch(() => false)) return t;
  }
  return '';
}

// 点 Pay 后判定结果：success / declined / error（超时归 error）。
async function detectOutcome(cp, profile, timeoutMs, log) {
  const end = Date.now() + Math.max(0, timeoutMs);
  const succ = profile.successSignals || {};
  const dec = profile.declineSignals || {};
  const err = profile.errorSignals || {};
  while (Date.now() < end) {
    if (cp.isClosed && cp.isClosed()) return { result: 'error', via: 'page-closed' };
    const url = String(cp.url ? cp.url() : '').toLowerCase();
    for (const frag of (succ.urlIncludes || [])) { if (url.includes(String(frag).toLowerCase())) return { result: 'success', via: `url:${frag}` }; }
    const sHit = await textPresent(cp, succ.texts); if (sHit) return { result: 'success', via: `text:${sHit}` };
    const dHit = await textPresent(cp, dec.texts); if (dHit) return { result: 'declined', via: `text:${dHit}` };
    const eHit = await textPresent(cp, err.texts); if (eHit) return { result: 'error', via: `text:${eHit}` };
    await cp.waitForTimeout(800).catch(() => {});
  }
  return { result: 'error', via: 'timeout' };
}

// —— 主入口（供 lib/stage-runners/payment.js 调用）——
async function runPayment(page, runtime, context) {
  const log = typeof context?.logInfo === 'function' ? context.logInfo : null;
  const account = (context && context.account) || {};
  const profile = loadProfile();
  const cfg = loadBillingConfig();

  if (!cfg.enabled) return { ok: true, state: 'PAYMENT_SKIPPED_DISABLED', reason: 'PAYMENT_SKIPPED_DISABLED', detail: {} };

  const cp = resolveCashierPage(page, context, cfg.urlPattern);
  if (!cp) return { ok: false, state: 'PAYMENT_NO_CASHIER_PAGE', reason: 'PAYMENT_NO_CASHIER_PAGE', detail: {} };
  await cp.bringToFront().catch(() => {});
  await cp.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
  if (!new RegExp(escRe(cfg.urlPattern), 'i').test(String(cp.url() || ''))) {
    return { ok: false, state: 'CASHIER_URL_INVALID', reason: 'CASHIER_URL_INVALID', detail: { url: String(cp.url() || '') } };
  }

  let lastState = 'PAYMENT_DECLINED_EXHAUSTED';
  for (let attempt = 1; attempt <= cfg.maxCardTries; attempt += 1) {
    const card = cardPool.acquire ? await cardPool.acquire() : null;
    if (!card) return { ok: false, state: attempt === 1 ? 'PAYMENT_NO_CARD' : lastState, reason: attempt === 1 ? 'PAYMENT_NO_CARD' : lastState, detail: { attempt } };

    const address = generateAddress();
    if (log) log(`支付尝试 ${attempt}/${cfg.maxCardTries} | 卡尾号=${card.last4} | realCharge=${cfg.realCharge}`);

    await selectCreditCardMethod(cp, log).catch(() => {});
    const fieldsReady = await waitForCardFields(cp, cfg.fieldsWaitMs);
    if (!fieldsReady) {
      await cardPool.report(card.id, { result: 'error', error: 'CARD_FIELDS_NOT_READY' });
      lastState = 'PAYMENT_FIELDS_NOT_READY';
      continue;
    }

    const fill = await cardFill.fillCard({ page: cp, card, address, log, runtime, engine: cfg.engine });
    const filledOk = fill && fill.num && fill.exp && fill.cvc;
    if (!filledOk) {
      await cardPool.report(card.id, { result: 'error', error: (fill && fill.error) || 'FILL_INCOMPLETE' });
      ledger.record({ email: account.email, result: 'error', error: 'FILL_INCOMPLETE', cardLast4: card.last4, amount: cfg.amount });
      lastState = 'PAYMENT_FILL_INCOMPLETE';
      continue;
    }

    await maybeToggleSaveCard(cp, cfg.saveCard, log).catch(() => {});

    // —— DRY-RUN：填完即停，不点 Pay，不消耗卡（零成本验证选择器）——
    if (!cfg.realCharge) {
      await cardPool.report(card.id, { result: 'error', error: 'DRY_RUN' }); // error=卡不计用量、保持 active
      ledger.record({ email: account.email, result: 'dry-run', cardLast4: card.last4, amount: cfg.amount });
      return {
        ok: true,
        state: 'PAYMENT_DRY_RUN',
        reason: 'PAYMENT_DRY_RUN',
        billing: { result: 'dry-run', last4: card.last4, amount: cfg.amount, cardId: card.id },
        detail: { dryRun: true, filled: { num: !!fill.num, exp: !!fill.exp, cvc: !!fill.cvc, cardholder: fill.cardholder }, cashierUrl: String(cp.url() || '') },
      };
    }

    // —— 真实扣款：点 Pay → 判定 ——
    const payBtn = await findFirstVisibleBySelectors(cp, sels.payButton || []);
    if (!payBtn) { await cardPool.report(card.id, { result: 'error', error: 'PAY_BUTTON_NOT_FOUND' }); lastState = 'PAYMENT_PAY_BUTTON_NOT_FOUND'; continue; }
    await tryClickLocator(payBtn, 'pay', { logInfo: log, clickTimeout: cfg.payClickTimeoutMs });

    const outcome = await detectOutcome(cp, profile, cfg.outcomeTimeoutMs, log);
    if (outcome.result === 'success') {
      await cardPool.report(card.id, { result: 'success' });
      ledger.record({ email: account.email, result: 'success', charged: cfg.amount, cardLast4: card.last4, amount: cfg.amount });
      return {
        ok: true,
        state: 'PAYMENT_SUCCESS',
        reason: 'PAYMENT_SUCCESS',
        billing: { result: 'success', last4: card.last4, amount: cfg.amount, cardId: card.id, via: outcome.via },
        detail: { attempt, via: outcome.via, cashierUrl: String(cp.url() || '') },
      };
    }
    if (outcome.result === 'declined') {
      await cardPool.report(card.id, { result: 'declined' });
      ledger.record({ email: account.email, result: 'declined', cardLast4: card.last4, amount: cfg.amount, error: outcome.via });
      lastState = 'PAYMENT_DECLINED_EXHAUSTED';
      continue; // 换下一张卡
    }
    // error / timeout / page-closed → 卡保持 active，不再继续（环境/页面问题）
    await cardPool.report(card.id, { result: 'error', error: outcome.via });
    ledger.record({ email: account.email, result: 'error', cardLast4: card.last4, amount: cfg.amount, error: outcome.via });
    return {
      ok: false,
      state: outcome.via === 'page-closed' ? 'PAYMENT_PAGE_CLOSED' : 'PAYMENT_CASHIER_TIMEOUT',
      reason: outcome.via === 'page-closed' ? 'PAYMENT_PAGE_CLOSED' : 'PAYMENT_CASHIER_TIMEOUT',
      billing: { result: 'error', last4: card.last4, amount: cfg.amount, cardId: card.id, via: outcome.via },
      detail: { attempt, via: outcome.via },
    };
  }

  return { ok: false, state: 'PAYMENT_DECLINED_EXHAUSTED', reason: 'PAYMENT_DECLINED_EXHAUSTED', detail: { tries: cfg.maxCardTries } };
}

function classifyPaymentFailure(input = {}) {
  const state = String(input.state || 'PAYMENT_FAILED').trim();
  // 支付失败默认 hardFailure（failureMode=hard：账号判失败）；NO_CARD/超时等可重试不拉黑。
  const soft = ['PAYMENT_NO_CARD', 'PAYMENT_CASHIER_TIMEOUT', 'PAYMENT_FIELDS_NOT_READY', 'PAYMENT_NO_CASHIER_PAGE'];
  return { siteReason: state.startsWith('DREAMINA_') ? state : `DREAMINA_${state}`, hardFailure: !soft.includes(state) };
}

module.exports = { runPayment, classifyPaymentFailure, loadProfile, loadBillingConfig };
