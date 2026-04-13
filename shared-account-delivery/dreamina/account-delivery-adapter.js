'use strict';

// 引入文件系统模块，用来读取 Dreamina 第六阶段 profile JSON 配置文件。
const fs = require('fs');
// 引入 path 模块，用来安全拼接当前目录下的 profile 文件路径。
const path = require('path');

// 当前 Dreamina 第六阶段 profile 的固定文件路径。
const DREAMINA_ACCOUNT_DELIVERY_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-account-delivery-profile.json');

// profile 缓存对象，避免每次调用 adapter 方法都重复读取磁盘文件。
let dreaminaAccountDeliveryProfileCache = null;

/**
 * 读取 Dreamina 第六阶段 profile。
 *
 * 作用：
 * - 从 JSON 文件加载静态规则
 * - 默认走内存缓存
 * - 在需要时允许 forceReload 强制重新读取
 */
function loadDreaminaAccountDeliveryProfile(options = {}) {
  // 读取是否要求强制刷新 profile 的开关。
  const forceReload = Boolean(options?.forceReload);
  // 如果没有要求强制刷新，并且缓存里已经有 profile，就直接返回缓存。
  if (!forceReload && dreaminaAccountDeliveryProfileCache) return dreaminaAccountDeliveryProfileCache;
  // 从磁盘读取 profile 文件原始文本。
  const raw = fs.readFileSync(DREAMINA_ACCOUNT_DELIVERY_PROFILE_PATH, 'utf8');
  // 解析 JSON，同时去掉可能存在的 BOM 头。
  dreaminaAccountDeliveryProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  // 返回最新读取到的 profile 对象。
  return dreaminaAccountDeliveryProfileCache;
}

/**
 * 判断 locator 当前是否可见。
 *
 * 作用：
 * - 统一第六阶段所有可见性判断逻辑
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
 * 检测 Dreamina 第六阶段的 selector ready 信号。
 *
 * 作用：
 * - 优先依赖结构信号，而不是只看文本或 URL
 * - selector 命中时，一般更接近真实进入最终交付页面壳
 */
async function detectDreaminaAccountDeliveryReadyBySelector(page, profile) {
  // 从 profile 中读取第六阶段入口 selector 列表。
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.deliveryReady?.selectors || []);
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
 * 检测 Dreamina 第六阶段的 account summary 辅助 ready 信号。
 *
 * 作用：
 * - 第六阶段入口不一定总有稳定 selector
 * - 如果当前账号基础字段已经齐全，也可以作为“已经进入交付整理区间”的辅助信号
 */
async function detectDreaminaAccountDeliveryReadyByAccountContext(account, profile) {
  // 从 profile 里读取建议观察的 accountFields。
  const accountFields = profile?.summarySignals?.accountFields || [];
  // 从 accountFields 中挑出当前有值的字段。
  const presentFields = accountFields.filter(field => String(account?.[field] ?? '').trim());
  // 如果一个都没有，就返回统一未命中结构。
  if (presentFields.length === 0) {
    return {
      ok: false,
      source: '',
      value: '',
      strength: '',
    };
  }

  // 如果至少有一个关键 account field 已存在，就按中强辅助信号返回。
  return {
    ok: true,
    source: 'account',
    value: presentFields.join(' | '),
    strength: presentFields.length >= Math.min(2, accountFields.length || 1) ? 'medium' : 'weak',
  };
}

/**
 * 检测 Dreamina 第六阶段的文本 ready 信号。
 *
 * 作用：
 * - 作为 selector 之后的补充判断
 * - 当最终交付页面缺少稳定 selector 时，文本信号可以作为辅助入口判断
 */
