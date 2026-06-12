'use strict';
// ═══════════════════════════════════════════════════════════════════════
// 混合方案 — Playwright 那一半：接管 Python 已启动的 AdsPower 环境(CDP)，
// 跑 register → magicLinkLogin → apiKey → billing(只绑地址)，然后【断开但不关浏览器】，
// 把同一个环境留给 Python-Selenium 去加卡。
//
// 用法: node playwright/hybrid-pw-stage.js <cdp-endpoint> <email> <mailbox_pw> <openrouter_pw> [mode] [priorApiKey] [x,y,w,h]
// 约定: stdout 只输出【最后一行 JSON 结果】；所有日志走 stderr，方便 Python 解析。
//
// 边界(BOUNDARY)：
//   ✅ 负责 —— 混合模式接管 Python 已建/已启的 AdsPower 环境(connectOverCDP),跑 register→login→apiKey→billing(仅绑地址),
//             完事【disconnect 但不关浏览器】,把同一环境留给 Python-Selenium 加卡。是 Node↔Python 的 Playwright 半边入口。
//   ❌ 不负责 —— 加卡(留 Selenium Fix C)、建环境/代理(Python 建)、并发调度(Python hybrid_run 调度)、充值。
// ═══════════════════════════════════════════════════════════════════════
const { chromium } = require('playwright');
const { runOpenrouterRegisterFlow, STAGE_DEFS } = require('./Openrouter-register');
const { installTurnstileIntercept } = require('./openrouter-turnstile');

function loadConfig() {
  function deepMerge(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b || {})) {
      out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k];
    }
    return out;
  }
  let cfg = {};
  try { cfg = require('../config.json'); } catch (_e) {}
  try { cfg = deepMerge(cfg, require('../config.local.json')); } catch (_e) {}
  if (process.env.OPENROUTER_CAPTCHA_KEY) cfg = deepMerge(cfg, { captcha: { apiKey: process.env.OPENROUTER_CAPTCHA_KEY } });
  if (process.env.OPENROUTER_FIRSTMAIL_KEY) cfg = deepMerge(cfg, { mailbox: { apiKey: process.env.OPENROUTER_FIRSTMAIL_KEY } });
  return cfg;
}

