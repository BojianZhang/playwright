// 引擎配置字段 schema —— 引擎配置页渲染 + payload 取值的唯一事实源。
// ⚠️ 改这里要同步改 web/engine-schema.js(后端 seed 默认值 + 写入白名单);两份字段 key 与默认值必须一致。
//
// 边界(三方解耦):**引擎配置 = 该引擎"怎么跑"的技术行为**(填卡方式 / 求解 / 换IP / 环境生命周期 / 分流 + 各步转人工)。
//   ↔ 环节策略预设(lib/strategySchema)= 各环节"做什么"的业务参数(Key名/有效期、每卡次数/试卡数、充值金额)。
//   ↔ 全局(控制台 state)= 与引擎无关的运行设置(统一密码/模式/并发/数量/显示浏览器/续跑/拟人)。
//   ↔ 浏览器接管 + 环境来源(控制台 state:browserProvider/envIds/useAdspowerPool)= "这次用哪些资源",留在控制台。
// 默认值严格 = 重构前 ConsolePage 的 py state + card/register 策略里 engine-filtered 字段默认,保证全默认 payload 逐字段一致。

import type { EngineKey, FieldType } from './strategySchema';

export type { EngineKey } from './strategySchema';

export interface EngineField {
  key: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  default: string | boolean;
  min?: number;
  max?: number;
  step?: number;
}

// GLM 单引擎(纯 Selenium / run.py)。EngineKey 类型保留四值以满足 Record 类型,但控制台只暴露 selenium。
export const ENGINE_LIST: { key: EngineKey; label: string }[] = [
  { key: 'selenium', label: 'Selenium(z.ai 全流程)' },
];
export const ENGINE_SUBTITLE: Record<EngineKey, string> = {
  playwright: '(GLM 不用)',
  selenium: 'AdsPower 全流程 · 注册(滑块+邮箱验证+完成注册) → 创建 API Key → 订阅 GLM Coding Plan + 信用卡支付',
  hybrid: '(GLM 不用)',
  split: '(GLM 不用)',
};

