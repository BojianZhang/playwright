'use strict';

// 引入文件系统模块，用来读取 Dreamina 第五阶段 profile JSON 配置文件。
const fs = require('fs');
// 引入 path 模块，用来安全拼接当前目录下的 profile 文件路径。
const path = require('path');

// 当前 Dreamina 第五阶段 profile 的固定文件路径。
const DREAMINA_POST_AUTH_READY_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-post-auth-ready-profile.json');

// profile 缓存对象，避免每次调用 adapter 方法都重复读取磁盘文件。
let dreaminaPostAuthReadyProfileCache = null;

/**
 * 读取 Dreamina 第五阶段 profile。
 *
 * 作用：
 * - 从 JSON 文件加载静态规则
 * - 默认走内存缓存
 * - 在需要时允许 forceReload 强制重新读取
 */
function loadDreaminaPostAuthReadyProfile(options = {}) {
  // 读取是否要求强制刷新 profile 的开关。
  const forceReload = Boolean(options?.forceReload);
  // 如果没有要求强制刷新，并且缓存里已经有 profile，就直接返回缓存。
  if (!forceReload && dreaminaPostAuthReadyProfileCache) return dreaminaPostAuthReadyProfileCache;
  // 从磁盘读取 profile 文件原始文本。
  const raw = fs.readFileSync(DREAMINA_POST_AUTH_READY_PROFILE_PATH, 'utf8');
  // 解析 JSON，同时去掉可能存在的 BOM 头。
  dreaminaPostAuthReadyProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  // 返回最新读取到的 profile 对象。
  return dreaminaPostAuthReadyProfileCache;
}

/**
 * 判断 locator 当前是否可见。
 *
 * 作用：
 * - 统一第五阶段所有可见性判断逻辑
 * - 出错时不抛异常，而是安全返回 false
 */
async function isVisible(locator) {
  // 尝试调用 Playwright 的 isVisible，若抛错则兜底为 false。
  return await locator.isVisible().catch(() => false);
}

/**
 * 从 selector 列表中找到第一个当前可见的目标。
 */
async function findFirstVisibleBySelectors(page, selectors = []) {
  // 依次遍历所有候选 selector。
  for (const selector of selectors) {
    // 基于当前 selector 取第一个匹配元素。
    const locator = page.locator(selector).first();
    // 如果当前 locator 可见，就直接返回命中结果。
    if (await isVisible(locator)) {
      return { ok: true, selector, locator };
    }
  }
  // 如果所有 selector 都没命中，就返回统一失败结构。
  return { ok: false, selector: '', locator: null };
}

/**
 * 从文本列表中找到第一个当前可见的目标。
 */
async function findFirstVisibleByTexts(page, texts = []) {
  // 依次遍历所有候选文本。
  for (const text of texts) {
    // 基于当前文本构造 Playwright text locator。
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    // 如果当前文本命中并且可见，就直接返回结果。
    if (await isVisible(locator)) {
      return { ok: true, text, locator };
    }
  }
  // 如果所有文本都没命中，就返回统一失败结构。
  return { ok: false, text: '', locator: null };
}

/**
 * 检测 Dreamina 第五阶段的 selector ready 信号。
 *
 * 作用：
 * - 优先依赖结构信号，而不是只看文本或 URL
 * - selector 命中时，一般更接近真实进入登录后区域
 */
async function findAllVisibleBySelectors(page, selectors = []) {
  const hits = [];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await isVisible(locator)) hits.push(selector);
  }
  return [...new Set(hits)];
}

async function findAllVisibleByTexts(page, texts = []) {
  const hits = [];
  for (const text of texts) {
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    if (await isVisible(locator)) hits.push(String(text || ''));
  }
  return [...new Set(hits)];
}

async function detectDreaminaPostAuthReadyBySelector(page, profile) {
  // 从 profile 中读取第五阶段入口 selector 列表。
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.postAuthReady?.selectors || []);
  // 如果没有命中 selector，就返回统一未命中结构。
  if (!selectorHit.ok) {
    return {
      ok: false,
      source: '',
      value: '',
      strength: '',
    };
  }

  // selector 命中时，按强信号返回。
  return {
    ok: true,
    source: 'selector',
    value: selectorHit.selector,
    strength: 'strong',
  };
}

