'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / stages（各阶段页面操作实现）
//
// 文件定位：Openrouter/0.0.1/stages.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 每个阶段的真实页面操作，返回统一结构 { success, state, reason, detail }。
// ❌ 不负责 —— 编排顺序（register）、并发（job-runner）、浏览器创建（job-runner）。
//
// 约定：每个 stage 函数签名 async (ctx) => result；ctx = { page, account, proxy, runtime, context }。
//   runtime.config 为合并后的配置；context.cfRequestUrls 为收集到的 Cloudflare 请求 URL 数组。
// ═══════════════════════════════════════════════════════════════════════

const { solveAndInject } = require('./openrouter-turnstile');
const { hasHCaptcha, solveHCaptchaAndInject } = require('./openrouter-hcaptcha');
const { waitForClerkVerifyLink, waitForVerifyCode, changePassword } = require('./firstmail-client');

// OpenRouter 账号密码 = 统一密码(若设置) 否则用输入里的原密码。
// 注意：邮箱(Firstmail) API 读取始终用 account.password(原邮箱密码)；
//       仅 OpenRouter 表单填这个 openrouterPassword。
function openrouterPassword(runtime, account) {
  // 续跑优先用已存登录密码(账号当初就用它建/登)；否则统一密码 > 原密码。
  return (runtime && runtime.priorState && runtime.priorState.loginPassword)
    || (runtime && runtime.taskParams && String(runtime.taskParams.unifiedPassword || '').trim())
    || account.password;
}
// 邮箱(Firstmail)读信密码：续跑若已改过密，用已存 mailboxPassword；否则原密码。
function mailboxPassword(runtime, account) {
  return (runtime && runtime.priorState && runtime.priorState.mailboxPassword) || account.password;
}
const cardPool = require('../billing/card-pool');
const billingLedger = require('../billing/billing-ledger');
const accountStore = require('../data/account-store');
const { generateAddress } = require('../billing/address-gen');
// 填卡引擎(可切换 + 失败兜底链);fillAcross/humanPause 抽到 fill-primitive，本文件其它调用点继续复用。
const cardFill = require('../billing/card-fill');
const cardSelectors = require('../billing/card-fill/selectors');
const { fillAcross, humanPause } = require('../billing/card-fill/fill-primitive');
const humanBehavior = require('../billing/card-fill/human-behavior');
const { buildZipCandidates } = require('../billing/taxfree-zips');
const { envInt } = require('../billing/env-tunables');
const { classifyDecline } = require('../billing/decline-classify');

const ok = (state, detail) => ({ success: true, state, reason: '', detail: detail || {} });
const fail = (state, reason, detail) => ({ success: false, state, reason: reason || state, detail: detail || {} });

// 随机 API Key 名称（表单名称留空时使用）。生成形如 "swift-falcon-3козак" 的可读随机名。
const _KW_ADJ = ['swift', 'bright', 'calm', 'bold', 'lunar', 'solar', 'amber', 'azure', 'crimson', 'jade', 'noble', 'rapid', 'quiet', 'brave', 'cosmic', 'silent', 'golden', 'iron', 'misty', 'royal'];
const _KW_NOUN = ['falcon', 'otter', 'comet', 'maple', 'river', 'ember', 'harbor', 'cedar', 'lynx', 'quartz', 'raven', 'willow', 'orbit', 'pixel', 'nimbus', 'delta', 'cobalt', 'meadow', 'zephyr', 'onyx'];
function generateRandomKeyName() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${pick(_KW_ADJ)}-${pick(_KW_NOUN)}-${suffix}`;
}

function deriveName(email) {
  const local = String(email || 'user').split('@')[0].replace(/[^a-zA-Z]/g, ' ').trim() || 'user';
  const parts = local.split(/\s+/);
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
  return { firstName: cap(parts[0]) || 'Alex', lastName: cap(parts[1]) || 'Lee' };
}

// 指纹总览：浏览器一开就抓「出口 IP 的地理信息 + 浏览器自身指纹」综合核对一致性，
// 像 AdsPower 概览那样确认 IP / 时区 / 语言 / UA / 邮编 / 地理全部对齐（防 Stripe 风控）。
// 不阻断主流程，纯诊断 + 一致性告警。
async function fingerprintOverview(page, log) {
  try {
    // 1) 浏览器自身指纹（任意页面可读）
    const fp = await page.evaluate(() => ({
      ua: navigator.userAgent,
      lang: navigator.language,
      langs: (navigator.languages || []).join(','),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzOffsetMin: new Date().getTimezoneOffset(),
      platform: navigator.platform,
      vendor: navigator.vendor,
      webdriver: navigator.webdriver,
      vw: window.innerWidth, vh: window.innerHeight,
    })).catch(() => null);

    // 2) 出口 IP 地理信息：顶层导航到 ip-api（http，避免 https 混合内容拦截），读 JSON。
    let geo = null;
    try {
      const fields = 'status,country,countryCode,regionName,city,zip,timezone,isp,proxy,hosting,query';
      await page.goto(`http://ip-api.com/json/?fields=${fields}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
      const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      geo = JSON.parse(body);
    } catch (_e) { /* 地理查询失败不阻断 */ }

    if (!fp) { log('指纹总览：读取浏览器指纹失败'); return; }

    // 3) 综合 + 一致性判定
    const chromeVer = (fp.ua.match(/Chrome\/(\d+)/) || [])[1] || '?';
    log(`指纹总览[浏览器]: UA=Chrome/${chromeVer} 时区=${fp.tz}(offset ${fp.tzOffsetMin}) 语言=${fp.lang}[${fp.langs}] 视口=${fp.vw}x${fp.vh} platform=${fp.platform} webdriver=${fp.webdriver}`);
    const warns = [];
    let corrected = false;
    if (geo && geo.status === 'success') {
      // 存到 page，供后续 billing 阶段判断「脏IP(proxy/hosting)→跳过加卡」。
      try { page._ipGeo = { proxy: !!geo.proxy, hosting: !!geo.hosting, query: geo.query, country: geo.countryCode, timezone: geo.timezone }; } catch (_e) {}
      log(`指纹总览[出口IP]: ${geo.query} ${geo.country}/${geo.regionName}/${geo.city} zip=${geo.zip} IP时区=${geo.timezone} ISP=${geo.isp} proxy=${geo.proxy} hosting=${geo.hosting}`);
      const tzMatch = geo.timezone && fp.tz && geo.timezone === fp.tz;
      const langCC = (fp.lang.split('-')[1] || '').toUpperCase();
      const ccMatch = !langCC || !geo.countryCode || langCC === geo.countryCode;
      // 真正「基于 IP」：若浏览器时区与 IP 时区不一致，用 CDP 动态把时区对齐到 IP 所在时区。
      if (!tzMatch && geo.timezone) {
        try {
          const cdp = await page.context().newCDPSession(page);
          // Playwright 建 context 时已设过一个时区 override，直接再设 Chrome 会报 "already in effect"。
          // 先置空禁用旧 override，再设成 IP 时区，校正才会真正生效。
          await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
          await cdp.send('Emulation.setTimezoneOverride', { timezoneId: geo.timezone });
          const after = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => '');
          corrected = after === geo.timezone;
          fp.tz = after || fp.tz; // 让总览页显示校正后的时区
          log(`指纹总览[校正] CDP 设时区→${geo.timezone}，现为 ${after || '?'}${corrected ? ' ✓' : ' (未生效)'}`);
        } catch (e) { log(`指纹总览[校正] CDP 时区对齐失败：${e.message}`); }
      }
      if (!tzMatch) warns.push(corrected ? `时区已校正为 IP 时区 ${geo.timezone}（原 ${fp.tzOrig || ''}）` : `时区不一致(浏览器 ${fp.tz} ≠ IP ${geo.timezone})，CDP 校正未生效`);
      if (!ccMatch) warns.push(`语言地区不一致(浏览器 ${langCC} ≠ IP ${geo.countryCode})`);
      if (geo.proxy) warns.push('IP 被标记为代理(proxy=true) → 加卡会被跳过，需换 proxy=false 环境');
      if (geo.hosting) warns.push('IP 被标记为机房/hosting(住宅代理更佳)');
      log(warns.length ? `指纹总览[一致性] ⚠ ${warns.join(' | ')}` : '指纹总览[一致性] ✓ 时区/语言地区/IP类型 均与出口 IP 对齐');
    } else {
      log('指纹总览[出口IP]: 地理查询失败(ip-api 不可达)，仅核对浏览器侧');
    }

    // 4) 渲染成人性化总览页（替换难看的 ip-api 裸 JSON），停留几秒让用户看清，再继续。
    await renderFingerprintOverviewPage(page, { fp, geo, warns, corrected, chromeVer }).catch(() => {});
    await page.waitForTimeout(3500);
  } catch (e) { log(`指纹总览异常：${e.message}`); }
}

