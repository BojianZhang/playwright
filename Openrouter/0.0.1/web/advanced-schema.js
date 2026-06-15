'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 高级参数 schema(后端镜像)— Openrouter / web / advanced-schema.js
//
// ⚠️ 这是 src/lib/advancedSchema.ts 的后端镜像。改 key / env / 默认 时两边同步。
//
// 边界(和「引擎配置」零重叠):这里【只放引擎配置页没有的】全局/共用调优旋钮。
//   引擎专属 per-engine 的(solveHcaptcha/cardDeadline/hcRecheckWait/FIXC_RESULT_WAIT/WIZARD_STALL_REFRESH…)
//   留在 engine-schema,绝不在这里重复(否则同一参数两处能设=打架)。
// 每个字段标 scope = 作用于哪套执行流程:'selenium'(纯Selenium) / 'hybrid'(混合) / 'both'(两套共用)。
// 【关键】存的是用户【显式覆盖值】,不 seed 默认;envPatch 只注【非空】值 → 没设=不注入=Python 用代码内置默认,
//   绝不因为上了页面就改默认行为。
// ═══════════════════════════════════════════════════════════════════════

const FIELDS = [
  // ── 提速总开关(默认空=关=与现状逐字节一致;on=注册/登录提速:省成功截图 + 固定等待改轮询提前退出)──
  { key: 'fastMode', env: 'OPENROUTER_FAST', type: 'select', scope: 'both', group: '提速', def: '', options: ['', 'on'] },
  // ── 取key(仅纯 Selenium;混合取key走 Playwright,这些用不到)──────────────
  { key: 'wizardKeyDeadline', env: 'WIZARD_KEY_DEADLINE', type: 'number', scope: 'selenium', group: '取key', def: '150' },
  { key: 'wizardPayMode', env: 'WIZARD_PAY_MODE', type: 'select', scope: 'selenium', group: '取key', def: 'random',
    options: ['random', 'address', 'later'] },
  { key: 'wizardCreditMode', env: 'WIZARD_CREDIT_MODE', type: 'select', scope: 'selenium', group: '取key', def: 'skip',
    options: ['skip', 'credits', 'random'] },
  // ── 邮箱验证(纯Selenium 注册读 Clerk 魔法链接;收信慢/想快失败时调小,默认 3轮×12次×3s+Resend≈196s)──
  { key: 'mailVerifyAttempts', env: 'MAIL_VERIFY_ATTEMPTS', type: 'number', scope: 'selenium', group: '邮箱验证', def: '12' },
  { key: 'mailVerifyCycles', env: 'MAIL_VERIFY_CYCLES', type: 'number', scope: 'selenium', group: '邮箱验证', def: '3' },
  { key: 'mailVerifyInterval', env: 'MAIL_VERIFY_INTERVAL', type: 'number', scope: 'selenium', group: '邮箱验证', def: '3' },
  // ── 加卡 / Fix C 核(纯Selenium + 混合 都走 fixc_core)─────────────────────
  { key: 'fixcSuccessHold', env: 'FIXC_SUCCESS_HOLD', type: 'number', scope: 'both', group: '加卡', def: '4' },
  { key: 'fixcZipDeadline', env: 'FIXC_ZIP_DEADLINE', type: 'number', scope: 'both', group: '加卡', def: '60' },
  { key: 'fixcIamhumanTries', env: 'FIXC_IAMHUMAN_TRIES', type: 'number', scope: 'both', group: '加卡', def: '30' },
  { key: 'cardSwapOnDecline', env: 'CARD_SWAP_ON_DECLINE', type: 'number', scope: 'selenium', group: '加卡', def: '3' },
  { key: 'zipRetry', env: 'ZIP_RETRY', type: 'number', scope: 'selenium', group: '加卡', def: '' },
  { key: 'stripeReloadRetries', env: 'STRIPE_RELOAD_RETRIES', type: 'number', scope: 'selenium', group: '加卡', def: '' },
  // ── 驱动 / 环境(两套共用)────────────────────────────────────────────────
  // ★并发硬上限:engine-runner 起 job 时把任何引擎的每进程并发钳到 ≤ 它(防 AdsPower 高并发批量掉线);空=不限。
  { key: 'maxConcurrency', env: 'OPENROUTER_MAX_CONCURRENCY', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'selPageloadTimeout', env: 'SEL_PAGELOAD_TIMEOUT', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'selScriptTimeout', env: 'SEL_SCRIPT_TIMEOUT', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'adsMaxLaunch', env: 'ADS_MAX_LAUNCH', type: 'number', scope: 'both', group: '驱动环境', def: '' },
  { key: 'envScreenRes', env: 'ENV_SCREEN_RES', type: 'text', scope: 'both', group: '驱动环境', def: '' },
  // ── 卡池(两套共用,载卡时 ledger 读)──────────────────────────────────────
  { key: 'cardStrategy', env: 'CARD_STRATEGY', type: 'text', scope: 'both', group: '卡池', def: '' },
  { key: 'cardPreferBin', env: 'CARD_PREFER_BIN', type: 'text', scope: 'both', group: '卡池', def: '' },
  { key: 'cardBinDailyCap', env: 'CARD_BIN_DAILY_CAP', type: 'number', scope: 'both', group: '卡池', def: '' },
  // ── 充值 / 改密(计费收尾)──────────────────────────────────────────────────
  // 充值结果等待上限(秒):成功/拒付一般几十秒内判定;到点仍 unknown 才放弃。空=代码默认 90(原来死等 300s)。
  { key: 'purchaseWait', env: 'FIXC_PURCHASE_WAIT', type: 'number', scope: 'both', group: '充值改密', def: '90' },
  // 只在充值【确认成功】才改邮箱密码:空=关(取到key即改密,与现状逐字节一致);on=拒付/未成功跳过改密,保号可干净重试。
  { key: 'changepwRequirePurchase', env: 'CHANGEPW_REQUIRE_PURCHASE', type: 'select', scope: 'selenium', group: '充值改密', def: '', options: ['', 'on'] },
  // ── 混合专属 ──────────────────────────────────────────────────────────────
  { key: 'proxySegOctets', env: 'PROXY_SEG_OCTETS', type: 'number', scope: 'hybrid', group: '混合', def: '' },
  { key: 'proxyDiversify', env: 'PROXY_DIVERSIFY', type: 'text', scope: 'hybrid', group: '混合', def: '' },
];

const KEYS = new Set(FIELDS.map((f) => f.key));

// 只注【用户显式设了非空值】的 → 空=不注入=Python 用内置默认(绝不因上页面而改默认行为)。
function envPatch(stored) {
  const s = stored || {};
  const env = {};
  for (const f of FIELDS) {
    const v = s[f.key];
    if (v !== undefined && v !== null && String(v).trim() !== '') env[f.env] = String(v).trim();
  }
  return env;
}

module.exports = { FIELDS, KEYS, envPatch };
