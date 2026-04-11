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
 * 规范化 birthday 年份范围。
 *
 * 作用：
 * - 避免 runtime 传入的 min/max year 非法或倒置
 * - 给第四阶段 plan 生成提供稳定边界
 */
function normalizeBirthdayYearRange(runtime = {}) {
  // 读取最小年份；默认给 1980。
  let minYear = Number(runtime?.birthdayMinYear || 1980);
  // 读取最大年份；默认给 2008。
  let maxYear = Number(runtime?.birthdayMaxYear || 2008);
  // 如果 minYear 不是有效数字，就回退默认值。
  if (!Number.isFinite(minYear)) minYear = 1980;
  // 如果 maxYear 不是有效数字，就回退默认值。
  if (!Number.isFinite(maxYear)) maxYear = 2008;
  // 把年份取整，避免传小数。
  minYear = Math.floor(minYear);
  maxYear = Math.floor(maxYear);
  // 如果年份顺序写反了，就交换，保证 min <= max。
  if (minYear > maxYear) {
    const temp = minYear;
    minYear = maxYear;
    maxYear = temp;
  }
  // 返回规范化后的年份范围。
  return { minYear, maxYear };
}

/**
 * 获取 birthday 月份候选集合。
 *
 * 作用：
 * - 统一第四阶段 month plan 的来源
 * - 允许后续通过 runtime 自定义 month 值集合
 */
function getBirthdayMonthCandidates(runtime = {}) {
  // 优先从 runtime 读取自定义 month 候选数组。
  const customMonths = Array.isArray(runtime?.birthdayMonthCandidates)
    ? runtime.birthdayMonthCandidates.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  // 如果 runtime 里给了合法 month 候选，就优先使用自定义集合。
  if (customMonths.length > 0) return customMonths;
  // 否则回退到默认英文月份集合。
  return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
}

/**
 * 随机生成 birthday day。
 *
 * 第一版先固定在 1~28 的安全区间，避免月长/闰年复杂性。
 */
function buildSafeBirthdayDay(runtime = {}) {
  // 读取最小 day；默认值为 1。
  let minDay = Number(runtime?.birthdayMinDay || 1);
  // 读取最大 day；默认值为 28。
  let maxDay = Number(runtime?.birthdayMaxDay || 28);
  // 如果 minDay 不是有效数字，就回退到 1。
  if (!Number.isFinite(minDay)) minDay = 1;
  // 如果 maxDay 不是有效数字，就回退到 28。
  if (!Number.isFinite(maxDay)) maxDay = 28;
  // 取整，避免小数。
  minDay = Math.floor(minDay);
  maxDay = Math.floor(maxDay);
  // 对 day 做安全夹取，保证在 1~28 内。
  minDay = Math.max(1, Math.min(28, minDay));
  maxDay = Math.max(1, Math.min(28, maxDay));
  // 如果顺序反了，就交换。
  if (minDay > maxDay) {
    const temp = minDay;
    minDay = maxDay;
    maxDay = temp;
  }
  // 在安全区间内随机取一个 day。
  return String(minDay + Math.floor(Math.random() * Math.max(1, maxDay - minDay + 1)));
}

/**
 * 生成 Dreamina 第四阶段资料填写计划。
 *
 * 当前补强后的目标：
 * - 不只是“随便随机一个 birthday”
 * - 而是先把第四阶段资料计划的边界、来源、字段结构稳定下来
 */
async function buildDreaminaProfileCompletionPlan(page, account, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有则保持 null。
  const { logInfo = null, profileReady = null } = context;
  // 规范化 year 范围。
  const { minYear, maxYear } = normalizeBirthdayYearRange(runtime);
  // 读取 month 候选集合。
  const months = getBirthdayMonthCandidates(runtime);
  // 如果 month 候选集合为空，就直接返回失败，避免生成无效 plan。
  if (!Array.isArray(months) || months.length === 0) {
    return {
      ok: false,
      state: 'PROFILE_COMPLETION_PLAN_FAILED',
      birthdayPlan: null,
      source: 'runtime-random-plan',
    };
  }

  // 按规范化后的 year 范围生成一个随机年份。
  const year = String(minYear + Math.floor(Math.random() * Math.max(1, maxYear - minYear + 1)));
  // 从 month 候选集合里随机选一个 month。
  const month = String(months[Math.floor(Math.random() * months.length)] || '').trim();
  // 在安全 day 区间里生成一个随机 day。
  const day = buildSafeBirthdayDay(runtime);

  // 如果 year / month / day 中任意一个为空，就按 plan 失败返回。
  if (!year || !month || !day) {
    return {
      ok: false,
      state: 'PROFILE_COMPLETION_PLAN_FAILED',
      birthdayPlan: null,
      source: 'runtime-random-plan',
    };
  }

  // 构造第四阶段统一 birthday plan。
  const birthdayPlan = {
    // 本轮要填写的 year。
    year,
    // 本轮要填写的 month。
    month,
    // 本轮要填写的 day。
    day,
  };

  // 如果存在日志函数，记录当前生成的 birthday plan，便于后续排查“填了什么”。
  if (typeof logInfo === 'function') {
    logInfo(`dreamina.profileCompletion.plan | readyState=${profileReady?.state || 'NA'} | year=${birthdayPlan.year} | month=${birthdayPlan.month} | day=${birthdayPlan.day} | yearRange=${minYear}-${maxYear}`);
  }

  // 返回统一计划结构。
  return {
    ok: true,
    state: 'PROFILE_COMPLETION_PLAN_READY',
    birthdayPlan,
    source: 'runtime-random-plan',
  };
}

