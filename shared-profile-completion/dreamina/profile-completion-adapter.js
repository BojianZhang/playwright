'use strict';

// 引入文件系统模块，用来读取 Dreamina profile-completion profile JSON 配置文件。
const fs = require('fs');
// 引入 path 模块，用来安全拼接当前目录下的 profile 文件路径。
const path = require('path');

// 当前 Dreamina 第四阶段 profile 的固定文件路径。
const DREAMINA_PROFILE_COMPLETION_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-profile-completion-profile.json');

// profile 缓存对象，避免每次调用 adapter 方法都重复读取磁盘文件。
let dreaminaProfileCompletionProfileCache = null;

/**
 * 读取 Dreamina 第四阶段 profile。
 *
 * 作用：
 * - 从 JSON 文件加载静态规则
 * - 默认走内存缓存
 * - 在需要时允许 forceReload 强制重新读取
 */
function loadDreaminaProfileCompletionProfile(options = {}) {
  // 读取是否要求强制刷新 profile 的开关。
  const forceReload = Boolean(options?.forceReload);
  // 如果没有要求强制刷新，并且缓存里已经有 profile，就直接返回缓存。
  if (!forceReload && dreaminaProfileCompletionProfileCache) return dreaminaProfileCompletionProfileCache;
  // 从磁盘读取 profile 文件原始文本。
  const raw = fs.readFileSync(DREAMINA_PROFILE_COMPLETION_PROFILE_PATH, 'utf8');
  // 解析 JSON，同时去掉可能存在的 BOM 头。
  dreaminaProfileCompletionProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  // 返回最新读取到的 profile 对象。
  return dreaminaProfileCompletionProfileCache;
}

/**
 * 判断 locator 当前是否可见。
 *
 * 作用：
 * - 统一第四阶段所有可见性判断逻辑
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
 * 检测 Dreamina 第四阶段的强 selector ready 信号。
 *
 * 作用：
 * - 这一层优先看结构信号，而不是文本
 * - 结构信号通常更像“真的已经进入可填写 birthday 的阶段”
 */
async function detectDreaminaProfileCompletionReadyBySelector(page, profile) {
  // 读取 profile 中定义的 profile-completion ready selector 列表。
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.profileReady?.selectors || []);
  // 如果没有命中任何 selector，就返回统一未命中结构。
  if (!selectorHit.ok) {
    return {
      ok: false,
      source: '',
      value: '',
      strength: '',
    };
  }
  // 如果命中 selector，就按强信号返回。
  return {
    ok: true,
    source: 'selector',
    value: selectorHit.selector,
    strength: 'strong',
  };
}

/**
 * 检测 Dreamina 第四阶段的 birthday inputs 是否真正可达。
 *
 * 作用：
 * - year / month / day 输入是否都可见，是第四阶段比纯文本更强的入口信号
 * - 这一层用来减少“看到文本但其实表单还没完全 ready”的误判
 */
