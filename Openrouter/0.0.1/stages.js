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
const cardPool = require('./billing/card-pool');
const billingLedger = require('./billing/billing-ledger');
const accountStore = require('./account-state/account-store');
const { generateAddress } = require('./billing/address-gen');

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

// ── S2: 注册 OpenRouter（填表 → 过 Turnstile → 提交);登录模式则直接登录已有账号 ──────
async function register(ctx) {
  const { page, account, runtime, context } = ctx;
  const cfg = runtime.config || {};

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
      const { code } = await waitForVerifyCode({ apiKey: mb.apiKey, email: account.email, password: mailboxPassword(runtime, account), baseUrl: mb.apiBaseUrl, attempts: 14, intervalMs: 3000, sinceTs, log: (m) => log(`[mail] ${m}`) });
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
    // 3) 通用:关掉残留的引导浮层，但**绝不**关账单相关弹窗(地址/付款/购买)——那是我们要填的。
    await page.evaluate(() => {
      const BILLING = /Billing Address|Payment Method|Add Credits|Buy Credits|Purchase Credits|Address line|card number|Total due/i;
      document.querySelectorAll('[role="dialog"]').forEach((dlg) => {
        if (BILLING.test(dlg.innerText || '')) return; // 跳过账单弹窗，别误关
        dlg.querySelectorAll('button[aria-label="Close"], button[aria-label="close"]').forEach((b) => b.click());
      });
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
  const log = (m) => context.log && context.log(`[billing] ${m}`);

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
      await billingLedger.record({ email: account.email, result, charged: charged || 0, cardLast4: cardLast4 || '', jobId: context.jobId || '', error });
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

  const steps = { doAddress: true, doCard, doPurchase };

  // 仅绑定地址(不加卡)：无需取卡，直接走地址流程。
  if (!doCard) {
    let outcome;
    try { outcome = await runBillingFlow(page, null, address, 0, cfg, log, steps); }
    catch (e) { outcome = { result: 'error', error: String(e.message || e).slice(0, 200) }; }
    const status = outcome.result === 'address-bound' ? 'address-bound' : outcome.result;
    await recordBilling(status, 0, '', outcome.error);
    if (status === 'address-bound') { log('✓ 账单地址已绑定'); return ok('BILLING_OK', { billingStatus: 'address-bound', charged: 0, cardLast4: '' }); }
    return softBilling(cfg, status, action);
  }

  // 需要加卡(card / charge)：从卡池取卡，被拒自动换下一张。
  const maxCardTries = Math.max(1, Number(tp.maxCardTries) || cfg.billing?.maxCardTries || 3);
  const pushCard = (last4, result, error) => {
    try { context.onCard && context.onCard(cardPool.snapshot(), { last4, result, error: error || '' }); } catch (_e) { /* ignore */ }
  };

  let lastResult = 'no-card';
  for (let tryN = 1; tryN <= maxCardTries; tryN += 1) {
    if (page.isClosed()) { log('页面/浏览器已关闭，停止试卡（不消耗卡）'); lastResult = 'page-closed'; break; }
    const card = await cardPool.acquire();
    if (!card) { log('卡池暂无可用卡（可能被其它并发任务占用或已用尽）'); lastResult = 'no-card'; break; }
    log(`第 ${tryN}/${maxCardTries} 张卡 ••${card.last4} ${doPurchase ? `充值 $${amount}` : '加卡(不扣费)'}…`);

    let outcome;
    try {
      outcome = await runBillingFlow(page, card, address, amount, cfg, log, steps);
    } catch (e) {
      outcome = { result: 'error', error: String(e.message || e).slice(0, 200) };
    }
    // 卡池计数：success=扣费成功(计一次用量)；card-bound=仅加卡(不计用量)；declined=踢卡。
    const repResult = outcome.result === 'card-bound' ? 'bound' : outcome.result;
    await cardPool.report(card.id, { result: repResult, error: outcome.error });
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
    log(`✗ 卡 ••${card.last4} 结果=${outcome.result} ${outcome.error || ''} → 换下一张`);
  }
  await recordBilling(lastResult === 'no-card' ? 'no-card' : 'declined', 0, '', '');
  return softBilling(cfg, lastResult, action);
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
async function runBillingFlow(page, card, address, amount, cfg, log, steps) {
  const { doCard, doPurchase } = steps;
  const billingUrl = cfg.site?.billingUrl || 'https://openrouter.ai/settings/credits';
  const dialogs = [];
  const onDialog = (d) => { dialogs.push(String(d.message() || '')); d.accept().catch(() => {}); };
  page.on('dialog', onDialog);
  try {
    await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await dismissOnboarding(page);

    const onSignin = await page.evaluate(() => /sign-in|sign-up/.test(location.pathname)).catch(() => false);
    if (onSignin) return { result: 'error', error: 'NOT_LOGGED_IN' };

    await clickFirst(page, ['button:has-text("Add Credits")', 'button:has-text("Buy Credits")', 'button:has-text("Add a Payment Method")'], 8000).catch(() => {});
    await page.waitForTimeout(1500);

    let addrSaved = false;
    let cardSaved = false;
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
        if (!clicked) log('账单地址提交按钮未可点（可能字段未填全/按钮仍禁用）');
        addrSaved = true;
        await page.waitForTimeout(2000);
      } else if (state === 'payment') {
        if (!doCard) return { result: 'address-bound' }; // 仅绑地址：到付款方式弹窗说明地址已存
        await addPaymentMethod(page, card, address, log);
        await page.waitForTimeout(1200);
        const declErr = await readBillingError(page);
        await clickFirst(page, ['button:has-text("Save payment method")', 'button:has-text("Save")'], 8000).catch(() => {});
        await page.waitForTimeout(3000);
        const err = (await readBillingError(page)) || declErr;
        if (err) {
          // 5xx / 网关 / "稍后再试" = 服务器或代理错误（多半是代理 IP 被 Stripe 风控），
          // 不是卡被拒 → 按瞬时错误处理：不踢卡、不消耗卡用量、可换代理重试。
          if (/error\s*5\d\d|bad gateway|gateway time|service unavailable|temporarily unavailable|try again|something went wrong|稍后|服务(暂时)?不可用|网关/i.test(err)) {
            log(`付款返回服务器/网关错误：${err.slice(0, 80)} → 按瞬时错误(不踢卡，建议换代理重试)`);
            return { result: 'error', error: `SERVER_ERROR:${err.slice(0, 80)}` };
          }
          return { result: 'declined', error: err }; // 真·卡被拒 → 踢卡
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
        await clickFirst(page, ['button:has-text("Add Credits")', 'button:has-text("Add a Payment Method")', 'button:has-text("Buy Credits")', 'a:has-text("Credits")'], 4000).catch(() => {});
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

// 判断当前显示的是哪个弹窗：address / payment / purchase / none。
async function detectModalState(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '');
    const has = (re) => re.test(t);
    const hasBtn = (label) => Array.from(document.querySelectorAll('button')).some(b => new RegExp(label, 'i').test(b.innerText || ''));
    if (has(/Purchase Credits/i) || (has(/Total due/i) && hasBtn('Purchase'))) return 'purchase';
    if (has(/Billing Address/i) || hasBtn('Update Address')) return 'address';
    if (has(/Payment Method/i) || hasBtn('Save payment method')) return 'payment';
    return 'none';
  }).catch(() => 'none');
}

// 读取被拒/错误提示文本(toast 或内联)。
async function readBillingError(page) {
  return page.evaluate(() => {
    const t = (document.body.innerText || '');
    const m = t.match(/(your card was declined|card was declined|银行卡被拒绝[^\n]*|payment issue|declined[^\n]*|Error 5\d\d[^\n]*)/i);
    return m ? m[0].slice(0, 160) : '';
  }).catch(() => '');
}

// 综合判定结果(被拒/成功)；dialogs 为已捕获的 JS alert 文案数组。
async function detectOutcome(page, dialogs) {
  const dlg = (dialogs || []).join(' ');
  if (/payment is processing|credits will be added|check back shortly/i.test(dlg)) return { result: 'success', dialog: dlg.slice(0, 160) };
  const err = await readBillingError(page);
  if (err) return { result: 'declined', error: err };
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
async function addPaymentMethod(page, card, address, log) {
  // 选「银行卡 / Card」tab(若有)。
  await clickFirst(page, ['button:has-text("银行卡")', 'button:has-text("Card")', '[role="tab"]:has-text("Card")'], 2500).catch(() => {});
  await page.waitForTimeout(400);
  const exp = `${card.expMonth}${card.expYear}`; // Stripe 自动格式化 MM/YY
  const okNum = await fillAcross(page, ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput" i]', 'input[placeholder*="1234" i]', 'input[placeholder*="卡号"]'], card.number, log);
  const okExp = await fillAcross(page, ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput" i]', 'input[placeholder*="MM" i]'], exp, log);
  const okCvc = await fillAcross(page, ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput" i]', 'input[placeholder*="CVC" i]', 'input[placeholder*="安全码"]'], card.cvc, log);
  // 诊断：到底哪个卡字段没填上（iframe 数 + 命中情况），定位 Stripe 表单问题
  log(`填卡: 卡号=${okNum ? '✓' : '✗'} 有效期=${okExp ? '✓' : '✗'} CVC=${okCvc ? '✓' : '✗'} | iframe数=${page.frames().length}`);
  // 诊断：付款时弹出的"校验"到底是 Cloudflare 人机 还是 银行 3DS（只在首次付款步打一次，避免刷屏）。
  if (!page._obstacleDumped) {
    page._obstacleDumped = true;
    const ob = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || f.title || '').filter(Boolean);
      const hints = [];
      if (/verify you are human|are you human|i'?m not a robot|确认您是真人|人机验证|需要验证/i.test(t)) hints.push('人机/Cloudflare文案');
      if (/3-?d secure|3ds|authenticate|authoriz|verification code|enter the code|短信验证码|授权这?笔|银行验证/i.test(t)) hints.push('3DS/银行验证文案');
      return { cfHook: !!(window.__cfParams && window.__cfParams.sitekey), frames: frames.slice(0, 12), hints, snippet: t.replace(/\s+/g, ' ').slice(0, 240) };
    }).catch(() => ({}));
    log(`付款校验诊断: cfHook=${ob.cfHook} 文案=${(ob.hints || []).join('/') || '无'}`);
    log(`付款 iframe: ${JSON.stringify(ob.frames || [])}`);
    log(`付款弹窗文案: ${(ob.snippet || '').slice(0, 200)}`);
  }
  // 卡片邮编(优先卡自带，否则用地址邮编)。
  const zip = card.zip || (address && address.zip) || '';
  if (zip) await fillAcross(page, ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput" i]', 'input[placeholder*="邮政编码"]'], zip, log);
  await selectCountry(page, 'United States', log);
  // 确保「使用 Link 保存我的信息」不勾。
  await uncheckLink(page, log);
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

// 设置购买额度。
async function setPurchaseAmount(page, amount, log) {
  const sels = ['input[type="number"]', 'input[name="amount"]', 'input[placeholder*="25000"]', 'input[inputmode="decimal"]', 'input[inputmode="numeric"]'];
  const ok = await fillAcross(page, sels, String(amount), log);
  if (!ok) log && log('未找到 Amount 输入框');
}

// 国家选择(select 或 combobox)。多为已默认 United States，尽力设置。
async function selectCountry(page, country, log) {
  try {
    const frames = [page.mainFrame(), ...page.frames()];
    for (const f of frames) {
      const sel = f.locator('select[name="country"], select[autocomplete="country"], select[name*="country" i]').first();
      if (await sel.count().catch(() => 0)) {
        await sel.selectOption({ label: country }).catch(async () => {
          await sel.selectOption('US').catch(() => {});
        });
        return;
      }
    }
  } catch (_e) { /* ignore */ }
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

// 跨主框架 + 所有子 iframe 寻找首个可见输入框并填值(Stripe 输入需 focus+type)。
async function fillAcross(page, selectors, value, log) {
  if (value == null || value === '') return false;
  const frames = [page.mainFrame(), ...page.frames()];
  for (const sel of selectors) {
    for (const f of frames) {
      try {
        const loc = f.locator(sel).first();
        if (!(await loc.count().catch(() => 0))) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 1500 }).catch(() => {});
        await loc.fill('').catch(() => {});
        const typed = await loc.fill(String(value)).then(() => true).catch(() => false);
        if (!typed) { await loc.type(String(value), { delay: 25 }).catch(() => {}); }
        return true;
      } catch (_e) { /* try next */ }
    }
  }
  return false;
}

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
