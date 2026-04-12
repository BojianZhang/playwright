'use strict';

// 引入文件系统模块，用来读取 Dreamina verification profile JSON 配置文件。
const fs = require('fs');
// 引入 path 模块，用来安全拼接当前目录下的 profile 文件路径。
const path = require('path');
// 引入现有 Firstmail provider 能力，用来在第三阶段接入真实拉码逻辑。
const { waitForDreaminaCodeViaApi } = require('../../firstmail-api');

// 当前 Dreamina 第三阶段 profile 的固定文件路径。
// 这个文件里只放静态规则，例如：
// - verification ready signals
// - code input selectors
// - failure signals
// - next stage signals
const DREAMINA_VERIFICATION_PROFILE_PATH = path.join(__dirname, 'profiles', 'dreamina-verification-profile.json');

// profile 缓存对象。
// 作用：
// - 避免每次调用 adapter 方法都重复 readFileSync + JSON.parse
// - 在第三阶段里保持 profile 读取成本稳定
let dreaminaVerificationProfileCache = null;

/**
 * 读取 Dreamina 第三阶段 profile。
 *
 * 作用：
 * - 从 JSON 文件加载静态规则
 * - 默认走内存缓存
 * - 在需要时允许 forceReload 强制重新读取
 */
function loadDreaminaVerificationProfile(options = {}) {
  // 读取是否要求强制刷新 profile 的开关。
  const forceReload = Boolean(options?.forceReload);
  // 如果没有要求强制刷新，并且缓存里已经有 profile，就直接返回缓存。
  if (!forceReload && dreaminaVerificationProfileCache) return dreaminaVerificationProfileCache;
  // 从磁盘读取 profile 文件原始文本。
  const raw = fs.readFileSync(DREAMINA_VERIFICATION_PROFILE_PATH, 'utf8');
  // 解析 JSON，同时去掉可能存在的 BOM 头。
  dreaminaVerificationProfileCache = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  // 返回最新读取到的 profile 对象。
  return dreaminaVerificationProfileCache;
}

function resolveDreaminaVerificationRuntime(runtime = {}, profile = null) {
  const verificationProfile = profile || loadDreaminaVerificationProfile();
  const profileApiKey = String(verificationProfile?.mailProvider?.firstmail?.apiKey || '').trim();
  if (String(runtime?.firstmailApiKey || runtime?.FIRSTMAIL_API_KEY || '').trim()) {
    return runtime;
  }

  if (!profileApiKey) {
    return runtime;
  }

  return {
    ...runtime,
    firstmailApiKey: profileApiKey,
    FIRSTMAIL_API_KEY: profileApiKey,
  };
}

/**
 * 判断 locator 当前是否可见。
 *
 * 作用：
 * - 统一第三阶段所有可见性判断逻辑
 * - 出错时不抛异常，而是安全返回 false
 */
async function isVisible(locator) {
  // 尝试调用 Playwright 的 isVisible，若抛错则兜底为 false。
  return await locator.isVisible().catch(() => false);
}

/**
 * 从 selector 列表中找到第一个当前可见的目标。
 *
 * 作用：
 * - 用于 verification ready 检测
 * - 用于 code input 解析
 * - 用于 next-stage / failure signal 检测
 */
async function findFirstVisibleBySelectors(page, selectors = []) {
  // 依次遍历所有候选 selector。
  for (const selector of selectors) {
    // 基于当前 selector 取第一个匹配元素。
    const locator = page.locator(selector).first();
    // 如果当前 locator 可见，就直接返回命中结果。
    if (await isVisible(locator)) {
      // 返回统一结构，说明 selector 命中成功。
      return { ok: true, selector, locator };
    }
  }
  // 如果所有 selector 都没命中，就返回统一失败结构。
  return { ok: false, selector: '', locator: null };
}

/**
 * 从文本列表中找到第一个当前可见的目标。
 *
 * 作用：
 * - 用于 ready 文案识别
 * - 用于 failure 文案识别
 * - 用于 next-stage 文案识别
 */
async function findFirstVisibleByTexts(page, texts = []) {
  // 依次遍历所有候选文本。
  for (const text of texts) {
    // 基于当前文本构造 Playwright text locator。
    const locator = page.getByText(String(text || ''), { exact: false }).first();
    // 如果当前文本命中并且可见，就直接返回结果。
    if (await isVisible(locator)) {
      // 返回统一结构，说明文本命中成功。
      return { ok: true, text, locator };
    }
  }
  // 如果所有文本都没命中，就返回统一失败结构。
  return { ok: false, text: '', locator: null };
}

/**
 * 检测 Dreamina verification 阶段的强 selector ready 信号。
 *
 * 作用：
 * - 这一层优先看结构信号，而不是文本
 * - 结构信号通常比文本更像“真的已经进入可输入验证码状态”
 */
async function detectDreaminaVerificationReadyBySelector(page, profile) {
  // 读取 profile 中定义的 verification ready selector 列表。
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.verificationReady?.selectors || []);
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
 * 检测 Dreamina verification 阶段的文本 ready 信号。
 *
 * 作用：
 * - 这一层主要承接 Resend code / countdown 之类的页面文本线索
 * - 文本信号通常弱于 selector，但仍然是有效的 ready 补充判断
 */