// 把指纹总览渲染成一个深色卡片页（AdsPower 风格），替换 ip-api 的裸 JSON。
async function renderFingerprintOverviewPage(page, data) {
  await page.evaluate((d) => {
    const { fp, geo, warns, corrected, chromeVer } = d;
    const ok = geo && geo.status === 'success';
    const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #20242e"><span style="color:#8b93a7">${k}</span><span style="font-weight:600;text-align:right;word-break:break-all">${esc(v)}</span></div>`;
    const consistent = ok && !warns.length;
    const badge = consistent
      ? '<span style="background:#10381f;color:#37d67a;border:1px solid #1c5c34;padding:4px 12px;border-radius:999px;font-weight:700">✓ 指纹与出口 IP 一致</span>'
      : (corrected
        ? '<span style="background:#3a2f10;color:#e0b341;border:1px solid #6b531c;padding:4px 12px;border-radius:999px;font-weight:700">⚠ 已自动校正(时区→IP)</span>'
        : '<span style="background:#3a1414;color:#ff6b6b;border:1px solid #6b1c1c;padding:4px 12px;border-radius:999px;font-weight:700">⚠ 存在不一致</span>');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>指纹总览</title></head>
<body style="margin:0;background:#0b0d12;color:#e6e6e6;font:14px/1.5 system-ui,Segoe UI,Arial;min-height:100vh">
  <div style="max-width:880px;margin:0 auto;padding:28px 20px">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
      <div style="font-size:26px;font-weight:800">${ok ? esc(geo.query) : '指纹总览'}</div>
      ${ok ? `<div style="color:#8b93a7;font-size:15px">${esc(geo.country)} / ${esc(geo.regionName)} / ${esc(geo.city)}</div>` : ''}
    </div>
    <div style="margin:10px 0 22px">${badge}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
      <div style="background:#11141b;border:1px solid #20242e;border-radius:12px;padding:16px">
        <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#4f8cff">出口 IP（代理）</div>
        ${ok ? (
          row('IP', geo.query) + row('国家', geo.country + ' (' + geo.countryCode + ')') + row('州/城市', geo.regionName + ' / ' + geo.city) +
          row('邮编', geo.zip) + row('时区', geo.timezone) + row('ISP', geo.isp) +
          row('代理', String(geo.proxy)) + row('机房(hosting)', String(geo.hosting))
        ) : '<div style="color:#ff6b6b">地理查询失败（ip-api 不可达）</div>'}
      </div>
      <div style="background:#11141b;border:1px solid #20242e;border-radius:12px;padding:16px">
        <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#37d67a">浏览器指纹</div>
        ${row('内核', 'Chrome ' + chromeVer)}
        ${row('时区', fp.tz + (corrected && ok ? ' → 已校正 ' + geo.timezone : ''))}
        ${row('语言', fp.lang)}
        ${row('视口', fp.vw + ' × ' + fp.vh)}
        ${row('平台', fp.platform)}
        ${row('webdriver', String(fp.webdriver))}
        <div style="margin-top:8px;color:#8b93a7;font-size:12px;word-break:break-all">UA: ${esc(fp.ua)}</div>
      </div>
    </div>
    ${warns.length ? `<div style="margin-top:18px;background:#1b1410;border:1px solid #6b531c;border-radius:12px;padding:14px;color:#e0b341"><b>提示</b><ul style="margin:8px 0 0;padding-left:20px">${warns.map((w) => '<li>' + esc(w) + '</li>').join('')}</ul></div>` : ''}
    <div style="margin-top:18px;color:#5a6172;font-size:12px">指纹总览 · 即将继续 OpenRouter 流程…</div>
  </div>
</body></html>`;
    document.open(); document.write(html); document.close();
  }, data);
}

// ── S0: 代理/站点连通预检 ──────────────────────────────────────────────────
async function proxyPrecheck(ctx) {
  const { page, runtime, context } = ctx;
  const log = (context && context.log) || (() => {});
  const url = runtime.config?.site?.homeUrl || 'https://openrouter.ai';
  try {
    // 先做指纹总览核对（顺带会导航到 ip-api，再回到 openrouter 做连通预检）。
    await fingerprintOverview(page, log);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: runtime.config?.navigation?.entryGotoTimeoutMs || 30000 });
    if (!resp || resp.status() >= 400) return fail('PROXY_PRECHECK_BAD', 'OPENROUTER_HOME_UNREACHABLE', { status: resp && resp.status() });
    return ok('PROXY_PRECHECK_OK', { exitIp: runtime.ipCheck?.browserRuntimeIp || '' });
  } catch (e) {
    return fail('PROXY_CONNECTIVITY_FAILED', String(e.message || e));
  }
}

// ── S1: 邮箱改密（默认 skip，见 config.mailbox.passwordChangeMode）────────────
async function emailPasswordChange(ctx) {
  const mode = ctx.runtime.config?.mailbox?.passwordChangeMode || 'skip';
  if (mode === 'skip') return ok('MAILBOX_PASSWORD_SKIPPED', { skipped: true });
  // TODO(S1): 待用户提供 Firstmail 改密接口后实现。
  return ok('MAILBOX_PASSWORD_SKIPPED', { skipped: true, note: 'change mode not implemented' });
}

// 残留会话检测：导航到 OpenRouter，借 Clerk 读当前登录账号（环境可能带持久化 cookie/登录态）。
async function detectSession(page, cfg, log) {
  const home = (cfg.site && cfg.site.homeUrl) || 'https://openrouter.ai';
  if (!/openrouter\.ai/.test(page.url())) {
    await page.goto(`${home}/settings/keys`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  const info = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 24; i += 1) { if (window.Clerk && window.Clerk.loaded) break; await sleep(300); }
    const c = window.Clerk;
    if (!c) return { clerk: false };
    const u = c.user;
    if (!u) return { clerk: true, loggedIn: false };
    const em = (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress)
      || (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) || '';
    return { clerk: true, loggedIn: true, email: em };
  }).catch(() => ({ clerk: false }));
  if (info && info.clerk) {
    log(`会话检测：${info.loggedIn ? `已登录 ${info.email || '(读不到邮箱)'}` : '未登录'}`);
    return { loggedIn: !!info.loggedIn, email: info.email || '' };
  }
  const onAuth = await page.evaluate(() => /sign-in|sign-up/.test(location.pathname)).catch(() => false);
  log(`会话检测(兜底URL)：${onAuth ? '未登录' : '疑似已登录'}`);
  return { loggedIn: !onAuth, email: '' };
}

// 登出当前 Clerk 会话（清掉环境里上一个账号的登录态），并确认已登出。
async function clerkSignOut(page, cfg, log) {
  const home = (cfg.site && cfg.site.homeUrl) || 'https://openrouter.ai';
  try {
    await page.evaluate(async () => { try { if (window.Clerk && window.Clerk.signOut) await window.Clerk.signOut(); } catch (e) { /* ignore */ } });
    await page.waitForTimeout(2500);
  } catch (_e) { /* ignore */ }
  await page.goto(`${home}/settings/keys`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const out = await page.evaluate(() => {
    const noUser = !(window.Clerk && window.Clerk.user);
    const onAuth = /sign-in|sign-up/.test(location.pathname) || !!document.querySelector('#identifier-field, #password-field');
    return noUser || onAuth;
  }).catch(() => true);
  log(`登出${out ? '成功' : '未确认(继续尝试注册/登录)'}`);
  return out;
}

// ── S2: 注册 OpenRouter（填表 → 过 Turnstile → 提交);登录模式则直接登录已有账号 ──────
async function register(ctx) {
  const { page, account, runtime, context } = ctx;
  const cfg = runtime.config || {};
  const slog = (m) => context.log && context.log(`[register] ${m}`);

  // 残留会话检测：环境可能带着上一次的登录态（尤其 AdsPower 持久化指纹环境）。
  // 已登录目标账号 → 当登录成功跳过；登的是别的账号 → 先登出再走注册/登录。
  try {
    const sess = await detectSession(page, cfg, slog);
    if (sess.loggedIn && sess.email && sess.email.toLowerCase() === String(account.email).toLowerCase()) {
      slog(`环境已登录目标账号(${sess.email}) → 跳过注册/登录，直接进取 Key`);
      return ok('SIGNIN_OK', { loggedIn: true, alreadyLoggedIn: true });
    }
    if (sess.loggedIn) {
      slog(`环境登录的是别的账号(${sess.email || '未知'}) → 先登出再处理目标账号`);
      await clerkSignOut(page, cfg, slog);
    }
  } catch (e) { slog(`会话检测异常(忽略，按未登录处理)：${String((e && e.message) || e).slice(0, 80)}`); }

  // 登录模式:跳过注册,直接登录已有账号(登录成功 → S3 跳过 → 直接 S4 取 Key)。
  if ((runtime.taskParams?.mode) === 'login') {
    context.log && context.log('[register] 登录模式:直接登录已有账号');
    const si = await signInExisting(page, account, runtime, context);
    if (si.ok) return ok('SIGNIN_OK', { loggedIn: true });
    if (si.reason === 'ACCOUNT_NOT_ALLOWED' || si.reason === 'ACCOUNT_LOCKED') return fail(si.reason, si.reason);
    return fail('SIGNIN_FAILED', `SIGNIN_FAILED:${si.reason}`);
  }

  const signUpUrl = (cfg.site?.homeUrl || 'https://openrouter.ai') + '/sign-up';
  const { firstName, lastName } = deriveName(account.email);

  try {
    await page.goto(signUpUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navigation?.entryGotoTimeoutMs || 60000 });
    await page.waitForSelector('#emailAddress-field', { timeout: 25000 });
    await page.fill('#firstName-field', firstName).catch(() => {});
    await page.fill('#lastName-field', lastName).catch(() => {});
    await page.fill('#emailAddress-field', account.email);
    await page.fill('#password-field', openrouterPassword(runtime, account));
    await page.check('#legalAccepted-field').catch(() => {});
    await page.waitForTimeout(500);

    const cfUrls = context.cfRequestUrls || [];
    const tlog = (m) => context.log && context.log(`[turnstile] ${m}`);

    // 提交 → 触发 Turnstile
    await page.click('button:has-text("Continue")').catch(() => {});

    // 等 Turnstile 渲染并被钩子捕获(拿到 callback 才能真正提交)；中途若已跳验证页直接成功。
    let hookCaptured = false;
    for (let i = 0; i < 18 && !hookCaptured; i += 1) {
      await page.waitForTimeout(1000);
      if (/verify-email/.test(page.url())) return ok('REGISTER_SUBMIT_OK', { verifyUrl: page.url() });
      hookCaptured = await page.evaluate(() => !!(window.__cfParams && window.__cfParams.sitekey && typeof window.tsCallback === 'function')).catch(() => false);
      if (!hookCaptured && i === 8) await page.click('button:has-text("Continue")').catch(() => {});
    }
    // 钩子没抓到 callback → 注入无法提交,不浪费 2Captcha,直接失败让整账号换新浏览器重试。
    if (!hookCaptured) {
      tlog('未捕获 Turnstile callback,跳过求解,快速失败 → 换浏览器重试');
      return fail('TURNSTILE_CALLBACK_MISSING', 'TURNSTILE_CALLBACK_MISSING');
    }

    // 求解 + 注入(此时一定有 callback)
    const solveRes = await solveAndInject(page, {
      provider: cfg.captcha?.provider, apiKey: cfg.captcha?.apiKey, pageUrl: signUpUrl,
      cfRequestUrls: cfUrls, timeoutMs: cfg.captcha?.solveTimeoutMs || 120000, log: tlog,
    });
    if (!solveRes.ok) return fail('TURNSTILE_FAILED', solveRes.reason);

    await page.waitForTimeout(1200);
    if (/\/sign-up/.test(page.url()) && !/verify-email/.test(page.url())) {
      await page.click('button:has-text("Continue")').catch(() => {});
    }

    // 有 callback,注入后若成功会跳验证页；等 ~40s(并发下新账号到验证页可能较慢)。
    let explicitExists = false;
    for (let t = 0; t < 16; t += 1) {
      await page.waitForTimeout(2500);
      const url = page.url();
      if (/verify-email/.test(url)) return ok('REGISTER_SUBMIT_OK', { verifyUrl: url });
      if (!/sign-up/.test(url)) return ok('REGISTER_SUBMIT_OK', { url });
      const sig = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const errs = Array.from(document.querySelectorAll('.cl-formFieldErrorText, [role="alert"]')).map(e => e.innerText).join(' ');
        const all = t + ' ' + errs;
        if (/account is locked|too many (failed )?(attempts|requests)|try again in \d+ ?(minute|hour|second)/i.test(all)) return 'locked';
        if (/not allowed to access|is ?n'?t allowed|not permitted to access|access (is )?(denied|restricted)/i.test(all)) return 'notAllowed';
        if (/already exists|already registered|is taken|taken\.|that email address is taken|exists|registered/i.test(all)) return 'exists';
        return '';
      }).catch(() => '');
      if (sig === 'locked') { context.log && context.log('[register] 注册页:账号被锁'); return fail('ACCOUNT_LOCKED', 'ACCOUNT_LOCKED'); }
      if (sig === 'notAllowed') { context.log && context.log('[register] 注册页:账号被平台限制'); return fail('ACCOUNT_NOT_ALLOWED', 'ACCOUNT_NOT_ALLOWED'); }
      if (sig === 'exists') { explicitExists = true; break; }
    }

    // Turnstile 已过却没进验证页 → 极可能邮箱已注册(错误文案各异) → 登录兜底。
    context.log && context.log(`[register] 未进验证页(exists=${explicitExists}),尝试登录兜底…`);
    const si = await signInExisting(page, account, runtime, context);
    if (si.ok) return ok('SIGNIN_OK', { loggedIn: true });
    context.log && context.log(`[register] 登录兜底失败: ${si.reason}`);
    // 账号被锁/被平台限制 → 不重试(再试只会更糟/更久)。
    if (si.reason === 'ACCOUNT_NOT_ALLOWED' || si.reason === 'ACCOUNT_LOCKED') return fail(si.reason, si.reason);
    // 其它 → 可重试(整账号换浏览器再试)。
    return fail('REGISTER_NO_VERIFY_PAGE', 'REGISTER_SUBMIT_RESULT_UNKNOWN', { url: page.url(), signinReason: si.reason });
  } catch (e) {
    return fail('REGISTER_THREW', String(e.message || e));
  }
}

// 账号已存在时的登录回退：邮箱+密码 → (可能的)Turnstile → 邮箱验证码二次校验 → 确认登录。
async function signInExisting(page, account, runtime, context) {
  const cfg = runtime.config || {};
  const signinUrl = cfg.site?.signinUrl || ((cfg.site?.homeUrl || 'https://openrouter.ai') + '/sign-in');
  const mb = cfg.mailbox || {};
  const log = (m) => context.log && context.log(`[signin] ${m}`);
  try {
    const sinceTs = Date.now(); // 本次登录开始时间：只接受发件时间晚于它的验证码，避免抓到上一次的旧码
    await page.goto(signinUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#identifier-field', { timeout: 20000 }).catch(() => {});
    await page.fill('#identifier-field', account.email).catch(() => {});
    await page.click('button:has-text("Continue")').catch(() => {});
    await page.waitForTimeout(2000);
    await page.fill('#password-field', openrouterPassword(runtime, account)).catch(() => {});
    await page.click('button:has-text("Continue")').catch(() => {});
    await page.waitForTimeout(2500);

    // 快速判定"账号不存在/密码错"：避免给真·未注册账号白等验证码。
    const noAccount = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /couldn't find|couldn’t find|no account|not found|isn't right|incorrect|enter a correct/i.test(t);
    }).catch(() => false);
    if (noAccount) { log('账号不存在/密码错,放弃登录'); return { ok: false, reason: 'SIGNIN_NO_ACCOUNT' }; }

    // 轮询:登录页可能弹 Turnstile;捕获到回调就求解注入,直到进入二次校验页或已登录(~40s)。
    for (let i = 0; i < 20; i += 1) {
      const u = page.url();
      // 账号被锁(登录太频繁触发)或被平台限制 → 不可重试(再试只会更糟)。
      const block = await page.evaluate(() => {
        const t = document.body.innerText || '';
        if (/account is locked|too many (failed )?(attempts|requests)|try again in \d+ ?(minute|hour|second)/i.test(t)) return 'locked';
        if (/not allowed to access|is ?n'?t allowed|not permitted to access|access (is )?(denied|restricted)/i.test(t)) return 'notAllowed';
        return '';
      }).catch(() => '');
      if (block === 'locked') { log('账号被锁(登录过于频繁),不重试'); return { ok: false, reason: 'ACCOUNT_LOCKED' }; }
      if (block === 'notAllowed') { log('账号被平台限制(not allowed),永久失败'); return { ok: false, reason: 'ACCOUNT_NOT_ALLOWED' }; }
      if (!/sign-in|sign-up/.test(u)) break;        // 已离开登录页(可能直接登录成功)
      if (/factor-two|verify/.test(u)) break;        // 到邮箱验证码步骤
      const hooked = await page.evaluate(() => !!(window.__cfParams && window.__cfParams.sitekey && typeof window.tsCallback === 'function')).catch(() => false);
      if (hooked) {
        log('登录页 Turnstile,求解中…');
        const r = await solveAndInject(page, {
          provider: cfg.captcha?.provider, apiKey: cfg.captcha?.apiKey, pageUrl: signinUrl,
          cfRequestUrls: context.cfRequestUrls || [], timeoutMs: cfg.captcha?.solveTimeoutMs || 120000, log: (m) => log(`[turnstile] ${m}`),
        });
        if (r.ok) { await page.waitForTimeout(1200); await page.click('button:has-text("Continue")').catch(() => {}); }
      }
      await page.waitForTimeout(1500);
    }

    // 二次校验:邮箱验证码
    if (/factor-two|verify/.test(page.url())) {
      log('需要邮箱验证码,读取中…');
      // password=原邮箱密码;altPassword=统一密码(改密后邮箱真实密码已变成它)→ 原密码读不到自动换统一密码读,修复"改过密的号登录读不到 OTP"。
      const { code } = await waitForVerifyCode({ apiKey: mb.apiKey, email: account.email, password: mailboxPassword(runtime, account), altPassword: openrouterPassword(runtime, account), baseUrl: mb.apiBaseUrl, attempts: 14, intervalMs: 3000, sinceTs, log: (m) => log(`[mail] ${m}`) });
      if (!code) { log('未取到验证码'); return { ok: false, reason: 'SIGNIN_CODE_NOT_FOUND' }; }
      const otp = page.locator('input[inputmode="numeric"], input[name="code"], input[id*="code"], input[autocomplete="one-time-code"]').first();
      await otp.click({ timeout: 5000 }).catch(() => {});
      await page.keyboard.type(code, { delay: 120 }).catch(() => {});
      await page.waitForTimeout(2500);
      await page.click('button:has-text("Continue")').catch(() => {});
      await page.waitForTimeout(3500);
    }

    // 收紧确认:导航到 Keys 页,能进(未被弹回 sign-in)才算真正登录成功。
    const keysUrl = cfg.site?.keysUrl || 'https://openrouter.ai/settings/keys';
    await page.goto(keysUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const authed = await page.evaluate(() => !(/sign-in|sign-up/.test(location.pathname) || document.querySelector('#password-field, #identifier-field'))).catch(() => false);
    if (authed) return { ok: true };
    // 未登录成功:最后再查一次"被锁/被限制",否则按可重试的未确认处理。
    const fin = await page.evaluate(() => {
      const t = document.body.innerText || '';
      if (/account is locked|too many (failed )?(attempts|requests)|try again in \d+ ?(minute|hour|second)/i.test(t)) return 'ACCOUNT_LOCKED';
      if (/not allowed to access|is ?n'?t allowed|not permitted to access|access (is )?(denied|restricted)/i.test(t)) return 'ACCOUNT_NOT_ALLOWED';
      return '';
    }).catch(() => '');
    return { ok: false, reason: fin || 'SIGNIN_NOT_CONFIRMED' };
  } catch (e) {
    return { ok: false, reason: `SIGNIN_THREW:${String(e.message || e).slice(0, 80)}` };
  }
}

// ── S3: 邮箱验证（取 clerk 验证链接 → 同 context 打开 → 确认登录）────────────
async function magicLinkLogin(ctx) {
  const { page, account, runtime } = ctx;
  const cfg = runtime.config || {};
  const mb = cfg.mailbox || {};
  // 若 S2 已通过登录回退完成登录,则跳过邮箱链接验证。
  if (ctx.context?.stageResults?.register?.detail?.loggedIn) {
    return ok('MAGIC_LINK_SKIPPED_LOGGED_IN', { skipped: true });
  }
  try {
    const { link } = await waitForClerkVerifyLink({
      apiKey: mb.apiKey, email: account.email, password: mailboxPassword(runtime, account),
      baseUrl: mb.apiBaseUrl, attempts: 14, intervalMs: 3000,
      log: (m) => ctx.context.log && ctx.context.log(`[mail] ${m}`),
    });
    if (!link) return fail('VERIFY_LINK_NOT_FOUND', 'MAGIC_LINK_EMAIL_NOT_FOUND');

    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    await page.goto(cfg.site?.homeUrl || 'https://openrouter.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const signedIn = await page.evaluate(() => {
      const top = document.body.innerText.slice(0, 200);
      return !/Sign In|Sign Up/i.test(top) || !!document.querySelector('[data-clerk-user-button], .cl-userButton');
    }).catch(() => false);
    if (!signedIn) return fail('LOGIN_NOT_CONFIRMED', 'MAGIC_LINK_LOGIN_UNCONFIRMED', { url: page.url() });
    return ok('MAGIC_LINK_LOGIN_OK', { url: page.url() });
  } catch (e) {
    return fail('MAGIC_LINK_THREW', String(e.message || e));
  }
}

// ── S4: 创建并提取 API Key（best-effort，需实测细化选择器）────────────────────
// 向导确认进入、但没抓到明文 key 的哨兵返回值。caller 据此【快速失败走整账号重试】,
// 而不是掉进新版根本不存在的 New Key 路径(那会空耗 6×刷新后误报 API_KEY_MODAL_NOT_OPEN)。
const WIZARD_NO_KEY = '__WIZARD_NO_KEY__';

async function apiKey(ctx) {
  const { page, runtime } = ctx;
  // 阶段开关：未勾「取Key」→ 跳过（显式 off 优先于续跑复用）。
  if (runtime.taskParams && runtime.taskParams.doApiKey === false) {
    return ok('API_KEY_SKIPPED', { apiKey: '' });
  }
  // 断点续跑：已有 Key → 复用，跳过新建（绝不重复建 Key）。
  const ps = runtime.priorState;
  if (runtime.resume !== false && ps && ps.apiKey) {
    ctx.context.log && ctx.context.log('[apikey] 续跑：复用已存 Key，跳过新建');
    // 【关键】复用key仍要补完可能未完成的 onboarding 向导:之前若卡在问卷(旧DOM点击),onboarding 没走完,
    //   再跑复用key跳过向导→billing 导航被打回未完成向导→地址绑不上(BILLING_ERROR)。这里导航到 keys 页,
    //   有向导就用原生click走完(Individual/问卷/Go to Dashboard);老号/已完成的→无向导,快速返回不影响。
    try {
      const ku = runtime.config?.site?.keysUrl || 'https://openrouter.ai/settings/keys';
      const rl = (m) => { try { console.error('[pw] [wizard] ' + m); } catch (_e) {} ctx.context.log && ctx.context.log(`[apikey] ${m}`); };
      await page.goto(ku, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const did = await completeOnboardingIfPresent(page, rl);
      if (did) rl('复用key路径:补完了未完成的 onboarding 向导');
    } catch (_e) { /* 补完失败不阻断:billing 阶段还会再撞,这只是提前清障 */ }
    return ok('API_KEY_REUSED', { apiKey: ps.apiKey, apiKeyName: ps.apiKeyName || '', expiration: ps.expiration || '' });
  }
  const cfg = runtime.config || {};
  const keysUrl = cfg.site?.keysUrl || 'https://openrouter.ai/settings/keys';
  // 名称随机：表单未填则每个 key 生成不同的随机名。
  const keyName = (runtime.taskParams?.apiKeyName || '').trim() || generateRandomKeyName();
  const expiration = runtime.taskParams?.apiKeyExpiration || 'No expiration';
  const log = (m) => ctx.context.log && ctx.context.log(`[apikey] ${m}`);
  const dumpDom = async (tag) => {
    const d = await page.evaluate(() => ({
      url: location.href,
      buttons: Array.from(document.querySelectorAll('button')).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 40),
      inputs: Array.from(document.querySelectorAll('input,textarea')).map(i => ({ t: i.type, n: i.name, id: i.id, ph: i.placeholder })).slice(0, 30),
    })).catch(() => null);
    if (d) log(`${tag} url=${d.url} buttons=${JSON.stringify(d.buttons)} inputs=${JSON.stringify(d.inputs)}`);
  };

  try {
    await dismissOnboarding(page);
    await page.goto(keysUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 若被重定向回 sign-in,说明会话无效(未真正登录)→ 快速失败,交给整账号重试,别干等。
    const onSignin = await page.evaluate(() => /sign-in|sign-up/.test(location.pathname) || !!document.querySelector('#password-field, #identifier-field')).catch(() => false);
    if (onSignin) { await dumpDom('apikey-not-logged-in'); return fail('API_KEY_NOT_LOGGED_IN', 'API_KEY_NOT_LOGGED_IN'); }

    await dismissOnboarding(page);

    // 新号 onboarding 向导(Welcome→选 Individual→"workspace is ready" 自动给一把 key→payment 步)。
    // 全新号【没有 New Key 按钮】,走向导直接抓 key;抓到就返回,不再去点根本不存在的 New Key。
    {
      const wkey = await handleOnboardingWizard(page, log).catch(() => '');
      if (wkey && wkey !== WIZARD_NO_KEY) {
        try { console.error('[pw] APIKEY_CREATED ' + wkey); } catch (_e) {}
        return ok('API_KEY_OK', { apiKey: wkey, apiKeyName: 'onboarding', expiration });
      }
      // 向导确认进了但没抓到 key → 别去点新版不存在的 New Key(空耗6×刷新误报 MODAL_NOT_OPEN),直接快速失败走整账号重试
      if (wkey === WIZARD_NO_KEY) {
        await dumpDom('wizard-no-key');
        return fail('API_KEY_WIZARD_KEY_NOT_CAPTURED', 'API_KEY_WIZARD_KEY_NOT_CAPTURED');
      }
    }

    // 打开新 Key 弹窗 —— 引导浮层(You're all set)常拦截点击,故每次先关浮层、滚动入视图、
    // 普通点击失败再强制点击;重试至 #name 出现(最多 4 次)。
    // 取 key 弹窗:高并发(conc=10)页面慢 → 按钮没渲染/弹窗没出就误判 API_KEY_MODAL_NOT_OPEN(实测 conc=1 一次必成)。
    // 加韧性:① 点前先【等 New Key 按钮可见】(页面真加载好);② 重试 6 次、#name 等到 10s;
    //        ③ 按钮没出 / 点两轮还没弹窗 → 【刷新 keys 页重载】(对慢/半加载最对症,跟卡表单兜底同理)。
    const NEWKEY_SEL = 'button:has-text("New Key"), button:has-text("Create Key"), button:has-text("Create API Key")';
    const MAX_NEWKEY_TRY = parseInt(process.env.NEWKEY_TRIES || '6', 10);
    let modalOpen = false;
    for (let attempt = 0; attempt < MAX_NEWKEY_TRY && !modalOpen; attempt += 1) {
      await dismissOnboarding(page);
      const btnVisible = await page.waitForSelector(NEWKEY_SEL, { state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
      if (!btnVisible) {
        log(`new-key 按钮没出(第${attempt + 1}次)→ 刷新 keys 页重载`);
        await page.goto(keysUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
        continue;
      }
      const newKeyBtn = page.locator(NEWKEY_SEL).first();
      await newKeyBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      let clicked = await newKeyBtn.click({ timeout: 6000 }).then(() => true).catch(() => false);
      if (!clicked) clicked = await newKeyBtn.click({ timeout: 5000, force: true }).then(() => true).catch((e) => { log(`new-key click attempt ${attempt + 1}: ${e.message}`); return false; });
      modalOpen = await page.waitForSelector('#name', { state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
      // 加固:改版后命名框可能不叫 #name(placeholder 变 "Untitled key"、浮动 label 致 placeholder 空、Radix portal 无 name 元数据)→
      //   #name 等不到时,只要【确实打开的 dialog/modal 内】有可见非search文本输入就算弹窗已开(严格超集:排账单弹窗+search+combobox)。
      //   带 #name 的老号上面已 true,不进此分支,行为逐字不变。与 selenium steps_key.py 同一套判据。
      if (!modalOpen) {
        modalOpen = await page.evaluate(() => {
          try {
            const mods = [].slice.call(document.querySelectorAll('[role=dialog],[aria-modal="true"],[data-state="open"][class*=ontent],[class*=modal i],[class*=overlay i],[class*=Dialog i]'));
            for (const m of mods) {
              if (m.offsetParent === null && getComputedStyle(m).position !== 'fixed') continue;
              const r = m.getBoundingClientRect(); if (r.width < 40 || r.height < 40) continue;
              const tx = (m.innerText || '').toLowerCase();
              if (/payment|card number|add a payment|billing address|update address|verify your identity|cardholder|expiry|cvc|postal code|zip/.test(tx)) continue;
              for (const e of m.querySelectorAll('input,textarea')) {
                if (e.offsetParent === null) continue;
                const t = (e.type || 'text').toLowerCase();
                if (['search', 'hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(t)) continue;
                const em = ((e.id || '') + ' ' + (e.getAttribute('name') || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('role') || '')).toLowerCase();
                if (/search|combobox|listbox/.test(em)) continue;
                const ec = getComputedStyle(e); if (ec.visibility === 'hidden' || ec.display === 'none') continue;
                const br = e.getBoundingClientRect(); if (br.width < 30 || br.height < 8) continue;
                return true;
              }
            }
          } catch (_e) { /* 异常静默回落原行为 */ }
          return false;
        }).catch(() => false);
        if (modalOpen) log('new-key 命名框非 #name(改版)→ 按弹窗内文本框判定弹窗已开');
      }
      if (!modalOpen && attempt >= 1) {   // 点两轮还没弹窗 → 刷新 keys 页重载再来
        log(`new-key 弹窗没出(第${attempt + 1}次)→ 刷新 keys 页重载`);
        await page.goto(keysUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
    if (!modalOpen) { await dumpDom('newkey-modal-not-open'); return fail('API_KEY_MODAL_NOT_OPEN', 'API_KEY_MODAL_NOT_OPEN'); }

    // 名称（#name）—— Create 按钮在填名后才启用。#name 不在(改版)时退【弹窗内首个非search文本框】填名,
    //   配合上面 modalOpen 的 dialog-open 兜底,保证「弹窗已开但命名框不叫 #name」也能填上。老号 #name 5s 内必成,不进退路。
    const _nameFilled = await page.fill('#name', keyName, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!_nameFilled) {
      const _dlgName = page.locator('[role=dialog] input[type=text]:not([role=combobox]), [aria-modal="true"] input[type=text]:not([role=combobox]), [role=dialog] input:not([type]):not([role=combobox]):not([type=search]), [aria-modal="true"] input:not([type]):not([role=combobox]):not([type=search]), [role=dialog] textarea, [aria-modal="true"] textarea').first();
      const _ok2 = await _dlgName.fill(keyName, { timeout: 5000 }).then(() => true).catch(() => false);
      if (!_ok2) { await _dlgName.click({ timeout: 3000 }).catch(() => {}); await page.keyboard.type(keyName).catch(() => {}); }
      log('new-key 命名框非 #name → 退弹窗内文本框填名');
    }
    await page.waitForTimeout(400);

    // 有效期（base-ui Select）—— 总是显式选择，确保所选即所得（含「永不过期」）。
    await selectExpiration(page, expiration || 'No expiration', log);

    // 提交创建
    await page.locator('button:has-text("Create")').last().click({ timeout: 10000 });
    await page.waitForTimeout(3000);

    // 抓一次性展示的 key（sk-or-...）
    const key = await page.evaluate(() => {
      const m = document.body.innerText.match(/sk-or-[A-Za-z0-9-]{20,}/);
      if (m) return m[0];
      const v = Array.from(document.querySelectorAll('input,textarea,code')).map(i => i.value || i.textContent).find(x => /sk-or-/.test(x || ''));
      return v || '';
    }).catch(() => '');

    if (!key) { await dumpDom('apikey-not-captured'); return fail('API_KEY_NOT_CAPTURED', 'API_KEY_CAPTURE_FAILED', { keyName }); }
    // 抓到 key 当场打 stderr 标记:即便随后(绑地址等)超时被 Python 强杀,Python 也能从已捕获的
    // stderr 里正则抢救这把已建出的 key,接管续跑,避免重试重建第二把、首把成孤儿。
    try { console.error('[pw] APIKEY_CREATED ' + key); } catch (_e) {}
    return ok('API_KEY_OK', { apiKey: key, apiKeyName: keyName, expiration });
  } catch (e) {
    await dumpDom('apikey-threw');
    return fail('API_KEY_THREW', String(e.message || e));
  }
}

// 关闭注册后会出现、且会拦截点击的各种引导浮层/弹窗。
async function dismissOnboarding(page) {
  try {
    // 1) 新用户问卷:"Where did you first hear about OpenRouter?"(须选一项 + Continue)
    const survey = page.locator('text=Where did you first hear about OpenRouter');
    if (await survey.count()) {
      await page.getByText('Other / Not sure', { exact: false }).click({ timeout: 4000 }).catch(() => {});
      await page.getByRole('button', { name: 'Continue' }).click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    // 2) "You're all set! ... buying credits and creating an API key" 引导浮层 —— 会盖住 New Key 按钮。
    //    用 DOM 直接找浮层的关闭按钮(× / aria-label=Close)点掉;并对其根节点隐藏兜底。
    await page.evaluate(() => {
      const txt = 'all set';
      const blocks = Array.from(document.querySelectorAll('div,section,aside'))
        .filter(el => /all set|buying credits|creating an api key/i.test(el.innerText || '') && el.querySelector('button'));
      for (const b of blocks.slice(0, 3)) {
        const closeBtn = Array.from(b.querySelectorAll('button')).find(x => {
          const t = (x.innerText || x.getAttribute('aria-label') || '').trim();
          return /^(×|✕|x|close|dismiss|maybe later|skip|got it|later)$/i.test(t) || x.getAttribute('aria-label') === 'Close';
        });
        if (closeBtn) { closeBtn.click(); }
      }
    }).catch(() => {});
    // 3) Account/Profile 详情弹窗（点头像误开 / 自动弹）会盖住「Add a Payment Method」→ 必须先关掉。
    //    用更宽的关闭按钮匹配：aria-label=Close / ×/✕ / 右上角只含 svg 的小按钮。
    await page.evaluate(() => {
      const PROFILE = /Profile details|Manage your account info|Connected accounts|Web3 wallets/i;
      const BILLING = /Billing Address|Payment Method|Add Credits|Buy Credits|Purchase Credits|Address line|card number|Total due/i;
      const dlgs = Array.from(document.querySelectorAll('[role="dialog"],[class*="modal" i]'));
      for (const d of dlgs) {
        const t = d.innerText || '';
        if (!PROFILE.test(t) || BILLING.test(t)) continue; // 只关 Profile，绝不关账单弹窗
        let btn = d.querySelector('button[aria-label="Close" i], button[aria-label="close" i]');
        if (!btn) btn = Array.from(d.querySelectorAll('button')).find((b) => /^(×|✕|x|close)$/i.test((b.innerText || '').trim()));
        if (!btn) btn = Array.from(d.querySelectorAll('button')).find((b) => b.querySelector('svg') && !(b.innerText || '').trim());
        if (btn) btn.click();
      }
    }).catch(() => {});
    // 4) 通用:关掉残留的引导浮层，但**绝不**关账单相关弹窗(地址/付款/购买)——那是我们要填的。
    await page.evaluate(() => {
      const BILLING = /Billing Address|Payment Method|Add Credits|Buy Credits|Purchase Credits|Address line|card number|Total due/i;
      document.querySelectorAll('[role="dialog"]').forEach((dlg) => {
        if (BILLING.test(dlg.innerText || '')) return; // 跳过账单弹窗，别误关
        dlg.querySelectorAll('button[aria-label="Close"], button[aria-label="close"]').forEach((b) => b.click());
      });
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// 新号 onboarding 向导:OpenRouter 现在对全新号走引导向导(Welcome to OpenRouter →
// "How will you be using OpenRouter?" 选 Individual → "Your workspace is ready" 自动生成一把 API Key
// → "Add a payment method")。新号【根本没有 New Key 按钮】,所以旧的"点 New Key 开弹窗"必然失败
// (API_KEY_MODAL_NOT_OPEN)。本函数:在向导里选 Individual → 等 key 出现 → 直接抓 key(向导页/示例代码里
// 有完整 sk-or-),再把向导(含 payment 步)推过去。抓到 key 返回它,否则返回 ''(让调用方回退走 New Key 流程)。
// 把新号 onboarding 向导【剩余步骤全部推完】(可从任意中间步进入,故复用key路径也能调它补完未走完的onboarding)。
// 步骤:Welcome→Individual / payment&credits→I'll do this later / 问卷→选项+Continue / all-set→Go to Dashboard。
// 【关键】全程 Playwright 原生 click —— React 控件(Individual卡片/问卷radio)用 evaluate().click() 点 DOM 不触发 onChange,
//   会让 Continue 一直灰、卡在该步 → onboarding 走不完 → 新号 billing 被打回向导 → 地址绑不上。无向导时快速返回 false。
async function completeOnboardingIfPresent(page, L) {
  let acted = false;
  for (let i = 0; i < 10; i += 1) {
    const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/You['’]re all set|Go to Dashboard/i.test(body)) {
      await page.getByRole('button', { name: /Go to Dashboard/i }).first().click({ timeout: 4000 })
        .catch(() => page.getByText('Go to Dashboard', { exact: false }).first().click({ timeout: 4000 }).catch(() => {}));
      L && L('向导已收尾(Go to Dashboard)'); acted = true; await page.waitForTimeout(1000); break;
    }
    // 问卷:必须【原生点】一个 radio 选项(否则 Continue 灰),再点 Continue。Other/Not sure 优先(可能在滚动区下,原生click自动滚入)。
    if (/first hear about OpenRouter/i.test(body)) {
      let opt = page.getByText('Other / Not sure', { exact: false }).first();
      if (!(await opt.count().catch(() => 0))) opt = page.getByText('Google', { exact: true }).first();
      if (!(await opt.count().catch(() => 0))) opt = page.locator('[role="radio"], input[type="radio"]').first();
      await opt.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /^Continue$/i }).first().click({ timeout: 4000 }).catch(() => {});
      L && L('问卷:已原生选项+Continue'); acted = true; await page.waitForTimeout(1300); continue;
    }
    // payment/credits:点 "I'll do this later" 跳过(账单/加卡走后续阶段,不在向导填卡)
    const later = page.getByText(/I['’`]?ll do this later|do this later|Skip for now|Maybe later/i).first();
    if (await later.count().catch(() => 0)) {
      await later.click({ timeout: 4000 }).catch(() => {});
      L && L('payment/credits 步:I\'ll do this later'); acted = true; await page.waitForTimeout(1300); continue;
    }
    // Welcome 步(复用key路径可能从头进):原生点 Individual 卡片
    if (/How will you be using OpenRouter/i.test(body)) {
      const ind = page.getByText('Build side projects', { exact: false }).first();
      if (await ind.count().catch(() => 0)) { await ind.click({ timeout: 4000 }).catch(() => {}); L && L('已点 Individual(原生click)'); acted = true; await page.waitForTimeout(2200); continue; }
    }
    // 中间步:点可用的 Continue 推进
    const cont = page.getByRole('button', { name: /^Continue$/i }).first();
    if ((await cont.count().catch(() => 0)) && (await cont.isEnabled().catch(() => false))) {
      await cont.click({ timeout: 4000 }).catch(() => {}); acted = true; await page.waitForTimeout(1300); continue;
    }
    break;   // 没有可推进的向导元素 → 不在向导/已到 dashboard
  }
  return acted;
}