/**
 * 读取当前 birthday year 输入值。
 *
 * 作用：
 * - 在填写前后读取 year 输入框当前值
 * - 避免只看 fill/type 是否报错，而不看页面真实值
 */
async function readDreaminaBirthdayYearValue(page, profile) {
  // 遍历 profile 中定义的 yearSelectors，找到第一个当前可见 year 输入。
  const hit = await findFirstVisibleBySelectors(page, profile?.birthday?.yearSelectors || []);
  // 如果当前没有可见 year 输入，就返回统一未命中结构。
  if (!hit.ok || !hit.locator) {
    return {
      ok: false,
      selector: '',
      value: '',
    };
  }

  // 读取当前 year 输入值；若读取失败，则回退空字符串。
  const currentValue = await hit.locator.inputValue().catch(() => '');
  // 返回统一 year 读取结构。
  return {
    ok: true,
    selector: hit.selector,
    value: String(currentValue || '').trim(),
    locator: hit.locator,
  };
}

/**
 * 填写 birthday year。
 *
 * 第一版真实能力目标：
 * - 找到 year 输入控件
 * - 清空旧值
 * - 写入本轮 birthdayPlan.year
 * - 读回 year 值确认是否真正写入成功
 */
async function fillDreaminaBirthdayYear(page, plan, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第四阶段 profile。
  const profile = loadDreaminaProfileCompletionProfile();
  // 取出本轮 plan 里要填写的 year，并统一 trim。
  const yearValue = String(plan?.birthdayPlan?.year || '').trim();

  // 如果 year 本身为空，就直接失败，不做无意义输入动作。
  if (!yearValue) {
    return {
      ok: false,
      state: 'BIRTHDAY_YEAR_FILL_FAILED',
      source: 'profile-input',
      value: 'EMPTY_YEAR_PLAN',
      stateChanged: null,
    };
  }

  // 先读取填写前的 year 输入状态。
  const beforeState = await readDreaminaBirthdayYearValue(page, profile);
  // 如果当前找不到 year 输入控件，就直接失败。
  if (!beforeState.ok || !beforeState.locator) {
    return {
      ok: false,
      state: 'BIRTHDAY_YEAR_FILL_FAILED',
      source: 'profile-input',
      value: 'YEAR_INPUT_NOT_FOUND',
      stateChanged: null,
    };
  }

  try {
    // 先点击 year 输入控件，尽量确保焦点落在正确输入框上。
    await beforeState.locator.click({ force: true }).catch(() => {});
    // 再显式 focus，降低只 click 不聚焦的概率。
    await beforeState.locator.focus().catch(() => {});
    // 尝试全选旧值。
    await beforeState.locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    // 删除旧值，避免新旧年份拼接。
    await beforeState.locator.press('Backspace').catch(() => {});
    // 优先尝试用 fill 直接写入 year。
    await beforeState.locator.fill(yearValue).catch(async () => {
      // 如果 fill 失败，再回退到 type。
      await beforeState.locator.type(yearValue, { delay: 40 }).catch(() => {});
    });
    // 给页面一小段时间消化输入事件。
    await page.waitForTimeout(120).catch(() => {});

    // 读取填写后的 year 输入状态。
    const afterState = await readDreaminaBirthdayYearValue(page, profile);
    // 取出填写前的值。
    const beforeValue = String(beforeState?.value || '').trim();
    // 取出填写后的值。
    const afterValue = String(afterState?.value || '').trim();
    // 判断 year 是否已经被正确写入。
    const ok = afterValue === yearValue;
    // 判断页面/输入值是否发生了变化。
    const stateChanged = afterValue !== beforeValue;

    // 如果有日志函数，记录本轮 year 填写情况。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.profileCompletion.fillYear | selector=${beforeState.selector || ''} | before=${beforeValue || '[EMPTY]'} | after=${afterValue || '[EMPTY]'} | target=${yearValue}`);
    }

    // 返回统一 year 填写结果。
    return {
      ok,
      state: ok ? 'BIRTHDAY_YEAR_FILLED' : 'BIRTHDAY_YEAR_FILL_FAILED',
      source: 'profile-input',
      value: afterValue,
      stateChanged,
    };
  } catch (error) {
    // 如果整个填写过程抛异常，就按统一失败结构返回。
    return {
      ok: false,
      state: 'BIRTHDAY_YEAR_FILL_FAILED',
      source: 'profile-input',
      value: error?.message || 'UNKNOWN',
      stateChanged: false,
    };
  }
}

