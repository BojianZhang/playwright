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
  // Dreamina 当前 birthday month 实际是数字下拉项，默认返回 1~12。
  return ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
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
    // 先点击 month 输入控件，尽量触发 Dreamina 数字月份下拉。
    await beforeState.locator.click({ force: true }).catch(() => {});
    await beforeState.locator.focus().catch(() => {});
    await page.waitForTimeout(180).catch(() => {});

    // 优先按下拉项点击数字月份；找不到时才回退文本输入。
    const optionPick = await trySelectDreaminaBirthdayMonthOption(page, profile, monthValue, logInfo);
    if (!optionPick.ok) {
      await beforeState.locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      await beforeState.locator.press('Backspace').catch(() => {});
      await beforeState.locator.fill(monthValue).catch(async () => {
        await beforeState.locator.type(monthValue, { delay: 40 }).catch(() => {});
      });
      await page.waitForTimeout(120).catch(() => {});
    } else {
      await page.waitForTimeout(180).catch(() => {});
    }

    // 读取填写后的 month 输入状态。
    const afterState = await readDreaminaBirthdayMonthValue(page, profile);
    // 取出填写前的值。
    const beforeValue = String(beforeState?.value || '').trim();
    // 取出填写后的值。
    const afterValue = String(afterState?.value || '').trim();
    // 判断 month 是否已经被正确写入。
    const ok = afterValue === monthValue;
    // 判断页面/输入值是否发生了变化。
    const stateChanged = afterValue !== beforeValue || optionPick.ok;

    // 如果有日志函数，记录本轮 month 填写情况。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.profileCompletion.fillMonth | selector=${beforeState.selector || ''} | before=${beforeValue || '[EMPTY]'} | after=${afterValue || '[EMPTY]'} | target=${monthValue} | option=${optionPick.ok ? optionPick.text : '[NONE]'}`);
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
 * 读取当前 birthday day 输入值。
 *
 * 作用：
 * - 在填写前后读取 day 输入框当前值
 * - 避免只看 fill/type 是否报错，而不看页面真实值
 */
