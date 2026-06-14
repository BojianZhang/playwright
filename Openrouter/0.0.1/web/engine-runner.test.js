// engine-runner 纯函数回归测试(零依赖,Node 内置 node:test;契合 web 零依赖CJS 铁律)。
// 跑: cd web && node --test    或  npm test
// 覆盖的都是本会话反复出过 bug 的"承重"纯函数:成功判定 / 拉黑判定 / 跨引擎衔接 / 结果行映射 / 失败真因。
const test = require('node:test');
const assert = require('node:assert');
const er = require('./engine-runner');

test('isSuccessRow: ok=true 或 steps.card===card-bound 都算成功', () => {
  assert.strictEqual(er.isSuccessRow({ ok: true }), true);
  assert.strictEqual(er.isSuccessRow({ steps: { card: 'card-bound' } }), true, '加卡绑成但没取key也算成功(与聚合对齐)');
  assert.strictEqual(er.isSuccessRow({ ok: false, steps: { card: 'declined' } }), false);
  assert.strictEqual(er.isSuccessRow({ steps: { key: true } }), false, '只取到key没绑卡不算最终成功');
  assert.strictEqual(er.isSuccessRow(null), false);
  assert.strictEqual(er.isSuccessRow({}), false);
});

test('isNotAllowed: 三判据(not_allowed / auth以NOT_ALLOWED结尾 / banned)', () => {
  assert.strictEqual(er.isNotAllowed({ not_allowed: true }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { auth: 'REGISTER_NOT_ALLOWED' } }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { banned: 'not-allowed' } }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { auth: 'ok' } }), false);
  assert.strictEqual(er.isNotAllowed(null), false);
});

test('handoffTarget: selenium取key败→hybrid;hybrid加卡hcaptcha→selenium;其余→null', () => {
  // 纯Sel 取key向导进了抓不到key(steps.key===false)→ 转 Playwright
  assert.strictEqual(er.handoffTarget({ steps: { auth: 'ok', key: false } }, 'selenium'), 'hybrid');
  // 纯Sel 其它失败(如注册败)不转
  assert.strictEqual(er.handoffTarget({ steps: { auth: 'fail:FORM_NOT_FILLED' } }, 'selenium'), null);
  // hybrid 加卡撞 hcaptcha 的三种标记 → 转纯Sel
  assert.strictEqual(er.handoffTarget({ steps: { card: 'hcaptcha' } }, 'hybrid'), 'selenium');
  assert.strictEqual(er.handoffTarget({ giveup_reason: 'hcaptcha' }, 'hybrid'), 'selenium');
  assert.strictEqual(er.handoffTarget({ card_hcaptcha: true }, 'hybrid'), 'selenium');
  // hybrid 其它失败(declined)不转
  assert.strictEqual(er.handoffTarget({ steps: { card: 'declined' } }, 'hybrid'), null);
  // 成功行不转;未知引擎不转
  assert.strictEqual(er.handoffTarget({ ok: true }, 'selenium'), null);
  assert.strictEqual(er.handoffTarget({ steps: { key: false } }, 'unknown-engine'), null);
});

test('mapRow 成功行: charged 多键名兜底 + billingStatus + passwordChanged', () => {
  const acc = new Map([['a@x.com', 'origpw']]);
  const [kind, row] = er.mapRow({ email: 'a@x.com', ok: true, api_key: 'sk-or-1', steps: { card: 'card-bound', changepw: true }, card_last4: '4242', charged: 5, proxy: '1.2.3.4:9' }, acc);
  assert.strictEqual(kind, 'success');
  assert.strictEqual(row.billingStatus, 'card-bound');
  assert.strictEqual(row.charged, 5);
  assert.strictEqual(row.passwordChanged, true);
  assert.strictEqual(row.cardLast4, '4242');
  assert.strictEqual(row.exitIp, '1.2.3.4', 'exitIp 取 proxy 的 host 段');
  // charged 兜底:无 charged 用 charge,再无→0
  assert.strictEqual(er.mapRow({ email: 'a@x.com', ok: true, charge: 3, steps: { card: 'card-bound' } }, acc)[1].charged, 3);
  assert.strictEqual(er.mapRow({ email: 'a@x.com', ok: true, steps: { card: 'card-bound' } }, acc)[1].charged, 0);
});

test('mapRow 失败行: reason=真因, blacklisted=拉黑判定, 密码回退原密码', () => {
  const acc = new Map([['b@x.com', 'origpw']]);
  const [kind, row] = er.mapRow({ email: 'b@x.com', steps: { auth: 'ok', key: false } }, acc);
  assert.strictEqual(kind, 'failed');
  assert.strictEqual(row.password, 'origpw', '失败行密码回退到输入的原密码');
  assert.strictEqual(row.reason, 'card:false' === row.reason ? row.reason : er.pyFailReason({ steps: { auth: 'ok', key: false } }));
  // 拉黑号
  const [, brow] = er.mapRow({ email: 'b@x.com', not_allowed: true, steps: { auth: 'REGISTER_NOT_ALLOWED' } }, acc);
  assert.strictEqual(brow.blacklisted, true);
  assert.strictEqual(brow.blacklistReason, 'ACCOUNT_NOT_ALLOWED');
});

test('pyFailReason: 各失败态映射', () => {
  assert.strictEqual(er.pyFailReason({ steps: { auth: 'fail:FORM_NOT_FILLED' } }), 'fail:FORM_NOT_FILLED');
  assert.strictEqual(er.pyFailReason({ steps: { card: 'declined' } }), 'card:declined');
  assert.strictEqual(er.pyFailReason({ steps: { pw: false, pw_reason: 'changepw-fail' } }), 'pw:changepw-fail');
  assert.strictEqual(er.pyFailReason({ not_allowed: true, steps: {} }), 'ACCOUNT_NOT_ALLOWED');
});

test('reasonFromLine: 从 stdout 结果行提取真因(替代 see-log 占位)', () => {
  // run.py 行内含 Python repr 的 steps
  assert.strictEqual(er.reasonFromLine("════ 结果 alice ok=false steps={'auth': 'fail:FORM_NOT_FILLED'}"), 'fail:FORM_NOT_FILLED');
  assert.strictEqual(er.reasonFromLine("════ 结果 bob ok=false steps={'auth': 'ok', 'key': False}"), 'key:false');
  assert.strictEqual(er.reasonFromLine("════ 结果 carol ok=false steps={'auth': 'ok', 'key': True, 'card': 'unknown'}"), 'card:unknown');
  // 提取不到 → 回退 see-log(无回归)
  assert.strictEqual(er.reasonFromLine('════ dave 结果 ok=false pw=...'), 'see-log');
  // card-bound 是成功态,不应被当失败真因
  assert.notStrictEqual(er.reasonFromLine("steps={'card': 'card-bound'}"), 'card:card-bound');
});