/**
 * 读取当前 birthday month 输入值。
 *
 * 作用：
 * - 在填写前后读取 month 输入框当前值
 * - 避免只看 fill/type 是否报错，而不看页面真实值
 */
async function readDreaminaBirthdayMonthValue(page, profile) {
  // 遍历 profile 中定义的 monthSelectors，找到第一个当前可见 month 输入。
  const hit = await findFirstVisibleBySelectors(page, profile?.birthday?.monthSelectors || []);
  // 如果当前没有可见 month 输入，就返回统一未命中结构。
  if (!hit.ok || !hit.locator) {
    return {
      ok: false,
      selector: '',
      value: '',
    };
  }

  // 读取当前 month 输入值；若读取失败，则回退空字符串。
  const currentValue = await hit.locator.inputValue().catch(() => '');
  // 返回统一 month 读取结构。
  return {
    ok: true,
    selector: hit.selector,
    value: String(currentValue || '').trim(),
    locator: hit.locator,
  };
}

/**
 * 填写 birthday month。
 *
 * 第一版真实能力目标：
 * - 找到 month 输入控件
 * - 清空旧值
 * - 写入本轮 birthdayPlan.month
 * - 读回 month 值确认是否真正写入成功
 */
async function fillDreaminaBirthdayMonth(page, plan, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第四阶段 profile。
  const profile = loadDreaminaProfileCompletionProfile();
  // 取出本轮 plan 里要填写的 month，并统一 trim。
  const monthValue = String(plan?.birthdayPlan?.month || '').trim();

  // 如果 month 本身为空，就直接失败，不做无意义输入动作。
  if (!monthValue) {
    return {
      ok: false,
      state: 'BIRTHDAY_MONTH_FILL_FAILED',
      source: 'profile-input',
      value: 'EMPTY_MONTH_PLAN',
      stateChanged: null,
    };
  }

  // 先读取填写前的 month 输入状态。
  const beforeState = await readDreaminaBirthdayMonthValue(page, profile);
  // 如果当前找不到 month 输入控件，就直接失败。
  if (!beforeState.ok || !beforeState.locator) {
    return {
      ok: false,
      state: 'BIRTHDAY_MONTH_FILL_FAILED',
      source: 'profile-input',
      value: 'MONTH_INPUT_NOT_FOUND',
      stateChanged: null,
    };
  }

  try {
    // 先点击 month 输入控件，尽量确保焦点落在正确输入框上。
    await beforeState.locator.click({ force: true }).catch(() => {});
    // 再显式 focus，降低只 click 不聚焦的概率。
    await beforeState.locator.focus().catch(() => {});
    // 尝试全选旧值。
    await beforeState.locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    // 删除旧值，避免新旧月份拼接。
    await beforeState.locator.press('Backspace').catch(() => {});
    // 优先尝试用 fill 直接写入 month。
    await beforeState.locator.fill(monthValue).catch(async () => {
      // 如果 fill 失败，再回退到 type。
      await beforeState.locator.type(monthValue, { delay: 40 }).catch(() => {});
    });
    // 给页面一小段时间消化输入事件。
    await page.waitForTimeout(120).catch(() => {});

    // 读取填写后的 month 输入状态。
    const afterState = await readDreaminaBirthdayMonthValue(page, profile);
    // 取出填写前的值。
    const beforeValue = String(beforeState?.value || '').trim();
    // 取出填写后的值。
    const afterValue = String(afterState?.value || '').trim();
    // 判断 month 是否已经被正确写入。
    const ok = afterValue === monthValue;
    // 判断页面/输入值是否发生了变化。
    const stateChanged = afterValue !== beforeValue;

    // 如果有日志函数，记录本轮 month 填写情况。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.profileCompletion.fillMonth | selector=${beforeState.selector || ''} | before=${beforeValue || '[EMPTY]'} | after=${afterValue || '[EMPTY]'} | target=${monthValue}`);
    }

    // 返回统一 month 填写结果。
    return {
      ok,
      state: ok ? 'BIRTHDAY_MONTH_FILLED' : 'BIRTHDAY_MONTH_FILL_FAILED',
      source: 'profile-input',
      value: afterValue,
      stateChanged,
    };
  } catch (error) {
    // 如果整个填写过程抛异常，就按统一失败结构返回。
    return {
      ok: false,
      state: 'BIRTHDAY_MONTH_FILL_FAILED',
      source: 'profile-input',
      value: error?.message || 'UNKNOWN',
      stateChanged: false,
    };
  }
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
