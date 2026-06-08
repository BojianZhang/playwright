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
const { waitForClerkVerifyLink, waitForVerifyCode } = require('./firstmail-client');

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

// ── S0: 代理/站点连通预检 ──────────────────────────────────────────────────
async function proxyPrecheck(ctx) {
  const { page, runtime } = ctx;
  const url = runtime.config?.site?.homeUrl || 'https://openrouter.ai';
  try {
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

// ── S2: 注册 OpenRouter（填表 → 过 Turnstile → 提交）─────────────────────────
async function register(ctx) {
  const { page, account, runtime, context } = ctx;
  const cfg = runtime.config || {};
  const signUpUrl = (cfg.site?.homeUrl || 'https://openrouter.ai') + '/sign-up';
  const { firstName, lastName } = deriveName(account.email);

  try {
    await page.goto(signUpUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navigation?.entryGotoTimeoutMs || 60000 });
    await page.waitForSelector('#emailAddress-field', { timeout: 25000 });
    await page.fill('#firstName-field', firstName).catch(() => {});
    await page.fill('#lastName-field', lastName).catch(() => {});
    await page.fill('#emailAddress-field', account.email);
    await page.fill('#password-field', account.password);
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

    // 有 callback,注入后若成功会跳验证页；等 ~25s。
    let explicitExists = false;
    for (let t = 0; t < 10; t += 1) {
      await page.waitForTimeout(2500);
      const url = page.url();
      if (/verify-email/.test(url)) return ok('REGISTER_SUBMIT_OK', { verifyUrl: url });
      if (!/sign-up/.test(url)) return ok('REGISTER_SUBMIT_OK', { url });
      // 检测"邮箱已注册"错误（含 Clerk 字段错误元素 + 文案）
      const exists = await page.evaluate(() => {
        const t = document.body.innerText;
        if (/already exists|already registered|is taken|taken\.|that email address is taken/i.test(t)) return true;
        const errs = Array.from(document.querySelectorAll('.cl-formFieldErrorText, [role="alert"]')).map(e => e.innerText).join(' ');
        return /taken|exists|registered/i.test(errs);
      }).catch(() => false);
      if (exists) { explicitExists = true; break; }
    }

    // Turnstile 已过却没进验证页 → 极可能邮箱已注册(错误文案各异) → 登录兜底。
    context.log && context.log(`[register] 未进验证页(exists=${explicitExists}),尝试登录兜底…`);
    const si = await signInExisting(page, account, runtime, context);
    if (si.ok) return ok('SIGNIN_OK', { loggedIn: true });
    // 登录也没成 → 统一按可重试处理(整账号换浏览器再试;真不存在则下次重新注册)。
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
    await page.goto(signinUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#identifier-field', { timeout: 20000 }).catch(() => {});
    await page.fill('#identifier-field', account.email).catch(() => {});
    await page.click('button:has-text("Continue")').catch(() => {});
    await page.waitForTimeout(2000);
    await page.fill('#password-field', account.password).catch(() => {});
    await page.click('button:has-text("Continue")').catch(() => {});
    await page.waitForTimeout(3000);

    // 快速判定"账号不存在/密码错"：避免给真·未注册账号白等 36s 验证码。
    const noAccount = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /couldn't find|couldn’t find|no account|not found|isn't right|incorrect|enter a correct/i.test(t);
    }).catch(() => false);
    if (noAccount) return { ok: false, reason: 'SIGNIN_NO_ACCOUNT' };

    // 登录页可能也有 Turnstile
    const needTs = await page.evaluate(() => !!window.__cfParams || !!document.querySelector('input[name="cf-turnstile-response"]')).catch(() => false);
    if (needTs) {
      const r = await solveAndInject(page, {
        provider: cfg.captcha?.provider, apiKey: cfg.captcha?.apiKey, pageUrl: signinUrl,
        cfRequestUrls: context.cfRequestUrls || [], timeoutMs: cfg.captcha?.solveTimeoutMs || 180000,
        log: (m) => log(`[turnstile] ${m}`),
      });
      if (r.ok) { await page.waitForTimeout(1200); await page.click('button:has-text("Continue")').catch(() => {}); }
    }

    // 二次校验：邮箱验证码（非登录链接）
    await page.waitForTimeout(2000);
    if (/factor-two|verify/.test(page.url())) {
      const { code } = await waitForVerifyCode({ apiKey: mb.apiKey, email: account.email, password: account.password, baseUrl: mb.apiBaseUrl, attempts: 12, intervalMs: 3000, log: (m) => log(`[mail] ${m}`) });
      if (!code) return { ok: false, reason: 'SIGNIN_CODE_NOT_FOUND' };
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
    return authed ? { ok: true } : { ok: false, reason: 'SIGNIN_NOT_CONFIRMED' };
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
      apiKey: mb.apiKey, email: account.email, password: account.password,
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
async function apiKey(ctx) {
  const { page, runtime } = ctx;
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

    // 打开新 Key 弹窗 —— 引导浮层(You're all set)常拦截点击,故每次先关浮层、滚动入视图、
    // 普通点击失败再强制点击;重试至 #name 出现(最多 4 次)。
    let modalOpen = false;
    for (let attempt = 0; attempt < 4 && !modalOpen; attempt += 1) {
      await dismissOnboarding(page);
      const newKeyBtn = page.locator('button:has-text("New Key"), button:has-text("Create Key"), button:has-text("Create API Key")').first();
      await newKeyBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      let clicked = await newKeyBtn.click({ timeout: 6000 }).then(() => true).catch(() => false);
      if (!clicked) clicked = await newKeyBtn.click({ timeout: 5000, force: true }).then(() => true).catch((e) => { log(`new-key click attempt ${attempt + 1}: ${e.message}`); return false; });
      modalOpen = await page.waitForSelector('#name', { state: 'visible', timeout: 7000 }).then(() => true).catch(() => false);
    }
    if (!modalOpen) { await dumpDom('newkey-modal-not-open'); return fail('API_KEY_MODAL_NOT_OPEN', 'API_KEY_MODAL_NOT_OPEN'); }

    // 名称（#name）—— Create 按钮在填名后才启用
    await page.fill('#name', keyName);
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
    // 3) 通用:任意可见 dialog 的关闭按钮 + Esc
    await page.evaluate(() => {
      document.querySelectorAll('[role="dialog"] button[aria-label="Close"], [role="dialog"] button[aria-label="close"]').forEach(b => b.click());
    }).catch(() => {});
  } catch (e) { /* ignore */ }
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
async function billing(ctx) {
  // TODO(S5): 账单+卡+充值（用户确认"先做到抽 API Key 为止"，暂不实现，需 --allow-charges + 卡信息）。
  return ok('BILLING_SKIPPED', { skipped: true });
}
async function exportStage(ctx) {
  return ok('EXPORT_OK', {});
}

module.exports = {
  proxyPrecheck, emailPasswordChange, register, magicLinkLogin, apiKey, billing, exportStage,
};
