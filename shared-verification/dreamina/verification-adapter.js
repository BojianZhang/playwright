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
 * 等待 Dreamina verification 阶段 ready。
 *
 * 设计目标：
 * - 只确认“是否进入验证码阶段”
 * - 不负责获取验证码
 * - 不负责输入验证码
 *
 * 当前策略：
 * - 立即检查一次
 * - 按 primary / secondary 等待步再检查
 * - 优先命中 selector，再命中文本
 */
async function waitForDreaminaVerificationStageReady(page, runtime = {}, context = {}) {
  // 从上下文中取日志函数；没有则保持 null。
  const { logInfo = null } = context;
  // 读取 Dreamina 第三阶段 profile。
  const profile = loadDreaminaVerificationProfile();
  // 构造 ready 检测的等待步列表：
  // - 先立即检查
  // - 再 primary wait
  // - 再 secondary wait
  const steps = [...new Set([0, Number(runtime?.verificationReadyPrimaryWaitMs || 300), Number(runtime?.verificationReadySecondaryWaitMs || 900)].filter(ms => Number(ms) >= 0))];

  // 记录最后一次执行到的等待步，用于失败返回时保留现场信息。
  let lastWaitStepMs = 0;
  // 依次执行每个等待步。
  for (const waitStepMs of steps) {
    // 更新当前等待步记录。
    lastWaitStepMs = waitStepMs;
    // 如果当前等待步大于 0，先等待对应毫秒数。
    if (waitStepMs > 0) await page.waitForTimeout(waitStepMs);

    // 优先尝试通过 selector 检测 verification ready。
    const selectorHit = await findFirstVisibleBySelectors(page, profile?.verificationReady?.selectors || []);
    // 如果 selector 已命中，就按强信号返回成功。
    if (selectorHit.ok) {
      // 如果存在日志函数，记录当前 selector 命中情况。
      if (typeof logInfo === 'function') logInfo(`dreamina.verification.waitForStageReady | selector=${selectorHit.selector} | waitStepMs=${waitStepMs}`);
      // 返回 ready 成功结果。
      return { ok: true, state: 'VERIFICATION_STAGE_READY', source: 'selector', value: selectorHit.selector, strength: 'strong', waitStepMs };
    }

    // 如果 selector 没命中，再尝试通过文本检测 verification ready。
    const textHit = await findFirstVisibleByTexts(page, profile?.verificationReady?.texts || []);
    // 如果文本命中，就按弱一些的信号返回成功。
    if (textHit.ok) {
      // 如果存在日志函数，记录当前文本命中情况。
      if (typeof logInfo === 'function') logInfo(`dreamina.verification.waitForStageReady | text=${textHit.text} | waitStepMs=${waitStepMs}`);
      // 返回 ready 成功结果。
      return { ok: true, state: 'VERIFICATION_STAGE_READY', source: 'text', value: textHit.text, strength: 'weak', waitStepMs };
    }
  }

  // 所有等待步都没有命中 ready，则返回统一失败结构。
  return { ok: false, state: 'VERIFICATION_STAGE_NOT_READY', source: '', value: '', strength: '', waitStepMs: lastWaitStepMs };
}

/**
 * 获取 Dreamina 当前验证码。
 *
 * 当前设计：
 * - 第三阶段本身只定义“需要一个验证码”这件事
 * - 真正的 provider 调用仍复用现有 firstmail-api 能力
 * - adapter 在这里把 provider 返回结果压平到第三阶段统一契约
 *
 * 当前边界：
 * - 这里只负责获取验证码
 * - 不负责 verification 阶段内重试闭环
 * - 不负责 wrong code 后重新轮询 latest
 */