async function detectDreaminaVerificationReadyByText(page, profile) {
  // 读取 profile 中定义的 verification ready 文本列表。
  const textHit = await findFirstVisibleByTexts(page, profile?.verificationReady?.texts || []);
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
 * 在单个等待步内执行一次 verification ready 探测。
 *
 * 作用：
 * - 把“先查 selector，再查 text”收口成一个步骤级检测单元
 * - 让 waitForDreaminaVerificationStageReady 主函数更清楚地表达每一步在做什么
 */
async function detectDreaminaVerificationStageReadyOnce(page, profile, context = {}) {
  // 先做 selector 级 ready 探测，因为结构信号比文本更强。
  const selectorReady = await detectDreaminaVerificationReadyBySelector(page, profile);
  // 如果 selector 已命中，直接返回 selector 结果，不再继续跑文本探测。
  if (selectorReady.ok) return selectorReady;

  // selector 没命中时，再补一轮文本级 ready 探测。
  const textReady = await detectDreaminaVerificationReadyByText(page, profile);
  // 如果文本命中，就返回文本 ready 结果。
  if (textReady.ok) return textReady;

  // selector 和 text 都没有命中时，返回统一未命中结构。
  return {
    ok: false,
    source: '',
    value: '',
    strength: '',
  };
}

/**
 * 等待 Dreamina verification 阶段 ready。
 *
 * 设计目标：
 * - 只确认“是否进入验证码阶段”
 * - 不负责获取验证码
 * - 不负责输入验证码
 *
 * 当前补强后的步骤：
 * 1. 读取阶段 3 profile
 * 2. 构造 ready 检测等待步
 * 3. 每个等待步内先查强 selector 信号
 * 4. 如果强 selector 没命中，再查文本 / countdown 信号
 * 5. 一旦任意一步确认 ready，就立即返回
 * 6. 所有等待步都没命中时，再统一返回 not-ready
 */
async function waitForDreaminaVerificationStageReady(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 第一步：读取 Dreamina 第三阶段 profile，用来拿 ready selector/text 规则。
  const profile = loadDreaminaVerificationProfile();
  // 第二步：构造 ready 检测等待步列表。
  // 这里的含义是：
  // - 先立即检查一次
  // - 再给页面一段 primary 等待
  // - 最后再给页面一段 secondary 等待
  const steps = [...new Set([0, Number(runtime?.verificationReadyPrimaryWaitMs || 300), Number(runtime?.verificationReadySecondaryWaitMs || 900)].filter(ms => Number(ms) >= 0))];

  // 记录最后一次执行到的等待步，用于最终失败返回时保留现场信息。
  let lastWaitStepMs = 0;
  // 第三步：依次执行每个等待步。
  for (const waitStepMs of steps) {
    // 更新当前等待步记录。
    lastWaitStepMs = waitStepMs;
    // 如果当前等待步大于 0，先等待对应毫秒数，让页面有机会从过渡态进入验证码态。
    if (waitStepMs > 0) await page.waitForTimeout(waitStepMs);

    // 第四步：在当前等待步内执行一次完整 ready 探测。
    const readyResult = await detectDreaminaVerificationStageReadyOnce(page, profile, context);
    // 如果当前等待步已经确认 ready，就直接返回成功结构。
    if (readyResult.ok) {
      // 如果存在日志函数，记录当前 ready 命中来源、值和等待步。
      if (typeof logInfo === 'function') logInfo(`dreamina.verification.waitForStageReady | source=${readyResult.source} | value=${readyResult.value} | strength=${readyResult.strength} | waitStepMs=${waitStepMs}`);
      // 返回统一 ready 结果。
      return {
        ok: true,
        state: 'VERIFICATION_STAGE_READY',
        source: readyResult.source,
        value: readyResult.value,
        strength: readyResult.strength,
        waitStepMs,
      };
    }

    // 如果当前等待步没有命中任何 ready 信号，也写一条日志，方便后面判断是“完全没进来”还是“慢一拍”。
    if (typeof logInfo === 'function') logInfo(`dreamina.verification.waitForStageReady | miss | waitStepMs=${waitStepMs}`);
  }

  // 第五步：所有等待步都没有命中 ready 时，统一按 not-ready 返回。
  return {
    ok: false,
    state: 'VERIFICATION_STAGE_NOT_READY',
    source: '',
    value: '',
    strength: '',
    waitStepMs: lastWaitStepMs,
  };
}

/**
 * 获取 Dreamina 当前验证码。
 *
 * 当前设计：
 * - 第三阶段本身只定义“需要一个验证码”这件事
 * - 真正的 provider 调用仍复用现有 firstmail-api 能力
 * - adapter 在这里把 provider 返回结果压平到第三阶段统一契约
 * - 当前第二批增强会额外消费 usedCodes，避免 verification 内重试时重复使用旧验证码
 *
 * 当前边界：
 * - 这里只负责获取“当前这轮可用的新验证码”
 * - 允许过滤掉本阶段已经尝试过的旧验证码
 * - 不负责 verification 阶段内重试循环本身
 * - 不负责 wrong code 后决定是否进入下一轮
 */
async function fetchDreaminaVerificationCode(page, account, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有就保持为 null。
  const { logInfo = null, log = null, verificationReady = null, usedCodes = new Set(), attemptIndex = 1 } = context;
  const profile = loadDreaminaVerificationProfile();
  const effectiveRuntime = resolveDreaminaVerificationRuntime(runtime, profile);
  // 读取 provider 名称；当前默认使用 firstmail。
  const provider = String(effectiveRuntime?.verificationCodeProvider || 'firstmail').trim().toLowerCase();
  // 把 usedCodes 统一转成 Set，保证后续 has 判断稳定可用。
  const usedCodeSet = usedCodes instanceof Set ? usedCodes : new Set(Array.isArray(usedCodes) ? usedCodes : []);

  // 如果当前 provider 不是 firstmail，先按未配置处理，避免 silently 使用错误 provider。
  if (provider !== 'firstmail') {
    return {
      // 表示当前没有成功拿到验证码。
      ok: false,
      // 当前阶段状态码：provider 当前不支持。
      state: 'VERIFICATION_CODE_NOT_AVAILABLE',
      // 验证码为空字符串。
      code: '',
      // 来源仍标记为 mail-provider。
      source: 'mail-provider',
      // 辅助值记录不支持的 provider 名称。
      value: `UNSUPPORTED_PROVIDER:${provider}`,
      // 返回当前 provider 名称。
      provider,
      // 当前 provider 尝试序号记为 0。
      attempt: 0,
    };
  }

  try {
    // 如果存在日志函数，先记一条第三阶段拉码开始日志，同时把 usedCodes 数量也记录出来。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.verification.fetchCode | provider=${provider} | account=${account?.email || ''} | readyState=${verificationReady?.state || 'NA'} | attemptIndex=${attemptIndex} | usedCodes=${usedCodeSet.size} | apiKeySource=${String(runtime?.firstmailApiKey || runtime?.FIRSTMAIL_API_KEY || '').trim() ? 'runtime' : (String(profile?.mailProvider?.firstmail?.apiKey || '').trim() ? 'profile' : 'missing')}`);
    }

    // 调用现有 firstmail provider 能力，复用已经稳定的 latest 轮询与验证码提取逻辑。
    const result = await waitForDreaminaCodeViaApi({
      // 传入当前账号上下文，provider 依赖邮箱账号拉取验证码。
      account,
      // 直接复用 runtime 作为 provider 配置来源，保证第三阶段不重复发明配置结构。
      config: effectiveRuntime,
      // 传入 log 函数，兼容旧 provider 的日志接口。
      log,
      // 传入当前账号标签，用于 provider 内部日志定位。
      accountLabel: account?.email || '',
      // 当前第三阶段没有单独代理标签概念，先写固定标记。
      proxyLabel: 'STAGE3_VERIFICATION',
      // 如果上层有传触发时间，就继续透传；没有就按 0 处理。
      triggeredAtMs: Number(runtime?.verificationTriggeredAtMs || context?.verificationTriggeredAtMs || 0),
      // 把第三阶段已使用验证码集合透传给 provider，让 provider 在 recent candidate 里跳过旧验证码继续找新码。
      seenCodes: usedCodeSet,
    });

    // 取出 provider 返回的验证码文本，并统一 trim。
    const code = String(result?.code || '').trim();
    // 如果 provider 返回结构里没有有效验证码，按获取失败处理。
    if (!code) {
      return {
        // 当前没有成功拿到验证码。
        ok: false,
        // 当前阶段状态码：验证码不可用。
        state: 'VERIFICATION_CODE_NOT_AVAILABLE',
        // 验证码为空字符串。
        code: '',
        // 当前来源为邮件提供方。
        source: 'mail-provider',
        // 辅助值记录为空码语义。
        value: 'EMPTY_CODE',
        // 当前 provider 名称。
        provider,
        // 返回 provider 的尝试次数；没有则记 0。
        attempt: Number(result?.attempt || 0),
        // 保留 provider 命中的消息时间戳。
        messageTs: result?.messageTs,
        // 保留 provider 的命中模式。
        matchMode: result?.matchMode,
      };
    }

    // 理论上 provider 已经消费了 seenCodes，并优先返回未使用的新验证码。
    // 这里保留一层防守式判断，避免 provider 未来变更时又把旧验证码漏回第三阶段。
    if (usedCodeSet.has(code)) {
      if (typeof logInfo === 'function') {
        logInfo(`dreamina.verification.fetchCode | duplicate-code-guard-hit | code=${code} | attemptIndex=${attemptIndex} | providerAttempt=${Number(result?.attempt || 0)}`);
      }
      return {
        ok: false,
        state: 'VERIFICATION_CODE_NOT_AVAILABLE',
        code: '',
        source: 'mail-provider',
        value: `DUPLICATE_CODE_SKIPPED:${code}`,
        provider,
        attempt: Number(result?.attempt || 0),
        messageTs: result?.messageTs,
        matchMode: result?.matchMode,
      };
    }

    // provider 成功命中新验证码后，返回第三阶段统一成功结构。
    return {
      // 表示本轮成功获取到了可用的新验证码。
      ok: true,
      // 当前阶段状态码：验证码已获取。
      state: 'VERIFICATION_CODE_FETCHED',
      // 返回实际验证码。
      code,
      // 当前来源为邮件提供方。
      source: 'mail-provider',
      // 辅助值记录 provider 命中模式。
      value: String(result?.matchMode || 'provider-success'),
      // 返回 provider 名称。
      provider,
      // 返回 provider 的命中尝试序号。
      attempt: Number(result?.attempt || 0),
      // 返回消息时间戳，供调试和后续比对使用。
      messageTs: result?.messageTs,
      // 返回验证码命中模式。
      matchMode: result?.matchMode,
    };
  } catch (error) {
    // 如果 provider 调用过程中抛异常，则按统一失败结构返回，而不是把异常直接抛给公共层。
    return {
      // 当前没有成功获取到验证码。
      ok: false,
      // 当前阶段状态码：验证码获取失败。
      state: 'VERIFICATION_CODE_FETCH_FAILED',
      // 验证码为空字符串。
      code: '',
      // 当前来源为邮件提供方。
      source: 'mail-provider',
      // 辅助值写入异常消息，便于排查。
      value: error?.message || 'UNKNOWN',
      // 返回 provider 名称。
      provider,
      // 失败时尝试次数先记 0，避免制造不真实的次数语义。
      attempt: 0,
    };
  }
}