/**
 * 检测 Dreamina 第五阶段的 UI ready 辅助信号。
 *
 * 作用：
 * - 这一层不是最终 UI 确认，而是“第五阶段入口已经像是登录后页面”的弱辅助信号
 * - 优先利用 uiSignals 里已经存在的工作台/用户面板规则
 */
async function detectDreaminaPostAuthReadyByUiSignals(page, profile) {
  // 优先检查 UI selector。
  const uiSelectorHit = await findFirstVisibleBySelectors(page, profile?.uiSignals?.selectors || []);
  // 如果 UI selector 命中，按中强辅助信号返回。
  if (uiSelectorHit.ok) {
    return {
      ok: true,
      source: 'user-panel',
      value: uiSelectorHit.selector,
      strength: 'medium',
    };
  }

  // 再检查 UI text。
  const uiTextHit = await findFirstVisibleByTexts(page, profile?.uiSignals?.texts || []);
  // 如果 UI text 命中，按弱辅助信号返回。
  if (uiTextHit.ok) {
    return {
      ok: true,
      source: 'dashboard',
      value: uiTextHit.text,
      strength: 'weak',
    };
  }

  // 都没命中时，返回统一未命中结构。
  return {
    ok: false,
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 检测 Dreamina 第五阶段的文本 ready 信号。
 *
 * 作用：
 * - 作为 selector 之后的补充判断
 * - 当登录后页面缺少稳定 selector 时，文本信号可以作为辅助入口判断
 */
async function detectDreaminaPostAuthReadyByText(page, profile) {
  // 从 profile 中读取第五阶段入口文本列表。
  const textHit = await findFirstVisibleByTexts(page, profile?.postAuthReady?.texts || []);
  // 如果没有命中文本，就返回统一未命中结构。
  if (!textHit.ok) {
    return {
      ok: false,
      source: '',
      value: '',
      strength: '',
    };
  }

  // 文本命中时，按弱信号返回。
  return {
    ok: true,
    source: 'text',
    value: textHit.text,
    strength: 'weak',
  };
}

/**
 * 检测 Dreamina 第五阶段的 URL ready 信号。
 *
 * 作用：
 * - 在页面已经明显离开注册流、进入登录后路径时，URL 片段是一个很实用的辅助信号
 * - 但 URL 只能做辅助判断，不能单独代表最终 registration-complete
 */
async function detectDreaminaPostAuthReadyByUrl(page, profile) {
  // 读取当前页面 URL。
  const currentUrl = String(page.url ? page.url() : '').trim();
  // 从 profile 的 urlIncludes 里找第一个命中项。
  const urlHit = (profile?.postAuthReady?.urlIncludes || []).find(fragment => currentUrl.includes(String(fragment || '')));
  // 如果没有命中 URL 片段，则返回统一未命中结构。
  if (!urlHit) {
    return {
      ok: false,
      source: '',
      value: '',
      strength: '',
    };
  }

  // URL 命中时，按弱辅助信号返回。
  return {
    ok: true,
    source: 'url',
    value: urlHit,
    strength: 'weak',
  };
}

/**
 * 在单个等待步内执行一次第五阶段入口 ready 探测。
 *
 * 当前顺序：
 * 1. selector ready
 * 2. UI signals ready
 * 3. text ready
 * 4. URL ready
 */
async function detectDreaminaPostAuthReadyOnce(page, profile) {
  // 第一层：优先查 selector ready。
  const selectorReady = await detectDreaminaPostAuthReadyBySelector(page, profile);
  if (selectorReady.ok) return selectorReady;

  // 第二层：再查 UI ready 辅助信号。
  const uiReady = await detectDreaminaPostAuthReadyByUiSignals(page, profile);
  if (uiReady.ok) return uiReady;

  // 第三层：再查文本 ready。
  const textReady = await detectDreaminaPostAuthReadyByText(page, profile);
  if (textReady.ok) return textReady;

  // 第四层：最后查 URL ready。
  const urlReady = await detectDreaminaPostAuthReadyByUrl(page, profile);
  if (urlReady.ok) return urlReady;

  // 都没有命中时，返回统一未命中结构。
  return {
    ok: false,
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 等待并确认 Dreamina 是否已经进入第五阶段上下文。
 *
 * 第一轮补强后：
 * - 不再只看 selector / text / url 三层
 * - 补进 UI login-after signals 作为第五阶段入口辅助信号
 * - 仍然只负责“第五阶段可以开始”，不在这里宣布 registration-complete
 */
async function waitForPostAuthReady(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第五阶段 profile。
  const profile = loadDreaminaPostAuthReadyProfile();
  // 构造等待步列表；当前先沿用和前几阶段一致的轻量节奏。
  const steps = [...new Set([0, Number(runtime?.postAuthPrimaryWaitMs || 600), Number(runtime?.postAuthSecondaryWaitMs || 1500)].filter(ms => Number(ms) >= 0))];

  // 记录最后一次执行到的等待步。
  let lastWaitStepMs = 0;
  // 依次执行每个等待步。
  for (const waitStepMs of steps) {
    // 更新当前等待步记录。
    lastWaitStepMs = waitStepMs;
    // 如果当前等待步大于 0，则等待对应毫秒数。
    if (waitStepMs > 0) await page.waitForTimeout(waitStepMs).catch(() => {});

    // 在当前等待步内执行一次完整 ready 探测。
    const readyResult = await detectDreaminaPostAuthReadyOnce(page, profile);
    // 如果当前等待步已确认进入第五阶段，就直接返回成功结构。
    if (readyResult.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.postAuth.ready | source=${readyResult.source} | value=${readyResult.value} | strength=${readyResult.strength} | waitStepMs=${waitStepMs}`);
      }
      return {
        ok: true,
        state: 'POST_AUTH_READY',
        source: readyResult.source,
        value: readyResult.value,
        strength: readyResult.strength,
        waitStepMs,
      };
    }

    // 当前等待步未命中时，记一条 miss，便于后续看是慢一拍还是根本没进第五阶段。
    if (typeof logInfo === 'function') logInfo(`dreamina.postAuth.ready | miss | waitStepMs=${waitStepMs}`);
  }

  // 所有等待步都未命中时，返回 not-ready。
  return {
    ok: false,
    state: 'POST_AUTH_NOT_READY',
    source: '',
    value: '',
    strength: '',
    waitStepMs: lastWaitStepMs,
  };
}

/**
 * 读取当前页面 cookie 名称列表。
 *
 * 作用：
 * - 只读取 cookie key 摘要，不触碰敏感值内容
 * - 给第五阶段 session readiness 提供最轻量的存储侧观察能力
 */
async function readDreaminaCookies(page, context = {}) {
  // 尝试从 page.context() 里读取浏览器上下文对象。
  const browserContext = typeof page?.context === 'function' ? page.context() : null;
  // 如果拿不到 context 或 context 不支持 cookies 方法，就回退空数组。
  if (!browserContext || typeof browserContext.cookies !== 'function') return [];
  // 读取当前上下文可见 cookie 列表。
  const cookies = await browserContext.cookies().catch(() => []);
  // 返回轻量规范化后的 cookie 摘要列表，保留 name/domain 供第五阶段做域约束判断。
  return (cookies || []).map(item => ({
    name: String(item?.name || '').trim(),
    domain: String(item?.domain || '').trim(),
  })).filter(item => item.name);
}

function isDreaminaCapCutSessionCookie(cookie = {}) {
  const name = String(cookie?.name || '').trim().toLowerCase();
  const domain = String(cookie?.domain || '').trim().toLowerCase();
  if (name !== 'sessionid') return false;
  return domain === '.capcut.com'
    || domain === 'dreamina.capcut.com'
    || domain.endsWith('.capcut.com');
}

function extractDreaminaCookieKeys(cookies = []) {
  return [...new Set((cookies || []).map(item => String(item?.name || '').trim()).filter(Boolean))];
}

function extractDreaminaSeenCookies(cookies = []) {
  return [...new Set((cookies || []).map(item => {
    const name = String(item?.name || '').trim();
    const domain = String(item?.domain || '').trim();
    if (!name) return '';
    return domain ? `${name}@${domain}` : name;
  }).filter(Boolean))];
}

function normalizeDreaminaSignalText(value) {
  return String(value || '').trim().toLowerCase();
}

function buildDreaminaSuccessTextTierMap(profile = {}) {
  const textTiers = profile?.successSignals?.textTiers || {};
  const map = new Map();
  for (const value of textTiers?.strong || []) map.set(normalizeDreaminaSignalText(value), 'strong');
  for (const value of textTiers?.medium || []) map.set(normalizeDreaminaSignalText(value), 'medium');
  for (const value of textTiers?.risky || []) map.set(normalizeDreaminaSignalText(value), 'risky');
  return map;
}

function buildDreaminaSoftCookieSummary(profile = {}, cookies = []) {
  const softCookieKeys = [...new Set((profile?.sessionSignals?.softCookieKeys || []).map(item => String(item || '').trim()).filter(Boolean))];
  const presentKeys = softCookieKeys.filter(key => (cookies || []).some(cookie => String(cookie?.name || '').trim() === key));
  return {
    expectedKeys: softCookieKeys,
    presentKeys,
    matchedRule: presentKeys[0] || '',
  };
}

/**
 * 读取当前页面 localStorage key 列表。
 *
 * 作用：
 * - 只读取 key 摘要，不读取值
 * - 减少敏感数据暴露与无意义大对象扫描
 */
async function readDreaminaLocalStorageKeys(page) {
  // 在页面上下文中读取 localStorage 的所有 key。
  const keys = await page.evaluate(() => Object.keys(window.localStorage || {})).catch(() => []);
  // 返回去重后的 key 列表。
  return [...new Set((keys || []).map(item => String(item || '').trim()).filter(Boolean))];
}

/**
 * 读取当前页面 sessionStorage key 列表。
 *
 * 作用：
 * - 只读取 key 摘要，不读取值
 * - 给第五阶段 session readiness 提供 sessionStorage 侧观察能力
 */
async function readDreaminaSessionStorageKeys(page) {
  // 在页面上下文中读取 sessionStorage 的所有 key。
  const keys = await page.evaluate(() => Object.keys(window.sessionStorage || {})).catch(() => []);
  // 返回去重后的 key 列表。
  return [...new Set((keys || []).map(item => String(item || '').trim()).filter(Boolean))];
}

/**
 * 根据 expectedKeys 与 actualKeys 构造统一存储摘要。
 */
function buildDreaminaStorageSummary(expectedKeys = [], actualKeys = []) {
  // 规范化 expectedKeys。
  const normalizedExpectedKeys = [...new Set((expectedKeys || []).map(item => String(item || '').trim()).filter(Boolean))];
  // 规范化 actualKeys。
  const normalizedActualKeys = [...new Set((actualKeys || []).map(item => String(item || '').trim()).filter(Boolean))];
  // 取出当前存在的交集 key。
  const presentKeys = normalizedExpectedKeys.filter(key => normalizedActualKeys.includes(key));
  // 命中的第一个 key 可以先当第一版 matchedRule。
  const matchedRule = presentKeys[0] || '';
  // 返回统一摘要结构。
  return {
    expectedKeys: normalizedExpectedKeys,
    presentKeys,
    matchedRule,
  };
}

/**
 * 检查第五阶段 session / storage 可用态。
 *
 * 第一轮落地目标：
 * - 真实读取 cookie/localStorage/sessionStorage 的 key 摘要
 * - 按 profile 中定义的 expectedKeys 做命中判断
 * - 给出统一的 session inspection 返回结构
 *
 * 注意：
 * - 当前仍然只读 key，不读 value
 * - 这样既能给运维足够信号，也尽量避免把敏感值带进日志与结构体
 */
async function inspectPostAuthSession(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第五阶段 profile。
  const profile = loadDreaminaPostAuthReadyProfile();

  // 读取当前 cookie 摘要列表。
  const cookies = await readDreaminaCookies(page, context);
  // 只把 cookie name 提炼成 key 列表，供统一摘要复用。
  const cookieKeys = extractDreaminaCookieKeys(cookies);
  // 额外保留当前真实可见的 cookie name@domain 列表，便于排查 session 命中缺失。
  const seenCookies = extractDreaminaSeenCookies(cookies);
  // 读取当前 localStorage key 列表。
  const localStorageKeys = await readDreaminaLocalStorageKeys(page);
  // 读取当前 sessionStorage key 列表。
  const sessionStorageKeys = await readDreaminaSessionStorageKeys(page);

  // 根据 profile 规则构造 cookie 摘要。
  const cookieSummary = buildDreaminaStorageSummary(profile?.sessionSignals?.cookieKeys || [], cookieKeys);
  const softCookieSummary = buildDreaminaSoftCookieSummary(profile, cookies);
  // 根据 profile 规则构造 localStorage 摘要。
  const localStorageSummary = buildDreaminaStorageSummary(profile?.sessionSignals?.localStorageKeys || [], localStorageKeys);
  // 根据 profile 规则构造 sessionStorage 摘要。
  const sessionStorageSummary = buildDreaminaStorageSummary(profile?.sessionSignals?.sessionStorageKeys || [], sessionStorageKeys);

  // 优先以 Dreamina/CapCut 域下的 sessionid cookie 命中作为 session 硬信号。
  const matchedSessionCookie = (cookies || []).find(isDreaminaCapCutSessionCookie);
  if (matchedSessionCookie && cookieSummary.presentKeys.includes('sessionid')) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.postAuth.session | source=cookie | value=sessionid@${matchedSessionCookie.domain} | strength=strong`);
    }
    return {
      ok: true,
      state: 'SESSION_SIGNAL_DETECTED',
      source: 'cookie',
      value: `sessionid@${matchedSessionCookie.domain}`,
      strength: 'strong',
      stateChanged: null,
      cookieSummary: {
        ...cookieSummary,
        matchedRule: 'sessionid',
        matchedDomain: matchedSessionCookie.domain,
        seenCookies,
        softCookieSummary,
      },
      seenCookies,
      localStorageSummary,
      sessionStorageSummary,
    };
  }

  if (softCookieSummary.presentKeys.length > 0) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.postAuth.session | source=soft-cookie | value=${softCookieSummary.presentKeys.join('|')} | strength=medium`);
    }
    return {
      ok: true,
      state: 'SESSION_SIGNAL_SOFT_DETECTED',
      source: 'soft-cookie',
      value: softCookieSummary.presentKeys.join('|'),
      strength: 'medium',
      stateChanged: null,
      cookieSummary: {
        ...cookieSummary,
        seenCookies,
        softCookieSummary,
      },
      seenCookies,
      localStorageSummary,
      sessionStorageSummary,
    };
  }

  // 再以 localStorage 命中作为 session 基础信号。
  if (localStorageSummary.presentKeys.length > 0) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.postAuth.session | source=local-storage | value=${localStorageSummary.matchedRule} | strength=medium`);
    }
    return {
      ok: true,
      state: 'SESSION_SIGNAL_DETECTED',
      source: 'local-storage',
      value: localStorageSummary.matchedRule,
      strength: 'medium',
      stateChanged: null,
      cookieSummary: {
        ...cookieSummary,
        seenCookies,
        softCookieSummary,
      },
      seenCookies,
      localStorageSummary,
      sessionStorageSummary,
    };
  }

  // 最后以 sessionStorage 命中作为较弱 session 基础信号。
  if (sessionStorageSummary.presentKeys.length > 0) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.postAuth.session | source=session-storage | value=${sessionStorageSummary.matchedRule} | strength=weak`);
    }
    return {
      ok: true,
      state: 'SESSION_SIGNAL_DETECTED',
      source: 'session-storage',
      value: sessionStorageSummary.matchedRule,
      strength: 'weak',
      stateChanged: null,
      cookieSummary: {
        ...cookieSummary,
        seenCookies,
        softCookieSummary,
      },
      seenCookies,
      localStorageSummary,
      sessionStorageSummary,
    };
  }

  // 如果三类存储侧信号都没命中，按 not-found 返回。
  return {
    ok: false,
    state: 'SESSION_SIGNAL_NOT_FOUND',
    source: '',
    value: '',
    strength: '',
    stateChanged: null,
    cookieSummary: {
      ...cookieSummary,
      seenCookies,
      softCookieSummary,
    },
    seenCookies,
    localStorageSummary,
    sessionStorageSummary,
  };
}

/**
 * Confirm bridge-oriented UI signals for the current post-auth transition stage.
 *
 * Note:
 * - Current Dreamina implementation still relies heavily on birthday-panel bridge signals.
 * - These signals indicate transition readiness, not a fully mature logged-in dashboard/user-panel state.
 */
function isDreaminaBridgeSignal(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return text.includes('birthday')
    || text === 'year'
    || text === 'month'
    || text === 'day'
    || text === 'next';
}

async function confirmPostAuthUi(page, runtime = {}, context = {}) {
  const profile = loadDreaminaPostAuthReadyProfile();
  const bridgeSelectors = await findAllVisibleBySelectors(page, profile?.uiSignals?.selectors || []);
  const workspaceSelectors = await findAllVisibleBySelectors(page, profile?.successSignals?.workspaceSelectors || []);
  const bridgeTexts = await findAllVisibleByTexts(page, profile?.uiSignals?.texts || []);
  const workspaceTexts = await findAllVisibleByTexts(page, profile?.successSignals?.workspaceTexts || []);
  const matchedSelectors = [...new Set([...bridgeSelectors, ...workspaceSelectors])];
  const matchedTexts = [...new Set([...bridgeTexts, ...workspaceTexts])];

  const workspaceSelectorHit = workspaceSelectors[0] || '';
  if (workspaceSelectorHit) {
    return {
      ok: true,
      state: 'WORKSPACE_UI_SELECTOR_VISIBLE',
      source: 'selector',
      value: workspaceSelectorHit,
      strength: 'strong',
      matchedSelectors,
      matchedTexts,
    };
  }

  const workspaceTextHit = workspaceTexts[0] || '';
  if (workspaceTextHit) {
    return {
      ok: true,
      state: 'WORKSPACE_UI_TEXT_VISIBLE',
      source: 'text',
      value: workspaceTextHit,
      strength: 'medium',
      matchedSelectors,
      matchedTexts,
    };
  }

  const selectorHit = bridgeSelectors[0] ? { ok: true, selector: bridgeSelectors[0] } : { ok: false, selector: '' };
  if (selectorHit.ok) {
    return {
      ok: true,
      state: 'BRIDGE_UI_SELECTOR_VISIBLE',
      source: 'selector',
      value: selectorHit.selector,
      strength: 'strong',
      matchedSelectors,
      matchedTexts,
    };
  }

  const textHit = bridgeTexts[0] ? { ok: true, text: bridgeTexts[0] } : { ok: false, text: '' };
  if (textHit.ok) {
    return {
      ok: true,
      state: 'BRIDGE_UI_TEXT_VISIBLE',
      source: 'text',
      value: textHit.text,
      strength: 'weak',
      matchedSelectors,
      matchedTexts,
    };
  }

  return {
    ok: false,
    state: 'POST_AUTH_UI_NOT_CONFIRMED',
    source: '',
    value: '',
    strength: '',
    matchedSelectors,
    matchedTexts,
  };
}

/**
 * Confirm post-auth result for Dreamina.
 *
 * Strategy:
 * - successSignals can confirm registration-complete
 * - sessionInspection + uiConfirmation can provide an additional success path
 * - failureSignals can confirm explicit failure
 * - otherwise return unknown
 */
async function confirmPostAuthResult(page, runtime = {}, context = {}) {
  const profile = loadDreaminaPostAuthReadyProfile();
  const { sessionInspection = null, uiConfirmation = null } = context;
  const matchedSuccessSelectors = await findAllVisibleBySelectors(page, profile?.successSignals?.selectors || []);
  const matchedSuccessTexts = await findAllVisibleByTexts(page, profile?.successSignals?.texts || []);
  const matchedBridgeSelectors = await findAllVisibleBySelectors(page, profile?.bridgeSignals?.selectors || []);
  const matchedBridgeTexts = await findAllVisibleByTexts(page, profile?.bridgeSignals?.texts || []);
  const matchedFailureSelectors = await findAllVisibleBySelectors(page, profile?.failureSignals?.selectors || []);
  const matchedFailureTexts = await findAllVisibleByTexts(page, profile?.failureSignals?.texts || []);

  const successSelector = matchedSuccessSelectors[0] ? { ok: true, selector: matchedSuccessSelectors[0] } : { ok: false, selector: '' };
  if (successSelector.ok) {
    return {
      ok: true,
      state: 'REGISTRATION_COMPLETE',
      nextStage: 'account-delivery',
      source: 'selector',
      value: successSelector.selector,
      strength: 'strong',
      settleStage: 'primary-success',
      stateChanged: true,
      retryCount: 0,
      winningSuccessSignal: {
        type: 'selector',
        value: successSelector.selector,
      },
      matchedSelectors: matchedSuccessSelectors,
      matchedTexts: matchedSuccessTexts,
    };
  }

  const successText = matchedSuccessTexts[0] ? { ok: true, text: matchedSuccessTexts[0] } : { ok: false, text: '' };
  if (successText.ok) {
    const textTierMap = buildDreaminaSuccessTextTierMap(profile);
    const normalizedText = normalizeDreaminaSignalText(successText.text);
    const textTier = textTierMap.get(normalizedText) || 'unknown';
    const bridgeOnlyUi = Boolean(
      uiConfirmation?.matchedSelectors?.length
      && uiConfirmation.matchedSelectors.every(selector => String(selector || '').includes('birthday-next'))
      && (uiConfirmation?.matchedTexts || []).every(text => ['year', 'month', 'day', 'next'].includes(normalizeDreaminaSignalText(text)))
    );
    const strongSession = Boolean(sessionInspection?.ok && sessionInspection?.value);
    const hasStrongText = textTier === 'strong';
    const hasMediumText = textTier === 'medium';
    const riskyText = textTier === 'risky';
    const nonBridgeSelector = matchedSuccessSelectors.some(selector => !String(selector || '').includes('birthday-next'));

    const allowTextSuccess = !bridgeOnlyUi && (
      strongSession
      || nonBridgeSelector
      || hasStrongText
      || (hasMediumText && (strongSession || nonBridgeSelector))
      || (riskyText && strongSession)
    );

    if (allowTextSuccess) {
      return {
        ok: true,
        state: 'REGISTRATION_COMPLETE',
        nextStage: 'account-delivery',
        source: 'text',
        value: successText.text,
        strength: hasStrongText ? 'medium' : (hasMediumText ? 'weak' : 'weak'),
        settleStage: 'secondary-success',
        stateChanged: true,
        retryCount: 0,
        winningSuccessSignal: {
          type: 'text',
          tier: textTier,
          value: successText.text,
        },
        matchedSelectors: matchedSuccessSelectors,
        matchedTexts: matchedSuccessTexts,
      };
    }
  }

  const bridgeSelector = matchedBridgeSelectors[0] ? { ok: true, selector: matchedBridgeSelectors[0] } : { ok: false, selector: '' };
  if (bridgeSelector.ok) {
    return {
      ok: true,
      state: 'POST_AUTH_READY_ONLY',
      nextStage: 'account-delivery',
      source: 'selector',
      value: bridgeSelector.selector,
      strength: 'strong',
      settleStage: 'primary-success',
      stateChanged: true,
      retryCount: 0,
      matchedSelectors: matchedBridgeSelectors,
      matchedTexts: matchedBridgeTexts,
    };
  }

  const bridgeText = matchedBridgeTexts[0] ? { ok: true, text: matchedBridgeTexts[0] } : { ok: false, text: '' };
  if (bridgeText.ok) {
    return {
      ok: true,
      state: 'POST_AUTH_READY_ONLY',
      nextStage: 'account-delivery',
      source: 'text',
      value: bridgeText.text,
      strength: 'weak',
      settleStage: 'secondary-success',
      stateChanged: true,
      retryCount: 0,
      matchedSelectors: matchedBridgeSelectors,
      matchedTexts: matchedBridgeTexts,
    };
  }

  if (sessionInspection?.ok && uiConfirmation?.ok) {
    return {
      ok: true,
      state: 'REGISTRATION_COMPLETE',
      nextStage: 'account-delivery',
      source: 'session+ui',
      value: [sessionInspection.value, uiConfirmation.value].filter(Boolean).join(' | '),
      strength: sessionInspection?.strength === 'strong' || uiConfirmation?.strength === 'strong' ? 'medium' : 'weak',
      settleStage: 'session-check',
      stateChanged: true,
      retryCount: 0,
      winningSuccessSignal: {
        type: 'session+ui',
        value: [sessionInspection.value, uiConfirmation.value].filter(Boolean).join(' | '),
      },
      matchedSelectors: Array.isArray(uiConfirmation?.matchedSelectors) ? uiConfirmation.matchedSelectors : [],
      matchedTexts: Array.isArray(uiConfirmation?.matchedTexts) ? uiConfirmation.matchedTexts : [],
    };
  }

  if (uiConfirmation?.ok) {
    return {
      ok: true,
      state: 'POST_AUTH_READY_ONLY',
      nextStage: 'account-delivery',
      source: uiConfirmation.source || '',
      value: uiConfirmation.value || '',
      strength: uiConfirmation.strength || 'weak',
      settleStage: 'ui-bridge',
      stateChanged: true,
      retryCount: 0,
      matchedSelectors: Array.isArray(uiConfirmation?.matchedSelectors) ? uiConfirmation.matchedSelectors : [],
      matchedTexts: Array.isArray(uiConfirmation?.matchedTexts) ? uiConfirmation.matchedTexts : [],
    };
  }

  const failureSelector = matchedFailureSelectors[0] ? { ok: true, selector: matchedFailureSelectors[0] } : { ok: false, selector: '' };
  if (failureSelector.ok) {
    return {
      ok: false,
      state: 'POST_AUTH_FAILED',
      nextStage: '',
      source: 'selector',
      value: failureSelector.selector,
      strength: 'strong',
      settleStage: 'primary-failure',
      stateChanged: null,
      retryCount: 0,
      matchedSelectors: matchedFailureSelectors,
      matchedTexts: matchedFailureTexts,
    };
  }

  const failureText = matchedFailureTexts[0] ? { ok: true, text: matchedFailureTexts[0] } : { ok: false, text: '' };
  if (failureText.ok) {
    return {
      ok: false,
      state: 'POST_AUTH_FAILED',
      nextStage: '',
      source: 'text',
      value: failureText.text,
      strength: 'weak',
      settleStage: 'secondary-failure',
      stateChanged: null,
      retryCount: 0,
      matchedSelectors: matchedFailureSelectors,
      matchedTexts: matchedFailureTexts,
    };
  }

  return {
    ok: false,
    state: 'POST_AUTH_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: 'none',
    stateChanged: null,
    retryCount: 0,
    matchedSelectors: [],
    matchedTexts: [],
  };
}

/**
 * Classify Dreamina post-auth failure reason.
 *
 * Map raw stage reason/state to a Dreamina-specific siteReason.
 */
function classifyPostAuthFailure(input = {}) {
  // 提取原始 reason/state，并统一转成大写。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;

  // 先覆盖第五阶段当前最常见的草案映射。
  if (reason === 'POST_AUTH_NOT_READY') siteReason = 'DREAMINA_POST_AUTH_NOT_READY';
  else if (reason === 'SESSION_SIGNAL_NOT_FOUND' || reason === 'SESSION_INSPECTION_UNKNOWN') siteReason = 'DREAMINA_SESSION_SIGNAL_NOT_FOUND';
  else if (reason === 'POST_AUTH_UI_NOT_CONFIRMED') siteReason = 'DREAMINA_POST_AUTH_UI_NOT_CONFIRMED';
  else if (reason === 'POST_AUTH_READY_ONLY') siteReason = 'DREAMINA_POST_AUTH_READY_ONLY';
  else if (reason === 'POST_AUTH_FAILED') siteReason = 'DREAMINA_POST_AUTH_FAILED';
  else if (reason === 'POST_AUTH_RESULT_UNKNOWN') siteReason = 'DREAMINA_POST_AUTH_RESULT_UNKNOWN';

  // 返回统一分类结果。
  return {
    reason,
    siteReason,
    hardFailure: false,
  };
}

module.exports = {
  loadDreaminaPostAuthReadyProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  waitForPostAuthReady,
  inspectPostAuthSession,
  confirmPostAuthUi,
  confirmPostAuthResult,
  classifyPostAuthFailure,
};
