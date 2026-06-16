'use strict';

// 失败策略单一来源回归测试（browser-free）。验证 6 个决策谓词的判定表不被误改。
const test = require('node:test');
const assert = require('node:assert');
const fp = require('../failure-policy');

const R = (reason) => ({ finalReason: reason });

test('isBlacklistFailure: 注册被拒/IP封/验证码限流 → 黑名单', () => {
  for (const r of ['SIGNUP_REJECTED', 'DREAMINA_SIGNUP_REJECTED', 'SIGNUP_REJECTED_IP_BANNED', 'VERIFICATION_CODE_RATE_LIMITED']) {
    assert.equal(fp.isBlacklistFailure(R(r)), true, r);
  }
  assert.equal(fp.isBlacklistFailure(R('PROXY_CONNECTIVITY_FAILED')), false);
});

test('isAccountRetryFailure: 偶发代理/环境失败 → 可重试；黑名单/终止业务失败 → 不重试', () => {
  assert.equal(fp.isAccountRetryFailure(R('PROXY_CONNECTIVITY_FAILED')), true);
  assert.equal(fp.isAccountRetryFailure(R('DREAMINA_WHITE_SCREEN')), true);
  assert.equal(fp.isAccountRetryFailure(R('CREDENTIAL_SUBMIT_RESULT_UNKNOWN')), true);
  assert.equal(fp.isAccountRetryFailure(R('SIGNUP_REJECTED')), false, '黑名单不进重试');
  assert.equal(fp.isAccountRetryFailure(R('ACCOUNT_ALREADY_EXISTS')), false, '已存在是终止业务失败');
});

test('isTerminalBusinessFailure: 已存在/拒绝/限流/已知存在 → 终止', () => {
  for (const r of ['ACCOUNT_ALREADY_EXISTS', 'SIGNUP_REJECTED', 'VERIFICATION_CODE_RATE_LIMITED', 'KNOWN_EXISTS_ACCOUNT_SKIPPED']) {
    assert.equal(fp.isTerminalBusinessFailure(R(r)), true, r);
  }
  assert.equal(fp.isTerminalBusinessFailure(R('PROXY_PRECHECK_BAD')), false);
});

test('shouldRetryAccountWithNextProxy: 受 maxProxyRetriesPerAccount 限制', () => {
  const ctx = { config: { maxProxyRetriesPerAccount: 2 } };
  assert.equal(fp.shouldRetryAccountWithNextProxy(R('PROXY_CONNECTIVITY_FAILED'), 1, ctx), true);
  assert.equal(fp.shouldRetryAccountWithNextProxy(R('PROXY_CONNECTIVITY_FAILED'), 2, ctx), false, '到上限不再重试');
  assert.equal(fp.shouldRetryAccountWithNextProxy(R('SIGNUP_REJECTED'), 1, ctx), false, '终止业务失败不换代理');
});

test('黑名单与重试集合互斥（无重叠误判）', () => {
  for (const r of ['SIGNUP_REJECTED', 'VERIFICATION_CODE_RATE_LIMITED']) {
    assert.equal(fp.isBlacklistFailure(R(r)) && fp.isAccountRetryFailure(R(r)), false, r + ' 不应同时黑名单+重试');
  }
});

test('保留粗粒度分类导出（与决策谓词并存于同一文件）', () => {
  for (const fn of ['isProxyHardFailure', 'isBusinessFailure', 'classifyFailure', 'createFailureClassifier']) {
    assert.equal(typeof fp[fn], 'function', fn);
  }
});