async function detectDreaminaAccountDeliveryReadyByText(page, profile) {
  // 从 profile 中读取第六阶段入口文本列表。
  const textHit = await findFirstVisibleByTexts(page, profile?.deliveryReady?.texts || []);
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
 * 检测 Dreamina 第六阶段的 URL ready 信号。
 *
 * 作用：
 * - 当页面已经明显停留在最终工作台/已登录路径时，URL 片段是很实用的辅助入口信号
 * - 但 URL 仍然只是辅助，不代表最终 delivery-complete
 */
async function detectDreaminaAccountDeliveryReadyByUrl(page, profile) {
  // 读取当前页面 URL。
  const currentUrl = String(page.url ? page.url() : '').trim();
  // 从 profile 的 urlIncludes 里找第一个命中项。
  const urlHit = (profile?.deliveryReady?.urlIncludes || []).find(fragment => currentUrl.includes(String(fragment || '')));
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
 * 在单个等待步内执行一次第六阶段入口 ready 探测。
 *
 * 当前顺序：
 * 1. selector ready
 * 2. account context ready
 * 3. text ready
 * 4. URL ready
 */
async function detectDreaminaAccountDeliveryReadyOnce(page, account, profile) {
  // 第一层：优先查 selector ready。
  const selectorReady = await detectDreaminaAccountDeliveryReadyBySelector(page, profile);
  if (selectorReady.ok) return selectorReady;

  // 第二层：再查 account context 辅助 ready。
  const accountReady = await detectDreaminaAccountDeliveryReadyByAccountContext(account, profile);
  if (accountReady.ok) return accountReady;

  // 第三层：再查文本 ready。
  const textReady = await detectDreaminaAccountDeliveryReadyByText(page, profile);
  if (textReady.ok) return textReady;

  // 第四层：最后查 URL ready。
  const urlReady = await detectDreaminaAccountDeliveryReadyByUrl(page, profile);
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
 * 等待并确认 Dreamina 是否已经进入第六阶段上下文。
 *
 * 第一轮补强后：
 * - 不再只看 selector / text / url 三层
 * - 补进 account context 作为第六阶段入口辅助信号
 * - 仍然只负责“第六阶段可以开始”，不在这里宣布 delivery-complete
 */
async function waitForAccountDeliveryReady(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null, account = {} } = context;
  // 读取 Dreamina 第六阶段 profile。
  const profile = loadDreaminaAccountDeliveryProfile();
  // 构造等待步列表。
  const steps = [...new Set([0, Number(runtime?.accountDeliveryPrimaryWaitMs || 600), Number(runtime?.accountDeliverySecondaryWaitMs || 1500)].filter(ms => Number(ms) >= 0))];

  // 记录最后一次执行到的等待步。
  let lastWaitStepMs = 0;
  // 依次执行每个等待步。
  for (const waitStepMs of steps) {
    // 更新等待步。
    lastWaitStepMs = waitStepMs;
    // 大于 0 时执行等待。
    if (waitStepMs > 0) await page.waitForTimeout(waitStepMs).catch(() => {});

    // 在当前等待步内执行一次完整 ready 探测。
    const readyResult = await detectDreaminaAccountDeliveryReadyOnce(page, account, profile);
    // 如果当前等待步已确认进入第六阶段，就直接返回成功结构。
    if (readyResult.ok) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.accountDelivery.ready | source=${readyResult.source} | value=${readyResult.value} | strength=${readyResult.strength} | waitStepMs=${waitStepMs}`);
      }
      return {
        ok: true,
        state: 'ACCOUNT_DELIVERY_READY',
        source: readyResult.source,
        value: readyResult.value,
        strength: readyResult.strength,
        waitStepMs,
      };
    }

    // 当前等待步未命中时，记一条 miss，便于后续区分是慢一拍还是根本没进第六阶段。
    if (typeof logInfo === 'function') logInfo(`dreamina.accountDelivery.ready | miss | waitStepMs=${waitStepMs}`);
  }

  // 所有等待步都未命中时，返回 not-ready。
  return {
    ok: false,
    state: 'ACCOUNT_DELIVERY_NOT_READY',
    source: '',
    value: '',
    strength: '',
    waitStepMs: lastWaitStepMs,
  };
}

/**
 * 读取当前页面轻量文本摘要。
 *
 * 作用：
 * - 第六阶段只需要最小 UI/页面上下文线索
 * - 不需要把整个页面文本全量塞进交付结构
 */
async function readDreaminaPageTextPreview(page, runtime = {}) {
  // 读取预览长度预算；默认只保留前 200 个字符，避免结构膨胀。
  const maxChars = Number(runtime?.accountDeliveryTextPreviewChars || 200);
  // 在页面上下文中读取 body 文本。
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');
  // 返回裁剪后的轻量预览文本。
  return String(bodyText || '').slice(0, Math.max(0, maxChars));
}

/**
 * 收集当前账号最终交付摘要。
 *
 * 第一轮补强目标：
 * - 不再只是 account 字段占位
 * - 开始把 account / session / url / ui 四类摘要真正收进来
 * - 仍然只做“交付摘要整理”，不做外部写入
 */
async function collectAccountDeliverySummary(page, account, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null, sessionInspection = null, uiConfirmation = null, postAuthResultConfirmation = null } = context;
  // 读取第六阶段 profile。
  const profile = loadDreaminaAccountDeliveryProfile();
  // 读取当前 URL。
  const currentUrl = String(page.url ? page.url() : '').trim();
  // 读取 accountFields 规则。
  const accountFields = profile?.summarySignals?.accountFields || [];
  // 提取账号基础快照。
  const accountSnapshot = {};
  for (const field of accountFields) {
    accountSnapshot[field] = account?.[field] ?? '';
  }

  // 统计当前已有值的 account fields。
  const presentAccountFields = accountFields.filter(field => String(accountSnapshot?.[field] ?? '').trim());

  // 收口 session 摘要；优先复用第五阶段已经拿到的 sessionInspection 结果。
  const sessionSnapshot = {
    expectedKeys: profile?.summarySignals?.sessionKeys || [],
    matchedCookieKeys: sessionInspection?.cookieSummary?.presentKeys || [],
    matchedLocalStorageKeys: sessionInspection?.localStorageSummary?.presentKeys || [],
    matchedSessionStorageKeys: sessionInspection?.sessionStorageSummary?.presentKeys || [],
    source: String(sessionInspection?.source || ''),
    value: String(sessionInspection?.value || ''),
    state: String(sessionInspection?.state || ''),
    strength: String(sessionInspection?.strength || ''),
    cookieSummary: sessionInspection?.cookieSummary || null,
    localStorageSummary: sessionInspection?.localStorageSummary || null,
    sessionStorageSummary: sessionInspection?.sessionStorageSummary || null,
  };

  // 读取页面轻量文本预览，作为 UI 摘要的一部分。
  const textPreview = await readDreaminaPageTextPreview(page, runtime);
  // 组装 UI 摘要。
  const uiSnapshot = {
    expectedSignals: profile?.summarySignals?.uiSignals || [],
    matchedSelectors: uiConfirmation?.matchedSelectors || postAuthResultConfirmation?.matchedSelectors || [],
    matchedTexts: uiConfirmation?.matchedTexts || postAuthResultConfirmation?.matchedTexts || [],
    source: String(uiConfirmation?.source || postAuthResultConfirmation?.source || ''),
    value: String(uiConfirmation?.value || postAuthResultConfirmation?.value || ''),
    state: String(uiConfirmation?.state || postAuthResultConfirmation?.state || ''),
    strength: String(uiConfirmation?.strength || postAuthResultConfirmation?.strength || ''),
    currentUrl,
    textPreview,
  };

  // 判断是否至少具备 account 基础字段。
  const hasRequiredAccountField = presentAccountFields.length > 0;
  // 判断是否至少具备 session 或 UI 辅助线索。
  const hasSupportSignal = Boolean(sessionSnapshot.value || uiSnapshot.value || currentUrl);

  // 组合本轮 summary 是否可以认为“已收集到可用摘要”。
  const ok = hasRequiredAccountField || hasSupportSignal;
  // 为当前摘要选择主要来源。
  const source = hasRequiredAccountField
    ? 'account'
    : sessionSnapshot.value
      ? 'session'
      : uiSnapshot.value
        ? 'ui'
        : currentUrl
          ? 'url'
          : '';
  // 为当前摘要选择主要值。
  const value = hasRequiredAccountField
    ? (presentAccountFields[0] || '')
    : sessionSnapshot.value || uiSnapshot.value || currentUrl || '';
  // 为当前摘要给出信号强度。
  const strength = hasRequiredAccountField && hasSupportSignal
    ? 'medium'
    : ok
      ? 'weak'
      : '';

  // 如果有日志函数，记录本轮摘要的主要收敛来源。
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.accountDelivery.summary | source=${source} | value=${value} | strength=${strength} | accountFields=${presentAccountFields.join('|') || '[NONE]'}`);
  }

  return {
    // 当前摘要是否已经整理到“可用交付摘要”级别。
    ok,
    // 当前摘要整理阶段的原始状态码。
    state: ok ? 'ACCOUNT_SUMMARY_COLLECTED' : 'ACCOUNT_SUMMARY_INCOMPLETE',
    // 当前摘要最主要的收敛来源。
    source,
    // 当前摘要最主要的代表值或辅助值。
    value,
    // 当前摘要信号强度。
    strength,
    // 账号基础字段摘要对象。
    accountSnapshot,
    // session / storage 侧摘要对象。
    sessionSnapshot,
    // UI / URL / 文本预览侧摘要对象。
    uiSnapshot,
  };
}

/**
 * 规范化交付字段值。
 *
 * 作用：
 * - 统一把 undefined / null / 非字符串值整理成稳定可交付形式
 * - 避免 payload 里混入不可控类型
 */
function normalizeDeliveryFieldValue(value) {
  // null / undefined 统一回退为空字符串。
  if (value === null || value === undefined) return '';
  // 字符串直接 trim 后返回。
  if (typeof value === 'string') return value.trim();
  // 布尔值转成字符串，避免丢失显式 true/false。
  if (typeof value === 'boolean') return String(value);
  // 数字直接转字符串，避免后续 JSON/日志出现类型分歧。
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  // 对象/数组先保守转 JSON；失败则回退空字符串。
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '';
  }
}

