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
 * 检查第五阶段 session / storage 可用态。
 *
 * 当前草案实现只先给出统一结构：
 * - 先读 profile 里的 cookie/localStorage/sessionStorage 规则
 * - 再给出空实现下的稳定返回结构
 *
 * 注意：
 * - 这一版先把字段和注释写清，不急着在没有真实信号前硬编码逻辑
 */
async function inspectPostAuthSession(page, runtime = {}, context = {}) {
  // 读取 Dreamina 第五阶段 profile。
  const profile = loadDreaminaPostAuthReadyProfile();
  // 返回统一草案结构；后续接真实 session 信号时，在这个结构上补齐即可。
  return {
    ok: false,
    state: 'SESSION_INSPECTION_UNKNOWN',
    source: '',
    value: '',
    strength: '',
    stateChanged: null,
    cookieSummary: {
      presentKeys: [],
      matchedRule: '',
      expectedKeys: profile?.sessionSignals?.cookieKeys || [],
    },
    localStorageSummary: {
      presentKeys: [],
      matchedRule: '',
      expectedKeys: profile?.sessionSignals?.localStorageKeys || [],
    },
    sessionStorageSummary: {
      presentKeys: [],
      matchedRule: '',
      expectedKeys: profile?.sessionSignals?.sessionStorageKeys || [],
    },
  };
}

/**
 * 确认第五阶段 UI 登录后信号。
 *
 * 当前草案实现：
 * - 优先查 UI selector
 * - 再查 UI text
 * - 返回统一结构
 */
async function confirmPostAuthUi(page, runtime = {}, context = {}) {
  // 读取 Dreamina 第五阶段 profile。
  const profile = loadDreaminaPostAuthReadyProfile();

  // 先查 selector。
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.uiSignals?.selectors || []);
  if (selectorHit.ok) {
    return {
      ok: true,
      state: 'USER_PANEL_VISIBLE',
      source: 'selector',
      value: selectorHit.selector,
      strength: 'strong',
    };
  }

  // 再查 text。
  const textHit = await findFirstVisibleByTexts(page, profile?.uiSignals?.texts || []);
  if (textHit.ok) {
    return {
      ok: true,
      state: 'DASHBOARD_VISIBLE',
      source: 'text',
      value: textHit.text,
      strength: 'weak',
    };
  }

  // 当前未确认 UI 登录后信号。
  return {
    ok: false,
    state: 'POST_AUTH_UI_NOT_CONFIRMED',
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 收口第五阶段最终结果。
 *
 * 当前草案实现策略：
 * - 如果 successSignals 命中，直接认定 registration-complete
 * - 否则如果 sessionInspection 和 uiConfirmation 都强成立，也可作为中强成功草案
 * - 否则如果 failureSignals 命中，返回失败
 * - 最后返回 unknown
 */
async function confirmPostAuthResult(page, runtime = {}, context = {}) {
  // 读取 Dreamina 第五阶段 profile。
  const profile = loadDreaminaPostAuthReadyProfile();
  // 解构前序步骤结果。
  const { sessionInspection = null, uiConfirmation = null } = context;

  // 优先查 success selector。
  const successSelector = await findFirstVisibleBySelectors(page, profile?.successSignals?.selectors || []);
  if (successSelector.ok) {
    return {
      ok: true,
      state: 'REGISTRATION_COMPLETE',
      nextStage: 'registration-complete',
      source: 'selector',
      value: successSelector.selector,
      strength: 'strong',
      settleStage: 'primary-success',
      stateChanged: true,
      retryCount: 0,
    };
  }

  // 再查 success text。
  const successText = await findFirstVisibleByTexts(page, profile?.successSignals?.texts || []);
  if (successText.ok) {
    return {
      ok: true,
      state: 'REGISTRATION_COMPLETE',
      nextStage: 'registration-complete',
      source: 'text',
      value: successText.text,
      strength: 'weak',
      settleStage: 'secondary-success',
      stateChanged: true,
      retryCount: 0,
    };
  }

  // 如果 sessionInspection 与 uiConfirmation 都成立，可以作为阶段 5 第一版的联合成功草案。
  if (sessionInspection?.ok && uiConfirmation?.ok) {
    return {
      ok: true,
      state: 'POST_AUTH_SUCCESS',
      nextStage: 'registration-complete',
      source: 'session+ui',
      value: [sessionInspection.value, uiConfirmation.value].filter(Boolean).join(' | '),
      strength: sessionInspection?.strength === 'strong' || uiConfirmation?.strength === 'strong' ? 'medium' : 'weak',
      settleStage: 'session-check',
      stateChanged: true,
      retryCount: 0,
    };
  }

  // 再查 failure selector。
  const failureSelector = await findFirstVisibleBySelectors(page, profile?.failureSignals?.selectors || []);
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
    };
  }

  // 最后查 failure text。
  const failureText = await findFirstVisibleByTexts(page, profile?.failureSignals?.texts || []);
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
    };
  }

  // 如果都没命中，则按 unknown 返回。
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
  };
}

/**
 * 将第五阶段原始失败状态收敛成 Dreamina 专属 reason。
 *
 * 当前草案实现先覆盖最常见几类状态，后续再根据真实日志细化。
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