/**
 * 解析 Dreamina 验证码输入目标。
 *
 * 作用：
 * - 从 profile 定义的 Dreamina 专用白名单候选里，找到当前可用输入目标
 * - 读取输入目标基础元信息
 * - 返回统一的输入目标解析结构
 *
 * 注意：
 * - 当前只允许 Dreamina 专用候选池
 * - 不允许退回通用 textbox / 任意 input / 任意 div 的宽泛策略
 */
async function resolveDreaminaVerificationInput(page, runtime = {}, context = {}) {
  // 读取 Dreamina 第三阶段 profile。
  const profile = loadDreaminaVerificationProfile();
  // 按 profile 中的 codeInput.selectors 顺序寻找第一个可见输入目标。
  const selectorHit = await findFirstVisibleBySelectors(page, profile?.codeInput?.selectors || []);
  // 如果没有命中任何输入目标，就直接返回失败结构。
  if (!selectorHit.ok) {
    return {
      // 当前没有成功解析到输入目标。
      ok: false,
      // 当前阶段内状态码：验证码输入目标未找到。
      state: 'VERIFICATION_INPUT_NOT_FOUND',
      // 没有命中的 locator。
      locator: null,
      // 没有检测来源。
      source: '',
      // 没有命中的 selector。
      selector: '',
      // 没有可读取的输入目标元信息。
      inputMeta: null,
      // 没有强度信息。
      strength: '',
    };
  }

  // 命中输入目标后，读取目标元素的基础元信息，便于调试和后续策略判断。
  const inputMeta = {
    // 读取目标元素的标签名。
    tagName: await selectorHit.locator.evaluate(node => String(node?.tagName || '')).catch(() => ''),
    // 读取目标元素的 className。
    className: await selectorHit.locator.evaluate(node => String(node?.className || '')).catch(() => ''),
    // 读取目标元素的 type 属性。
    type: await selectorHit.locator.getAttribute('type').catch(() => ''),
    // 读取目标元素的 maxlength 属性。
    maxLength: await selectorHit.locator.getAttribute('maxlength').catch(() => ''),
    // 读取目标元素的 autocomplete 属性。
    autocomplete: await selectorHit.locator.getAttribute('autocomplete').catch(() => ''),
  };

  // 返回成功解析到验证码输入目标的结构。
  return {
    // 表示输入目标解析成功。
    ok: true,
    // 当前阶段内状态码：验证码输入目标已解析。
    state: 'VERIFICATION_INPUT_RESOLVED',
    // 返回真实命中的 locator，供后续填码使用。
    locator: selectorHit.locator,
    // 当前解析来源固定记为 verification-input。
    source: 'verification-input',
    // 返回命中的 selector 字符串。
    selector: selectorHit.selector,
    // 返回输入目标元信息。
    inputMeta,
    // 当前白名单命中按强信号处理。
    strength: 'strong',
  };
}