// 各字段(复用重构前的 label/hint/options,只是换了归属位置)。
const F_SOLVE: EngineField = { key: 'solveHcaptcha', label: '遇到人机验证时', hint: '三种都会先免费点一次「I am human」复选框;此项只决定点框过不去(弹真图片挑战)时怎么办', type: 'select', default: 'random', options: [
  { value: 'off', label: '只点选框 · 过不去就换卡(不花 2Captcha)' },
  { value: 'on', label: '点选框 + 2Captcha 硬解(尽量保住这张卡)' },
  { value: 'random', label: '点选框 · 随机:一半硬解 / 一半换卡(默认)' },
] };
const F_DEADLINE: EngineField = { key: 'cardDeadline', label: '加卡超时上限(秒)', hint: '单账号加卡超过就放弃 · 0=不限时', type: 'number', default: '480', min: 0 };
const F_FUTILE: EngineField = { key: 'solveFutileCap', label: '验证失败几次后改换卡', hint: '自动过验证仍卡这么多次→直接换卡', type: 'number', default: '3', min: 0 };
const F_SWAPS: EngineField = { key: 'maxHcaptchaCardSwaps', label: '因人机验证换卡上限', hint: '因反复撞验证而换卡,最多换几张就停', type: 'number', default: '1', min: 0 };
const F_HC_RECHECK: EngineField = { key: 'hcRecheckWait', label: '点框后复检等待(秒)', hint: '点完「I am human」后最多等这么久看框是否消失/绑成,再判过不去换卡;给慢放行的 checkbox 框更多机会(隐形框无效)', type: 'number', default: '5', min: 0, step: 0.5 };
const F_RESULT_WAIT: EngineField = { key: 'cardResultWait', label: '绑卡结果等待上限(秒)', hint: '点 Save 后轮询「绑成/被拒」结果的上限;遇 Stripe「Save card?」存卡弹窗、且下面设为「等待」时,会拖到此上限才转去刷新核验。调小=更快收尾(默认24)', type: 'number', default: '24', min: 1, step: 1 };
const F_SAVECARD: EngineField = { key: 'cardSaveDialog', label: 'Save card 存卡弹窗处理', hint: '点 Save 后 Stripe 弹「Save card?」存卡弹窗(自带 Save 按钮→会被绑成轮询误读成"还没好")。注:图片人机验证在更早一环,弹了会直接换卡,到这一步说明卡已被 Stripe 收下——等待与否都不影响是否出图片验证。', type: 'select', default: 'dismiss', options: [
  { value: 'dismiss', label: '秒关弹窗(No thanks)→ 立即判绑成(默认 · 推荐)' },
  { value: 'wait', label: '不关、等满「绑卡结果等待上限」再核验(对照测试)' },
] };
const F_STALL: EngineField = { key: 'wizardStallRefresh', label: '取key卡死自救阈值(秒)', hint: '取key 某一屏(Welcome/workspace-ready/问卷)卡过这么久仍不前进 → 自动刷新 keys 页逃逸(最多2次);仅纯 Selenium 取key 用', type: 'number', default: '30', min: 5, step: 5 };
const F_NODEL: EngineField = { key: 'noDeleteEnv', label: '跑完保留环境', hint: '不删除 AdsPower 环境,方便事后检查(平时别开)', type: 'bool', default: false };
const F_AUTORETRY: EngineField = { key: 'autoRetryFailed', label: '自动重试失败号', hint: '一批跑完后,把失败的号自动再跑几轮(断点续跑语义:已取key不重建、已充值不重扣、已绑卡跳过,只补做失败那一步)→ 直接降失败率。注册/取key/加卡类失败多是可重试的瞬时问题', type: 'bool', default: false };
const F_AUTORETRY_N: EngineField = { key: 'autoRetryTimes', label: '自动重试轮数', hint: '失败号最多再跑几轮(默认1,上限5);需先开「自动重试失败号」', type: 'number', default: '1', min: 1, max: 5, step: 1 };
// ── 走法变体(同一引擎多套方案就地切;默认 '' = 跟随 Python 内置默认 → 不注 env、跑批行为逐字节不变)──
const F_WIZ_PAY: EngineField = { key: 'wizardPayMode', label: '取key向导·支付步走法', hint: '向导到支付步怎么走;空=跟随默认(每号随机)', type: 'select', default: '', options: [
  { value: '', label: '跟随默认(每号随机)' }, { value: 'address', label: '填地址露出卡表单' }, { value: 'later', label: '点「稍后再说」跳过' }, { value: 'random', label: '每号随机一种' },
] };
const F_WIZ_CREDIT: EngineField = { key: 'wizardCreditMode', label: '取key向导·积分步走法', hint: 'credits=向导内真实充值(★扣款);空=跟随默认(跳过)', type: 'select', default: '', options: [
  { value: '', label: '跟随默认(跳过)' }, { value: 'skip', label: '跳过(不充值)' }, { value: 'credits', label: '向导内充值(★真扣款)' }, { value: 'random', label: '每号随机' },
] };
const F_CARD_STRATEGY: EngineField = { key: 'cardStrategy', label: '灌卡策略', hint: '从卡池取卡方式;concentrate=集中灌一张测真实容量。空=跟随默认(随机)', type: 'select', default: '', options: [
  { value: '', label: '跟随默认(随机)' }, { value: 'random', label: '随机' }, { value: 'spread', label: '轮流摊匀' }, { value: 'concentrate', label: '集中灌一张(测容量)' },
] };
const F_ZIP_RETRY: EngineField = { key: 'zipRetry', label: 'declined 时 ZIP 重试次数', hint: '加卡被拒时换免税州 ZIP 重试同一张卡的次数;空=跟随默认(3)', type: 'number', default: '', min: 0 };
const F_CARD_FILL: EngineField = { key: 'cardFillMethod', label: '填卡方式(Selenium 侧)', hint: '默认 Fix C 原生 CDP(推荐);旧 Selenium 为实验兜底(设 FIXC=0)', type: 'select', default: '', options: [
  { value: '', label: 'Fix C 原生 CDP(默认,推荐)' }, { value: 'selenium', label: '旧 Selenium 填卡(实验)' },
] };
const HS_ROTATE: EngineField[] = [
  { key: 'maxRotations', label: '最多换几次 IP', hint: '加卡一直卡住时换几次网络出口再试', type: 'number', default: '3', min: 0 },
  { key: 'cooldownHours', label: '冷却等待(小时)', hint: '换IP还不行后,隔多久再重试该账号', type: 'number', default: '3', min: 0, step: 0.5 },
  { key: 'maxReopen', label: '加卡失败重开次数', hint: '同一环境最多重开几次浏览器补加卡', type: 'number', default: '3', min: 0 },
  { key: 'manualCard', label: '手动选卡', hint: '付款页弹卡池面板手动点选(需开「显示浏览器窗口」)', type: 'bool', default: false },
];
const HS_ENVLIFE: EngineField[] = [
  { key: 'isolate', label: '每账号全新环境', hint: '每个账号用全新环境,失败也删', type: 'bool', default: false },
  { key: 'noGc', label: '开始前不清理残留环境', hint: '跳过启动时自动清理上次没删掉的环境', type: 'bool', default: false },
];