async function handleOnboardingWizard(page, log) {
  // L() 同时打到 stderr([pw] 前缀会被 Python 镜像回 diag 日志),便于排查向导卡在哪一步(否则只在 Node 内部日志看不到)。
  const L = (m) => { try { console.error('[pw] [wizard] ' + m); } catch (_e) {} if (log) log(`[apikey] ${m}`); };
  try {
    // 新版引导(/workspaces/default/keys)已是新号默认/强制流程;高并发下页面渲染慢,
    // 一次性读 body 会在没渲染好时误判"非向导"→ 掉进新流程里【根本不存在的 New Key 路径】而失败
    // (conc=10 那批 API_KEY_MODAL_NOT_OPEN 多半就是这么来的)。
    // 【按页面内容判,绝不按 URL 判】:新版 keys 页 URL 现在就是 /workspaces/default/keys —— 完成 onboarding 的
    //   【老号】也在这个 URL,但它显示的是带 "+ New Key" 按钮的 dashboard(走老 New Key 流程),不是向导!
    //   所以 ① 不能用 onWorkspaces URL 当向导依据;② 向导文案不能含 "Your API Key"(dashboard 的 "manage your API keys" 会误命中)。
    //   判据:有真·向导文案 → 走向导;有 "New Key" 按钮且无向导文案 → 交回 New Key 流程(老号/已建过key的号)。轮询抗慢。
    let inWizard = false;
    for (let i = 0; i < 14 && !inWizard; i += 1) {
      const sig = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return {
          wiz: /How will you be using OpenRouter|Welcome to OpenRouter|Your workspace is ready|workspace is ready|first hear about OpenRouter|You['’]re all set/i.test(t),
          hasNewKey: !!Array.from(document.querySelectorAll('button')).find((b) => /New Key|Create Key|Create API Key/i.test(b.innerText || '')),
        };
      }).catch(() => ({ wiz: false, hasNewKey: false }));
      if (sig.wiz) { inWizard = true; break; }                       // 真·向导文案 → 走向导
      if (sig.hasNewKey) { L('有 New Key 按钮且无向导文案(老号/已完成onboarding,新URL也在/workspaces)→ 交回 New Key 流程'); return ''; }
      await page.waitForTimeout(1500);
    }
    if (!inWizard) { L('轮询期满:既无向导文案也无 New Key 按钮(页面慢/异常)→ 回退 New Key 流程'); return ''; }
    L('检测到新号 onboarding 向导 → 走向导直接抓 key');
    // 1+2) 选 Individual 并等明文 key 出现。【关键】Individual 点击常没生效(慢页/浮层/未水合)→ 之前
    //      点一次就死等 key,没出就误判→掉死路。改为:在抓 key 的轮询里只要还停在 "How will you be using"
    //      就【反复重点 Individual】,直到 "workspace is ready" 给出明文 key;并加 Copy 按钮+剪贴板兜底。
    let key = '';
    for (let i = 0; i < 18 && !key; i += 1) {
      // 还停在选择步 → (重)点 Individual。【关键】卡片是 div,用 evaluate().click() 点 DOM 常【不触发 React onClick】
      //   (实测 beverlyhilser 撞3次才中、miracordes 一直卡死)→ 改用 Playwright 原生 click(真实鼠标事件 + actionability 等待,必触发)。
      //   优先点卡片里唯一的描述文字 "Build side projects"(点它会冒泡到卡片 onClick),再退 role/文本兜底。
      const needPick = await page.evaluate(() => /How will you be using OpenRouter/i.test(document.body.innerText || '')).catch(() => false);
      if (needPick) {
        let picked = false;
        const candidates = [
          page.getByText('Build side projects', { exact: false }),
          page.getByRole('button', { name: /Individual/i }),
          page.locator('button:has-text("Individual"), [role="button"]:has-text("Individual"), a:has-text("Individual")').first(),
          page.getByText('Individual', { exact: true }),
        ];
        for (const c of candidates) {
          if (await c.count().catch(() => 0)) {
            picked = await c.first().click({ timeout: 4000 }).then(() => true).catch(() => false);
            if (picked) break;
          }
        }
        L(picked ? '已点 Individual(原生click)' : '没点中 Individual 卡片(继续轮询重试)');
        await page.waitForTimeout(2800);
      }
      // 抓完整明文 sk-or-(掩码的 ••• 不会匹配;明文在 "Your workspace is ready" 的 fetch 示例 code/pre 里)
      key = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const m = body.match(/sk-or-[A-Za-z0-9-]{24,}/);
        if (m) return m[0];
        const v = Array.from(document.querySelectorAll('input,textarea,code,pre'))
          .map((el) => el.value || el.textContent || '').find((x) => /sk-or-[A-Za-z0-9-]{24,}/.test(x));
        const mm = v && v.match(/sk-or-[A-Za-z0-9-]{24,}/);
        return mm ? mm[0] : '';
      }).catch(() => '');
      if (key) break;
      // 注:不读剪贴板兜底 —— navigator.clipboard.readText() 会弹 Chrome 权限框("…wants to see clipboard")把向导页卡死(hybrid侧同 Selenium)。
      //   明文 key 就在 "workspace is ready" 的 fetch 示例 code/pre 里,上面的纯文本匹配已足够。
      await page.waitForTimeout(2000);
    }
    if (!key) {
      // 向导确实进了(inWizard=true)但没抓到 key → dump 当前页面状态,定位卡在哪一步(Individual 没点中 / 到了 workspace-ready 但只有掩码 / 别的页)。
      const dbg = await page.evaluate(() => {
        const body = document.body.innerText || '';
        return {
          url: location.href,
          onIndividual: /How will you be using OpenRouter/i.test(body),
          onWorkspaceReady: /workspace is ready|Your API Key/i.test(body),
          hasMasked: /sk-or-[A-Za-z0-9]*[•·\*]{2,}/.test(body),
          buttons: Array.from(document.querySelectorAll('button,[role="button"]')).map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 14),
          head: body.slice(0, 240).replace(/\s+/g, ' '),
        };
      }).catch(() => ({}));
      L('向导内没抓到明文 key,dump=' + JSON.stringify(dbg));
      // 【绝不】回退到新版根本不存在的 New Key 路径(会空耗 6×刷新后误报 MODAL_NOT_OPEN)。返回哨兵让 caller 快速失败重试。
      L('→ 返回哨兵,快速失败走整账号重试(不进 New Key 死路)');
      return WIZARD_NO_KEY;
    }
    L('向导抓到 key ✓');
    // 3) 把向导剩余步骤全部推完(原生click,见 completeOnboardingIfPresent 注释:React 控件 DOM click 不触发→卡死)。
    await completeOnboardingIfPresent(page, L);
    await page.waitForTimeout(600);
    return key;
  } catch (e) {
    L('向导处理异常: ' + String(e.message || e).slice(0, 90));
    return '';
  }
}