async function main() {
  const [ep, email, mailboxPw, orPw, mode, priorApiKey, winBounds] = process.argv.slice(2);
  if (!ep || !email || !mailboxPw || !orPw) {
    console.error('Usage: node hybrid-pw-stage.js <cdp-endpoint> <email> <mailbox_pw> <openrouter_pw> [mode=register|login] [priorApiKey] [x,y,w,h]');
    process.exit(2);
  }
  const runMode = (mode === 'login') ? 'login' : 'register';   // 已注册的号传 login,直接登录不再走注册
  // 已有 key → 作为续跑态传入,apiKey 阶段会复用、绝不重复建 key
  const priorState = priorApiKey ? { registered: true, apiKey: priorApiKey, loginPassword: orPw } : null;
  const CONFIG = loadConfig();
  const elog = (m) => console.error('[pw] ' + m);

  // 基础设施(CDP attach)失败必须也产出一行 JSON —— 否则 stdout 空,Python 只能笼统判 PW_NO_JSON,
  // 把"环境/内核没起来"误当业务失败,对坏环境白白 3 连试。给出 CDP_CONNECT_FAILED 让 Python 改去重启环境。
  let browser, context, page;
  try {
    browser = await chromium.connectOverCDP(ep, { timeout: 30000 });
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages()[0] || (await context.newPage());
  } catch (e) {
    elog('connectOverCDP 失败: ' + (e.message || e));
    process.stdout.write(JSON.stringify({
      ok: false, stage: 'connect', reason: 'CDP_CONNECT_FAILED',
      detail: String(e.message || e), apiKey: '', billingStatus: '', registered: false }) + '\n');
    process.exit(3);
  }

  // 并发平铺：把本环境窗口摆到 x,y,w,h(CDP Browser.setWindowBounds)
  if (winBounds && /^\d+,\d+,\d+,\d+$/.test(winBounds)) {
    try {
      const [x, y, w, h] = winBounds.split(',').map(Number);
      const sess = await context.newCDPSession(page);
      const { windowId } = await sess.send('Browser.getWindowForTarget');
      await sess.send('Browser.setWindowBounds', { windowId, bounds: { left: x, top: y, width: w, height: h, windowState: 'normal' } });
    } catch (e) { elog('摆窗失败(忽略): ' + (e.message || e)); }
  }

  // Turnstile 拦截(注册必需) + 收集 Cloudflare 请求 URL(sitekey 兜底)
  try { await installTurnstileIntercept(context); } catch (e) { elog('installTurnstileIntercept 失败(忽略): ' + e.message); }
  const cfRequestUrls = [];
  try { page.on('request', (req) => { if (req.url().includes('challenges.cloudflare.com')) cfRequestUrls.push(req.url()); }); } catch (_e) {}

  // 周期性关掉 Clerk「Profile details / Account」弹窗——它会挡住账单(绑地址)流程导致 BILLING_ERROR。
  // 【关键安全】只关确属 Clerk Profile 弹窗的；任何含账单/地址/卡/付款字样的弹窗【绝不碰】，
  // 否则会在绑地址提交中途把地址弹窗关掉，导致地址没真存上。
  let _closing = false;
  const modalCloser = setInterval(() => {
    if (_closing) return; _closing = true;
    page.evaluate(() => {
      var dlgs = document.querySelectorAll('[role="dialog"], .cl-modalContent, .cl-modal');
      for (var i = 0; i < dlgs.length; i++) {
        var d = dlgs[i], tx = (d.innerText || '');
        // 账单/地址/卡/付款相关 → 绝不关
        if (/billing address|payment method|card number|update address|add a payment|add credits|expiry|cvc|postal|verify your identity|buy credits/i.test(tx)) continue;
        // 只关明确的 Clerk Profile/Account 弹窗
        if (/Profile details|Manage your account info/i.test(tx)) {
          var btn = d.querySelector('button[aria-label*="lose" i],button[aria-label*="ismiss" i]');
          if (!btn) { var bs = d.querySelectorAll('button'); for (var j = 0; j < bs.length; j++) { var t = (bs[j].innerText || '').trim(); if (t === '×' || t === '✕' || t === 'X' || t.toLowerCase() === 'close') { btn = bs[j]; break; } } }
          if (btn) btn.click();
        }
      }
    }).catch(function () {}).finally(function () { _closing = false; });
  }, 1200);

  // 只跑 register → magicLinkLogin → apiKey → billing(地址)。跳过 proxyPrecheck/改密/export。
  const stageRegistry = STAGE_DEFS
    .filter((d) => ['register', 'magicLinkLogin', 'apiKey', 'billing'].includes(d.key))
    .map((d) => ({ ...d }));

  const runtime = {
    headed: true,
    config: CONFIG,
    taskParams: {
      mode: runMode,
      doApiKey: true,
      apiKeyName: 'auto-hybrid',
      apiKeyExpiration: 'No expiration',
      billingAction: 'address',      // 只绑地址，不加卡(卡留给 Selenium)
      addressMode: 'random',
      unifiedPassword: orPw,          // OpenRouter 登录密码(=统一密码)
      resume: !!priorApiKey,
    },
    priorState: priorState,
    resume: !!priorApiKey,            // 有已存 key → 开续跑,apiKey 阶段复用不另建
    ipCheck: { browserRuntimeIp: null, browserRuntimeIpSource: 'adspower', ipCheckError: null, checkedAt: new Date().toISOString() },
  };
  const ctx = {
    cfRequestUrls, workerId: 1, jobId: 'hybrid',
    log: (m) => elog(m),
    onStageStart: (s) => elog('▶ stage: ' + s),
    onCard: () => {}, onBilling: () => {}, saveState: () => {},
  };

  let result;
  try {
    result = await runOpenrouterRegisterFlow({
      page, account: { email, password: mailboxPw }, proxy: {}, runtime, context, stageRegistry,
    });
  } catch (e) {
    result = { success: false, stage: 'flow', reason: String(e.message || e), detail: {} };
  }

  const dp = (result.detail && result.detail.deliveryPayload) || {};
  const sr = (result.detail && result.detail.stages) || {};
  // 即使整体失败(如 billing 出错)，也把已拿到的 key / 已绑地址报出来，便于 Python 判断重试粒度。
  const keyFromStage = (sr.apiKey && sr.apiKey.detail && sr.apiKey.detail.apiKey) || '';
  const billFromStage = (sr.billing && sr.billing.detail && sr.billing.detail.billingStatus) || '';
  const out = {
    ok: !!result.success,
    stage: result.stage,
    reason: result.reason || '',
    apiKey: dp.apiKey || keyFromStage || '',
    billingStatus: dp.billingStatus || billFromStage || '',
    registered: !!(sr.register && sr.register.success),
  };
  // 断开但不关浏览器(留给 Selenium)。disconnect 在本版本可能不存在 → 忽略，直接退出即可。
  try { if (typeof browser.disconnect === 'function') await browser.disconnect(); } catch (_e) {}
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL ' + (e.message || e));
  // 任何未捕获路径也兜一行 JSON,杜绝 stdout 无 JSON → Python 笼统 PW_NO_JSON
  try {
    process.stdout.write(JSON.stringify({
      ok: false, stage: 'fatal', reason: 'PW_FATAL',
      detail: String(e.message || e), apiKey: '', billingStatus: '', registered: false }) + '\n');
  } catch (_e) {}
  process.exit(1);
});