// ── z.ai 引擎字段(纯 Selenium)──────────────────────────────────────────────
const Z_DOAPIKEY: EngineField = { key: 'doApiKey', label: '创建 API Key', hint: '注册成功后创建并抓取 API Key(独立于订阅:可只取 key 不订阅)', type: 'bool', default: true };
const Z_DOSUB: EngineField = { key: 'doSubscribe', label: '订阅 GLM Coding Plan', hint: '选套餐 + 填信用卡支付。★默认关;开了才进入支付流程', type: 'bool', default: false };
const Z_PLAN: EngineField = { key: 'plan', label: '套餐', hint: '需开「订阅」。Lite / Pro / Max', type: 'select', default: 'pro', options: [
  { value: 'lite', label: 'Lite' }, { value: 'pro', label: 'Pro(Popular)' }, { value: 'max', label: 'Max' },
] };
const Z_CYCLE: EngineField = { key: 'cycle', label: '计费周期', hint: '需开「订阅」。月付 / 季付 / 年付', type: 'select', default: 'monthly', options: [
  { value: 'monthly', label: '月付 Monthly(-10%)' }, { value: 'quarterly', label: '季付 Quarterly(-20%)' }, { value: 'yearly', label: '年付 Yearly(-30%)' },
] };
const Z_REALCHARGE: EngineField = { key: 'realCharge', label: '真实支付(★真扣款)', hint: '关=dry-run:走到 Confirm 但不真点(零成本验证全流程)。开=真点 Confirm 扣款,受卡容量账本约束', type: 'bool', default: false };
const Z_CHARGECNT: EngineField = { key: 'chargeCount', label: '整批最多真扣次数', hint: '测试帽:整批最多真扣 N 次,0=不限。需开「真实支付」', type: 'number', default: '0', min: 0 };
const Z_LIMITCAP: EngineField = { key: 'limitByCapacity', label: '按卡容量自动限批', hint: '卡总容量不够时,本批只跑能扣的个数(够几个跑几个)', type: 'bool', default: false };
const Z_SLIDER_SCALE: EngineField = { key: 'sliderScale', label: '滑块距离比例校准', hint: '滑块拖拽距离 ×比例;空=默认1。真机首跑按日志实测值微调', type: 'number', default: '', min: 0, step: 0.05 };
const Z_SLIDER_OFFSET: EngineField = { key: 'sliderOffset', label: '滑块距离偏移(px)', hint: '滑块拖拽距离 +偏移;空=默认0', type: 'number', default: '' };
const Z_SLIDER_ATT: EngineField = { key: 'sliderAttempts', label: '滑块重试次数', hint: '滑块没过时重截图重解的次数;空=默认4', type: 'number', default: '', min: 1 };
const Z_SLIDER_GAPMODE: EngineField = { key: 'sliderGapMode', label: '滑块缺口识别策略', hint: '缺口位置怎么定:默认=本地饱和度认读 + CapSolver 交叉验证(一致才高置信,分歧走 CapSolver 不回归基线);分歧优先本地=信本地(CapSolver 距离常偏时用,真机 A/B 哪个登录成功率高就留哪个);纯 CapSolver=只用 CapSolver(对照);★CapSolver 验证交付=最终拖 CapSolver 的值,但用本地精准检测当裁判,两者一致才提交、否则刷新重取(实测「只有 CapSolver 值能过」时选它,过滤掉 CapSolver 的垃圾值)', type: 'select', default: '', options: [
  { value: '', label: '默认 · 本地+CapSolver 交叉(推荐)' },
  { value: 'capsolver-verified', label: '★CapSolver 验证交付(本地当裁判,一致才提交 Cap 值)' },
  { value: 'local-first', label: '分歧时优先本地认读(A/B 测)' },
  { value: 'pure-capsolver', label: '纯 CapSolver(对照)' },
] };
const Z_SLIDER_MINCONF: EngineField = { key: 'sliderLocalMinConf', label: '本地认读置信阈值', hint: '本地认读置信≥此值才在分歧时采信;空=默认2.5。调高=更保守(更倾向 CapSolver)', type: 'number', default: '', min: 0, step: 0.5 };
const Z_SLIDER_VERIFY_TOL: EngineField = { key: 'sliderVerifyTol', label: '验证交付·一致容差(px)', hint: '仅「CapSolver 验证交付」模式用:CapSolver 值与本地精准值相差 ≤ 此像素才算一致、提交 Cap 值;空=默认6', type: 'number', default: '', min: 1, step: 1 };
const Z_SLIDER_VERIFY_REFRESH: EngineField = { key: 'sliderVerifyMaxRefresh', label: '验证交付·求一致刷新上限', hint: '仅「CapSolver 验证交付」模式用:CapSolver 与本地不一致时最多刷新换图几次求一致,超过则兜底交付本地精准值;空=默认3', type: 'number', default: '', min: 0, step: 1 };