// 点 "Your API Key" 旁的 Copy 复制按钮 → 读剪贴板抓完整明文 key(掩码情况下的兜底)。
// 读剪贴板需 context 已授 clipboard-read(adspower/persistent context 多数允许);拿不到就静默返回空,不报错。
async function _copyKeyFromClipboard(page) {
  try {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find((b) => /^copy$/i.test((b.innerText || '').trim()) || /copy/i.test(b.getAttribute('aria-label') || ''));
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForTimeout(400);
    const txt = await page.evaluate(() => navigator.clipboard.readText().then((s) => s || '').catch(() => '')).catch(() => '');
    const m = (txt || '').match(/sk-or-[A-Za-z0-9-]{24,}/);
    return m ? m[0] : '';
  } catch (_e) { return ''; }
}

// 在 New Key 弹窗里选择有效期（base-ui Select：点 combobox → 点选项）。
async function selectExpiration(page, expiration, log) {
  try {
    // combobox 当前显示 "No expiration"
    const combo = page.locator('button:has-text("No expiration"), [role="combobox"]:has-text("No expiration")').last();
    await combo.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    // 选项列表里点对应项（精确匹配，避免 "1 day" 命中 "1 day"... 用 role=option 精确）
    const opt = page.getByRole('option', { name: expiration, exact: true });
    if (await opt.count()) await opt.click({ timeout: 4000 });
    else await page.getByText(expiration, { exact: true }).last().click({ timeout: 4000 });
    await page.waitForTimeout(400);
  } catch (e) {
    log && log(`expiration select miss: ${e.message}`);
  }
}