async function detectDreaminaBirthdayInputsReachable(page, profile) {
  // 依次检测 year 输入是否可见。
  const yearHit = await findFirstVisibleBySelectors(page, profile?.birthday?.yearSelectors || []);
  // 依次检测 month 输入是否可见。
  const monthHit = await findFirstVisibleBySelectors(page, profile?.birthday?.monthSelectors || []);
  // 依次检测 day 输入是否可见。
  const dayHit = await findFirstVisibleBySelectors(page, profile?.birthday?.daySelectors || []);
  // 检测 birthday next/submit 按钮是否可见。
  const submitHit = await findFirstVisibleBySelectors(page, profile?.birthday?.submitSelectors || []);

  // 只要 year/month/day 都可见，就说明 birthday 面板基本已经可操作。
  if (yearHit.ok && monthHit.ok && dayHit.ok) {
    return {
      ok: true,
      source: 'profile-input',
      value: [yearHit.selector, monthHit.selector, dayHit.selector, submitHit.ok ? submitHit.selector : ''].filter(Boolean).join(' | '),
      strength: 'strong',
    };
  }

  // 如果核心输入没齐，就返回未命中结构。
  return {
    ok: false,
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 检测 Dreamina 第四阶段的文本 ready 信号。
 *
 * 作用：
 * - 这一层承接 Year / Month / Day 之类的文本线索
 * - 文本信号弱于结构信号，但仍然是有效的补充判断
 */
async function detectDreaminaProfileCompletionReadyByText(page, profile) {
  // 读取 profile 中定义的 profile-completion ready 文本列表。
  const textHit = await findFirstVisibleByTexts(page, profile?.profileReady?.texts || []);
  // 如果没有命中任何文本，就返回统一未命中结构。
  if (!textHit.ok) {
    return {
      ok: false,
      source: '',
      value: '',
      strength: '',
    };
  }
  // 如果命中文本，则按弱一些的信号返回。
  return {
    ok: true,
    source: 'text',
    value: textHit.text,
    strength: 'weak',
  };
}

/**
 * 在单个等待步内执行一次 profile-completion ready 探测。
 *
 * 当前顺序：
 * 1. 先查强 selector ready
 * 2. 再查 birthday inputs 是否可达
 * 3. 最后查文本 ready
 */
async function detectDreaminaProfileCompletionReadyOnce(page, profile, context = {}) {
  // 先做 selector 级 ready 探测。
  const selectorReady = await detectDreaminaProfileCompletionReadyBySelector(page, profile);
  // 如果 selector 已命中，直接返回 selector 结果。
  if (selectorReady.ok) return selectorReady;

  // selector 没命中时，再补一轮 birthday inputs 可达性检查。
  const inputsReady = await detectDreaminaBirthdayInputsReachable(page, profile);
  // 如果 year/month/day 已经可达，就按强信号返回。
  if (inputsReady.ok) return inputsReady;

  // 最后再补一轮文本级 ready 探测。
  const textReady = await detectDreaminaProfileCompletionReadyByText(page, profile);
  // 如果文本命中，就返回文本 ready 结果。
  if (textReady.ok) return textReady;

  // 三层都没有命中时，返回统一未命中结构。
  return {
    ok: false,
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 等待 Dreamina profile-completion 阶段 ready。
 *
 * 当前补强后的步骤：
 * 1. 读取第四阶段 profile
 * 2. 构造 ready 检测等待步
 * 3. 每个等待步内先查强 selector 信号
 * 4. 如果强 selector 没命中，再查 birthday inputs 是否可达
 * 5. 如果上面两层都没命中，再查弱文本信号
 * 6. 一旦任意一步确认 ready，就立即返回
 * 7. 所有等待步都没命中时，再统一返回 not-ready
 */
async function waitForDreaminaProfileCompletionReady(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 第一步：读取 Dreamina 第四阶段 profile，用来拿 ready selector/text/inputs 规则。
  const profile = loadDreaminaProfileCompletionProfile();
  // 第二步：构造 ready 检测等待步列表。
  const steps = [...new Set([0, Number(runtime?.profileCompletionPrimaryWaitMs || 300), Number(runtime?.profileCompletionSecondaryWaitMs || 900)].filter(ms => Number(ms) >= 0))];

  // 记录最后一次执行到的等待步。
  let lastWaitStepMs = 0;
  // 第三步：依次执行每个等待步。
  for (const waitStepMs of steps) {
    // 更新当前等待步记录。
    lastWaitStepMs = waitStepMs;
    // 如果当前等待步大于 0，则等待对应毫秒数。
    if (waitStepMs > 0) await page.waitForTimeout(waitStepMs);

    // 第四步：在当前等待步内执行一次完整 ready 探测。
    const readyResult = await detectDreaminaProfileCompletionReadyOnce(page, profile, context);
    // 如果当前等待步已经确认 ready，就直接返回成功结构。
    if (readyResult.ok) {
      if (typeof logInfo === 'function') logInfo(`dreamina.profileCompletion.ready | source=${readyResult.source} | value=${readyResult.value} | strength=${readyResult.strength} | waitStepMs=${waitStepMs}`);
      return {
        ok: true,
        state: 'PROFILE_COMPLETION_READY',
        source: readyResult.source,
        value: readyResult.value,
        strength: readyResult.strength,
        waitStepMs,
      };
    }

    // 如果当前等待步没命中 ready，也记录一条 miss 日志，便于后续判断是慢一拍还是根本没进到第四阶段。
    if (typeof logInfo === 'function') logInfo(`dreamina.profileCompletion.ready | miss | waitStepMs=${waitStepMs}`);
  }

  // 所有等待步都没有命中 ready，则返回 not-ready。
  return {
    ok: false,
    state: 'PROFILE_COMPLETION_NOT_READY',
    source: '',
    value: '',
    strength: '',
    waitStepMs: lastWaitStepMs,
  };
}

/**
 * 生成 Dreamina 第四阶段资料填写计划。
 *
 * 第一版先复用随机 birthday 生成思路，后续再按站点需求精修。
 */
async function buildDreaminaProfileCompletionPlan(page, account, runtime = {}, context = {}) {
  // 读取 year 起始范围。
  const minYear = Number(runtime?.birthdayMinYear || 1980);
  // 读取 year 结束范围。
  const maxYear = Number(runtime?.birthdayMaxYear || 2008);
  // 计算一个随机 year。
  const year = String(Math.floor(minYear + Math.random() * Math.max(1, maxYear - minYear + 1)));
  // 定义 month 候选。
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // 随机选一个 month。
  const month = months[Math.floor(Math.random() * months.length)];
  // 随机 day，先按 1-28 做安全范围。
  const day = String(1 + Math.floor(Math.random() * 28));

  // 返回统一计划结构。
  return {
    ok: true,
    state: 'PROFILE_COMPLETION_PLAN_READY',
    birthdayPlan: { year, month, day },
    source: 'runtime-random-plan',
  };
}

/**
 * 填写 birthday year。
 *
 * 第一版先返回骨架占位结构，后续再接真实 Dreamina 行为。
 */
async function fillDreaminaBirthdayYear(page, plan, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'BIRTHDAY_YEAR_FILL_NOT_IMPLEMENTED',
    source: 'profile-input',
    value: String(plan?.birthdayPlan?.year || ''),
    stateChanged: null,
  };
}

/**
 * 填写 birthday month。
 */
async function fillDreaminaBirthdayMonth(page, plan, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'BIRTHDAY_MONTH_FILL_NOT_IMPLEMENTED',
    source: 'profile-input',
    value: String(plan?.birthdayPlan?.month || ''),
    stateChanged: null,
  };
}

/**
 * 填写 birthday day。
 */
async function fillDreaminaBirthdayDay(page, plan, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'BIRTHDAY_DAY_FILL_NOT_IMPLEMENTED',
    source: 'profile-input',
    value: String(plan?.birthdayPlan?.day || ''),
    stateChanged: null,
  };
}

/**
 * 提交 Dreamina profile-completion。
 *
 * 第一版先返回骨架占位结构，后续再接 next / submit 的真实行为。
 */
async function submitDreaminaProfileCompletion(page, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'PROFILE_COMPLETION_SUBMIT_NOT_IMPLEMENTED',
    source: 'selector',
    value: '',
    beforeSnapshot: null,
    afterSnapshot: null,
    stateChanged: null,
  };
}