async function trySelectDreaminaBirthdayMonthOption(page, profile, monthValue, logInfo = null) {
  const optionSelectors = profile?.birthday?.monthOptionSelectors || [];
  for (const selector of optionSelectors) {
    const options = page.locator(selector);
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const option = options.nth(index);
      const visible = await isVisible(option);
      if (!visible) continue;
      const text = String(await option.innerText().catch(() => '')).trim();
      if (!text) continue;
      if (text.toLowerCase() !== String(monthValue || '').trim().toLowerCase()) continue;
      await option.click({ force: true }).catch(() => {});
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.profileCompletion.fillMonth.option | selector=${selector} | text=${text}`);
      }
      return {
        ok: true,
        selector,
        text,
      };
    }
  }

  return {
    ok: false,
    selector: '',
    text: '',
  };
}

async function readDreaminaBirthdayDayValue(page, profile) {
  // 遍历 profile 中定义的 daySelectors，找到第一个当前可见 day 输入。
  const hit = await findFirstVisibleBySelectors(page, profile?.birthday?.daySelectors || []);
  // 如果当前没有可见 day 输入，就返回统一未命中结构。
  if (!hit.ok || !hit.locator) {
    return {
      ok: false,
      selector: '',
      value: '',
    };
  }

  // 读取当前 day 输入值；若读取失败，则回退空字符串。
  const currentValue = await hit.locator.inputValue().catch(() => '');
  // 返回统一 day 读取结构。
  return {
    ok: true,
    selector: hit.selector,
    value: String(currentValue || '').trim(),
    locator: hit.locator,
  };
}

/**
 * 填写 birthday day。
 *
 * 第一版真实能力目标：
 * - 找到 day 输入控件
 * - 清空旧值
 * - 写入本轮 birthdayPlan.day
 * - 读回 day 值确认是否真正写入成功
 */
async function fillDreaminaBirthdayDay(page, plan, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第四阶段 profile。
  const profile = loadDreaminaProfileCompletionProfile();
  // 取出本轮 plan 里要填写的 day，并统一 trim。
  const dayValue = String(plan?.birthdayPlan?.day || '').trim();

  // 如果 day 本身为空，就直接失败，不做无意义输入动作。
  if (!dayValue) {
    return {
      ok: false,
      state: 'BIRTHDAY_DAY_FILL_FAILED',
      source: 'profile-input',
      value: 'EMPTY_DAY_PLAN',
      stateChanged: null,
    };
  }

  // 先读取填写前的 day 输入状态。
  const beforeState = await readDreaminaBirthdayDayValue(page, profile);
  // 如果当前找不到 day 输入控件，就直接失败。
  if (!beforeState.ok || !beforeState.locator) {
    return {
      ok: false,
      state: 'BIRTHDAY_DAY_FILL_FAILED',
      source: 'profile-input',
      value: 'DAY_INPUT_NOT_FOUND',
      stateChanged: null,
    };
  }

  try {
    // 先点击 day 输入控件，尽量确保焦点落在正确输入框上。
    await beforeState.locator.click({ force: true }).catch(() => {});
    // 再显式 focus，降低只 click 不聚焦的概率。
    await beforeState.locator.focus().catch(() => {});
    // 尝试全选旧值。
    await beforeState.locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    // 删除旧值，避免新旧日期拼接。
    await beforeState.locator.press('Backspace').catch(() => {});
    // 优先尝试用 fill 直接写入 day。
    await beforeState.locator.fill(dayValue).catch(async () => {
      // 如果 fill 失败，再回退到 type。
      await beforeState.locator.type(dayValue, { delay: 40 }).catch(() => {});
    });
    // 给页面一小段时间消化输入事件。
    await page.waitForTimeout(120).catch(() => {});

    // 读取填写后的 day 输入状态。
    const afterState = await readDreaminaBirthdayDayValue(page, profile);
    // 取出填写前的值。
    const beforeValue = String(beforeState?.value || '').trim();
    // 取出填写后的值。
    const afterValue = String(afterState?.value || '').trim();
    // 判断 day 是否已经被正确写入。
    const ok = afterValue === dayValue;
    // 判断页面/输入值是否发生了变化。
    const stateChanged = afterValue !== beforeValue;

    // 如果有日志函数，记录本轮 day 填写情况。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.profileCompletion.fillDay | selector=${beforeState.selector || ''} | before=${beforeValue || '[EMPTY]'} | after=${afterValue || '[EMPTY]'} | target=${dayValue}`);
    }

    // 返回统一 day 填写结果。
    return {
      ok,
      state: ok ? 'BIRTHDAY_DAY_FILLED' : 'BIRTHDAY_DAY_FILL_FAILED',
      source: 'profile-input',
      value: afterValue,
      stateChanged,
    };
  } catch (error) {
    // 如果整个填写过程抛异常，就按统一失败结构返回。
    return {
      ok: false,
      state: 'BIRTHDAY_DAY_FILL_FAILED',
      source: 'profile-input',
      value: error?.message || 'UNKNOWN',
      stateChanged: false,
    };
  }
}

/**
 * 读取第四阶段提交前后的轻量页面快照。
 *
 * 作用：
 * - 给 submit 前后状态变化判断提供统一摘要
 * - 避免一上来就引入复杂快照系统
 */