// ── S5/S6 占位（按用户要求先做到 S4）────────────────────────────────────────
// ── S5: 充值（账单地址 + 卡池加卡 + 购买额度）─────────────────────────────────
// 流程对标用户截图：/settings/credits → Add Credits → [Add Billing Address] →
// [Add Payment Method(银行卡)] → [Purchase Credits]。成功标志：弹出
// “Your payment is processing / Credits will be added” 页面(JS alert 或 toast)。
//
// 失败语义(默认 soft)：账号+Key 已是有价产物，充值失败不回退整账号——仍返回 ok，
// 只在 detail.billingStatus 标 success/declined/no-card/no-address/skipped。
async function billing(ctx) {
  const { page, account, runtime, context } = ctx;
  const cfg = runtime.config || {};
  const tp = runtime.taskParams || {};
  // 诊断:billing 日志同时打 stderr([pw] 前缀会被 Python 镜像回 diag 日志),便于看 modal 状态机/BILLING_ERROR 具体卡在哪。
  const log = (m) => { try { console.error('[pw] [billing] ' + m); } catch (_e) {} if (context.log) context.log(`[billing] ${m}`); };

  // 累进式动作：none < address < card < charge。每级包含前一级。
  //   none    : 不碰账单/卡/扣费(只注册+取Key)
  //   address : 仅绑定账单地址
  //   card    : 绑定地址 + 加卡(不扣费)
  //   charge  : 绑定地址 + 加卡 + 真实充值
  const action = resolveBillingAction(tp);
  // 断点续跑：账单已达所选等级 → 跳过（关键：charge×success 不复扣费）。
  const ps = runtime.priorState;
  if (runtime.resume !== false && ps && ps.billingStatus && accountStore.billingSatisfied(ps.billingStatus, action)) {
    log(`续跑：账单已达「${action}」(${ps.billingStatus})，跳过`);
    return ok('BILLING_RESUMED', { billingStatus: ps.billingStatus, charged: ps.charged || 0, cardLast4: ps.cardLast4 || '' });
  }
  if (action === 'none') return ok('BILLING_SKIPPED', { billingStatus: 'skipped', charged: 0 });

  const doCard = action === 'card' || action === 'charge';
  const doPurchase = action === 'charge';
  const amount = Math.max(0, Number(tp.topUpAmount) || 0);
  if (doPurchase && amount < 5) {
    log(`充值金额 $${amount} < 最低 $5，跳过`);
    return softBilling(cfg, 'skipped', action);
  }

  // 充值台账：每个账号终态记一条，避免糊涂账(哪个邮箱/哪张卡/多少钱/成败)。
  const recordBilling = async (result, charged, cardLast4, error) => {
    try {
      const declineCode = result === 'declined' ? (classifyDecline(error) || 'generic_decline') : '';   // 拒付具体原因(insufficient_funds vs 风控);兜底 generic_decline 保证每个 declined 有码
      await billingLedger.record({ email: account.email, result, charged: charged || 0, cardLast4: cardLast4 || '', jobId: context.jobId || '', error, declineCode });
      context.onBilling && context.onBilling(billingLedger.summary(), { email: account.email, result, charged: charged || 0, cardLast4: cardLast4 || '' });
    } catch (_e) { /* ignore */ }
  };

  // 浏览器/页面已关（崩溃或被手动关闭）→ 别再取卡空跑（会白白消耗卡用量），直接清晰收口。
  if (page.isClosed()) {
    log('页面/浏览器已关闭，跳过账单（不消耗卡）');
    await recordBilling('no-card', 0, '', 'PAGE_CLOSED');
    return softBilling(cfg, 'page-closed', action);
  }

  // 账单地址：默认随机生成(免税州)，每个账号一条；'pool' 模式才用手动地址池。
  let address;
  if ((tp.addressMode || 'random') === 'pool') {
    const addresses = Array.isArray(tp.billingAddresses) ? tp.billingAddresses : [];
    address = pickAddress(addresses, tp.billingAddressStrategy || 'random', context.workerId || 0);
    if (!address) {
      log('地址池为空(手动模式) → 跳过，账号(含Key)仍交付');
      await recordBilling('no-address', 0, '');
      return softBilling(cfg, 'no-address', action);
    }
  } else {
    address = generateAddress({ states: tp.addressStates });
    log(`随机账单地址: ${address.name} / ${address.line1}, ${address.city}, ${address.state} ${address.zip}`);
  }

  const manualCardPick = !!tp.manualCardPick;
  // 实测(本会话):AdsPower 干净指纹下付款 hCaptcha 也【不会被动通过】——不解则点 Save 弹窗永远停在 payment、
  //   提交不出去(2captcha 解了才 hadCallback=true、Save 才真正提交)。故【默认求解】;仅显式 skipCaptchaSolve:true 才跳过。
  const skipCaptchaSolve = tp.skipCaptchaSolve === true;
  // 填卡引擎(可逗号链，如 "playwright,osinput")；服务端已白名单，缺省 playwright。
  const cardFillEngine = tp.cardFillEngine || 'playwright';
  const steps = { doAddress: true, doCard, doPurchase, manualCaptchaFallback: !!tp.manualCaptchaFallback, manualBillingFallback: !!tp.manualBillingFallback, manualCardPick, skipCaptchaSolve, cardFillEngine, humanLike: tp.humanLike === true };

  // 仅绑定地址(不加卡)：无需取卡，直接走地址流程。
  if (!doCard) {
    let outcome;
    try { outcome = await runBillingFlow(page, null, address, 0, cfg, log, steps, runtime); }
    catch (e) { outcome = { result: 'error', error: String(e.message || e).slice(0, 200) }; }
    const status = outcome.result === 'address-bound' ? 'address-bound' : outcome.result;
    await recordBilling(status, 0, '', outcome.error);
    if (status === 'address-bound') { log('✓ 账单地址已绑定'); return ok('BILLING_OK', { billingStatus: 'address-bound', charged: 0, cardLast4: '' }); }
    return softBilling(cfg, status, action);
  }

  // 脏IP保护：**默认关闭**。实测证明 proxy=true 的 AdsPower 环境手动也能加卡成功，
  // 之前默认跳过是基于错误判断(以为 proxy=true 必拒)，反而把能用的环境全拦死。
  // 只有用户**显式勾选**「脏IP跳过加卡」时才跳过；否则照常加卡(真正的 502 病因已在代码层修复)。
  const ipGeo = page._ipGeo || null;
  const dirtyIp = ipGeo && (ipGeo.proxy || ipGeo.hosting);
  if (dirtyIp && tp.skipCardOnDirtyIp === true) {
    const tag = [ipGeo.proxy ? '代理(proxy)' : '', ipGeo.hosting ? '机房(hosting)' : ''].filter(Boolean).join('+');
    log(`出口IP ${ipGeo.query} 被标记为${tag} → Stripe 加卡几乎必拒，跳过加卡(不烧卡)。请换一个 proxy=false 的干净住宅IP。`);
    await recordBilling('dirty-ip', 0, '', `DIRTY_IP:${tag}:${ipGeo.query}`);
    return softBilling(cfg, 'dirty-ip', action);
  }

  // 需要加卡(card / charge)：从卡池取卡，被拒自动换下一张。
  const maxCardTries = Math.max(1, Number(tp.maxCardTries) || cfg.billing?.maxCardTries || 3);
  const pushCard = (last4, result, error) => {
    try { context.onCard && context.onCard(cardPool.snapshot(), { last4, result, error: error || '' }); } catch (_e) { /* ignore */ }
  };

  let lastResult = 'no-card';
  for (let tryN = 1; tryN <= maxCardTries; tryN += 1) {
    if (page.isClosed()) { log('页面/浏览器已关闭，停止试卡（不消耗卡）'); lastResult = 'page-closed'; break; }

    let card;
    const picked = { card: null }; // 手动选卡：由 runBillingFlow 在付款弹窗处回调填入
    if (manualCardPick) {
      // 手动模式：不预取卡。到付款弹窗时由面板让用户点选；runBillingFlow 通过 steps.pickCard 取卡。
      steps.pickCard = async () => {
        const id = await manualPickCard(page, log);
        const full = id ? await cardPool.getFull(id) : null;
        picked.card = full;
        return full;
      };
      card = null;
    } else {
      card = await cardPool.acquire();
      if (!card) { log('卡池暂无可用卡（可能被其它并发任务占用或已用尽）'); lastResult = 'no-card'; break; }
      log(`第 ${tryN}/${maxCardTries} 张卡 ••${card.last4} ${doPurchase ? `充值 $${amount}` : '加卡(不扣费)'}…`);
    }

    let outcome;
    try {
      outcome = await runBillingFlow(page, card, address, amount, cfg, log, steps, runtime);
    } catch (e) {
      outcome = { result: 'error', error: String(e.message || e).slice(0, 200) };
    }
    // 手动模式：实际使用的卡是用户点选的那张（由 picked.card 带回）。
    if (manualCardPick) {
      card = picked.card;
      if (!card) { log(`手动模式未选卡（取消/超时），停止试卡`); lastResult = outcome.result === 'success' ? outcome.result : 'no-card'; break; }
    }
    // 卡池计数(M7:maxUses=绑定数)：success=扣款成功 与 card-bound=仅加卡 都【计一次绑定用量】(与 Python ledger 对齐)；declined=冷却/累计禁卡。
    const repResult = outcome.result === 'card-bound' ? 'bound' : outcome.result;
    await cardPool.report(card.id, { result: repResult, error: outcome.error, decline_code: repResult === 'declined' ? (classifyDecline(outcome.error) || 'generic_decline') : '' });
    pushCard(card.last4, outcome.result, outcome.error);
    lastResult = outcome.result;

    if (outcome.result === 'success') {
      log(`✓ 充值成功 ••${card.last4} $${amount}`);
      await recordBilling('success', amount, card.last4);
      return ok('BILLING_OK', { billingStatus: 'success', charged: amount, cardLast4: card.last4 });
    }
    if (outcome.result === 'card-bound') {
      log(`✓ 已加卡(未扣费) ••${card.last4}`);
      await recordBilling('card-bound', 0, card.last4);
      return ok('BILLING_OK', { billingStatus: 'card-bound', charged: 0, cardLast4: card.last4 });
    }
    // 浏览器/页面崩溃或被关：再试也是白费、还会继续消耗卡，直接停。
    if (outcome.result === 'error' && /closed|crash|Target page/i.test(outcome.error || '')) {
      log(`✗ 页面/浏览器已关闭（${outcome.error || ''}）→ 停止试卡`);
      lastResult = 'page-closed'; break;
    }
    // 卡内已重试 4 次 Save 仍 5xx/网关错 = 该环境(OpenRouter/Stripe Radar)多半已被风控(burned env)。
    // 换卡也是同一环境继续被拒 → 只会白烧卡。停止在本环境继续试卡，按可重试的服务端错误收口
    //（卡 report 为 'error' → 不踢卡、保持 active，换个干净环境再来即可）。
    if (outcome.result === 'error' && /SERVER_ERROR|5\d\d|bad gateway|gateway|unavailable|网关/i.test(outcome.error || '')) {
      log(`✗ 卡 ••${card.last4} 触发服务端/网关错误(${(outcome.error || '').slice(0, 60)}) → 环境多半被风控，停止在本环境继续试卡(请换环境再跑)`);
      lastResult = 'server-error'; break;
    }
    log(`✗ 卡 ••${card.last4} 结果=${outcome.result} ${outcome.error || ''} → 换下一张`);
  }
  // 台账状态如实记：server-error/page-closed/no-card 各记本名(可重试)，其余按 declined。
  const ledgerStatus = ['no-card', 'page-closed', 'server-error'].includes(lastResult) ? lastResult : 'declined';
  await recordBilling(ledgerStatus, 0, '', '');
  // declined 用尽 maxCardTries 张卡仍全被拒 → 出细码 BILLING_DECLINED_EXHAUSTED,
  // 触发编排层【换干净环境(新IP+刷指纹)重试】(对齐 Selenium 换卡用尽后切IP);其余状态走原收口。
  return softBilling(cfg, lastResult === 'declined' ? 'declined-exhausted' : lastResult, action);
}

// 解析账单动作：优先 taskParams.billingAction；兼容老的 allowCharges 布尔。
function resolveBillingAction(tp) {
  const a = String(tp.billingAction || '').toLowerCase();
  if (['none', 'address', 'card', 'charge'].includes(a)) return a;
  return tp.allowCharges ? 'charge' : 'none';
}

// 账单收口：用户**明确要求的等级没达到 → 判失败**（账号进失败列表、断点续跑会重跑；
// Key 仍已落盘不丢失），不再揣着半成品当成功。只有"没要求该等级"或显式 soft 才软放过。
function softBilling(cfg, status, action) {
  const requested = action && action !== 'none';
  const missed = requested && !accountStore.billingSatisfied(status, action);
  if (missed || (cfg.billing && cfg.billing.failureMode === 'hard')) {
    const code = `BILLING_${String(status || 'INCOMPLETE').toUpperCase().replace(/-/g, '_')}`;
    return fail('BILLING_FAILED', code, { billingStatus: status, charged: 0 });
  }
  return ok('BILLING_SOFT_FAIL', { billingStatus: status, charged: 0 });
}

// 从地址池按策略挑一条账单地址。
function pickAddress(addresses, strategy, idx) {
  if (!addresses.length) return null;
  if (strategy === 'round-robin') return addresses[idx % addresses.length];
  return addresses[Math.floor(Math.random() * addresses.length)];
}