/**
 * 读取 Dreamina 验证码输入状态。
 *
 * 作用：
 * - 在多种输入策略后读取当前页面上的验证码输入结果
 * - 避免只看 click/fill 是否报错，而不看页面真实状态
 */
async function readDreaminaVerificationInputState(page) {
  // 在页面上下文里读取 Dreamina 验证码输入框与验证码格子的当前状态。
  return await page.evaluate(() => {
    // 优先寻找 Dreamina 真实 6 位验证码 input。
    const input = document.querySelector("input[maxlength='6'][autocomplete='one-time-code'], input[autocomplete='one-time-code'][inputmode='numeric'], .verification_code_input-wrapper input[maxlength='6']");
    // 收集页面上验证码格子的文本内容，作为 wrapper 模式下的补充判断依据。
    const boxes = Array.from(document.querySelectorAll(".verification_code_input-number, [class*='verification_code_input-number']"));
    // 返回统一状态结构。
    return {
      // 当前 input 的 value。
      inputValue: input instanceof HTMLInputElement ? String(input.value || '') : '',
      // 当前激活元素的标签名。
      activeTag: document.activeElement ? document.activeElement.tagName : '',
      // 当前激活元素的 className。
      activeClass: document.activeElement ? String(document.activeElement.className || '') : '',
      // 当前验证码格子的文本集合。
      boxTexts: boxes.map(node => String(node.textContent || '').trim()),
    };
  }).catch(() => ({ inputValue: '', activeTag: '', activeClass: '', boxTexts: [] }));
}

/**
 * 判断当前验证码输入状态是否已经成功承载目标验证码。
 *
 * 成功口径：
 * - inputValue 与验证码完全一致
 * - 或验证码格子的拼接文本前缀与验证码一致
 */