async function readDreaminaProfileCompletionSnapshot(page, profile) {
  // 读取当前 year 输入值。
  const yearState = await readDreaminaBirthdayYearValue(page, profile).catch(() => ({ value: '' }));
  // 读取当前 month 输入值。
  const monthState = await readDreaminaBirthdayMonthValue(page, profile).catch(() => ({ value: '' }));
  // 读取当前 day 输入值。
  const dayState = await readDreaminaBirthdayDayValue(page, profile).catch(() => ({ value: '' }));
  // 检测 submit selector 是否可见。
  const submitSelector = await findFirstVisibleBySelectors(page, profile?.birthday?.submitSelectors || []);
  // 检测 post-auth-ready selector 是否可见。
  const nextStageSelector = await findFirstVisibleBySelectors(page, profile?.nextStageSignals?.postAuthReady?.selectors || []);
  // 检测阶段 4 失败提示文本是否可见。
  const failureText = await findFirstVisibleByTexts(page, [
    ...(profile?.failureSignals?.inputInvalid || []),
    ...(profile?.failureSignals?.submitFailed || []),
    ...(profile?.failureSignals?.inlineErrors || []),
  ]);

  // 返回轻量快照结构。
  return {
    yearValue: String(yearState?.value || '').trim(),
    monthValue: String(monthState?.value || '').trim(),
    dayValue: String(dayState?.value || '').trim(),
    submitVisible: Boolean(submitSelector?.ok),
    submitSelector: String(submitSelector?.selector || ''),
    nextStageVisible: Boolean(nextStageSelector?.ok),
    nextStageSelector: String(nextStageSelector?.selector || ''),
    failureText: failureText?.ok ? String(failureText.text || '') : '',
  };
}

/**
 * 判断第四阶段 submit 前后是否发生了有意义状态变化。
 *
 * 作用：
 * - 避免只看 click 是否报错
 * - 改为看页面摘要是否出现推进迹象
 */
function detectDreaminaProfileCompletionStateChange(beforeSnapshot = {}, afterSnapshot = {}) {
  // 如果下一阶段信号从不可见变为可见，说明提交后页面已经开始往 post-auth-ready 推进。
  if (!beforeSnapshot?.nextStageVisible && afterSnapshot?.nextStageVisible) {
    return {
      changed: true,
      reason: 'advanced-to-next-stage',
      source: 'next-stage-signal',
      strength: 'strong',
    };
  }

  // 如果提交按钮从可见变为不可见，也通常意味着页面发生了推进或切屏。
  if (beforeSnapshot?.submitVisible && !afterSnapshot?.submitVisible) {
    return {
      changed: true,
      reason: 'submit-disappeared',
      source: 'submit-visibility',
      strength: 'medium',
    };
  }

  // 如果 failureText 发生变化，说明页面对这次提交给出了新的反馈。
  if (String(beforeSnapshot?.failureText || '') !== String(afterSnapshot?.failureText || '')) {
    return {
      changed: true,
      reason: 'inline-error-appeared',
      source: 'failure-text',
      strength: String(afterSnapshot?.failureText || '').trim() ? 'strong' : 'weak',
    };
  }

  // 如果 year / month / day 中任意一个值发生变化，说明表单自身状态发生了改变。
  if (String(beforeSnapshot?.yearValue || '') !== String(afterSnapshot?.yearValue || '')) {
    return {
      changed: true,
      reason: 'form-value-reset',
      source: 'year-value',
      strength: 'medium',
    };
  }
  if (String(beforeSnapshot?.monthValue || '') !== String(afterSnapshot?.monthValue || '')) {
    return {
      changed: true,
      reason: 'form-value-reset',
      source: 'month-value',
      strength: 'medium',
    };
  }
  if (String(beforeSnapshot?.dayValue || '') !== String(afterSnapshot?.dayValue || '')) {
    return {
      changed: true,
      reason: 'form-value-reset',
      source: 'day-value',
      strength: 'medium',
    };
  }

  // 如果没有检测到任何可识别变化，则返回 no-observable-change。
  return {
    changed: false,
    reason: 'no-observable-change',
    source: 'snapshot-diff',
    strength: 'none',
  };
}

/**
 * 提交 Dreamina profile-completion。
 *
 * 第一版真实能力目标：
 * - 找到 next / submit 按钮
 * - 记录 submit 前页面摘要
 * - 执行 click
 * - 记录 submit 后页面摘要
 * - 根据摘要判断是否发生了有意义变化
 */