// 按 steps 跑账单流程(地址→加卡→购买)，按需在任一级停下。
// 返回 { result:'success'|'card-bound'|'address-bound'|'declined'|'error', error?, dialog? }。
async function runBillingFlow(page, card, address, amount, cfg, log, steps, runtime) {
  const { doCard, doPurchase } = steps;
  const billingUrl = cfg.site?.billingUrl || 'https://openrouter.ai/settings/credits';
  const dialogs = [];
  const onDialog = (d) => { dialogs.push(String(d.message() || '')); d.accept().catch(() => {}); };
  page.on('dialog', onDialog);
  try {
    await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await dismissOnboarding(page);
    // 拟人预热(opt-in)：真人不会进页就秒加卡 → 先滚动浏览停留，给行为遥测留"在看页"的痕迹。
    if (steps.humanLike) await humanBehavior.warmup(page, log);

    const onSignin = await page.evaluate(() => /sign-in|sign-up/.test(location.pathname)).catch(() => false);
    if (onSignin) return { result: 'error', error: 'NOT_LOGGED_IN' };

    // 入口顺序：先「Add a Payment Method」(会先弹账单地址→再弹卡)，绝不先点「Add Credits/增加积分」——
    // 否则可能跳过绑地址直接进购买，且无账单地址加卡极易触发 Stripe 风控(502/被拒)。充值放到卡存上之后。
    await clickFirst(page, ['button:has-text("Add a Payment Method")', 'button:has-text("Add Credits")', 'button:has-text("Buy Credits")'], 8000).catch(() => {});
    await page.waitForTimeout(1500);

    let addrSaved = false;
    let cardSaved = false;
    let activeCard = card; // 实际使用的卡；手动选卡模式下到付款弹窗才由用户点选填入
    let cardEntered = false; // 卡信息是否已成功填入：避免每轮重复重填（会冲掉已填表单/已过的验证状态）
    let manualBillingTried = false; // 加卡人工兜底只触发一次，避免每轮都停 180s
    let noneStreak = 0; // 连续找不到任何账单弹窗的次数：连续多次说明卡在了别的页（如个人资料页），及早收口
    for (let step = 0; step < 12; step += 1) {
      if (page.isClosed()) return { result: 'error', error: 'PAGE_CLOSED' };
      const early = await detectOutcome(page, dialogs);
      if (early) return early; // 付款成功 或 被拒(任一级都可能在加卡时被拒)

      const state = await detectModalState(page);
      log(`step ${step} modal=${state} (card=${doCard} purchase=${doPurchase})`);
      if (state !== 'none') noneStreak = 0;

      if (state === 'address') {
        await fillBillingAddress(page, address, log);
        // 提交按钮：未填全时是禁用的「Complete address details to continue」，填全后才可点。
        // 在弹窗内点主按钮（含 Continue/Save/Update/Add address 等文案；"Continue" 子串可命中该按钮）。
        const clicked = await clickFirst(page, [
          'button:has-text("Update Address")', 'button:has-text("Save address")', 'button:has-text("Add address")',
          'button:has-text("Save")', 'button:has-text("Continue")', 'button:has-text("Confirm")',
        ], 8000).then(() => true).catch(() => false);
        // 【关键修正(防假绑成)】旧逻辑点没点中都无条件 addrSaved=true → 字段没填全/按钮禁用时点不动,
        // 却仍判 address-bound,交付一个【没真绑地址】的号 → 下游加卡撞 Stripe 风控。
        // 改为:必须【点中】且【弹窗真从 address 推进走了】(到 payment/purchase 或消失)才算 addrSaved;否则下轮重填重试。
        if (!clicked) {
          log('账单地址提交按钮未可点（字段未填全/按钮仍禁用）→ 本轮不算绑成,下轮重填重试');
        } else {
          await page.waitForTimeout(2000);
          const after = await detectModalState(page);
          if (after !== 'address') { addrSaved = true; log('账单地址已提交且推进 ✓'); }
          else log('点了提交但仍停在地址步(可能字段未填全/combobox没选上)→ 下轮重试,不假绑成');
        }
        await page.waitForTimeout(1000);
      } else if (state === 'payment') {
        if (!doCard) return { result: 'address-bound' }; // 仅绑地址：到付款方式弹窗说明地址已存
        // 手动选卡填入：地址填完、到付款弹窗才弹卡池面板让用户点选（满足「输入地址后在付款页选卡」）。
        if (steps.manualCardPick && !activeCard) {
          activeCard = steps.pickCard ? await steps.pickCard() : null;
          if (!activeCard) return { result: 'error', error: 'MANUAL_CARD_CANCELLED' };
          log(`手动选卡填入: ••${activeCard.last4}`);
        }
        // 卡只填一次：填成功后不再重填（重填会清空已填表单+冲掉刚过的验证状态，导致本可成功的也失败）。
        if (!cardEntered) {
          cardEntered = await addPaymentMethod(page, activeCard, address, log, { engine: steps.cardFillEngine || 'playwright', runtime });
          await page.waitForTimeout(1200);
        } else {
          log('卡信息已填好，跳过重复填写，仅点保存/处理验证并等结果');
        }
        // 点 Save 保存卡。关键：Error 502「try again」是**瞬时错误**——人工再点一次就成功，
        // 所以这里像人一样最多重试 4 次 Save；只有「真·卡被拒(非5xx)」才立即踢卡。
        const TRANSIENT = BILLING_TRANSIENT; // 瞬时/网关错正则(模块级单一定义，detectOutcome 同款判定)
        // declined 自救:放弃这张卡前先【轮换免税州 ZIP 重试同一张卡】(候选首个=初填已用,其后=重试用)。
        const altZips = buildZipCandidates(activeCard && activeCard.zip).slice(1, 1 + envInt('ZIP_RETRY', 3, cfg));
        let err = '';
        let saved = false;
        for (let sAttempt = 0; sAttempt < 4; sAttempt += 1) {
          // 点 Save 前核对卡号还在不在：Stripe 表单可能重渲染把已填值清空 → 空了就重填，
          // 否则会以 "card incomplete / Error 400" 失败并被误判成卡被拒。
          if (!(await cardNumberFilled(page, activeCard))) {
            log('卡号字段为空/不全(表单重渲染?) → 点 Save 前重新填写');
            await addPaymentMethod(page, activeCard, address, log, { engine: steps.cardFillEngine || 'playwright', runtime });
            await page.waitForTimeout(1000);
          }
          // 拟人(opt-in)：点 Save 前把真鼠标移到按钮 + 阅读停顿——提交前的鼠标轨迹/思考时间是 Radar 行为信号。
          if (steps.humanLike) {
            await humanBehavior.moveMouseTo(page, page.locator('button:has-text("Save payment method"), button:has-text("Save")').first(), log);
            await humanBehavior.readingDwell(page, 700, 1900);
          }
          await clickFirst(page, ['button:has-text("Save payment method")', 'button:has-text("Save")'], 8000).catch(() => {});
          await page.waitForTimeout(2500);
          // Save 后可能弹 hCaptcha；skipCaptchaSolve 时完全不碰(靠指纹被动过，避免污染)。
          await solveHCaptchaIfPresent(page, cfg, log, steps.manualCaptchaFallback, steps.skipCaptchaSolve);
          await dismissLinkDialog(page, log); // Save 后 Stripe Link 弹 "Save card?"(DOM弹窗)→ 点 No thanks,否则卡在弹窗
          await page.waitForTimeout(1500);
          // 判定顺序很关键(先拒后存)：①明确成功→返回 ②真·卡被拒→踢卡 ③瞬时/网关错→重试
          //   ④无任何错且弹窗推进→卡确已存上 ⑤无错但仍停在付款弹窗(验证码没过/没提交上)→重试。
          // 关键修正：旧逻辑「无报错就算存上」会把『卡在验证码、无报错文案』误判成 card-bound(假成功)→这里删掉。
          const early = await detectOutcome(page, dialogs);
          if (early && early.result === 'success') return early;
          err = await readBillingError(page);
          if (err && !TRANSIENT.test(err)) {
            // 真·卡被拒(非5xx):放弃这张卡之前,先【同卡轮换免税州ZIP重试】(declined 多是 AVS/ZIP 不匹配,不烧卡)。
            const zr = await retryWithAltZips(page, activeCard, address, cfg, log, steps, dialogs, altZips, runtime);
            if (zr && zr.result === 'success') return zr;                  // 某个 ZIP 过了 → 成功
            if (zr && zr.result === 'card-bound') { saved = true; break; } // 弹窗推进=卡已存
            return { result: 'declined', error: err, usedZip: (zr && zr.usedZip) || '' }; // ZIP 全用尽仍拒 → 踢卡
          }
          if (!err && (await detectModalState(page)) !== 'payment') { saved = true; break; } // 无任何错且弹窗推进 → 卡确已存上
          // 到这步：要么瞬时/网关错，要么无错但仍卡在付款弹窗 → 一律按「没存上」重试，绝不当成功。
          if (err && !page._serverErrDumped) { page._serverErrDumped = true; await dumpBillingErrSource(page, log); }
          log(`付款未完成「${(err || '仍停在付款弹窗·无报错(验证码未过?)').slice(0, 50)}」→ 再点一次 Save 重试 (${sAttempt + 1}/4)`);
          await page.waitForTimeout(2500);
        }
        if (!saved) {
          // 多次重试仍瞬时错误 → 人工兜底(若开)，否则按瞬时错误收口（不踢卡）。
          if (steps.manualBillingFallback && !manualBillingTried) {
            manualBillingTried = true;
            await waitForManualBilling(page, log);
            const em = await detectOutcome(page, dialogs); if (em) return em;
            if ((await detectModalState(page)) !== 'payment') { cardSaved = true; continue; }
          }
          log(`付款多次重试仍失败：${err.slice(0, 80)}`);
          return { result: 'error', error: `SERVER_ERROR:${(err || '').slice(0, 80)}` };
        }
        cardSaved = true;
      } else if (state === 'purchase') {
        if (!doCard) return { result: 'address-bound' };
        if (!doPurchase) return { result: 'card-bound' }; // 到购买弹窗 = 卡已存上
        await setPurchaseAmount(page, amount, log);
        await page.waitForTimeout(600);
        await clickFirst(page, ['button:has-text("Purchase")'], 8000).catch(() => {});
        await page.waitForTimeout(2500);
        const out = await waitForPurchaseOutcome(page, dialogs, 25000);
        if (out) return out;
      } else {
        // 未识别弹窗：可能已关。按已完成的步骤兜底判定。
        if (cardSaved && !doPurchase) return { result: 'card-bound' };
        if (addrSaved && !doCard) return { result: 'address-bound' };
        noneStreak += 1;
        // 连续 4 次都没看到任何账单弹窗（多半卡在别的页，如个人资料/未登录）→ 及早收口，别空转 60s。
        if (noneStreak >= 4) {
          const where = await page.evaluate(() => location.pathname + (document.querySelector('h1,h2,[role="heading"]')?.innerText ? ' · ' + document.querySelector('h1,h2,[role="heading"]').innerText.slice(0, 40) : '')).catch(() => '');
          return { result: 'error', error: `BILLING_NO_MODAL（未出现账单弹窗，停在: ${where || '未知'}）` };
        }
        // 卡还没存上 → 继续走「Add a Payment Method」(先绑地址再加卡)；卡存上了 → 才点「Add Credits」去充值。
        const reSel = cardSaved
          ? ['button:has-text("Add Credits")', 'button:has-text("Buy Credits")', 'button:has-text("Add a Payment Method")']
          : ['button:has-text("Add a Payment Method")', 'button:has-text("Add Credits")', 'button:has-text("Buy Credits")'];
        await dismissOnboarding(page); // 新账号 onboarding 浮层会盖住入口按钮 → 重开前先清掉
        await clickFirst(page, reSel, 4000).catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
    if (cardSaved && !doPurchase) return { result: 'card-bound' };
    if (addrSaved && !doCard) return { result: 'address-bound' };
    return { result: 'error', error: 'BILLING_FLOW_TIMEOUT' };
  } finally {
    page.off('dialog', onDialog);
  }
}

// 等人工在有头浏览器里手动完成加卡（填卡/过验证/点 Save），直到付款弹窗推进(进购买/关闭)或超时。
async function waitForManualBilling(page, log, maxMs = 180000) {
  log(`【加卡人工兜底】自动未完成 — 请在浏览器里手动完成加卡(填卡/过验证/点 Save)，最多等 ${Math.round(maxMs / 1000)}s…`);
  const rounds = Math.ceil(maxMs / 3000);
  for (let i = 0; i < rounds; i += 1) {
    await page.waitForTimeout(3000);
    if (page.isClosed()) return 'closed';
    const st = await detectModalState(page);
    if (st === 'purchase') { log('【加卡人工兜底】已进入购买弹窗，卡已存上，继续'); return 'advanced'; }
    if (st === 'none') { log('【加卡人工兜底】付款弹窗已关闭，继续判定结果'); return 'advanced'; }
  }
  log('【加卡人工兜底】等待超时，按当前状态继续判定');
  return 'timeout';
}

// 手动选卡填入：在页面注入卡池浮层面板（只发脱敏信息），等用户点选一张，返回卡 id（取消返回 null）。
async function manualPickCard(page, log, timeoutMs = 180000) {
  const cards = cardPool.snapshot(); // 脱敏：masked/exp/status/usedCount/maxUses/remaining/lastResult，无卡号/CVC
  if (!cards.length) { log('【手动选卡】卡池为空，无法选卡'); return null; }
  await page.evaluate((list) => {
    const old = document.getElementById('__or_pick_panel'); if (old) old.remove();
    try { delete document.documentElement.dataset.orPicked; } catch (e) {}
    const wrap = document.createElement('div');
    wrap.id = '__or_pick_panel';
    wrap.style.cssText = 'position:fixed;top:12px;right:12px;width:340px;max-height:92vh;overflow:auto;z-index:2147483647;background:#0f1117;color:#e6e6e6;border:1px solid #2a2f3a;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.55);font:13px/1.45 system-ui,Segoe UI,Arial;padding:10px';
    const title = document.createElement('div');
    title.textContent = '卡池选卡 — 点一张自动填入';
    title.style.cssText = 'font-weight:700;margin-bottom:8px;font-size:14px';
    wrap.appendChild(title);
    list.forEach((c) => {
      const dead = c.status !== 'active' || c.remaining <= 0;
      const row = document.createElement('div');
      row.style.cssText = 'border:1px solid #2a2f3a;border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer;' + (dead ? 'opacity:.45;' : 'background:#161a22;');
      row.innerHTML = '<div style="font-weight:600">' + c.masked + ' <span style="float:right;font-weight:400;color:#8b93a7">' + c.exp + '</span></div>'
        + '<div style="color:#8b93a7;font-size:12px;margin-top:2px">状态:' + c.status + ' · 用量 ' + c.usedCount + '/' + c.maxUses + ' · 剩 ' + c.remaining + (c.lastResult ? ' · 上次:' + c.lastResult : '') + '</div>';
      row.onmouseenter = () => { row.style.outline = '2px solid #4f8cff'; };
      row.onmouseleave = () => { row.style.outline = 'none'; };
      row.onclick = () => { document.documentElement.dataset.orPicked = c.id; wrap.remove(); };
      wrap.appendChild(row);
    });
    const cancel = document.createElement('button');
    cancel.textContent = '取消（跳过加卡）';
    cancel.style.cssText = 'width:100%;margin-top:4px;padding:8px;background:#2a2f3a;color:#e6e6e6;border:0;border-radius:8px;cursor:pointer';
    cancel.onclick = () => { document.documentElement.dataset.orPicked = '__cancel'; wrap.remove(); };
    wrap.appendChild(cancel);
    document.body.appendChild(wrap);
  }, cards).catch((e) => log(`【手动选卡】注入面板失败：${e.message}`));

  log(`【手动选卡】已注入卡池面板(${cards.length} 张)，请在浏览器右上角点选一张卡（最多等 ${Math.round(timeoutMs / 1000)}s）…`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;
    await page.waitForTimeout(800);
    const picked = await page.evaluate(() => document.documentElement.dataset.orPicked || '').catch(() => '');
    if (picked) {
      await page.evaluate(() => { const p = document.getElementById('__or_pick_panel'); if (p) p.remove(); try { delete document.documentElement.dataset.orPicked; } catch (e) {} }).catch(() => {});
      if (picked === '__cancel') { log('【手动选卡】已取消'); return null; }
      log(`【手动选卡】已选择卡 id=${picked.slice(0, 14)}…`);
      return picked;
    }
  }
  await page.evaluate(() => { const p = document.getElementById('__or_pick_panel'); if (p) p.remove(); }).catch(() => {});
  log('【手动选卡】等待超时，未选卡');
  return null;
}

// 等人工在有头浏览器里手动过验证（最多 maxMs）。验证消失即返回 true。
async function waitForManualHCaptcha(page, log, maxMs = 120000) {
  log(`【人工过验证码】请在浏览器里手动完成 hCaptcha（最多等 ${Math.round(maxMs / 1000)}s）…`);
  const rounds = Math.ceil(maxMs / 3000);
  for (let i = 0; i < rounds; i += 1) {
    await page.waitForTimeout(3000);
    if (!(await hasHCaptcha(page))) { log('【人工过验证码】验证已完成，继续流程'); return true; }
  }
  log('【人工过验证码】等待超时，继续流程');
  return false;
}

// 加卡/付款时若弹出 hCaptcha「I am human」风控验证。
// 策略：先 2Captcha 自动解（最多 3 轮）；若仍未过且开了「人工兜底」(manualFallback) → 停下等人工手动过。
// 纯调试：环境变量 OPENROUTER_MANUAL_HCAPTCHA=1 或 cfg.captcha.manual → 直接全程人工、不调 2Captcha。
async function solveHCaptchaIfPresent(page, cfg, log, manualFallback, skipSolve) {
  try {
    if (!(await hasHCaptcha(page))) return;
    // 跳过自动求解：AdsPower 等干净指纹下 invisible hCaptcha 会被动通过，我们去解反而会污染它
    // (覆盖掉有效的被动 token → "unable to authenticate")。开启后完全不碰，靠 Save+502重试推进。
    if (skipSolve) { log('跳过验证码自动求解：靠指纹被动通过(不注入 token，避免污染)'); return; }
    const forceManual = process.env.OPENROUTER_MANUAL_HCAPTCHA === '1' || (cfg && cfg.captcha && cfg.captcha.manual);
    if (forceManual) { await waitForManualHCaptcha(page, log); return; }

    const apiKey = cfg && cfg.captcha && cfg.captcha.apiKey;
    const pageUrl = (cfg && cfg.site && cfg.site.billingUrl) || page.url();
    const timeoutMs = (cfg && cfg.captcha && cfg.captcha.solveTimeoutMs) || 120000;
    if (!apiKey) {
      log('检测到 hCaptcha 但未配置 2Captcha key' + (manualFallback ? '，转人工' : '，无法求解'));
      if (manualFallback) await waitForManualHCaptcha(page, log);
      return;
    }
    // 先自动解，最多 3 轮。
    for (let round = 0; round < 3; round += 1) {
      if (!(await hasHCaptcha(page))) return; // 已过
      log(`检测到加卡 hCaptcha（第 ${round + 1} 轮），开始自动求解…`);
      const r = await solveHCaptchaAndInject(page, { apiKey, pageUrl, timeoutMs, log: (m) => log(`[hcaptcha] ${m}`) });
      if (!r.ok) { log(`hCaptcha 自动求解失败：${r.reason}（本轮重试）`); await page.waitForTimeout(1500); continue; }
      await page.waitForTimeout(1500);
      // 注入后再点一次保存（部分实现注入 callback 即自动提交，这一步是兜底）。
      await clickFirst(page, ['button:has-text("Save payment method")', 'button:has-text("Save")'], 4000).catch(() => {});
      await page.waitForTimeout(2500);
    }
    // 自动解 3 轮后验证仍在 → 解不动 → 按需转人工兜底。
    if (await hasHCaptcha(page)) {
      if (manualFallback) {
        log('自动求解未能通过 hCaptcha → 转人工兜底');
        const passed = await waitForManualHCaptcha(page, log);
        if (passed) await clickFirst(page, ['button:has-text("Save payment method")', 'button:has-text("Save")'], 4000).catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        log('自动求解未能通过 hCaptcha，且未开启人工兜底 → 放弃本卡');
      }
    }
  } catch (e) { log(`hCaptcha 处理异常：${e.message}`); }
}

// 判断当前显示的是哪个弹窗：address / payment / purchase / none。
async function detectModalState(page) {
  return page.evaluate(() => {
    // 只认「可见、非个人资料」的真弹窗 —— 绝不靠整页文字判断：页面那个 "Add a Payment Method"
    // 按钮文字含 "Payment Method"，靠整页判会在没开弹窗时误判 payment → 对着空气死循环填卡。
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => {
      const r = d.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      if (getComputedStyle(d).visibility === 'hidden') return false;
      const tt = d.innerText || '';
      const isProfile = /Manage your account info|Profile details|Connected accounts|Web3 wallets/i.test(tt)
        && !/Billing Address|Payment [Mm]ethod|card number|Total due|Purchase Credits/i.test(tt);
      return !isProfile;
    });
    if (!dlg) return 'none';
    const title = (((dlg.querySelector('h1,h2,[role="heading"]') || {}).innerText) || '');
    const t = dlg.innerText || '';
    const has = (re) => re.test(t);
    const hasBtn = (label) => Array.from(dlg.querySelectorAll('button')).some((b) => new RegExp(label, 'i').test(b.innerText || ''));
    // 标题最可靠：实测三种弹窗标题 = "Purchase Credits" / "Add a Billing Address" / "Add a Payment Method"。
    if (/Purchase Credits/i.test(title) || (has(/Total due/i) && hasBtn('Purchase'))) return 'purchase';
    if (/Billing Address/i.test(title) || hasBtn('Update Address') || hasBtn('address details to continue')) return 'address';
    if (/Payment method/i.test(title) || hasBtn('Save payment method')) return 'payment';
    return 'none';
  }).catch(() => 'none');
}

// 读取被拒/错误提示文本。关键：**只在付款弹窗/告警区 + Stripe iframe 内找**，
// 绝不扫整页背景——否则会误抓 OpenRouter 模型列表里无关的 "Error 5xx"，把好卡当成被拒。
// 瞬时/网关错(5xx/bad gateway/try again/表单不完整…)的单一定义 —— Save 重试循环与 detectOutcome 共用，
// 保证「该重试 vs 该踢卡」两处判定完全一致(避免循环顶 detectOutcome 把 502 当 declined 踢卡，而循环内却在重试)。
const BILLING_TRANSIENT = /error\s*5\d\d|bad gateway|gateway time|service unavailable|temporarily unavailable|try again|something went wrong|稍后|服务(暂时)?不可用|网关|incomplete|不完整/i;

// declined 后【同一张卡轮换 ZIP 重试】(declined 多是 AVS/ZIP 不匹配,换免税州ZIP常能过,不烧卡)。
// 【关键】只重填 postal 字段 → 重点 Save → 重判,绝不重填卡号(不动 cardEntered;每次 Save 前查卡号还在不在)。
// 逐字镜像 selenium-e2e/cardbind/fixc_core.py 的 alt-ZIP 重试段。过了返回 {result:'success',...}/{result:'card-bound'};全用尽返回 {result:'declined'}。带回 usedZip 供日志。
async function retryWithAltZips(page, card, address, cfg, log, steps, dialogs, altZips, runtime) {
  let usedZip = '';
  for (const z of (altZips || [])) {
    usedZip = z;
    log(`✗ declined → 切 ZIP=${z} 重试同一张卡(疑 AVS,不烧卡)`);
    // 只重填 postal(不调 addPaymentMethod→卡号保持已填);卡号被重渲染冲掉了才补填一次。
    if (!(await cardNumberFilled(page, card))) {
      await addPaymentMethod(page, card, address, log, { engine: steps.cardFillEngine || 'playwright', runtime }).catch(() => {});
      await page.waitForTimeout(800);
    }
    await fillAcross(page, cardSelectors.postal, z, log).catch(() => {});
    await page.waitForTimeout(400);
    await clickFirst(page, ['button:has-text("Save payment method")', 'button:has-text("Save")'], 8000).catch(() => {});
    await page.waitForTimeout(2200);
    await solveHCaptchaIfPresent(page, cfg, log, steps.manualCaptchaFallback, steps.skipCaptchaSolve);
    await dismissLinkDialog(page, log); // Save 后 Link "Save card?" 弹窗 → No thanks
    // 轮询 ~18s 等这个 ZIP 的结果
    for (let i = 0; i < 12; i += 1) {
      const early = await detectOutcome(page, dialogs);
      if (early && early.result === 'success') { log(`✓ 切 ZIP=${z} 后过了`); return { ...early, usedZip: z }; }
      const e2 = await readBillingError(page);
      if (e2 && /declined|do not honou?r|insufficient|incorrect|invalid|expired/i.test(e2)) break; // 这个 ZIP 仍拒 → 下一个
      if (!e2 && (await detectModalState(page)) !== 'payment') { log(`✓ 切 ZIP=${z} 后弹窗推进=已存`); return { result: 'card-bound', usedZip: z }; }
      await page.waitForTimeout(1500);
    }
  }
  return { result: 'declined', usedZip };
}

async function readBillingError(page) {
  const RE = /(your card was declined|card was declined|银行卡被拒绝[^\n]*|insufficient funds|card (number )?is (incorrect|invalid)|incorrect (card )?number|security code is (incorrect|invalid)|card (has )?expired|payment (method )?(failed|could not|was declined|was not completed)|Error 5\d\d[^\n]*|bad gateway|service unavailable|something went wrong|do not honou?r|declined)/i;
  const frames = [page.mainFrame(), ...page.frames()];
  for (const f of frames) {
    const t = await f.evaluate(() => {
      const u = location.href || '';
      // Stripe 子框架：报错就在里面，读全文。
      if (/stripe\.com|stripe\.network/.test(u)) return document.body.innerText || '';
      // 主站：只读弹窗/告警/toast 区，避开背景内容。
      const sc = Array.from(document.querySelectorAll('[role="dialog"],[role="alert"],[aria-live],[class*="toast" i],[class*="error" i],[class*="alert" i],[class*="danger" i]'));
      return sc.map((e) => e.innerText || '').join('\n');
    }).catch(() => '');
    const m = t.match(RE);
    if (m) return m[0].slice(0, 160);
  }
  return '';
}

// 一次性诊断：付款命中 5xx/网关错误时，dump 报错到底来自哪个 frame / 哪个元素 / 完整文案，
// 判断是真服务器错误，还是 readBillingError 误抓了背景元素。
async function dumpBillingErrSource(page, log) {
  try {
    for (const f of [page.mainFrame(), ...page.frames()]) {
      const info = await f.evaluate(() => {
        const u = location.href || '';
        const RE = /(error\s*5\d\d|bad gateway|service unavailable|something went wrong|try again|网关|稍后)/i;
        const isStripe = /stripe\.com|stripe\.network/.test(u);
        const scope = isStripe
          ? [document.body]
          : Array.from(document.querySelectorAll('[role="dialog"],[role="alert"],[aria-live],[class*="toast" i],[class*="error" i],[class*="alert" i],[class*="danger" i]'));
        for (const el of scope) {
          const txt = (el && el.innerText) || '';
          if (RE.test(txt)) {
            return { url: u.slice(0, 80), stripe: isStripe, tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), role: el.getAttribute && el.getAttribute('role'), text: txt.replace(/\s+/g, ' ').slice(0, 200) };
          }
        }
        return null;
      }).catch(() => null);
      if (info) { log(`502来源: frame=${info.stripe ? 'STRIPE' : '主站'} ${info.url} | <${info.tag} role=${info.role} class="${info.cls}"> | 文案="${info.text}"`); return; }
    }
    log('502来源: 未在弹窗/告警/Stripe 区定位到匹配元素（可能 readBillingError 范围与此处不一致）');
  } catch (e) { log(`502来源诊断异常：${e.message}`); }
}