/**
 * Build the current account-delivery payload draft.
 *
 * Current Dreamina semantics:
 * - this is still a minimal-delivery payload layer
 * - it focuses on packaging a deliverable object draft
 * - it does not imply a fully mature external delivery contract
 */
async function buildAccountDeliveryPayload(page, account, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null, accountSummary = null, postAuthResultConfirmation = null } = context;
  // 读取第六阶段 profile。
  const profile = loadDreaminaAccountDeliveryProfile();
  // 读取 required / optional 规则。
  const requiredFields = profile?.payloadRules?.requiredFields || [];
  const optionalFields = profile?.payloadRules?.optionalFields || [];

  // 先准备 payload 初始对象。
  const payload = {};

  // 第一层：把 required 字段先按规范化方式写入 payload。
  for (const field of requiredFields) {
    payload[field] = normalizeDeliveryFieldValue(account?.[field]);
  }

  // 第二层：把 optional 字段也按规范化方式写入 payload。
  for (const field of optionalFields) {
    payload[field] = normalizeDeliveryFieldValue(account?.[field]);
  }

  // 第三层：补充第六阶段允许携带的轻量辅助摘要。
  payload.currentUrl = String(page.url ? page.url() : '').trim();
  payload.accountSummary = {
    ...(accountSummary?.accountSnapshot || {}),
    registrationState: String(postAuthResultConfirmation?.state || ''),
    finalStage: 'account-delivery',
  };
  payload.sessionSummary = accountSummary?.sessionSnapshot || null;
  payload.uiSummary = accountSummary?.uiSnapshot
    ? {
        ...accountSummary.uiSnapshot,
        textPreview: String(accountSummary?.uiSnapshot?.textPreview || '').slice(0, 500),
      }
    : null;

  // 计算当前哪些 requiredFields 已经具备值。
  const presentRequiredFields = requiredFields.filter(field => String(payload?.[field] ?? '').trim());
  // 判断 requiredFields 是否全部具备值。
  const requiredReady = requiredFields.every(field => String(payload?.[field] ?? '').trim());

  // 如果有日志函数，记录当前 payload 组装情况。
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.accountDelivery.payload | value=${requiredReady ? 'required-fields-ready' : 'required-fields-missing'} | presentRequired=${presentRequiredFields.join('|') || '[NONE]'} | requiredTotal=${requiredFields.length}`);
  }

  return {
    // 当前是否已经成功组装出满足最低要求的交付对象。
    ok: requiredReady,
    // 当前 payload 组装阶段的原始状态码。
    state: requiredReady ? 'DELIVERY_PAYLOAD_READY' : 'DELIVERY_PAYLOAD_INCOMPLETE',
    // 当前结果主要来自 payload 结构本身。
    source: 'payload',
    // 当前 payload 侧的辅助摘要值。
    value: requiredReady ? 'required-fields-ready' : 'required-fields-missing',
    // 当前 payload 信号强度。
    strength: requiredReady ? 'strong' : (presentRequiredFields.length > 0 ? 'weak' : ''),
    // 当前账号可交付对象草案本体。
    payload,
  };
}

/**
 * 检测第六阶段的明确成功信号。
 *
 * 作用：
 * - 优先用站点成功 signals 收敛 delivery-complete
 * - 这层属于第六阶段自己的最终成功确认，不涉及外部系统写入
 */
async function detectDreaminaAccountDeliverySuccessSignals(page, profile, context = {}) {
  const { accountSummary = null, deliveryPayload = null, postAuthResultConfirmation = null } = context;
  // 优先查 success selector。
  const successSelector = await findFirstVisibleBySelectors(page, profile?.successSignals?.selectors || []);
  // 如果 selector 命中，按强成功返回。
  if (successSelector.ok) {
    return {
      hit: true,
      state: 'DELIVERY_COMPLETE',
      source: 'selector',
      value: successSelector.selector,
      strength: 'strong',
      winningSuccessSignal: {
        type: 'selector',
        value: successSelector.selector,
      },
      matchedSelectors: [successSelector.selector],
      matchedTexts: [],
    };
  }

  // 再查 success text。
  const successText = await findFirstVisibleByTexts(page, profile?.successSignals?.texts || []);
  // 文本命中时，先对高风险泛词做收紧，避免仅靠 Avatar 这类词单独宣布交付完成。
  if (successText.ok) {
    const normalizedText = String(successText.text || '').trim().toLowerCase();
    const riskyText = normalizedText === 'avatar';
    const sessionSignalPresent = Boolean(accountSummary?.sessionSnapshot?.value || deliveryPayload?.payload?.sessionSummary?.value);
    const nonBridgeUiSignal = Boolean(
      accountSummary?.uiSnapshot?.matchedSelectors?.some(selector => !String(selector || '').includes('birthday-next'))
      || accountSummary?.uiSnapshot?.matchedTexts?.some(text => {
        const normalized = String(text || '').trim().toLowerCase();
        return normalized && !['year', 'month', 'day', 'next'].includes(normalized);
      })
    );
    const strongPostAuth = String(postAuthResultConfirmation?.state || '').trim() === 'REGISTRATION_COMPLETE'
      && String(postAuthResultConfirmation?.source || '').trim() !== 'text';
    const supportSignalPresent = sessionSignalPresent || nonBridgeUiSignal || strongPostAuth;

    if (supportSignalPresent) {
      return {
        hit: true,
        state: 'DELIVERY_COMPLETE',
        source: 'text',
        value: successText.text,
        strength: riskyText ? 'weak' : 'medium',
        winningSuccessSignal: {
          type: 'text',
          value: successText.text,
        },
        matchedSelectors: [],
        matchedTexts: [successText.text],
      };
    }
  }

  // 都未命中时，返回统一未命中结构。
  return {
    hit: false,
    state: '',
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 检测第六阶段的明确失败信号。
 *
 * 作用：
 * - 优先减少 ACCOUNT_DELIVERY_RESULT_UNKNOWN 的比例
 * - 把 delivery 页上的明确失败态先收口
 */
async function detectDreaminaAccountDeliveryFailureSignals(page, profile) {
  // 优先查 failure selector。
  const failureSelector = await findFirstVisibleBySelectors(page, profile?.failureSignals?.selectors || []);
  // selector 命中时，按强失败返回。
  if (failureSelector.ok) {
    return {
      hit: true,
      state: 'ACCOUNT_DELIVERY_FAILED',
      source: 'selector',
      value: failureSelector.selector,
      strength: 'strong',
    };
  }

  // 再查 failure text。
  const failureText = await findFirstVisibleByTexts(page, profile?.failureSignals?.texts || []);
  // 文本命中时，按弱失败返回。
  if (failureText.ok) {
    return {
      hit: true,
      state: 'ACCOUNT_DELIVERY_FAILED',
      source: 'text',
      value: failureText.text,
      strength: 'weak',
    };
  }

  // 都未命中时，返回统一未命中结构。
  return {
    hit: false,
    state: '',
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * Confirm the final account-delivery result.
 *
 * Current Dreamina strategy:
 * 1. check explicit delivery success signals first
 * 2. allow summary + payload readiness to act as a minimal-delivery bridge success
 * 3. check explicit delivery failure signals
 * 4. run one grace wait and retry success/failure checks
 * 5. otherwise return unknown
 */
async function confirmAccountDeliveryResult(page, account, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null, accountSummary = null, deliveryPayload = null } = context;
  // 读取第六阶段 profile。
  const profile = loadDreaminaAccountDeliveryProfile();
  // 读取保护等待；默认给一小段时间让第六阶段页面和对象收敛。
  const confirmGraceWaitMs = Number(runtime?.accountDeliveryConfirmGraceWaitMs || 600);

  // 第一轮：先看明确成功信号。
  const successSignal = await detectDreaminaAccountDeliverySuccessSignals(page, profile, {
    accountSummary,
    deliveryPayload,
    postAuthResultConfirmation: context?.postAuthResultConfirmation || null,
  });
  if (successSignal.hit) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.accountDelivery.result | state=DELIVERY_COMPLETE | source=${successSignal.source} | value=${successSignal.value} | settleStage=primary-success`);
    }
    return {
      ok: true,
      state: successSignal.state,
      nextStage: 'delivery-complete',
      source: successSignal.source,
      value: successSignal.value,
      strength: successSignal.strength,
      settleStage: 'primary-success',
      stateChanged: true,
      retryCount: 0,
      winningSuccessSignal: successSignal.winningSuccessSignal || null,
      matchedSelectors: successSignal.matchedSelectors || [],
      matchedTexts: successSignal.matchedTexts || [],
    };
  }

  if (accountSummary?.ok && deliveryPayload?.ok) {
  // Current Dreamina bridge path:
  // if summary and payload are both ready, treat it as a minimal-delivery success draft.
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.accountDelivery.result | state=DELIVERY_PAYLOAD_READY | source=payload | value=${deliveryPayload?.value || ''} | settleStage=payload-check`);
    }
    return {
      ok: true,
      state: 'DELIVERY_PAYLOAD_READY',
      nextStage: 'delivery-complete',
      source: 'payload',
      value: deliveryPayload?.value || '',
      strength: 'medium',
      settleStage: 'payload-check',
      stateChanged: true,
      retryCount: 0,
    };
  }

  // 第一轮：再看明确失败信号。
  const failureSignal = await detectDreaminaAccountDeliveryFailureSignals(page, profile);
  if (failureSignal.hit) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.accountDelivery.result | state=${failureSignal.state} | source=${failureSignal.source} | value=${failureSignal.value} | settleStage=primary-failure`);
    }
    return {
      ok: false,
      state: failureSignal.state,
      nextStage: '',
      source: failureSignal.source,
      value: failureSignal.value,
      strength: failureSignal.strength,
      settleStage: 'primary-failure',
      stateChanged: null,
      retryCount: 0,
    };
  }

  // 如果第一轮没收敛，给一小段保护等待，降低慢一拍误判 unknown 的概率。
  if (confirmGraceWaitMs > 0) {
    await page.waitForTimeout(confirmGraceWaitMs).catch(() => {});
  }

  // 第二轮：保护等待后再次检查成功信号。
  const successSignalAfterGrace = await detectDreaminaAccountDeliverySuccessSignals(page, profile, {
    accountSummary,
    deliveryPayload,
    postAuthResultConfirmation: context?.postAuthResultConfirmation || null,
  });
  if (successSignalAfterGrace.hit) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.accountDelivery.result | state=DELIVERY_COMPLETE | source=${successSignalAfterGrace.source} | value=${successSignalAfterGrace.value} | settleStage=secondary-success`);
    }
    return {
      ok: true,
      state: successSignalAfterGrace.state,
      nextStage: 'delivery-complete',
      source: successSignalAfterGrace.source,
      value: successSignalAfterGrace.value,
      strength: successSignalAfterGrace.strength,
      settleStage: 'secondary-success',
      stateChanged: true,
      retryCount: 0,
      winningSuccessSignal: successSignalAfterGrace.winningSuccessSignal || null,
      matchedSelectors: successSignalAfterGrace.matchedSelectors || [],
      matchedTexts: successSignalAfterGrace.matchedTexts || [],
    };
  }

  // 第二轮：保护等待后再次检查失败信号。
  const failureSignalAfterGrace = await detectDreaminaAccountDeliveryFailureSignals(page, profile);
  if (failureSignalAfterGrace.hit) {
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.accountDelivery.result | state=${failureSignalAfterGrace.state} | source=${failureSignalAfterGrace.source} | value=${failureSignalAfterGrace.value} | settleStage=secondary-failure`);
    }
    return {
      ok: false,
      state: failureSignalAfterGrace.state,
      nextStage: '',
      source: failureSignalAfterGrace.source,
      value: failureSignalAfterGrace.value,
      strength: failureSignalAfterGrace.strength,
      settleStage: 'secondary-failure',
      stateChanged: null,
      retryCount: 0,
    };
  }

  // If neither explicit signals nor the minimal-delivery bridge path can settle the stage, return unknown.
  if (typeof logInfo === 'function') {
    logInfo('dreamina.accountDelivery.result | state=ACCOUNT_DELIVERY_RESULT_UNKNOWN | source= | value= | settleStage=none');
  }
  return {
    ok: false,
    state: 'ACCOUNT_DELIVERY_RESULT_UNKNOWN',
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
 * Classify Dreamina account-delivery failure reason.
 *
 * Map raw stage reason/state to a Dreamina-specific siteReason,
 * with extra narrowing from source/value when available.
 */
function classifyAccountDeliveryFailure(input = {}) {
  // 提取原始 reason/state，并统一转成大写。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 提取 source，后续用于细化同一 state 下的分支。
  const source = String(input.source || '').trim().toLowerCase();
  // 提取 value，后续用于细化辅助语义。
  const value = String(input.value || '').trim();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;
  // 默认先不把失败提升为强失败。
  let hardFailure = false;

  // 先收口第六阶段入口失败。
  if (reason === 'ACCOUNT_DELIVERY_NOT_READY') {
    siteReason = source === 'account'
      ? 'DREAMINA_ACCOUNT_DELIVERY_CONTEXT_NOT_READY'
      : 'DREAMINA_ACCOUNT_DELIVERY_NOT_READY';
  }
  // 再收口摘要整理失败。
  else if (reason === 'ACCOUNT_SUMMARY_INCOMPLETE') {
    siteReason = source === 'account'
      ? 'DREAMINA_ACCOUNT_SUMMARY_ACCOUNT_FIELDS_INCOMPLETE'
      : source === 'session'
        ? 'DREAMINA_ACCOUNT_SUMMARY_SESSION_INCOMPLETE'
        : source === 'ui'
          ? 'DREAMINA_ACCOUNT_SUMMARY_UI_INCOMPLETE'
          : 'DREAMINA_ACCOUNT_SUMMARY_INCOMPLETE';
  }
  // 再收口 payload 失败。
  else if (reason === 'DELIVERY_PAYLOAD_INCOMPLETE') {
    siteReason = /required-fields-missing/i.test(value)
      ? 'DREAMINA_DELIVERY_PAYLOAD_REQUIRED_FIELDS_MISSING'
      : 'DREAMINA_DELIVERY_PAYLOAD_INCOMPLETE';
  }
  // 再收口第六阶段明确失败信号。
  else if (reason === 'ACCOUNT_DELIVERY_FAILED') {
    siteReason = source === 'selector'
      ? 'DREAMINA_ACCOUNT_DELIVERY_FAILURE_SELECTOR_DETECTED'
      : source === 'text'
        ? 'DREAMINA_ACCOUNT_DELIVERY_FAILURE_TEXT_DETECTED'
        : 'DREAMINA_ACCOUNT_DELIVERY_FAILED';
    hardFailure = source === 'selector';
  }
  // 最后收口 unknown。
  else if (reason === 'ACCOUNT_DELIVERY_RESULT_UNKNOWN') {
    siteReason = source === 'payload'
      ? 'DREAMINA_ACCOUNT_DELIVERY_PAYLOAD_UNSETTLED'
      : 'DREAMINA_ACCOUNT_DELIVERY_RESULT_UNKNOWN';
  }

  // 返回统一分类结果。
  return {
    // 输入侧原始失败状态。
    reason,
    // Dreamina 站点语义下收敛后的失败原因。
    siteReason,
    // 是否应视为强失败。
    hardFailure,
  };
}

module.exports = {
  loadDreaminaAccountDeliveryProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  waitForAccountDeliveryReady,
  collectAccountDeliverySummary,
  buildAccountDeliveryPayload,
  confirmAccountDeliveryResult,
  classifyAccountDeliveryFailure,
};
