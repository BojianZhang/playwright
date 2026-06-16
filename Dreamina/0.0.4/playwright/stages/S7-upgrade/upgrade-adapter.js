'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 内容层（CONTENT LAYER）— S7 upgrade adapter（Dreamina 升级/选套餐）
//
// 文件定位：Dreamina/0.0.4/playwright/stages/S7-upgrade/upgrade-adapter.js
//
// 职责：登录后 →（关 Octo 弹窗）→ 点 Upgrade → 在升级弹窗按 config.upgrade.{tab,plan}
//       选套餐并点其 CTA → 等待跳转到 cashier.pipopayment.us（含新标签页兜底）→
//       把 cashierPage 交给 S8 payment。
// 只做页面操作；调度/日志/归一化在 lib/stage-runners/upgrade.js。
//
// 配置来源：config/config.json 的 upgrade 节（带 env 覆盖：DREAMINA_UPGRADE_*）。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { loadJsonProfileWithCache } = require('../../../lib/utils/profile');
const {
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  tryClickLocator,
} = require('../../../lib/utils/locator');

const PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-upgrade-profile.json');
let _profileCache = {};
function loadProfile() {
  return loadJsonProfileWithCache(PROFILE_PATH, _profileCache) || {};
}

let _cfgCache = null;
function loadUpgradeConfig() {
  if (_cfgCache) return _cfgCache;
  let cfg = {};
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'config.json'), 'utf8');
    cfg = (JSON.parse(raw) || {}).upgrade || {};
  } catch (_e) { cfg = {}; }
  const env = process.env;
  const bool = (v, d) => (v === undefined ? d : !(v === '0' || String(v).toLowerCase() === 'false'));
  _cfgCache = {
    enabled: bool(env.DREAMINA_UPGRADE_ENABLED, cfg.enabled !== false),
    tab: env.DREAMINA_UPGRADE_TAB || cfg.tab || '1-month',
    plan: env.DREAMINA_UPGRADE_PLAN || cfg.plan || 'Advanced',
    dismissOctoPopup: bool(env.DREAMINA_DISMISS_OCTO, cfg.dismissOctoPopup !== false),
    redirectTimeoutMs: Number(env.DREAMINA_UPGRADE_REDIRECT_MS || cfg.redirectTimeoutMs || 30000),
    modalWaitMs: Number(cfg.modalWaitMs || 8000),
    skipIfNoUpgradeButton: bool(env.DREAMINA_UPGRADE_SKIP_IF_NO_BUTTON, Boolean(cfg.skipIfNoUpgradeButton)),
  };
  return _cfgCache;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fillTemplate(t, plan) { return String(t).replace(/\{plan\}/gi, plan); }

// —— 关闭 Octo beta 弹窗（幂等，找不到即跳过）——
async function dismissOctoPopup(page, profile, log) {
  const oc = profile.octoClose || {};
  // 仅当出现 Octo 文案时才尝试关闭，避免误关其它弹层。
  let present = false;
  for (const t of (oc.anchorTexts || [])) {
    const loc = page.getByText(t, { exact: false }).first();
    if (await loc.isVisible().catch(() => false)) { present = true; break; }
  }
  if (!present) return false;
  let closer = await findFirstVisibleBySelectors(page, oc.closeSelectors || []);
  if (!closer) closer = await findFirstVisibleByTexts(page, oc.closeTexts || []);
  if (closer) {
    await tryClickLocator(closer, 'octo-close', { logInfo: log });
    await page.waitForTimeout(600).catch(() => {});
    return true;
  }
  return false;
}

async function clickUpgradeButton(page, profile, log) {
  const ub = profile.upgradeButton || {};
  let btn = await findFirstVisibleByTexts(page, ub.texts || ['Upgrade']);
  if (!btn) btn = await findFirstVisibleBySelectors(page, ub.selectors || []);
  if (!btn) return false;
  const clicked = await tryClickLocator(btn, 'upgrade-button', { logInfo: log, clickTimeout: 3000 });
  return Boolean(clicked);
}

