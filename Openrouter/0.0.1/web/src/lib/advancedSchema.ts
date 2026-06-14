// 高级参数 schema(前端)— 渲染「高级参数」页 + 取值。
// ⚠️ 后端镜像 web/advanced-schema.js,key / env / 默认 必须一致。
// 边界:只放引擎配置页【没有的】全局/共用调优旋钮;每个标 scope = 作用于哪套执行流程。

export type AdvScope = 'selenium' | 'hybrid' | 'both';
export interface AdvField {
  key: string; env: string; label: string; hint: string;
  type: 'number' | 'text' | 'select'; scope: AdvScope; group: string;
  def: string; options?: string[];
}
export const SCOPE_LABEL: Record<AdvScope, string> = { selenium: '纯Selenium', hybrid: '混合', both: '两套共用' };
export const SCOPE_COLOR: Record<AdvScope, string> = { selenium: '#2563eb', hybrid: '#7c3aed', both: '#0d9488' };

export const ADV_FIELDS: AdvField[] = [
  // ── 提速总开关(默认关=与现状逐字节一致)──
  { key: 'fastMode', env: 'OPENROUTER_FAST', label: '提速模式 ★', hint: '空=关(默认,与现状完全一致);on=开:注册/登录省成功路径截图 + 把固定等待改成轮询提前退出(更快,不改成功判定/反检测)', type: 'select', scope: 'both', group: '提速', def: '', options: ['', 'on'] },
  // ── 取key(仅纯 Selenium;混合取key走 Playwright)──
  { key: 'wizardKeyDeadline', env: 'WIZARD_KEY_DEADLINE', label: '取key总死线(秒)', hint: '取key整体上限,到点放弃走整号重试(配合「取key卡死自救」)', type: 'number', scope: 'selenium', group: '取key', def: '150' },
  { key: 'wizardPayMode', env: 'WIZARD_PAY_MODE', label: '向导支付方式', hint: '向导"Add a payment method"步:填地址露卡表单 / 跳过 / 每号随机', type: 'select', scope: 'selenium', group: '取key', def: 'random', options: ['random', 'address', 'later'] },
  { key: 'wizardCreditMode', env: 'WIZARD_CREDIT_MODE', label: '向导积分(充值)', hint: '⚠ credits=真实扣款;默认 skip 跳过,谨慎改', type: 'select', scope: 'selenium', group: '取key', def: 'skip', options: ['skip', 'credits', 'random'] },
  // ── 邮箱验证(纯Selenium 注册读 Clerk 验证链接;收信慢/想快失败时调小)──
  { key: 'mailVerifyAttempts', env: 'MAIL_VERIFY_ATTEMPTS', label: '验证轮询次数/轮', hint: '每轮读验证链接的轮询次数(默认12);总耗≈重发轮数×本值×间隔+Resend≈196s,调小更快放弃', type: 'number', scope: 'selenium', group: '邮箱验证', def: '12' },
  { key: 'mailVerifyCycles', env: 'MAIL_VERIFY_CYCLES', label: '重发轮数', hint: '读不到就点 Resend 重发再轮询的轮数(默认3);设 1=只读一轮不重发=最快失败', type: 'number', scope: 'selenium', group: '邮箱验证', def: '3' },
  { key: 'mailVerifyInterval', env: 'MAIL_VERIFY_INTERVAL', label: '轮询间隔(秒)', hint: '每次读链接之间隔秒数(默认3)', type: 'number', scope: 'selenium', group: '邮箱验证', def: '3' },
  // ── 加卡 / Fix C 核(纯Selenium + 混合 都走)──
  { key: 'fixcSuccessHold', env: 'FIXC_SUCCESS_HOLD', label: '绑成展示停留(秒)', hint: '绑成后停留几秒让你看到再走;无人值守设 0 更快', type: 'number', scope: 'both', group: '加卡', def: '4' },
  { key: 'fixcZipDeadline', env: 'FIXC_ZIP_DEADLINE', label: 'ZIP重试死线(秒)', hint: 'declined 换 ZIP 重试同一张卡的总上限', type: 'number', scope: 'both', group: '加卡', def: '60' },
  { key: 'fixcIamhumanTries', env: 'FIXC_IAMHUMAN_TRIES', label: '点框尝试次数', hint: '弹 hCaptcha 点「I am human」复选框的最多次数', type: 'number', scope: 'both', group: '加卡', def: '30' },
  { key: 'cardSwapOnDecline', env: 'CARD_SWAP_ON_DECLINE', label: '拒付换卡张数', hint: 'declined 时换不同卡/不同 BIN 重试,最多换几张', type: 'number', scope: 'selenium', group: '加卡', def: '3' },
  { key: 'zipRetry', env: 'ZIP_RETRY', label: 'ZIP重试次数', hint: '留空=用代码内置默认', type: 'number', scope: 'selenium', group: '加卡', def: '' },
  { key: 'stripeReloadRetries', env: 'STRIPE_RELOAD_RETRIES', label: 'Stripe重载重试', hint: '卡表单没出时重载 Stripe.js 的次数;留空=代码默认', type: 'number', scope: 'selenium', group: '加卡', def: '' },
  // ── 驱动 / 环境(两套共用)──
  { key: 'maxConcurrency', env: 'OPENROUTER_MAX_CONCURRENCY', label: '并发硬上限 ★', hint: '防 AdsPower 批量掉线:任何 job 的每进程并发超过它都自动钳到它(无论控制台填多少),设一次以后都生效。留空=不限。建议先 4~6,稳了(无 session-deleted)再逐步往上加', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'selPageloadTimeout', env: 'SEL_PAGELOAD_TIMEOUT', label: '页面加载超时(秒)', hint: 'Selenium set_page_load_timeout;慢代理可调大;留空=代码默认', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'selScriptTimeout', env: 'SEL_SCRIPT_TIMEOUT', label: '脚本执行超时(秒)', hint: 'Selenium set_script_timeout;留空=代码默认', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'adsMaxLaunch', env: 'ADS_MAX_LAUNCH', label: 'AdsPower开浏览器并发上限', hint: '本地 API 开浏览器的限频;留空=代码默认', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'envScreenRes', env: 'ENV_SCREEN_RES', label: '环境分辨率', hint: '如 1280_720;留空=代码默认', type: 'text', scope: 'both', group: '驱动环境', def: '' },
  // ── 卡池(两套共用,载卡时 ledger 读)──
  { key: 'cardStrategy', env: 'CARD_STRATEGY', label: '卡池策略', hint: '如 concentrate(集中灌一张测容量);留空=默认', type: 'text', scope: 'both', group: '卡池', def: '' },
  { key: 'cardPreferBin', env: 'CARD_PREFER_BIN', label: '优先BIN', hint: '优先用某 BIN 的卡;留空=不限', type: 'text', scope: 'both', group: '卡池', def: '' },
  // ── 混合专属 ──
  { key: 'proxySegOctets', env: 'PROXY_SEG_OCTETS', label: '代理分段位数', hint: '混合:IP 分段去重的位数;留空=代码默认', type: 'number', scope: 'hybrid', group: '混合', def: '' },
  { key: 'proxyDiversify', env: 'PROXY_DIVERSIFY', label: '代理多样化', hint: '混合:换 IP 时尽量跨段;留空=代码默认', type: 'text', scope: 'hybrid', group: '混合', def: '' },
];

export const ADV_GROUPS = ['提速', '取key', '邮箱验证', '加卡', '驱动环境', '卡池', '混合'];