// 综合判定结果(被拒/成功)；dialogs 为已捕获的 JS alert 文案数组。
async function detectOutcome(page, dialogs) {
  const dlg = (dialogs || []).join(' ');
  if (/payment is processing|credits will be added|check back shortly/i.test(dlg)) return { result: 'success', dialog: dlg.slice(0, 160) };
  const err = await readBillingError(page);
  // 瞬时/网关错(5xx/bad gateway/try again…)不是「卡被拒」——绝不在这里判 declined 踢卡(那会冤枉好卡，
  // 且和付款分支 Save 重试循环自相矛盾)；交给 Save 循环重试，仍不行则收口为 SERVER_ERROR(卡保持 active)。
  // 只有【真·卡被拒】(余额不足/卡号错/CVC错/过期/明确 declined)才算 declined。
  if (err && !BILLING_TRANSIENT.test(err)) return { result: 'declined', error: err };
  const txt = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (/payment is processing|credits will be added|check back shortly/i.test(txt)) return { result: 'success' };
  return null;
}

// Purchase 后等待结果：轮询 dialog/成功文案/被拒文案。
async function waitForPurchaseOutcome(page, dialogs, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    const out = await detectOutcome(page, dialogs);
    if (out) return out;
    await page.waitForTimeout(1000);
  }
  return null;
}

// 填账单地址(兼容 OpenRouter 原生表单 + Stripe AddressElement iframe)。
async function fillBillingAddress(page, address, log) {
  const a = address || {};
  const CITY = ['input[name="locality"]', 'input[name="city"]', 'input[autocomplete="address-level2"]', 'input[placeholder*="City" i]', 'input[placeholder*="城市"]'];
  const ZIP = ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[placeholder*="ZIP" i]', 'input[placeholder*="邮政编码"]'];
  await fillAcross(page, ['input[name="name"]', 'input[autocomplete="name"]', 'input[placeholder*="Full name" i]', 'input[placeholder*="全名"]'], a.name || '', log);
  await selectCountry(page, a.country || 'United States', log);
  await page.waitForTimeout(400);
  await fillAcross(page, ['input[name="addressLine1"]', 'input[name="line1"]', 'input[autocomplete="address-line1"]', 'input[placeholder*="Address line 1" i]', 'input[placeholder*="地址第 1 行"]', 'input[placeholder*="地址第1行"]'], a.line1 || '', log);
  if (a.line2) await fillAcross(page, ['input[name="addressLine2"]', 'input[name="line2"]', 'input[autocomplete="address-line2"]'], a.line2, log);
  // City/State/Zip 多为填完 line1 后才渲染出来 → 等一下再填，并补一轮兜底。
  await page.waitForTimeout(700);
  await fillAcross(page, CITY, a.city || '', log);
  await fillStateField(page, a.state || '', log);
  await fillAcross(page, ZIP, a.zip || '', log);
  // 二次兜底：若上面因渲染时序没填上，再补一次（fillAcross 命中即填，未命中无副作用）。
  await page.waitForTimeout(300);
  await fillAcross(page, CITY, a.city || '', log);
  await fillStateField(page, a.state || '', log);
  await fillAcross(page, ZIP, a.zip || '', log);
}

// 加银行卡(Stripe Elements iframe + 原生兜底)。
const CARD_NUM_SELS = cardSelectors.number; // 单一来源：billing/card-fill/selectors.js

// 等 Stripe 卡号输入框真正出现且可见（表单异步加载），最多 maxMs。没加载完就填会被清空→incomplete。
async function waitForCardForm(page, log, maxMs = 12000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    for (const f of [page.mainFrame(), ...page.frames()]) {
      for (const sel of CARD_NUM_SELS) {
        try {
          const loc = f.locator(sel).first();
          if ((await loc.count().catch(() => 0)) && (await loc.isVisible().catch(() => false))) return true;
        } catch (_e) { /* next */ }
      }
    }
    await page.waitForTimeout(500);
  }
  log && log('等待卡号输入框超时（表单可能未加载全）');
  return false;
}