function hasDreaminaVerificationValue(state = {}, code = '') {
  // 把目标验证码统一成字符串。
  const expectedValue = String(code || '').trim();
  // 如果目标验证码为空，直接返回 false。
  if (!expectedValue) return false;
  // 读取 inputValue。
  const inputValue = String(state?.inputValue || '').trim();
  // 把 boxTexts 拼接起来，适配 Dreamina wrapper 格子输入场景。
  const joinedBoxText = Array.isArray(state?.boxTexts) ? state.boxTexts.join('') : '';
  // 只要 inputValue 全等，或者格子文本前缀等于验证码，就视为成功承载验证码。
  return inputValue === expectedValue || joinedBoxText.slice(0, expectedValue.length) === expectedValue;
}

/**
 * 尝试通过 Dreamina 真实 input 做输入。
 *
 * 这是 Dreamina 最优先的输入策略：
 * - click / focus
 * - 清空旧值
 * - fill / type
 * - evaluate 注入 input/change/keyup 事件
 */
async function tryDreaminaHiddenInputFill(page, locator, code, logInfo) {
  // 统一目标验证码字符串。
  const value = String(code || '').trim();
  // 如果没有验证码，直接失败返回。
  if (!value) return { ok: false, mode: 'dreamina-hidden-input', value: 'EMPTY_CODE', stateChanged: null };
  try {
    // 先点击目标 input，尽量把焦点落在真实输入框上。
    await locator.click({ force: true }).catch(() => {});
    // 再次显式 focus，降低只 click 不聚焦的概率。
    await locator.focus().catch(() => {});
    // 尝试全选旧值。
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    // 删除旧值，避免新旧验证码拼接。
    await locator.press('Backspace').catch(() => {});
    // 先尝试 fill 直接写入验证码。
    await locator.fill(value).catch(async () => {
      // 如果 fill 失败，再回退到 type。
      await locator.type(value, { delay: 60 }).catch(() => {});
    });
    // 补一层 DOM 注入，触发 input / change / keyup，覆盖 Dreamina 可能依赖的事件链。
    await locator.evaluate((node, verificationCode) => {
      // 只有 HTMLInputElement 才继续执行。
      if (!(node instanceof HTMLInputElement)) return;
      // 直接设置 input value。
      node.value = verificationCode;
      // 主动派发 input 事件。
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: verificationCode, inputType: 'insertText' }));
      // 主动派发 change 事件。
      node.dispatchEvent(new Event('change', { bubbles: true }));
      // 主动派发 keyup 事件，补 Dreamina 某些监听链。
      node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: verificationCode.slice(-1) || '' }));
    }, value).catch(() => {});
    // 给页面一小段时间吃掉状态变化。
    await page.waitForTimeout(180).catch(() => {});
    // 读取输入后的页面状态。
    const state = await readDreaminaVerificationInputState(page);
    // 如果有日志函数，记录当前输入结果状态。
    if (typeof logInfo === 'function') logInfo(`dreamina.verification.fillCode.hiddenInput | active=${state.activeTag}.${state.activeClass} | inputValue=${state.inputValue || '[EMPTY]'} | boxTexts=${JSON.stringify(state.boxTexts || [])}`);
    // 判断当前页面状态是否已经成功承载验证码。
    const ok = hasDreaminaVerificationValue(state, value);
    // 返回本轮 hidden input 输入结果。
    return {
      ok,
      mode: 'dreamina-hidden-input',
      value: String(state?.inputValue || ''),
      stateChanged: ok || Boolean(String(state?.inputValue || '').trim()),
    };
  } catch (error) {
    // hidden input 路径抛异常时，按失败结构返回，交给下一条策略继续尝试。
    return {
      ok: false,
      mode: 'dreamina-hidden-input',
      value: error?.message || 'UNKNOWN',
      stateChanged: false,
    };
  }
}

/**
 * 尝试通过 Dreamina wrapper 容器做键盘输入。
 *
 * 这个策略适用于：
 * - 页面表面是验证码格子容器
 * - 真实输入焦点落在 wrapper 关联元素上
 */
async function tryDreaminaWrapperKeyboardFill(page, code, logInfo) {
  // 统一目标验证码字符串。
  const value = String(code || '').trim();
  // 如果验证码为空，直接失败。
  if (!value) return { ok: false, mode: 'dreamina-wrapper-keyboard', value: 'EMPTY_CODE', stateChanged: null };
  // 构造 Dreamina wrapper 候选集合。
  const wrapperCandidates = [
    page.locator('.verification_code_input-wrapper').first(),
    page.locator("[class*='verification_code_input-wrapper']").first(),
    page.locator(".verification_code_input-number-focus").first(),
    page.locator("[class*='verification_code_input-number-focus']").first(),
  ];

  // 依次尝试每个 wrapper 候选。
  for (const candidate of wrapperCandidates) {
    // 如果候选不存在或不可见，则跳过。
    if (!candidate || !(await isVisible(candidate))) continue;
    try {
      // 先强制点击 wrapper，让焦点尽量落到 Dreamina 的验证码输入链路上。
      await candidate.click({ force: true }).catch(() => {});
      // 尝试全选旧值。
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
      // 删除旧值。
      await page.keyboard.press('Backspace').catch(() => {});
      // 使用键盘逐字输入验证码。
      await page.keyboard.type(value, { delay: 80 }).catch(() => {});
      // 给页面一点时间同步格子状态。
      await page.waitForTimeout(180).catch(() => {});
      // 读取输入后的页面状态。
      const state = await readDreaminaVerificationInputState(page);
      // 如果有日志函数，记录当前 wrapper 输入结果。
      if (typeof logInfo === 'function') logInfo(`dreamina.verification.fillCode.wrapper | active=${state.activeTag}.${state.activeClass} | inputValue=${state.inputValue || '[EMPTY]'} | boxTexts=${JSON.stringify(state.boxTexts || [])}`);
      // 判断当前页面状态是否已经成功承载验证码。
      const ok = hasDreaminaVerificationValue(state, value);
      // 如果当前 wrapper 路径成功，就直接返回。
      if (ok) {
        return {
          ok: true,
          mode: 'dreamina-wrapper-keyboard',
          value: String(state?.inputValue || ''),
          stateChanged: true,
        };
      }
    } catch (error) {
      // 当前 wrapper 候选失败时，静默进入下一个候选。
    }
  }

  // 所有 wrapper 候选都失败时，返回统一失败结构。
  return {
    ok: false,
    mode: 'dreamina-wrapper-keyboard',
    value: 'WRAPPER_INPUT_NOT_APPLIED',
    stateChanged: false,
  };
}

