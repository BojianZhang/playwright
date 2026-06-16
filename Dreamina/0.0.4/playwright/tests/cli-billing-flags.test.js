'use strict';

// CLI 支付旗标 → env 覆盖回归（CLI > config）。每个用例隔离 env。
const test = require('node:test');
const assert = require('node:assert');
const { applyBillingFlags } = require('../cli-billing-flags');

const BILLING_ENVS = ['DREAMINA_REAL_CHARGE', 'DREAMINA_UPGRADE_ENABLED', 'DREAMINA_BILLING_ENABLED', 'DREAMINA_UPGRADE_PLAN', 'DREAMINA_UPGRADE_TAB', 'DREAMINA_BILLING_AMOUNT', 'DREAMINA_CARD_FILL_ENGINE'];
function clearEnv() { for (const k of BILLING_ENVS) delete process.env[k]; }

test('--dry-run → DREAMINA_REAL_CHARGE=0', () => {
  clearEnv();
  applyBillingFlags(['--dry-run']);
  assert.equal(process.env.DREAMINA_REAL_CHARGE, '0');
});

test('--plan/--tab/--amount → 对应 env', () => {
  clearEnv();
  applyBillingFlags(['--plan', 'Standard', '--tab', 'Monthly', '--amount', '42']);
  assert.equal(process.env.DREAMINA_UPGRADE_PLAN, 'Standard');
  assert.equal(process.env.DREAMINA_UPGRADE_TAB, 'Monthly');
  assert.equal(process.env.DREAMINA_BILLING_AMOUNT, '42');
});

test('--no-upgrade / --no-billing → 关闭开关', () => {
  clearEnv();
  applyBillingFlags(['--no-upgrade', '--no-billing']);
  assert.equal(process.env.DREAMINA_UPGRADE_ENABLED, '0');
  assert.equal(process.env.DREAMINA_BILLING_ENABLED, '0');
});

test('--flag=value 形式也支持', () => {
  clearEnv();
  applyBillingFlags(['--plan=Basic', '--amount=18']);
  assert.equal(process.env.DREAMINA_UPGRADE_PLAN, 'Basic');
  assert.equal(process.env.DREAMINA_BILLING_AMOUNT, '18');
});

test('无支付旗标 → 不污染 env（保留 config 默认）', () => {
  clearEnv();
  applyBillingFlags(['--concurrency', '4', '--headed']);
  for (const k of BILLING_ENVS) assert.equal(process.env[k], undefined, k + ' 不应被设置');
});

test('--real-charge 显式开启', () => {
  clearEnv();
  applyBillingFlags(['--real-charge']);
  assert.equal(process.env.DREAMINA_REAL_CHARGE, '1');
});