async function submitDreaminaProfileCompletion(page, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第四阶段 profile。
  const profile = loadDreaminaProfileCompletionProfile();
  // 优先通过 selector 找 submit / next 按钮。
  const submitBySelector = await findFirstVisibleBySelectors(page, profile?.birthday?.submitSelectors || []);
  // 如果 selector 没命中，再尝试通过文本找 submit / next 按钮。
  const submitByText = submitBySelector.ok ? { ok: false, text: '', locator: null } : await findFirstVisibleByTexts(page, profile?.birthday?.submitTexts || []);

  // 统一 submit 入口结构。
  const submitTarget = submitBySelector.ok
    ? { ok: true, source: 'selector', value: submitBySelector.selector, locator: submitBySelector.locator }
    : submitByText.ok
      ? { ok: true, source: 'text', value: submitByText.text, locator: submitByText.locator }
      : { ok: false, source: '', value: '', locator: null };

  // 如果 submit 入口都没找到，就直接失败。
  if (!submitTarget.ok || !submitTarget.locator) {
    return {
      ok: false,
      state: 'PROFILE_COMPLETION_SUBMIT_FAILED',
      source: 'selector',
      value: 'SUBMIT_BUTTON_NOT_FOUND',
      beforeSnapshot: null,
      afterSnapshot: null,
      stateChanged: null,
    };
  }

  try {
    // 先读取点击前的页面摘要。
    const beforeSnapshot = await readDreaminaProfileCompletionSnapshot(page, profile);
    // 执行点击，尽量触发 next / submit。
    await submitTarget.locator.click({ force: true }).catch(() => submitTarget.locator.click().catch(() => {}));
    // 给页面一小段时间消化点击动作。
    await page.waitForTimeout(Number(runtime?.profileCompletionSubmitSettleMs || 220)).catch(() => {});
    // 读取点击后的页面摘要。
    const afterSnapshot = await readDreaminaProfileCompletionSnapshot(page, profile);
    // 根据前后快照判断页面是否发生了有意义变化，并给出变化原因。
    const stateChange = detectDreaminaProfileCompletionStateChange(beforeSnapshot, afterSnapshot);
    // 保持原有布尔字段，兼容上层；同时在提交态 value 中补足变化原因。
    const stateChanged = Boolean(stateChange.changed);
    const submitValue = [submitTarget.value, stateChange.reason].filter(Boolean).join(' | ');

    // 如果有日志函数，记录本轮 submit 摘要与变化类型。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.profileCompletion.submit | source=${submitTarget.source} | value=${submitTarget.value} | changeReason=${stateChange.reason} | changeSource=${stateChange.source} | changeStrength=${stateChange.strength} | beforeNext=${beforeSnapshot.nextStageVisible ? 'Y' : 'N'} | afterNext=${afterSnapshot.nextStageVisible ? 'Y' : 'N'} | beforeFailure=${beforeSnapshot.failureText || '[NONE]'} | afterFailure=${afterSnapshot.failureText || '[NONE]'}`);
    }

    // 返回统一 submit 结果结构。
    return {
      ok: true,
      state: 'PROFILE_COMPLETION_SUBMITTED',
      source: submitTarget.source,
      value: submitValue,
      beforeSnapshot,
      afterSnapshot,
      stateChanged,
    };
  } catch (error) {
    // 如果 submit 过程抛异常，就按统一失败结构返回。
    return {
      ok: false,
      state: 'PROFILE_COMPLETION_SUBMIT_FAILED',
      source: submitTarget.source || 'selector',
      value: error?.message || 'UNKNOWN',
      beforeSnapshot: null,
      afterSnapshot: null,
      stateChanged: false,
    };
  }
}

/**
 * 检测 Dreamina 是否已经进入 post-auth-ready。
 *
 * 作用：
 * - 这是第四阶段成功的最强确认之一
 * - 只确认“下一阶段是否可达”，不执行第五阶段稳定确认动作
 */
