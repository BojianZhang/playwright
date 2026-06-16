'use strict';

// ═══════════════════════════════════════════════════════════════════════
// CLI 支付旗标 → env 覆盖（S7/S8 adapter 读 env；CLI > config.json）。
//
// 文件定位：Dreamina/0.0.4/playwright/cli-billing-flags.js
//
// 在 register CLI / batch-runner 入口处尽早调用 applyBillingFlags()，把
// 支付相关命令行旗标翻译成 DREAMINA_* 环境变量——S7-upgrade / S8-payment 的
// adapter 在 loadXxxConfig() 里读取这些 env，从而覆盖 config.json 默认值。
//
//   --dry-run        DREAMINA_REAL_CHARGE=0       （填完卡不点 Pay，零成本验证）
//   --no-upgrade     DREAMINA_UPGRADE_ENABLED=0
//   --no-billing     DREAMINA_BILLING_ENABLED=0
//   --plan <P>       DREAMINA_UPGRADE_PLAN=<P>     （Free|Basic|Standard|Advanced）
//   --tab <T>        DREAMINA_UPGRADE_TAB=<T>      （Yearly|Monthly|1-month）
//   --amount <N>     DREAMINA_BILLING_AMOUNT=<N>
//   --card-engine <E> DREAMINA_CARD_FILL_ENGINE=<E>（如 playwright,osinput）
// ═══════════════════════════════════════════════════════════════════════

function applyBillingFlags(argv = process.argv.slice(2)) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const has = (f) => list.includes(f);
  const val = (f) => {
    const i = list.indexOf(f);
    if (i >= 0 && i + 1 < list.length && !String(list[i + 1]).startsWith('--')) return list[i + 1];
    // 同时支持 --flag=value 形式
    const kv = list.find((a) => a.startsWith(f + '='));
    return kv ? kv.slice(f.length + 1) : null;
  };

  if (has('--dry-run')) process.env.DREAMINA_REAL_CHARGE = '0';
  if (has('--real-charge')) process.env.DREAMINA_REAL_CHARGE = '1';
  if (has('--no-upgrade')) process.env.DREAMINA_UPGRADE_ENABLED = '0';
  if (has('--no-billing')) process.env.DREAMINA_BILLING_ENABLED = '0';

  const plan = val('--plan'); if (plan) process.env.DREAMINA_UPGRADE_PLAN = plan;
  const tab = val('--tab'); if (tab) process.env.DREAMINA_UPGRADE_TAB = tab;
  const amount = val('--amount'); if (amount) process.env.DREAMINA_BILLING_AMOUNT = amount;
  const engine = val('--card-engine'); if (engine) process.env.DREAMINA_CARD_FILL_ENGINE = engine;

  return {
    realCharge: process.env.DREAMINA_REAL_CHARGE,
    upgradeEnabled: process.env.DREAMINA_UPGRADE_ENABLED,
    billingEnabled: process.env.DREAMINA_BILLING_ENABLED,
    plan: process.env.DREAMINA_UPGRADE_PLAN,
    tab: process.env.DREAMINA_UPGRADE_TAB,
    amount: process.env.DREAMINA_BILLING_AMOUNT,
  };
}

module.exports = { applyBillingFlags };
