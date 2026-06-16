// recovery-schema 纯函数回归(零依赖,node:test)。跑: cd web && node --test  或 npm test
// 守两条承重不变量:
//   ① recoveryEnvJson 输出【逐字节不变】—— 加任何【动作】字段(ACTION_FIELDS)绝不泄漏进 OPENROUTER_RECOVERY_JSON
//      (否则破坏「默认逐字节不变」+ 把动作误当重试开关喂给 Python common/recovery.py)。
//   ② recoveryResumeOptions 把动作字段 → 批量恢复 recoverOptions 的映射(空串=省略=默认等价)。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rs = require('./recovery-schema');

test('recoveryEnvJson(DEFAULTS): 锁定生产字节串(retry.* 全 on,无任何动作字段)', () => {
  assert.strictEqual(
    rs.recoveryEnvJson(rs.DEFAULTS),
    '{"retry":{"retryRegister":"on","retryKey":"on","retryCard":"on","retryCharge":"on"}}',
  );
});

test('recoveryEnvJson: 加任意动作字段输出逐字节不变(动作绝不泄漏进 retry JSON)', () => {
  const base = { retryRegister: 'on', retryKey: 'on', retryCard: 'on', retryCharge: 'on' };
  const withActions = { ...base, ipRounds: '3', zipRetry: '2', cardStrategy: 'spread', swapOnHcaptcha: 'on' };
  assert.strictEqual(rs.recoveryEnvJson(withActions), rs.recoveryEnvJson(base));
  // 也别把未知键带进去
  assert.strictEqual(rs.recoveryEnvJson({ ...base, bogusKey: 'x' }), rs.recoveryEnvJson(base));
});

test('recoveryEnvJson: retry 某项关掉如实序列化(不受动作字段影响)', () => {
  assert.strictEqual(
    rs.recoveryEnvJson({ retryRegister: 'on', retryKey: 'on', retryCard: 'off', retryCharge: 'on', ipRounds: '5' }),
    '{"retry":{"retryRegister":"on","retryKey":"on","retryCard":"off","retryCharge":"on"}}',
  );
});

test('KEYS / DEFAULTS 覆盖动作字段(savePreset 白名单能收;默认全空=不注入)', () => {
  for (const k of ['ipRounds', 'zipRetry', 'cardStrategy', 'swapOnHcaptcha']) {
    assert.ok(rs.KEYS.has(k), `KEYS 应含动作字段 ${k}`);
    assert.strictEqual(rs.DEFAULTS[k], '', `动作字段 ${k} 默认应为空串(= 不注入,默认等价)`);
  }
  // retry.* 默认仍全 on
  for (const k of ['retryRegister', 'retryKey', 'retryCard', 'retryCharge']) assert.strictEqual(rs.DEFAULTS[k], 'on');
});

test('recoveryResumeOptions: 全空 → {}(默认弹窗行为等价,不注入任何动作)', () => {
  assert.deepStrictEqual(rs.recoveryResumeOptions(rs.DEFAULTS), {});
  assert.deepStrictEqual(rs.recoveryResumeOptions({}), {});
  assert.deepStrictEqual(rs.recoveryResumeOptions(undefined), {});
});

test('recoveryResumeOptions: ipRounds → autoRetryFailed+autoRetryTimes,clamp 5', () => {
  assert.deepStrictEqual(rs.recoveryResumeOptions({ ipRounds: '3' }), { autoRetryFailed: true, autoRetryTimes: 3 });
  assert.deepStrictEqual(rs.recoveryResumeOptions({ ipRounds: '9' }), { autoRetryFailed: true, autoRetryTimes: 5 });
  assert.deepStrictEqual(rs.recoveryResumeOptions({ ipRounds: '0' }), {}, '0 轮=不开自动重试');
  assert.deepStrictEqual(rs.recoveryResumeOptions({ ipRounds: '' }), {});
});

test('recoveryResumeOptions: zipRetry(0 有效,空省略)', () => {
  assert.deepStrictEqual(rs.recoveryResumeOptions({ zipRetry: '0' }), { zipRetry: 0 }, '0 是有效值,不省略');
  assert.deepStrictEqual(rs.recoveryResumeOptions({ zipRetry: '3' }), { zipRetry: 3 });
  assert.deepStrictEqual(rs.recoveryResumeOptions({ zipRetry: '' }), {});
  assert.deepStrictEqual(rs.recoveryResumeOptions({ zipRetry: 'abc' }), {}, '非数字省略');
});

test('recoveryResumeOptions: cardStrategy 枚举(非法/空省略)', () => {
  assert.deepStrictEqual(rs.recoveryResumeOptions({ cardStrategy: 'spread' }), { cardStrategy: 'spread' });
  assert.deepStrictEqual(rs.recoveryResumeOptions({ cardStrategy: 'random' }), { cardStrategy: 'random' });
  assert.deepStrictEqual(rs.recoveryResumeOptions({ cardStrategy: 'bogus' }), {});
  assert.deepStrictEqual(rs.recoveryResumeOptions({ cardStrategy: '' }), {});
});

test('recoveryResumeOptions: swapOnHcaptcha 三态(on→swap;off/空省略,不强制改源)', () => {
  assert.deepStrictEqual(rs.recoveryResumeOptions({ swapOnHcaptcha: 'on' }), { solveHcaptcha: 'swap' });
  assert.deepStrictEqual(rs.recoveryResumeOptions({ swapOnHcaptcha: 'off' }), {}, 'off=继承源,省略不强制');
  assert.deepStrictEqual(rs.recoveryResumeOptions({ swapOnHcaptcha: '' }), {});
});

test('recoveryResumeOptions: 组合(换环境内置方案口径)', () => {
  // r_swap_env = { zipRetry:'3', ipRounds:'2' }(+ retry.* all on,不进 resumeOptions)
  assert.deepStrictEqual(
    rs.recoveryResumeOptions({ retryRegister: 'on', retryCharge: 'on', zipRetry: '3', ipRounds: '2' }),
    { autoRetryFailed: true, autoRetryTimes: 2, zipRetry: 3 },
  );
  // r_swap_card = { cardStrategy:'spread', swapOnHcaptcha:'on', ipRounds:'1' }
  assert.deepStrictEqual(
    rs.recoveryResumeOptions({ cardStrategy: 'spread', swapOnHcaptcha: 'on', ipRounds: '1' }),
    { autoRetryFailed: true, autoRetryTimes: 1, cardStrategy: 'spread', solveHcaptcha: 'swap' },
  );
});