// 核对卡号字段当前是否已填满（防止表单重渲染把已填值清空）。
async function cardNumberFilled(page, card) {
  const want = String((card && card.number) || '').replace(/\D/g, '');
  if (!want) return true;
  for (const f of [page.mainFrame(), ...page.frames()]) {
    for (const sel of CARD_NUM_SELS) {
      try {
        const loc = f.locator(sel).first();
        if (!(await loc.count().catch(() => 0))) continue;
        const v = ((await loc.inputValue().catch(() => '')) || '').replace(/\D/g, '');
        if (v.length >= want.length) return true;
      } catch (_e) { /* next */ }
    }
  }
  return false;
}

async function addPaymentMethod(page, card, address, log, ctx2) {
  // ctx2 = { engine, runtime }：填卡引擎名(可逗号链) + runtime(供 selenium 等引擎用)。
  // 选「银行卡 / Card」tab(若有)。
  await clickFirst(page, ['button:has-text("银行卡")', 'button:has-text("Card")', '[role="tab"]:has-text("Card")'], 2500).catch(() => {});
  // 等卡号框真正加载出来再填，避免"没加载完就填→被清空→incomplete/Error 400"。
  await waitForCardForm(page, log);
  await page.waitForTimeout(1000); // 让 Stripe 给输入框接好事件
  await humanPause(page, 400, 900);
  // 填卡字段(number/exp/cvc/zip)交给可切换引擎(默认 playwright，可配置兜底链)。引擎只填字段，不碰 Save/验证码。
  const res = await cardFill.fillCard({
    page, card, address, log,
    runtime: ctx2 && ctx2.runtime,
    engine: (ctx2 && ctx2.engine) || 'playwright',
  });
  const okNum = !!res.num; const okExp = !!res.exp; const okCvc = !!res.cvc;
  // 诊断：到底哪个卡字段没填上（iframe 数 + 命中情况 + 用了哪个引擎 + 失败原因），定位 Stripe 表单问题
  log(`填卡: 卡号=${okNum ? '✓' : '✗'} 有效期=${okExp ? '✓' : '✗'} CVC=${okCvc ? '✓' : '✗'} | 引擎=${res.engine}${res.error ? '(' + res.error + ')' : ''} | iframe数=${page.frames().length}`);
  // 诊断：付款时弹出的"校验"到底是 Cloudflare 人机 还是 银行 3DS（只在首次付款步打一次，避免刷屏）。
  if (!page._obstacleDumped) {
    page._obstacleDumped = true;
    const ob = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || f.title || '').filter(Boolean);
      const hints = [];
      if (/verify you are human|are you human|i'?m not a robot|确认您是真人|人机验证|需要验证/i.test(t)) hints.push('人机/Cloudflare文案');
      if (/3-?d secure|3ds|authenticate|authoriz|verification code|enter the code|短信验证码|授权这?笔|银行验证/i.test(t)) hints.push('3DS/银行验证文案');
      const btns = Array.from(document.querySelectorAll('button,[role="button"],a[class*="btn" i]')).map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return { cfHook: !!(window.__cfParams && window.__cfParams.sitekey), frames: frames.slice(0, 12), hints, snippet: t.replace(/\s+/g, ' ').slice(0, 240), buttons: [...new Set(btns)].slice(0, 30) };
    }).catch(() => ({}));
    log(`付款校验诊断: cfHook=${ob.cfHook} 文案=${(ob.hints || []).join('/') || '无'}`);
    log(`付款按钮: ${JSON.stringify(ob.buttons || [])}`);
    log(`付款 iframe: ${JSON.stringify(ob.frames || [])}`);
    log(`付款弹窗文案: ${(ob.snippet || '').slice(0, 200)}`);
  }
  // 卡片邮编(zip)已在填卡引擎里随卡填入(见 card-fill/engines/playwright.js → sels.postal)。
  await selectCountry(page, 'United States', log);
  // 确保「使用 Link 保存我的信息」不勾。
  await uncheckLink(page, log);
  // 返回卡三要素是否都填上：调用方据此决定是否「已填好、不再重填」。
  return okNum && okExp && okCvc;
}

// 取消勾选 Stripe Link / 保存信息 复选框。
async function uncheckLink(page, log) {
  try {
    const frames = [page.mainFrame(), ...page.frames()];
    for (const f of frames) {
      const boxes = f.locator('input[type="checkbox"]');
      const n = await boxes.count().catch(() => 0);
      for (let i = 0; i < n; i += 1) {
        const cb = boxes.nth(i);
        const checked = await cb.isChecked().catch(() => false);
        if (checked) { await cb.uncheck({ timeout: 1500 }).catch(() => cb.click({ timeout: 1500 }).catch(() => {})); log && log('取消勾选 Link/保存信息'); }
      }
    }
  } catch (_e) { /* ignore */ }
}

// 关掉 Stripe Link 的 "Save card? / Pay faster" 弹窗(点 No thanks/Not now/Skip)。
// 这是 DOM 模态(不是 JS alert → page.on('dialog') 接不住),必须原生 click 触发 React。镜像 selenium-e2e/cardbind/fixc_core.py _dismiss_link_dialog。
async function dismissLinkDialog(page, log) {
  try {
    const RE = /^(no thanks|not now|skip|maybe later|continue without.*|close)$/i;
    for (const f of [page.mainFrame(), ...page.frames()]) {
      const btns = f.locator('button, [role="button"]');
      const n = await btns.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 40); i += 1) {
        const b = btns.nth(i);
        const txt = ((await b.innerText().catch(() => '')) || '').trim();
        if (RE.test(txt)) {
          const ok = await b.click({ timeout: 1500 }).then(() => true).catch(() => false);
          if (ok) { log && log(`关 Link 弹窗: ${txt}`); return true; }
        }
      }
    }
  } catch (_e) { /* ignore */ }
  return false;
}

// 设置购买额度。
async function setPurchaseAmount(page, amount, log) {
  const sels = ['input[type="number"]', 'input[name="amount"]', 'input[inputmode="decimal"]', 'input[inputmode="numeric"]', 'input[placeholder*="25000"]', 'input[aria-label*="amount" i]', 'input[id*="amount" i]', 'input[placeholder*="amount" i]'];
  let ok = await fillAcross(page, sels, String(amount), log);
  if (ok) return;
  // 兜底：购买弹窗里按「Amount」标签找最近的可见 input，打标记后再填。
  const marked = await page.evaluate(() => {
    const labs = Array.from(document.querySelectorAll('div,span,label,p')).filter((el) => el.children.length === 0 && /^\s*amount\s*$/i.test(el.textContent || ''));
    for (const lab of labs) {
      let scope = lab.parentElement;
      for (let up = 0; up < 4 && scope; up += 1) {
        const inp = Array.from(scope.querySelectorAll('input')).find((i) => i.offsetParent !== null && !/checkbox|radio|hidden/i.test(i.type || ''));
        if (inp) { inp.setAttribute('data-or-amount', '1'); return true; }
        scope = scope.parentElement;
      }
    }
    // 再兜底：弹窗里任何"当前值像金额(以数字或$开头)"的可见 input。
    const any = Array.from(document.querySelectorAll('input')).find((i) => i.offsetParent !== null && /^\$?\s*\d/.test(i.value || ''));
    if (any) { any.setAttribute('data-or-amount', '1'); return true; }
    return false;
  }).catch(() => false);
  if (marked) ok = await fillAcross(page, ['input[data-or-amount="1"]'], String(amount), log, { human: true });
  if (!ok) log && log('未找到 Amount 输入框');
}

// 国家选择(select 或 combobox)。多为已默认 United States，尽力设置。
async function selectCountry(page, country, log) {
  const want = country || 'United States';
  try {
    const frames = [page.mainFrame(), ...page.frames()];
    for (const f of frames) {
      const sel = f.locator('select[name="country"], select[autocomplete="country"], select[name*="country" i]').first();
      if (await sel.count().catch(() => 0)) {
        await sel.selectOption({ label: want }).catch(async () => {
          await sel.selectOption('US').catch(() => {});
        });
        return;
      }
    }
    // 新版 "Country or region" 是 base-ui combobox(button+下拉),不是原生 select → 上面原生分支会静默 no-op。
    // 兜底:查当前 combobox 是否已是目标国家(默认就是 United States,多数无需动);不是才点开选。命中不到要告警,不再静默。
    const cur = await page.evaluate((w) => {
      const el = Array.from(document.querySelectorAll('button,[role="combobox"]'))
        .find((b) => /country|region/i.test(b.getAttribute('aria-label') || '') || /Country or region|United States/i.test(b.innerText || ''));
      if (!el) return 'no-field';
      return new RegExp(w, 'i').test(el.innerText || '') ? 'ok' : 'need-set';
    }, want).catch(() => 'no-field');
    if (cur === 'ok') return;              // 已是目标国家
    if (cur === 'no-field') { log && log('selectCountry: 没有原生 select 也没有 country combobox(可能字段不在此步),跳过'); return; }
    // need-set: 点开 combobox 选目标国家
    const combo = page.locator('[role="combobox"], button[aria-haspopup="listbox"], button[aria-haspopup="menu"]').filter({ hasText: /United States|Country|region|Select/i }).first();
    await combo.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    const opt = page.getByRole('option', { name: want, exact: false }).first();
    if (await opt.count().catch(() => 0)) { await opt.click({ timeout: 3000 }).catch(() => {}); return; }
    const clicked = await page.getByText(want, { exact: true }).last().click({ timeout: 3000 }).then(() => true).catch(() => false);
    if (!clicked) log && log(`selectCountry: combobox 没选上「${want}」(可能 DOM 变动),保持默认值继续`);
  } catch (_e) { log && log('selectCountry combobox 兜底异常(多数已默认 US,不阻断)'); }
}

// 州字段：select(全名 Oregon) / combobox / input 兜底。
async function fillStateField(page, state, log) {
  if (!state) return;
  try {
    const frames = [page.mainFrame(), ...page.frames()];
    for (const f of frames) {
      const sel = f.locator('select[name="administrativeArea"], select[name="state"], select[autocomplete="address-level1"], select[name*="state" i]').first();
      if (await sel.count().catch(() => 0)) {
        await sel.selectOption({ label: state }).catch(() => sel.selectOption(state).catch(() => {}));
        return;
      }
    }
  } catch (_e) { /* ignore */ }
  await fillAcross(page, ['input[name="administrativeArea"]', 'input[name="state"]', 'input[autocomplete="address-level1"]', 'input[placeholder*="State" i]', 'input[placeholder*="州"]'], state, log);
}

// humanPause / fillAcross 已抽到 ./billing/card-fill/fill-primitive.js（本文件顶部 require 回来复用）。
// 抽出原因：与 playwright 填卡引擎共用同一份穿跨域 iframe 的填值原语，避免重复。

// 点击第一个匹配到的按钮(任意 selector 命中即点)。
async function clickFirst(page, selectors, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) {
        const clicked = await loc.click({ timeout: 2000 }).then(() => true).catch(() => false);
        if (clicked) return true;
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`clickFirst 超时: ${selectors[0]}`);
}
// ── S6: 导出 / 最终状态 ──────────────────────────────────────────────────
// 到达最终状态：若设置了「统一密码」，把邮箱密码从原密码改成统一新密码(Firstmail API)。
// 仅在「付款成功」或「本就不充值(skipped)」时改密；付款失败时保留原密码以便重试。
async function exportStage(ctx) {
  const { account, runtime, context } = ctx;
  // 阶段开关：未勾「改密」→ 跳过。
  if (runtime.taskParams && runtime.taskParams.doPasswordChange === false) {
    return ok('EXPORT_OK', { passwordChanged: false });
  }
  // 断点续跑：已改过密 → 跳过。
  const ps = runtime.priorState;
  if (runtime.resume !== false && ps && ps.passwordChanged) {
    return ok('EXPORT_OK', { passwordChanged: true });
  }
  const cfg = runtime.config || {};
  const mb = cfg.mailbox || {};
  const tp = runtime.taskParams || {};
  const log = (m) => context.log && context.log(`[export] ${m}`);
  const unified = String(tp.unifiedPassword || '').trim();

  if (!unified || unified === account.password) {
    return ok('EXPORT_OK', { passwordChanged: false });
  }

  // 用户规则：改密前置 = 已取到 Key 且充值成功（这才算流程正常跑完）。
  // 两者可来自本次阶段结果或断点续跑的已存状态。
  const apiKeyOk = !!((context.stageResults?.apiKey?.detail?.apiKey) || (ps && ps.apiKey));
  const billingStatus = context.stageResults?.billing?.detail?.billingStatus || (ps && ps.billingStatus) || 'skipped';
  // 走到这里说明用户**要求了改密**(doPasswordChange!==false)。改密做不成 = 流程没真正完成 → 判失败
  // （账号进失败列表、断点续跑重跑；Key/充值已落盘，重跑会跳过、只补改密）。
  if (!apiKeyOk || billingStatus !== 'success') {
    log(`改密前置未满足(取Key=${apiKeyOk ? '是' : '否'}, 充值=${billingStatus})，未改密`);
    return fail('PASSWORD_CHANGE_BLOCKED', 'PWD_PREREQ_NOT_MET', { passwordChanged: false, passwordChangeNote: `need-key+charge(key=${apiKeyOk},billing=${billingStatus})` });
  }
  if (!mb.apiKey) {
    log('未配置 Firstmail apiKey，无法改密');
    return fail('PASSWORD_CHANGE_FAILED', 'NO_MAILBOX_APIKEY', { passwordChanged: false, passwordChangeError: 'NO_MAILBOX_APIKEY' });
  }

  try {
    const r = await changePassword({
      apiKey: mb.apiKey, email: account.email,
      currentPassword: account.password, newPassword: unified,
      baseUrl: mb.apiBaseUrl, timeoutMs: mb.apiTimeoutMs || 30000,
    });
    if (r.ok) {
      log(`✓ 邮箱密码已改为统一新密码 (${account.email})`);
      return ok('EXPORT_OK', { passwordChanged: true, newPassword: unified });
    }
    const detail = (typeof r.json === 'object') ? JSON.stringify(r.json).slice(0, 140) : '';
    log(`✗ 邮箱改密失败 status=${r.status} ${detail}`);
    return fail('PASSWORD_CHANGE_FAILED', `HTTP ${r.status}`, { passwordChanged: false, passwordChangeError: `HTTP ${r.status} ${detail}` });
  } catch (e) {
    log(`✗ 邮箱改密异常 ${e.message}`);
    return fail('PASSWORD_CHANGE_FAILED', String(e.message || e).slice(0, 80), { passwordChanged: false, passwordChangeError: String(e.message || e) });
  }
}

module.exports = {
  proxyPrecheck, emailPasswordChange, register, magicLinkLogin, apiKey, billing, exportStage,
};