async function fetchDreaminaVerificationCode(page, account, runtime = {}, context = {}) {
  // 从上下文中读取日志函数；没有就保持为 null。
  const { logInfo = null, log = null, verificationReady = null } = context;
  // 读取 provider 名称；当前默认使用 firstmail。
  const provider = String(runtime?.verificationCodeProvider || 'firstmail').trim().toLowerCase();

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
    // 如果存在日志函数，先记一条第三阶段拉码开始日志。
    if (typeof logInfo === 'function') {
      logInfo(`dreamina.verification.fetchCode | provider=${provider} | account=${account?.email || ''} | readyState=${verificationReady?.state || 'NA'}`);
    }

    // 调用现有 firstmail provider 能力，复用已经稳定的 latest 轮询与验证码提取逻辑。
    const result = await waitForDreaminaCodeViaApi({
      // 传入当前账号上下文，provider 依赖邮箱账号拉取验证码。
      account,
      // 直接复用 runtime 作为 provider 配置来源，保证第三阶段不重复发明配置结构。
      config: runtime,
      // 传入 log 函数，兼容旧 provider 的日志接口。
      log,
      // 传入当前账号标签，用于 provider 内部日志定位。
      accountLabel: account?.email || '',
      // 当前第三阶段没有单独代理标签概念，先写固定标记。
      proxyLabel: 'STAGE3_VERIFICATION',
      // 如果上层有传触发时间，就继续透传；没有就按 0 处理。
      triggeredAtMs: Number(runtime?.verificationTriggeredAtMs || context?.verificationTriggeredAtMs || 0),
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

    // provider 成功命中验证码后，返回第三阶段统一成功结构。
    return {
      // 表示本轮成功获取到了验证码。
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
 * 输入 Dreamina 验证码。
 *
 * 当前状态说明：
 * - 这还是第一版基础实现
 * - 当前只做 direct-fill + type fallback
 * - 后续会补 Dreamina hidden input / wrapper keyboard / fallback 多策略
 */
async function fillDreaminaVerificationCode(page, code, runtime = {}, context = {}) {
  // 从上下文里读取前一步解析出来的输入目标结果。
  const { codeInputResolution = null } = context;
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

  try {
    // 尝试先点击输入目标，尽量让焦点落在目标输入控件上。
    await codeInputResolution.locator.click().catch(() => {});
    // 优先尝试使用 fill 直接输入验证码。
    await codeInputResolution.locator.fill(String(code || '')).catch(async () => {
      // 如果 fill 失败，再 fallback 到 type。
      if (typeof codeInputResolution.locator.type === 'function') {
        // 用轻微 delay 的方式模拟逐字输入。
        await codeInputResolution.locator.type(String(code || ''), { delay: 60 }).catch(() => {});
      }
    });

    // 读取当前输入框里的值，作为输入是否成功的基础判断。
    const currentValue = await codeInputResolution.locator.inputValue().catch(() => '');
    // 如果当前值非空，则认为状态发生了可识别变化。
    const stateChanged = Boolean(String(currentValue || '').trim());
    // 返回输入结果结构。
    return {
      // 只要当前值非空，就先按成功处理。
      ok: Boolean(String(currentValue || '').trim()),
      // 如果当前值非空，state 就是输入成功；否则仍然算失败。
      state: String(currentValue || '').trim() ? 'VERIFICATION_CODE_FILLED' : 'VERIFICATION_CODE_FILL_FAILED',
      // 当前第一版输入模式固定为 direct-fill。
      mode: 'direct-fill',
      // 当前输入来源固定为 verification-input。
      source: 'verification-input',
      // 返回当前输入框里读取到的值。
      value: currentValue,
      // 返回状态变化判断结果。
      stateChanged,
    };
  } catch (error) {
    // 如果整个输入过程抛异常，则返回统一失败结构。
    return {
      // 明确失败。
      ok: false,
      // 当前阶段状态码：验证码输入失败。
      state: 'VERIFICATION_CODE_FILL_FAILED',
      // 当前输入模式仍记作 direct-fill，因为异常发生在这一条链上。
      mode: 'direct-fill',
      // 当前来源仍记为 verification-input。
      source: 'verification-input',
      // 用异常消息作为辅助值，便于排查。
      value: error?.message || 'UNKNOWN',
      // 明确记为没有成功状态变化。
      stateChanged: false,
    };
  }
}

/**
 * 确认 Dreamina 验证码提交结果。
 *
 * 当前策略：
 * 1. 先确认是否进入 profile-completion
 * 2. 再确认是否命中明确失败
 * 3. 如果都没有，则返回 unknown
 *
 * 注意：
 * - 这里只负责“确认第三阶段是否完成”
 * - 不负责填写 birthday / profile completion
 */
async function confirmDreaminaVerificationSubmitResult(page, runtime = {}, context = {}) {
  // 读取 Dreamina 第三阶段 profile。
  const profile = loadDreaminaVerificationProfile();

  // 先尝试通过 selector 确认是否已经进入下一阶段 profile-completion。
  const nextStageSelector = await findFirstVisibleBySelectors(page, profile?.nextStageSignals?.profileCompletion?.selectors || []);
  // 如果 selector 命中，按强成功信号返回。
  if (nextStageSelector.ok) {
    return {
      // 表示当前阶段成功完成。
      ok: true,
      // 当前阶段状态码：验证码提交成功。
      state: 'VERIFICATION_SUBMIT_OK',
      // 成功后应推进到 profile-completion。
      nextStage: 'profile-completion',
      // 当前结果通过 selector 命中。
      source: 'selector',
      // 返回命中的 selector 值。
      value: nextStageSelector.selector,
      // selector 命中按强信号处理。
      strength: 'strong',
      // 当前结果在第一层确认就命中成功。
      settleStage: 'primary-success',
    };
  }

  // 如果 selector 没命中，再尝试通过文本确认是否已经进入下一阶段。
  const nextStageText = await findFirstVisibleByTexts(page, profile?.nextStageSignals?.profileCompletion?.texts || []);
  // 如果文本命中，按较弱成功信号返回。
  if (nextStageText.ok) {
    return {
      // 表示当前阶段成功完成。
      ok: true,
      // 当前阶段状态码：验证码提交成功。
      state: 'VERIFICATION_SUBMIT_OK',
      // 成功后应推进到 profile-completion。
      nextStage: 'profile-completion',
      // 当前结果通过文本命中。
      source: 'text',
      // 返回命中的文本值。
      value: nextStageText.text,
      // 文本命中按弱一些的信号处理。
      strength: 'weak',
      // 当前结果在第一层确认就命中成功。
      settleStage: 'primary-success',
    };
  }

  // 如果还没确认进入下一阶段，再检测是否命中 wrong code。
  const wrongCode = await findFirstVisibleByTexts(page, profile?.failureSignals?.wrongCode || []);
  // 如果 wrong code 命中，返回明确失败。
  if (wrongCode.ok) {
    return {
      // 当前阶段失败。
      ok: false,
      // 当前状态码：验证码错误。
      state: 'WRONG_VERIFICATION_CODE',
      // 失败时 nextStage 为空。
      nextStage: '',
      // 当前失败来源为文本命中。
      source: 'text',
      // 返回命中的失败文本。
      value: wrongCode.text,
      // wrong code 属于强失败信号。
      strength: 'strong',
      // 在第一层确认里就命中失败。
      settleStage: 'primary-failure',
    };
  }

  // 继续检测是否命中验证码频率受限。
  const rateLimited = await findFirstVisibleByTexts(page, profile?.failureSignals?.rateLimited || []);
  // 如果频率受限命中，返回明确失败。
  if (rateLimited.ok) {
    return {
      // 当前阶段失败。
      ok: false,
      // 当前状态码：验证码频率受限。
      state: 'VERIFICATION_CODE_RATE_LIMITED',
      // 失败时 nextStage 为空。
      nextStage: '',
      // 当前失败来源为文本命中。
      source: 'text',
      // 返回命中的失败文本。
      value: rateLimited.text,
      // 频率受限按强失败信号处理。
      strength: 'strong',
      // 在第一层确认里就命中失败。
      settleStage: 'primary-failure',
    };
  }

  // 继续检测是否命中注册被拒绝相关提示。
  const rejected = await findFirstVisibleByTexts(page, profile?.failureSignals?.rejected || []);
  // 如果被拒绝命中，返回明确失败。
  if (rejected.ok) {
    return {
      // 当前阶段失败。
      ok: false,
      // 当前状态码：注册被拒绝。
      state: 'SIGNUP_REJECTED',
      // 失败时 nextStage 为空。
      nextStage: '',
      // 当前失败来源为文本命中。
      source: 'text',
      // 返回命中的失败文本。
      value: rejected.text,
      // 被拒绝按强失败信号处理。
      strength: 'strong',
      // 在第一层确认里就命中失败。
      settleStage: 'primary-failure',
    };
  }

  // 最后检测是否命中“账号已存在”。
  const existingAccount = await findFirstVisibleByTexts(page, profile?.failureSignals?.existingAccount || []);
  // 如果账号已存在命中，返回明确失败。
  if (existingAccount.ok) {
    return {
      // 当前阶段失败。
      ok: false,
      // 当前状态码：账号已存在。
      state: 'ACCOUNT_ALREADY_EXISTS',
      // 失败时 nextStage 为空。
      nextStage: '',
      // 当前失败来源为文本命中。
      source: 'text',
      // 返回命中的失败文本。
      value: existingAccount.text,
      // 账号已存在按强失败信号处理。
      strength: 'strong',
      // 在第一层确认里就命中失败。
      settleStage: 'primary-failure',
    };
  }

  // 如果既没有进入下一阶段，也没有命中明确失败，则按 unknown 返回。
  return {
    // 当前无法确认成功。
    ok: false,
    // 当前状态码：verification 结果未知。
    state: 'VERIFICATION_RESULT_UNKNOWN',
    // 失败时 nextStage 为空。
    nextStage: '',
    // 当前没有明确来源。
    source: '',
    // 当前没有明确辅助值。
    value: '',
    // 当前没有明确强弱定义。
    strength: '',
    // settleStage 记为 none，表示当前没有清晰收敛层。
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