export const ENGINE_FIELDS: Record<EngineKey, EngineField[]> = {
  playwright: [
    { key: 'cardFillEngine', label: '填卡方式', hint: '一般保持「自动」即可,其余为实验项', type: 'select', default: 'playwright', options: [
      { value: 'playwright', label: '自动(推荐,适用绝大多数情况)' }, { value: 'playwright,osinput', label: '自动 → 系统输入(兜底,实验)' },
      { value: 'osinput', label: '系统键盘输入(实验)' }, { value: 'extension', label: '浏览器扩展(需预装,实验)' },
      { value: 'selenium', label: 'Selenium(冗余,实验)' }, { value: 'api', label: 'API 直连(实验)' },
    ] },
    { key: 'manualCaptcha', label: '验证码转人工', hint: '自动解不出时转人工(需开「显示浏览器窗口」)', type: 'bool', default: false },
    { key: 'manualBilling', label: '加卡转人工', hint: '自动加卡没成时转人工(需开「显示浏览器窗口」)', type: 'bool', default: false },
    { key: 'manualCardPick', label: '手动选卡', hint: '付款页弹卡池面板手动点选(需开「显示浏览器窗口」)', type: 'bool', default: false },
    { key: 'skipDirtyIp', label: '高风险网络跳过加卡', hint: '代理/机房类 IP(易被银行拒)时跳过加卡,默认关', type: 'bool', default: false },
  ],
  // GLM 纯 selenium(run.py→pipeline.py):创建 Key + 订阅(套餐/周期/真扣) + 自动重试 + 滑块校准 + 环境保留。
  selenium: [Z_DOAPIKEY, Z_DOSUB, Z_PLAN, Z_CYCLE, Z_REALCHARGE, Z_CHARGECNT, Z_LIMITCAP, F_AUTORETRY, F_AUTORETRY_N, F_NODEL, Z_SLIDER_GAPMODE, Z_SLIDER_MINCONF, Z_SLIDER_VERIFY_TOL, Z_SLIDER_VERIFY_REFRESH, Z_SLIDER_SCALE, Z_SLIDER_OFFSET, Z_SLIDER_ATT],
  hybrid: [F_SOLVE, F_DEADLINE, F_FUTILE, F_SWAPS, F_HC_RECHECK, F_RESULT_WAIT, F_SAVECARD, ...HS_ROTATE, ...HS_ENVLIFE, F_NODEL, F_CARD_STRATEGY, F_ZIP_RETRY, F_CARD_FILL],
  split: [F_SOLVE, F_DEADLINE, F_FUTILE, F_SWAPS, F_HC_RECHECK, F_RESULT_WAIT, F_SAVECARD, F_STALL, F_AUTORETRY, F_AUTORETRY_N, ...HS_ROTATE, ...HS_ENVLIFE, F_NODEL,
    { key: 'splitRatio', label: '两套方案分配比例', hint: '0–1,如 0.5 表示一半 Selenium、一半混合', type: 'number', default: '0.5', min: 0, max: 1, step: 0.1 },
    { key: 'crossHandoff', label: '跨引擎衔接重试', hint: '第一轮分流后,把「纯Selenium取key向导卡死」的号转混合、把「混合加卡人机验证打不过」的号转纯Selenium,各号最多两引擎各试一次', type: 'bool', default: true },
    F_WIZ_PAY, F_WIZ_CREDIT, F_CARD_STRATEGY, F_ZIP_RETRY, F_CARD_FILL,
  ],
};

// schema 默认值(用于未加载/缺字段时兜底,等于重构前各引擎默认参数)。
export function engineDefaults(engine: EngineKey): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of ENGINE_FIELDS[engine]) out[f.key] = f.default;
  return out;
}

// 取某引擎"激活预设"的 opts;缺字段用 schema 默认兜底。供 buildPayload/buildRunPayload 取值。
export function engineActiveOpts(
  configs: { engines?: Record<string, { activeId: string; presets: { id: string; opts: Record<string, string | boolean> }[] }> } | undefined,
  engine: EngineKey,
): Record<string, string | boolean> {
  const en = configs?.engines?.[engine];
  const preset = en ? (en.presets.find((p) => p.id === en.activeId) || en.presets[0]) : undefined;
  return { ...engineDefaults(engine), ...(preset?.opts || {}) };
}