/**
 * 回退到普通 input fill/type 策略。
 *
 * 这是第三层兜底：
 * - 当前面 Dreamina 专用路径都没成功时
 * - 仍尝试直接对已解析出的 locator 做普通输入
 */
async function tryDreaminaFallbackFill(page, locator, code, logInfo) {
  // 统一目标验证码字符串。
  const value = String(code || '').trim();
  // 如果验证码为空，直接失败。
  if (!value) return { ok: false, mode: 'fallback-keyboard-type', value: 'EMPTY_CODE', stateChanged: null };
  try {
    // 点击目标输入控件。
    await locator.click().catch(() => {});
    // 先尝试键盘逐字输入。
    await page.keyboard.type(value, { delay: 80 }).catch(async () => {
      // 如果键盘输入失败，再尝试 fill。
      await locator.fill(value).catch(() => {});
    });
    // 给页面一点时间同步状态。
    await page.waitForTimeout(180).catch(() => {});
    // 读取输入后的页面状态。
    const state = await readDreaminaVerificationInputState(page);
    // 如果有日志函数，记录 fallback 输入结果。
    if (typeof logInfo === 'function') logInfo(`dreamina.verification.fillCode.fallback | active=${state.activeTag}.${state.activeClass} | inputValue=${state.inputValue || '[EMPTY]'} | boxTexts=${JSON.stringify(state.boxTexts || [])}`);
    // 判断当前页面状态是否已经成功承载验证码。
    const ok = hasDreaminaVerificationValue(state, value);
    // 返回 fallback 输入结果。
    return {
      ok,
      mode: 'fallback-keyboard-type',
      value: String(state?.inputValue || ''),
      stateChanged: ok || Boolean(String(state?.inputValue || '').trim()),
    };
  } catch (error) {
    // fallback 路径抛异常时，按统一失败结构返回。
    return {
      ok: false,
      mode: 'fallback-keyboard-type',
      value: error?.message || 'UNKNOWN',
      stateChanged: false,
    };
  }
}

/**
 * 输入 Dreamina 验证码。
 *
 * 当前策略：
 * 1. 先走 Dreamina hidden input 路径
 * 2. 再走 Dreamina wrapper keyboard 路径
 * 3. 最后走 fallback 普通输入路径
 *
 * 设计目标：
 * - 优先保留 Dreamina 专属输入能力
 * - 不退回宽泛输入目标匹配
 * - 不因为单一路径失败就直接判整阶段失败
 */
async function fillDreaminaVerificationCode(page, code, runtime = {}, context = {}) {
  // 从上下文里读取前一步解析出来的输入目标结果。
  const { codeInputResolution = null, logInfo = null } = context;
  // 如果输入目标本身都不存在，就直接失败，不再继续输入动作。
  if (!codeInputResolution?.ok || !codeInputResolution?.locator) {
    return {
      // 表示输入动作失败。
      ok: false,
      // 当前阶段状态码：验证码输入失败。
      state: 'VERIFICATION_CODE_FILL_FAILED',
      // 当前没有可用输入模式。
      mode: '',
      // 当前来源仍然记为 verification-input。
      source: 'verification-input',
      // 辅助值说明当前没有解析出的输入目标。
      value: 'NO_RESOLVED_INPUT',
      // 没有足够上下文判断 stateChanged。
      stateChanged: null,
    };
  }

  // 统一验证码字符串，避免后面多次重复 trim。
  const normalizedCode = String(code || '').trim();
  // 如果验证码本身为空，也直接失败，不做无意义输入动作。
  if (!normalizedCode) {
    return {
      ok: false,
      state: 'VERIFICATION_CODE_FILL_FAILED',
      mode: '',
      source: 'verification-input',
      value: 'EMPTY_CODE',
      stateChanged: null,
    };
  }

  // 第一层：优先尝试 Dreamina hidden input 路径。
  const hiddenInputResult = await tryDreaminaHiddenInputFill(page, codeInputResolution.locator, normalizedCode, logInfo);
  // 如果 hidden input 成功，就直接返回成功结果。
  if (hiddenInputResult.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_CODE_FILLED',
      mode: hiddenInputResult.mode,
      source: 'verification-input',
      value: hiddenInputResult.value,
      stateChanged: hiddenInputResult.stateChanged,
    };
  }

  // 第二层：hidden input 没成功时，尝试 Dreamina wrapper keyboard 路径。
  const wrapperResult = await tryDreaminaWrapperKeyboardFill(page, normalizedCode, logInfo);
  // 如果 wrapper 路径成功，就直接返回成功结果。
  if (wrapperResult.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_CODE_FILLED',
      mode: wrapperResult.mode,
      source: 'verification-input',
      value: wrapperResult.value,
      stateChanged: wrapperResult.stateChanged,
    };
  }

  // 第三层：当前面两条 Dreamina 专用路径都没成功时，再走普通 fallback 路径。
  const fallbackResult = await tryDreaminaFallbackFill(page, codeInputResolution.locator, normalizedCode, logInfo);
  // 如果 fallback 成功，也按成功结果返回。
  if (fallbackResult.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_CODE_FILLED',
      mode: fallbackResult.mode,
      source: 'verification-input',
      value: fallbackResult.value,
      stateChanged: fallbackResult.stateChanged,
    };
  }

  // 三条路径都失败时，统一返回失败结构。
  return {
    ok: false,
    state: 'VERIFICATION_CODE_FILL_FAILED',
    mode: fallbackResult.mode || wrapperResult.mode || hiddenInputResult.mode || '',
    source: 'verification-input',
    value: fallbackResult.value || wrapperResult.value || hiddenInputResult.value || 'UNKNOWN',
    stateChanged: false,
  };
}