/**
 * 确认 Dreamina 第四阶段提交结果。
 *
 * 第一版先返回骨架占位结构，后续再接 post-auth-ready reachability 判断。
 */
async function confirmDreaminaProfileCompletionSubmitResult(page, runtime = {}, context = {}) {
  return {
    ok: false,
    state: 'PROFILE_COMPLETION_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: 'none',
  };
}

/**
 * 将阶段 4 原始失败状态收敛成 Dreamina 专属 reason。
 */
function classifyDreaminaProfileCompletionFailure(input = {}) {
  // 先从输入中提取原始 reason/state，并统一转成大写形式便于比较。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;

  // 按常见阶段 4 失败做第一版 Dreamina 专属映射。
  if (reason === 'PROFILE_COMPLETION_NOT_READY') siteReason = 'DREAMINA_PROFILE_COMPLETION_NOT_READY';
  else if (reason === 'PROFILE_COMPLETION_PLAN_FAILED') siteReason = 'DREAMINA_PROFILE_COMPLETION_PLAN_FAILED';
  else if (reason === 'BIRTHDAY_YEAR_FILL_FAILED' || reason === 'BIRTHDAY_YEAR_FILL_NOT_IMPLEMENTED') siteReason = 'DREAMINA_BIRTHDAY_YEAR_FILL_FAILED';
  else if (reason === 'BIRTHDAY_MONTH_FILL_FAILED' || reason === 'BIRTHDAY_MONTH_FILL_NOT_IMPLEMENTED') siteReason = 'DREAMINA_BIRTHDAY_MONTH_FILL_FAILED';
  else if (reason === 'BIRTHDAY_DAY_FILL_FAILED' || reason === 'BIRTHDAY_DAY_FILL_NOT_IMPLEMENTED') siteReason = 'DREAMINA_BIRTHDAY_DAY_FILL_FAILED';
  else if (reason === 'PROFILE_COMPLETION_SUBMIT_FAILED' || reason === 'PROFILE_COMPLETION_SUBMIT_NOT_IMPLEMENTED') siteReason = 'DREAMINA_PROFILE_COMPLETION_SUBMIT_FAILED';
  else if (reason === 'PROFILE_COMPLETION_RESULT_UNKNOWN') siteReason = 'DREAMINA_PROFILE_COMPLETION_RESULT_UNKNOWN';

  // 返回统一失败分类结构。
  return {
    reason,
    siteReason,
    hardFailure: false,
  };
}

// 导出 Dreamina 第四阶段 adapter 的所有公开能力。
module.exports = {
  loadDreaminaProfileCompletionProfile,
  isVisible,
  findFirstVisibleBySelectors,
  findFirstVisibleByTexts,
  waitForDreaminaProfileCompletionReady,
  buildDreaminaProfileCompletionPlan,
  fillDreaminaBirthdayYear,
  fillDreaminaBirthdayMonth,
  fillDreaminaBirthdayDay,
  submitDreaminaProfileCompletion,
  confirmDreaminaProfileCompletionSubmitResult,
  classifyDreaminaProfileCompletionFailure,
};
