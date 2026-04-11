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
 * 等待并确认 Dreamina 是否已经进入第六阶段上下文。
 *
 * 当前草案实现先只做最小能力：
 * - selector ready
 * - text ready
 * - url includes ready
 */
async function waitForAccountDeliveryReady(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
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

    // 第一层：selector ready。
    const selectorHit = await findFirstVisibleBySelectors(page, profile?.deliveryReady?.selectors || []);
    if (selectorHit.ok) {
      if (typeof logInfo === 'function') logInfo(`dreamina.accountDelivery.ready | source=selector | value=${selectorHit.selector} | strength=strong | waitStepMs=${waitStepMs}`);
      return { ok: true, state: 'ACCOUNT_DELIVERY_READY', source: 'selector', value: selectorHit.selector, strength: 'strong', waitStepMs };
    }

    // 第二层：text ready。
    const textHit = await findFirstVisibleByTexts(page, profile?.deliveryReady?.texts || []);
    if (textHit.ok) {
      if (typeof logInfo === 'function') logInfo(`dreamina.accountDelivery.ready | source=text | value=${textHit.text} | strength=weak | waitStepMs=${waitStepMs}`);
      return { ok: true, state: 'ACCOUNT_DELIVERY_READY', source: 'text', value: textHit.text, strength: 'weak', waitStepMs };
    }

    // 第三层：url ready。
    const currentUrl = String(page.url ? page.url() : '').trim();
    const urlHit = (profile?.deliveryReady?.urlIncludes || []).find(fragment => currentUrl.includes(String(fragment || '')));
    if (urlHit) {
      if (typeof logInfo === 'function') logInfo(`dreamina.accountDelivery.ready | source=url | value=${urlHit} | strength=weak | waitStepMs=${waitStepMs}`);
      return { ok: true, state: 'ACCOUNT_DELIVERY_READY', source: 'url', value: urlHit, strength: 'weak', waitStepMs };
    }
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
 * 收集当前账号最终交付摘要。
 *
 * 当前草案实现：
 * - 先收口 account 基础字段
 * - 再收口 URL 与页面 UI 辅助摘要
 * - 暂不直接写外部系统
 */
async function collectAccountDeliverySummary(page, account, runtime = {}, context = {}) {
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

  // 组装最小 session 摘要草案；后续可与阶段 5 结果联动。
  const sessionSnapshot = {
    expectedKeys: profile?.summarySignals?.sessionKeys || [],
  };

  // 组装最小 UI 摘要草案。
  const uiSnapshot = {
    expectedSignals: profile?.summarySignals?.uiSignals || [],
    currentUrl,
  };

  // 判断最小摘要是否至少具备 account 基础字段。
  const hasRequiredAccountField = Object.values(accountSnapshot).some(value => String(value || '').trim());

  return {
    ok: hasRequiredAccountField,
    state: hasRequiredAccountField ? 'ACCOUNT_SUMMARY_COLLECTED' : 'ACCOUNT_SUMMARY_INCOMPLETE',
    source: hasRequiredAccountField ? 'account' : '',
    value: hasRequiredAccountField ? Object.keys(accountSnapshot).find(key => String(accountSnapshot[key] || '').trim()) || '' : '',
    strength: hasRequiredAccountField ? 'medium' : '',
    accountSnapshot,
    sessionSnapshot,
    uiSnapshot,
  };
}

/**
 * 组装当前账号的最终交付对象草案。
 *
 * 当前草案实现：
 * - 以 accountSummary 为基础组装 payload
 * - 只保证结构和字段边界，不做外部写入
 */
async function buildAccountDeliveryPayload(page, account, runtime = {}, context = {}) {
  // 读取第六阶段 profile。
  const profile = loadDreaminaAccountDeliveryProfile();
  // 解构 accountSummary。
  const { accountSummary = null } = context;
  // 读取 required / optional 规则。
  const requiredFields = profile?.payloadRules?.requiredFields || [];
  const optionalFields = profile?.payloadRules?.optionalFields || [];

  // 组装 payload 初始对象。
  const payload = {};
  for (const field of requiredFields) payload[field] = account?.[field] ?? '';
  for (const field of optionalFields) payload[field] = account?.[field] ?? '';

  // 挂上可安全暴露的辅助摘要。
  payload.currentUrl = String(page.url ? page.url() : '').trim();
  payload.accountSummary = accountSummary?.accountSnapshot || null;

  // 判断 requiredFields 是否都具备值。
  const requiredReady = requiredFields.every(field => String(payload?.[field] ?? '').trim());

  return {
    ok: requiredReady,
    state: requiredReady ? 'DELIVERY_PAYLOAD_READY' : 'DELIVERY_PAYLOAD_INCOMPLETE',
    source: 'payload',
    value: requiredReady ? 'required-fields-ready' : 'required-fields-missing',
    strength: requiredReady ? 'strong' : 'weak',
    payload,
  };
}

/**
 * 收口第六阶段最终结果。
 *
 * 当前草案实现策略：
 * - 如果 successSignals 命中，直接认定 delivery-complete
 * - 否则如果 summary 与 payload 都成立，也可作为联合成功草案
 * - 否则如果 failureSignals 命中，返回失败
 * - 最后返回 unknown
 */
async function confirmAccountDeliveryResult(page, account, runtime = {}, context = {}) {
  // 读取第六阶段 profile。
  const profile = loadDreaminaAccountDeliveryProfile();
  // 解构前序结果。
  const { accountSummary = null, deliveryPayload = null } = context;

  // 优先查 success selector。
  const successSelector = await findFirstVisibleBySelectors(page, profile?.successSignals?.selectors || []);
  if (successSelector.ok) {
    return {
      ok: true,
      state: 'DELIVERY_COMPLETE',
      nextStage: 'delivery-complete',
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
      state: 'DELIVERY_COMPLETE',
      nextStage: 'delivery-complete',
      source: 'text',
      value: successText.text,
      strength: 'weak',
      settleStage: 'secondary-success',
      stateChanged: true,
      retryCount: 0,
    };
  }

  // 如果 summary 与 payload 都成立，可以作为联合成功草案。
  if (accountSummary?.ok && deliveryPayload?.ok) {
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

  // 再查 failure selector。
  const failureSelector = await findFirstVisibleBySelectors(page, profile?.failureSignals?.selectors || []);
  if (failureSelector.ok) {
    return {
      ok: false,
      state: 'ACCOUNT_DELIVERY_FAILED',
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
      state: 'ACCOUNT_DELIVERY_FAILED',
      nextStage: '',
      source: 'text',
      value: failureText.text,
      strength: 'weak',
      settleStage: 'secondary-failure',
      stateChanged: null,
      retryCount: 0,
    };
  }

  // 都没命中时，返回 unknown。
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
 * 将第六阶段原始失败状态收敛成 Dreamina 专属 reason。
 */
function classifyAccountDeliveryFailure(input = {}) {
  // 提取原始 reason/state，并统一转成大写。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;

  // 先覆盖第六阶段当前最常见的草案映射。
  if (reason === 'ACCOUNT_DELIVERY_NOT_READY') siteReason = 'DREAMINA_ACCOUNT_DELIVERY_NOT_READY';
  else if (reason === 'ACCOUNT_SUMMARY_INCOMPLETE') siteReason = 'DREAMINA_ACCOUNT_SUMMARY_INCOMPLETE';
  else if (reason === 'DELIVERY_PAYLOAD_INCOMPLETE') siteReason = 'DREAMINA_DELIVERY_PAYLOAD_INCOMPLETE';
  else if (reason === 'ACCOUNT_DELIVERY_FAILED') siteReason = 'DREAMINA_ACCOUNT_DELIVERY_FAILED';
  else if (reason === 'ACCOUNT_DELIVERY_RESULT_UNKNOWN') siteReason = 'DREAMINA_ACCOUNT_DELIVERY_RESULT_UNKNOWN';

  // 返回统一分类结果。
  return {
    reason,
    siteReason,
    hardFailure: false,
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