/**
 * 检测 Dreamina 是否已经进入 profile-completion。
 *
 * 作用：
 * - 这是第三阶段成功的最强确认之一
 * - 只确认“下一阶段是否可达”，不执行下一阶段填写动作
 */
async function detectDreaminaProfileCompletionReady(page, profile, context = {}) {
  // 优先通过结构性 selector 判断是否进入下一阶段。
  const nextStageSelector = await findFirstVisibleBySelectors(page, profile?.nextStageSignals?.profileCompletion?.selectors || []);
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
  const nextStageText = await findFirstVisibleByTexts(page, profile?.nextStageSignals?.profileCompletion?.texts || []);
  // 如果文本命中，按弱一些的信号返回。
  if (nextStageText.ok) {
    return {
      ok: true,
      source: 'text',
      value: nextStageText.text,
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
 * 检测 Dreamina 验证码提交后的明确失败信号。
 *
 * 作用：
 * - 收口第三阶段里已经明确的失败语义
 * - 优先减少 verification-result-unknown 的比例
 */
async function detectDreaminaVerificationFailureSignals(page, profile, context = {}) {
  // 先检测 wrong code。
  const wrongCode = await findFirstVisibleByTexts(page, profile?.failureSignals?.wrongCode || []);
  // 如果验证码错误命中，返回明确失败。
  if (wrongCode.ok) {
    return {
      hit: true,
      state: 'WRONG_VERIFICATION_CODE',
      source: 'text',
      value: wrongCode.text,
      strength: 'strong',
    };
  }

  // 再检测验证码频率受限。
  const rateLimited = await findFirstVisibleByTexts(page, profile?.failureSignals?.rateLimited || []);
  // 如果频率受限命中，返回明确失败。
  if (rateLimited.ok) {
    return {
      hit: true,
      state: 'VERIFICATION_CODE_RATE_LIMITED',
      source: 'text',
      value: rateLimited.text,
      strength: 'strong',
    };
  }

  // 再检测注册被拒绝。
  const rejected = await findFirstVisibleByTexts(page, profile?.failureSignals?.rejected || []);
  // 如果被拒绝命中，返回明确失败。
  if (rejected.ok) {
    return {
      hit: true,
      state: 'SIGNUP_REJECTED',
      source: 'text',
      value: rejected.text,
      strength: 'strong',
    };
  }

  // 最后检测账号已存在。
  const existingAccount = await findFirstVisibleByTexts(page, profile?.failureSignals?.existingAccount || []);
  // 如果账号已存在命中，返回明确失败。
  if (existingAccount.ok) {
    return {
      hit: true,
      state: 'ACCOUNT_ALREADY_EXISTS',
      source: 'text',
      value: existingAccount.text,
      strength: 'strong',
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
 * 确认 Dreamina 验证码提交结果。
 *
 * 当前补强后的策略：
 * 1. 先确认是否进入 profile-completion
 * 2. 再确认是否命中明确失败
 * 3. 如果两者都没有，则再补一轮 profile-completion 保护等待
 * 4. 最后才返回 unknown
 *
 * 注意：
 * - 这里只负责“确认第三阶段是否完成”
 * - 可以确认第四阶段是否已可达
 * - 不能替第四阶段做填写动作
 */
async function confirmDreaminaVerificationSubmitResult(page, runtime = {}, context = {}) {
  // 读取第三阶段 profile。
  const profile = loadDreaminaVerificationProfile();
  // 从 runtime 中读取确认保护等待；默认给一小段时间让页面完成跳转。
  const confirmGraceWaitMs = Number(runtime?.verificationConfirmGraceWaitMs || 900);

  // 第一轮：先尝试确认是否已经进入下一阶段。
  const profileCompletionReady = await detectDreaminaProfileCompletionReady(page, profile, context);
  // 如果第一轮已经确认进入下一阶段，就直接按成功返回。
  if (profileCompletionReady.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_SUBMIT_OK',
      nextStage: 'profile-completion',
      source: profileCompletionReady.source,
      value: profileCompletionReady.value,
      strength: profileCompletionReady.strength,
      settleStage: 'primary-success',
    };
  }

  // 第一轮：如果还没进入下一阶段，再尝试识别明确失败。
  const failureSignal = await detectDreaminaVerificationFailureSignals(page, profile, context);
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

  // 如果第一轮既没成功也没失败，给页面一小段保护等待，降低“慢一拍导致误判 unknown”的概率。
  if (confirmGraceWaitMs > 0) {
    await page.waitForTimeout(confirmGraceWaitMs).catch(() => {});
  }

  // 第二轮：保护等待后再次确认是否进入下一阶段。
  const profileCompletionAfterGrace = await detectDreaminaProfileCompletionReady(page, profile, context);
  // 如果第二轮确认进入下一阶段，则按 secondary-success 返回。
  if (profileCompletionAfterGrace.ok) {
    return {
      ok: true,
      state: 'VERIFICATION_SUBMIT_OK',
      nextStage: 'profile-completion',
      source: profileCompletionAfterGrace.source,
      value: profileCompletionAfterGrace.value,
      strength: profileCompletionAfterGrace.strength,
      settleStage: 'secondary-success',
    };
  }

  // 第二轮：保护等待后再次确认明确失败。
  const failureAfterGrace = await detectDreaminaVerificationFailureSignals(page, profile, context);
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
    state: 'VERIFICATION_RESULT_UNKNOWN',
    nextStage: '',
    source: '',
    value: '',
    strength: '',
    settleStage: 'none',
  };
}

/**
 * 将第三阶段原始失败状态收敛成 Dreamina 专属 reason。
 *
 * 作用：
 * - 给外层返回更稳定的站点语义
 * - 让公共层不直接暴露过多内部状态码细节
 */
function classifyDreaminaVerificationFailure(input = {}) {
  // 先从输入中提取原始 reason/state，并统一转成大写形式便于比较。
  const reason = String(input.reason || input.state || 'UNKNOWN').trim().toUpperCase();
  // 默认情况下，siteReason 先等于原始 reason。
  let siteReason = reason;

  // 如果当前 reason 是 verification stage not ready，则映射到 Dreamina 专属语义。
  if (reason === 'VERIFICATION_STAGE_NOT_READY') siteReason = 'DREAMINA_VERIFICATION_STAGE_NOT_READY';
  // 如果当前 reason 是验证码不可用，则映射到 Dreamina 专属语义。
  else if (reason === 'VERIFICATION_CODE_NOT_AVAILABLE') siteReason = 'DREAMINA_VERIFICATION_CODE_NOT_AVAILABLE';
  // 如果当前 reason 是验证码输入目标未找到，则映射到 Dreamina 专属语义。
  else if (reason === 'VERIFICATION_INPUT_NOT_FOUND') siteReason = 'DREAMINA_VERIFICATION_INPUT_NOT_FOUND';
  // 如果当前 reason 是验证码输入失败，则映射到 Dreamina 专属语义。
  else if (reason === 'VERIFICATION_CODE_FILL_FAILED') siteReason = 'DREAMINA_VERIFICATION_CODE_FILL_FAILED';
  // 如果当前 reason 是验证码错误，则映射到 Dreamina 专属语义。
  else if (reason === 'WRONG_VERIFICATION_CODE') siteReason = 'DREAMINA_WRONG_VERIFICATION_CODE';
  // 如果当前 reason 是验证码频率受限，则映射到 Dreamina 专属语义。
  else if (reason === 'VERIFICATION_CODE_RATE_LIMITED') siteReason = 'DREAMINA_VERIFICATION_RATE_LIMITED';
  // 如果当前 reason 是注册被拒绝，则映射到 Dreamina 专属语义。
  else if (reason === 'SIGNUP_REJECTED') siteReason = 'DREAMINA_SIGNUP_REJECTED';
  // 如果当前 reason 是账号已存在，则映射到 Dreamina 专属语义。
  else if (reason === 'ACCOUNT_ALREADY_EXISTS') siteReason = 'DREAMINA_ACCOUNT_ALREADY_EXISTS';
  // 如果当前 reason 是 verification 结果未知，则映射到 Dreamina 专属语义。
  else if (reason === 'VERIFICATION_RESULT_UNKNOWN') siteReason = 'DREAMINA_VERIFICATION_RESULT_UNKNOWN';

  // 返回统一的失败分类结构。
  return {
    // 原始 reason/state。
    reason,
    // Dreamina 专属对外 reason。
    siteReason,
    // 当前是否属于强失败；当前只有 SIGNUP_REJECTED 被视作硬失败。
    hardFailure: reason === 'SIGNUP_REJECTED',
  };
}

// 导出 Dreamina 第三阶段 adapter 的所有公开能力。
module.exports = {
  // 导出 profile 读取函数。
  loadDreaminaVerificationProfile,
  resolveDreaminaVerificationRuntime,
  // 导出可见性判断工具。
  isVisible,
  // 导出 selector 命中工具。
  findFirstVisibleBySelectors,
  // 导出文本命中工具。
  findFirstVisibleByTexts,
  // 导出 verification ready 判断能力。
  waitForDreaminaVerificationStageReady,
  // 导出验证码获取能力。
  fetchDreaminaVerificationCode,
  // 导出验证码输入目标解析能力。
  resolveDreaminaVerificationInput,
  // 导出验证码输入能力。
  fillDreaminaVerificationCode,
  // 导出验证码提交结果确认能力。
  confirmDreaminaVerificationSubmitResult,
  // 导出 Dreamina 第三阶段失败分类能力。
  classifyDreaminaVerificationFailure,
};