async function waitForModalReady(page, profile, deadlineMs) {
  const mr = profile.modalReady || {};
  const end = Date.now() + Math.max(0, deadlineMs);
  while (Date.now() < end) {
    for (const t of (mr.texts || [])) {
      if (await page.getByText(t, { exact: false }).first().isVisible().catch(() => false)) return true;
    }
    for (const sel of (mr.selectors || [])) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function clickTab(page, profile, tab, log) {
  const candidates = (profile.tabTexts && profile.tabTexts[tab]) || [tab];
  const loc = await findFirstVisibleByTexts(page, candidates);
  if (loc) { await tryClickLocator(loc, `tab:${tab}`, { logInfo: log }); await page.waitForTimeout(500).catch(() => {}); return true; }
  return false;
}

// 在套餐卡片内点 CTA：先试「Upgrade to {plan} ...」模板，再退回「卡片标题祖先内的按钮」。
async function clickPlanCta(page, profile, plan, log) {
  const cta = profile.ctaTexts || {};
  // 1) 模板化 CTA 文案（优先精确，命中即点）。
  for (const tpl of (cta.templates || [])) {
    const text = fillTemplate(tpl, plan);
    const btn = page.getByRole('button', { name: new RegExp('^\\s*' + escRe(text) + '\\s*$', 'i') }).first();
    if (await btn.isVisible().catch(() => false)) {
      if (await tryClickLocator(btn, `cta:${text}`, { logInfo: log, clickTimeout: 3000 })) return { ok: true, via: 'template', text };
    }
  }
  // 2) 退回：定位套餐标题 → 取其卡片祖先 → 点其中按钮。
  const headings = (profile.planHeadingByPlan && profile.planHeadingByPlan[plan]) || [plan];
  for (const h of headings) {
    const heading = page.getByText(h, { exact: true }).first();
    if (!(await heading.isVisible().catch(() => false))) continue;
    // 卡片祖先：向上取 3 层最近的容器，点其中可见按钮。
    const card = heading.locator('xpath=ancestor::*[self::div or self::section or self::li][1]');
    const candidates = [...(cta.generic || [])];
    for (const t of candidates) {
      const btn = card.getByRole('button', { name: new RegExp(escRe(t), 'i') }).first();
      if (await btn.isVisible().catch(() => false)) {
        if (await tryClickLocator(btn, `cta-card:${plan}:${t}`, { logInfo: log, clickTimeout: 3000 })) return { ok: true, via: 'card', text: t };
      }
    }
    // 卡片内任意可见按钮兜底
    const anyBtn = card.locator('button:visible').first();
    if (await anyBtn.isVisible().catch(() => false)) {
      if (await tryClickLocator(anyBtn, `cta-card-any:${plan}`, { logInfo: log, clickTimeout: 3000 })) return { ok: true, via: 'card-any', text: '' };
    }
  }
  return { ok: false };
}

// 等待跳转到收银台（同标签 URL 变化 或 新标签页），返回 cashierPage。
async function waitForCashier(page, context, urlPattern, timeoutMs, log) {
  const ctx = context.browserContext || (typeof page.context === 'function' ? page.context() : null);
  const re = new RegExp(escRe(urlPattern), 'i');
  const newPageP = ctx ? ctx.waitForEvent('page', { timeout: timeoutMs }).catch(() => null) : Promise.resolve(null);
  const sameTabP = page.waitForURL(re, { timeout: timeoutMs }).then(() => page).catch(() => null);

  const newPage = await Promise.race([newPageP, sameTabP.then(() => null)]).catch(() => null);
  if (newPage && newPage !== page) {
    await newPage.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
    if (re.test(String(newPage.url() || ''))) { if (log) log(`cashier 新标签页：${newPage.url()}`); return newPage; }
  }
  // 同标签兜底（可能 race 先返回 null）
  const sameTab = await sameTabP;
  if (sameTab && re.test(String(page.url() || ''))) { if (log) log(`cashier 同标签：${page.url()}`); return page; }
  // 最后再扫一遍已开标签页
  if (ctx && typeof ctx.pages === 'function') {
    for (const p of ctx.pages()) { if (re.test(String(p.url() || ''))) return p; }
  }
  return null;
}

// —— 主入口（供 lib/stage-runners/upgrade.js 调用）——
async function runUpgrade(page, runtime, context) {
  const log = typeof context?.logInfo === 'function' ? context.logInfo : null;
  const profile = loadProfile();
  const cfg = loadUpgradeConfig();

  if (!cfg.enabled) {
    return { ok: true, state: 'UPGRADE_SKIPPED_DISABLED', reason: 'UPGRADE_SKIPPED_DISABLED', detail: {} };
  }

  if (cfg.dismissOctoPopup) {
    const dismissed = await dismissOctoPopup(page, profile, log).catch(() => false);
    if (dismissed && log) log('已关闭 Octo beta 弹窗');
  }

  const opened = await clickUpgradeButton(page, profile, log).catch(() => false);
  if (!opened) {
    if (cfg.skipIfNoUpgradeButton) return { ok: true, state: 'UPGRADE_SKIPPED_NO_BUTTON', reason: 'UPGRADE_SKIPPED_NO_BUTTON', detail: {} };
    return { ok: false, state: 'UPGRADE_NO_BUTTON', reason: 'UPGRADE_NO_BUTTON', detail: {} };
  }

  const modalReady = await waitForModalReady(page, profile, cfg.modalWaitMs);
  if (!modalReady) return { ok: false, state: 'UPGRADE_MODAL_NOT_FOUND', reason: 'UPGRADE_MODAL_NOT_FOUND', detail: {} };

  await clickTab(page, profile, cfg.tab, log).catch(() => {});

  const cta = await clickPlanCta(page, profile, cfg.plan, log).catch(() => ({ ok: false }));
  if (!cta.ok) return { ok: false, state: 'UPGRADE_PLAN_NOT_FOUND', reason: 'UPGRADE_PLAN_NOT_FOUND', detail: { tab: cfg.tab, plan: cfg.plan } };

  const cashierPage = await waitForCashier(page, context, profile.cashierUrlPattern || 'cashier.pipopayment.us', cfg.redirectTimeoutMs, log);
  if (!cashierPage) return { ok: false, state: 'UPGRADE_NO_REDIRECT', reason: 'UPGRADE_NO_REDIRECT', detail: { tab: cfg.tab, plan: cfg.plan, ctaVia: cta.via } };

  return {
    ok: true,
    state: 'UPGRADE_OK',
    reason: 'UPGRADE_OK',
    cashierPage,
    detail: { tab: cfg.tab, plan: cfg.plan, ctaVia: cta.via, cashierUrl: String(cashierPage.url() || ''), cashierPage },
  };
}

function classifyUpgradeFailure(input = {}) {
  const state = String(input.state || 'UPGRADE_FAILED').trim();
  return { siteReason: state.startsWith('DREAMINA_') ? state : `DREAMINA_${state}`, hardFailure: false };
}

module.exports = { runUpgrade, classifyUpgradeFailure, loadProfile, loadUpgradeConfig };