async function detectDreaminaPostAuthReady(page, profile, context = {}) {
  // 优先通过结构性 selector 判断是否进入下一阶段。
  const nextStageSelector = await findFirstVisibleBySelectors(page, profile?.nextStageSignals?.postAuthReady?.selectors || []);
  // 如果 selector 命中，直接按强信号返回。
  if (nextStageSelector.ok) {
    return {
      ok: true,
      source: 'selector',
      value: nextStageSelector.selector,
      strength: 'strong',
    };
  }

  // 如果 selector 没命中，再通过文本判断是否进入下一阶段。
  const nextStageText = await findFirstVisibleByTexts(page, profile?.nextStageSignals?.postAuthReady?.texts || []);
  // 如果文本命中，按弱一些的信号返回。
  if (nextStageText.ok) {
    return {
      ok: true,
      source: 'text',
      value: nextStageText.text,
      strength: 'weak',
    };
  }

  // 再补一层第四阶段边界内允许的辅助成功信号：
  // - birthday submit 按钮消失
  // - year / month / day 输入都不可见
  // 这只能作为“页面已经离开资料填写面板”的弱成功辅助，不等于第五阶段稳定完成。
  const submitStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.submitSelectors || []);
  const yearStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.yearSelectors || []);
  const monthStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.monthSelectors || []);
  const dayStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.daySelectors || []);

  // 如果 birthday submit 与三个输入都已经不可见，可以视为“已离开第四阶段表单”的辅助成功信号。
  if (!submitStillVisible.ok && !yearStillVisible.ok && !monthStillVisible.ok && !dayStillVisible.ok) {
    return {
      ok: true,
      source: 'panel-disappeared',
      value: 'birthday-form-hidden',
      strength: 'weak',
    };
  }

  // 当前没有确认进入下一阶段。
  return {
    ok: false,
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 检测 Dreamina 第四阶段提交后的明确失败信号。
 *
 * 作用：
 * - 收口第四阶段里已经明确的失败语义
 * - 优先减少 profile-completion-result-unknown 的比例
 */
async function detectDreaminaProfileCompletionFailureSignals(page, profile, context = {}) {
  // 先检测 input invalid。
  const inputInvalid = await findFirstVisibleByTexts(page, profile?.failureSignals?.inputInvalid || []);
  // 如果 input invalid 命中，返回明确失败。
  if (inputInvalid.ok) {
    return {
      hit: true,
      state: 'PROFILE_COMPLETION_INPUT_INVALID',
      source: 'text',
      value: inputInvalid.text,
      strength: 'strong',
    };
  }

  // 再检测 submit failed。
  const submitFailed = await findFirstVisibleByTexts(page, profile?.failureSignals?.submitFailed || []);
  // 如果 submit failed 命中，返回明确失败。
  if (submitFailed.ok) {
    return {
      hit: true,
      state: 'PROFILE_COMPLETION_SUBMIT_FAILED',
      source: 'text',
      value: submitFailed.text,
      strength: 'strong',
    };
  }

  // 再检查“表单仍完整停留在第四阶段”的弱失败信号。
  const submitStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.submitSelectors || []);
  const yearStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.yearSelectors || []);
  const monthStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.monthSelectors || []);
  const dayStillVisible = await findFirstVisibleBySelectors(page, profile?.birthday?.daySelectors || []);
  // 如果表单主元素仍都可见，说明至少当前还没明显离开第四阶段填写面板。
  if (submitStillVisible.ok && yearStillVisible.ok && monthStillVisible.ok && dayStillVisible.ok) {
    return {
      hit: true,
      state: 'PROFILE_COMPLETION_NEXT_STAGE_NOT_REACHED',
      source: 'form-still-visible',
      value: [submitStillVisible.selector, yearStillVisible.selector, monthStillVisible.selector, dayStillVisible.selector].filter(Boolean).join(' | '),
      strength: 'weak',
    };
  }

  // 最后检测 inline error。
  const inlineError = await findFirstVisibleByTexts(page, profile?.failureSignals?.inlineErrors || []);
  // 如果 inline error 命中，返回明确失败。
  if (inlineError.ok) {
    return {
      hit: true,
      state: 'PROFILE_COMPLETION_INLINE_ERROR',
      source: 'text',
      value: inlineError.text,
      strength: 'weak',
    };
  }

  // 如果没有命中任何明确失败信号，则返回未命中结构。
  return {
    hit: false,
    state: '',
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 确认 Dreamina 第四阶段提交结果。
 *
 * 当前补强后的策略：
 * 1. 先确认是否进入 post-auth-ready
 * 2. 再确认是否命中明确失败
 * 3. 如果两者都没有，则补一轮保护等待后复判
 * 4. 最后才返回 unknown
 *
 * 注意：
 * - 这里只负责“确认第四阶段是否完成”
 * - 可以确认第五阶段是否已可达
 * - 不能替第五阶段做最终稳定确认动作
 */
async function confirmDreaminaProfileCompletionSubmitResult(page, runtime = {}, context = {}) {
  // 读取第四阶段 profile。
  const profile = loadDreaminaProfileCompletionProfile();
  // 从 runtime 中读取确认保护等待；默认给一小段时间让页面完成跳转。
  const confirmGraceWaitMs = Number(runtime?.profileCompletionConfirmGraceWaitMs || 900);

  // 第一轮：先尝试确认是否已经进入下一阶段。
  const postAuthReady = await detectDreaminaPostAuthReady(page, profile, context);
  // 如果第一轮已经确认进入下一阶段，就直接按成功返回。
  if (postAuthReady.ok) {
    return {
      ok: true,
      state: 'PROFILE_COMPLETION_SUBMIT_OK',
      nextStage: 'post-auth-ready',
      source: postAuthReady.source,
      value: postAuthReady.value,
      strength: postAuthReady.strength,
      settleStage: 'primary-success',
    };
  }

  // 第一轮：如果还没进入下一阶段，再尝试识别明确失败。
  const failureSignal = await detectDreaminaProfileCompletionFailureSignals(page, profile, context);
  // 如果第一轮已经命中明确失败，就直接返回失败。
  if (failureSignal.hit) {
    return {
      ok: false,
      state: failureSignal.state,
      nextStage: '',
      source: failureSignal.source,
      value: failureSignal.value,
      strength: failureSignal.strength,
      settleStage: 'primary-failure',
    };
  }

  // 如果第一轮既没成功也没失败，给页面一小段保护等待，降低慢一拍误判 unknown 的概率。
  if (confirmGraceWaitMs > 0) {
    await page.waitForTimeout(confirmGraceWaitMs).catch(() => {});
  }

  // 第二轮：保护等待后再次确认是否进入下一阶段。
  const postAuthReadyAfterGrace = await detectDreaminaPostAuthReady(page, profile, context);
  // 如果第二轮确认进入下一阶段，则按 secondary-success 返回。
  if (postAuthReadyAfterGrace.ok) {
    return {
      ok: true,
      state: 'PROFILE_COMPLETION_SUBMIT_OK',
      nextStage: 'post-auth-ready',
      source: postAuthReadyAfterGrace.source,
      value: postAuthReadyAfterGrace.value,
      strength: postAuthReadyAfterGrace.strength,
      settleStage: 'secondary-success',
    };
  }

  // 第二轮：保护等待后再次确认明确失败。
  const failureAfterGrace = await detectDreaminaProfileCompletionFailureSignals(page, profile, context);
  // 如果第二轮命中明确失败，则按 secondary-failure 返回。
  if (failureAfterGrace.hit) {
    return {
      ok: false,
      state: failureAfterGrace.state,
      nextStage: '',
      source: failureAfterGrace.source,
      value: failureAfterGrace.value,
      strength: failureAfterGrace.strength,
      settleStage: 'secondary-failure',
    };
  }

  // 如果两轮确认都没有收敛到成功或明确失败，则按 unknown 返回。
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
 *
 * 当前精修目标：
 * - 把 submit / confirm 新增出来的失败语义收进来
 * - 让 siteReason 更接近实际业务含义
 * - 仍然只做第四阶段失败收口，不替 runner 做策略决策
 */
function classifyDreaminaProfileCompletionFailure(input = {}) {
  // 先从输入中提取原始 reason/state，并统一转成大写形式便于比较。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 从输入中提取 source，后面用于细化 submit/confirm 分支。
  const source = String(input.source || '').trim().toLowerCase();
  // 从输入中提取 value，后面用于识别更具体的失败含义。
  const value = String(input.value || '').trim();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;
  // 默认将 hardFailure 视为 false，只有少数明确无继续价值的场景才提升。
  let hardFailure = false;

  // 先收口第四阶段入口与计划类失败。
  if (reason === 'PROFILE_COMPLETION_NOT_READY') {
    siteReason = 'DREAMINA_PROFILE_COMPLETION_NOT_READY';
  } else if (reason === 'PROFILE_COMPLETION_PLAN_FAILED') {
    siteReason = 'DREAMINA_PROFILE_COMPLETION_PLAN_FAILED';
  }
  // 再收口 birthday 三字段填写失败。
  else if (reason === 'BIRTHDAY_YEAR_FILL_FAILED' || reason === 'BIRTHDAY_YEAR_FILL_NOT_IMPLEMENTED') {
    siteReason = value === 'YEAR_INPUT_NOT_FOUND'
      ? 'DREAMINA_BIRTHDAY_YEAR_INPUT_MISSING'
      : value === 'EMPTY_YEAR_PLAN'
        ? 'DREAMINA_BIRTHDAY_YEAR_PLAN_EMPTY'
        : 'DREAMINA_BIRTHDAY_YEAR_FILL_FAILED';
  } else if (reason === 'BIRTHDAY_MONTH_FILL_FAILED' || reason === 'BIRTHDAY_MONTH_FILL_NOT_IMPLEMENTED') {
    siteReason = value === 'MONTH_INPUT_NOT_FOUND'
      ? 'DREAMINA_BIRTHDAY_MONTH_INPUT_MISSING'
      : value === 'EMPTY_MONTH_PLAN'
        ? 'DREAMINA_BIRTHDAY_MONTH_PLAN_EMPTY'
        : 'DREAMINA_BIRTHDAY_MONTH_FILL_FAILED';
  } else if (reason === 'BIRTHDAY_DAY_FILL_FAILED' || reason === 'BIRTHDAY_DAY_FILL_NOT_IMPLEMENTED') {
    siteReason = value === 'DAY_INPUT_NOT_FOUND'
      ? 'DREAMINA_BIRTHDAY_DAY_INPUT_MISSING'
      : value === 'EMPTY_DAY_PLAN'
        ? 'DREAMINA_BIRTHDAY_DAY_PLAN_EMPTY'
        : 'DREAMINA_BIRTHDAY_DAY_FILL_FAILED';
  }
  // 再收口 submit 失败与 submit 后无有效推进。
  else if (reason === 'PROFILE_COMPLETION_SUBMIT_FAILED' || reason === 'PROFILE_COMPLETION_SUBMIT_NOT_IMPLEMENTED') {
    siteReason = value === 'SUBMIT_BUTTON_NOT_FOUND'
      ? 'DREAMINA_PROFILE_COMPLETION_SUBMIT_BUTTON_MISSING'
      : 'DREAMINA_PROFILE_COMPLETION_SUBMIT_FAILED';
  } else if (reason === 'PROFILE_COMPLETION_NEXT_STAGE_NOT_REACHED') {
    siteReason = source === 'form-still-visible'
      ? 'DREAMINA_PROFILE_COMPLETION_FORM_STILL_VISIBLE_AFTER_SUBMIT'
      : 'DREAMINA_PROFILE_COMPLETION_NEXT_STAGE_NOT_REACHED';
  }
  // 再收口确认阶段已经识别出的失败语义。
  else if (reason === 'PROFILE_COMPLETION_INPUT_INVALID') {
    siteReason = 'DREAMINA_PROFILE_COMPLETION_INPUT_INVALID';
    hardFailure = true;
  } else if (reason === 'PROFILE_COMPLETION_INLINE_ERROR') {
    siteReason = 'DREAMINA_PROFILE_COMPLETION_INLINE_ERROR';
  } else if (reason === 'PROFILE_COMPLETION_RESULT_UNKNOWN') {
    // 如果 value 里已经包含 no-observable-change，就把它显式收成更具体的 unknown。
    siteReason = /NO-OBSERVABLE-CHANGE/i.test(value)
      ? 'DREAMINA_PROFILE_COMPLETION_NO_OBSERVABLE_CHANGE'
      : 'DREAMINA_PROFILE_COMPLETION_RESULT_UNKNOWN';
  }

  // 返回统一失败分类结构。
  return {
    reason,
    siteReason,
    hardFailure,
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
