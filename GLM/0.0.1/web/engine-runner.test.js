// engine-runner 纯函数回归测试(零依赖,Node 内置 node:test)。
// 跑: cd web && node --test    或  npm test
// 覆盖 z.ai 承重纯函数:成功判定 / 拉黑 / 去重 / 订阅结果归一 / 结果行映射 / 失败真因 / 结果行解析。
const test = require('node:test');
const assert = require('node:assert');
const er = require('./engine-runner');

test('isSuccessRow: auth/apikey/subscribe 逐节点 gate', () => {
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', apikey: true } }), true, '注册+创建key成功');
  assert.strictEqual(er.isSuccessRow({ ok: true, api_key: 'k1' }), true, '有 api_key 即算产出');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', apikey: false } }), false, '创建key失败→不算成功');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', apikey: true, subscribe: 'declined' } }), false, '订阅拒付→失败');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', apikey: true, subscribe: 'success' } }), true, '订阅成功→成功');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', apikey: true, subscribe: 'dryrun' } }), true, 'dry-run 视为通过');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'fail:SLIDER_FAIL' } }), false, '注册失败→失败');
  assert.strictEqual(er.isSuccessRow(null), false);
  assert.strictEqual(er.isSuccessRow({}), false);
});

test('isNotAllowed: 三判据', () => {
  assert.strictEqual(er.isNotAllowed({ not_allowed: true }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { auth: 'fail:NOT_ALLOWED' } }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { banned: 'not-allowed' } }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { auth: 'ok' } }), false);
  assert.strictEqual(er.isNotAllowed(null), false);
});

test('dedupBySuccess: 成功恒胜失败,同态取 at 最近', () => {
  let { rows, collapsed } = er.dedupBySuccess([
    { email: 'a@x.com', ok: false, at: '1', steps: { subscribe: 'declined' } },
    { email: 'a@x.com', ok: true, at: '2', api_key: 'k1', steps: { auth: 'ok', apikey: true } },
  ]);
  assert.strictEqual(rows.length, 1); assert.strictEqual(collapsed, 1);
  assert.strictEqual(er.isSuccessRow(rows[0]), true); assert.strictEqual(rows[0].api_key, 'k1');

  ({ rows } = er.dedupBySuccess([
    { email: 'b@x.com', at: '1', ok: true, steps: { auth: 'ok', apikey: true, subscribe: 'success' } },
    { email: 'b@x.com', ok: false, at: '2', steps: { auth: 'ok', apikey: false } },
  ]));
  assert.strictEqual(rows.length, 1); assert.strictEqual(er.isSuccessRow(rows[0]), true, '成功后迟到失败不许降级');

  ({ rows } = er.dedupBySuccess([
    { email: 'c@x.com', ok: false, at: '1', steps: { auth: 'fail:A' } },
    { email: 'c@x.com', ok: false, at: '2', steps: { auth: 'fail:B' } },
  ]));
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].steps.auth, 'fail:B');
});

test('purchaseOutcome(订阅结果归一): success/failed/dry-run/skipped/not-attempted', () => {
  assert.strictEqual(er.purchaseOutcome({ steps: { apikey: true } }).status, 'not-attempted', '没订阅 → not-attempted');
  assert.strictEqual(er.purchaseOutcome({}).status, 'not-attempted');
  assert.strictEqual(er.purchaseOutcome({ steps: { subscribe: 'success' }, subscribed: 64.8 }).status, 'success');
  assert.strictEqual(er.purchaseOutcome({ steps: { subscribe: 'success' }, subscribed: 64.8 }).amount, 64.8);
  assert.strictEqual(er.purchaseOutcome({ subscribed: 30 }).status, 'success', 'subscribed>0 即成功');
  assert.strictEqual(er.purchaseOutcome({ steps: { subscribe: 'declined' } }).status, 'failed');
  assert.strictEqual(er.purchaseOutcome({ steps: { subscribe: 'declined' } }).reason, 'declined');
  assert.strictEqual(er.purchaseOutcome({ steps: { subscribe: 'invalid-amount' } }).label, '金额非法');
  assert.strictEqual(er.purchaseOutcome({ steps: { subscribe: 'dryrun' } }).status, 'dry-run');
  assert.strictEqual(er.purchaseOutcome({ skipped_subscribe: true, subscribed: 30 }).status, 'skipped');
});

test('handoffTarget: GLM 单引擎 → 恒 null', () => {
  assert.strictEqual(er.handoffTarget({ steps: { apikey: false } }, 'selenium'), null);
  assert.strictEqual(er.handoffTarget({ ok: true }, 'selenium'), null);
});

test('mapRow 成功行: apiKey/plan/cycle/subscribeStatus/subscribed', () => {
  const acc = new Map([['a@x.com', 'origpw']]);
  const [kind, row] = er.mapRow({ email: 'a@x.com', ok: true, api_key: 'k1', api_key_name: 'erhsh', plan: 'max', cycle: 'monthly', subscribed: 144, steps: { auth: 'ok', apikey: true, subscribe: 'success' }, card_last4: '9065', proxy: '1.2.3.4:9' }, acc);
  assert.strictEqual(kind, 'success');
  assert.strictEqual(row.apiKey, 'k1');
  assert.strictEqual(row.apiKeyName, 'erhsh');
  assert.strictEqual(row.plan, 'max');
  assert.strictEqual(row.cycle, 'monthly');
  assert.strictEqual(row.subscribed, 144);
  assert.strictEqual(row.subscribeStatus, 'subscribed');
  assert.strictEqual(row.paymentStatus, 'success');
  assert.strictEqual(row.cardLast4, '9065');
  assert.strictEqual(row.exitIp, '1.2.3.4');
});

test('mapRow subscribeStatus 阶梯: registered<apikey<subscribed', () => {
  const acc = new Map();
  const ss = (r) => er.mapRow(r, acc)[1].subscribeStatus;
  assert.strictEqual(ss({ email: 'a@x.com', ok: true, steps: { auth: 'ok', apikey: true }, api_key: 'k1' }), 'apikey', '只创建key → apikey 等级');
  assert.strictEqual(ss({ email: 'a@x.com', ok: true, api_key: 'k1', subscribed: 30, steps: { auth: 'ok', apikey: true, subscribe: 'success' } }), 'subscribed', '订阅成功 → subscribed 等级');
});

test('mapRow 失败行: reason=真因, 现/原密码, blacklisted', () => {
  const acc = new Map([['b@x.com', 'origpw']]);
  const [kind, row] = er.mapRow({ email: 'b@x.com', steps: { auth: 'ok', apikey: false }, key_reason: 'KEY_NOT_CAPTURED' }, acc);
  assert.strictEqual(kind, 'failed');
  assert.strictEqual(row.password, 'origpw', '无 res.password 回退原密码');
  assert.strictEqual(row.stage, 'apikey');
  const [, urow] = er.mapRow({ email: 'b@x.com', password: '@Unified2026', steps: { auth: 'ok', apikey: false } }, acc);
  assert.strictEqual(urow.password, '@Unified2026');
  assert.strictEqual(urow.originalPassword, 'origpw');
  const [, brow] = er.mapRow({ email: 'b@x.com', not_allowed: true, steps: { auth: 'fail:NOT_ALLOWED' } }, acc);
  assert.strictEqual(brow.blacklisted, true);
  assert.strictEqual(brow.blacklistReason, 'ACCOUNT_NOT_ALLOWED');
});

test('pyFailReason: 各失败态映射', () => {
  assert.strictEqual(er.pyFailReason({ fail_reason: 'SLIDER_FAIL' }), 'SLIDER_FAIL', 'pipeline 已归因优先用');
  assert.strictEqual(er.pyFailReason({ steps: { auth: 'fail:NO_SIGNUP_FORM' } }), 'fail:NO_SIGNUP_FORM');
  assert.strictEqual(er.pyFailReason({ steps: { auth: 'ok', apikey: false }, key_reason: 'KEY_NOT_CAPTURED' }), 'apikey:KEY_NOT_CAPTURED');
  assert.strictEqual(er.pyFailReason({ steps: { auth: 'ok', apikey: true, subscribe: 'declined' } }), 'subscribe:declined');
  assert.strictEqual(er.pyFailReason({ not_allowed: true, steps: {} }), 'ACCOUNT_NOT_ALLOWED');
});

test('parseResultLine: 实时判定与 isSuccessRow 同口径(apikey bool / subscribe)', () => {
  const P = (line) => er.parseResultLine(line);
  assert.strictEqual(P("════ 结果 alice ok=false steps={'auth': 'ok', 'apikey': True, 'subscribe': 'declined'}").ok, false, '订阅declined→失败');
  assert.strictEqual(P("════ 结果 bob ok=true steps={'auth': 'ok', 'apikey': True}").ok, true, '纯创建key成功');
  assert.strictEqual(P("════ 结果 carol ok=true steps={'auth': 'ok', 'apikey': False}").ok, false, 'apikey False→失败(纠正)');
  assert.strictEqual(P("════ 结果 dave ok=false steps={'auth': 'fail:SLIDER_FAIL'}").ok, false);
  assert.strictEqual(P("════ 结果 grace ok=true steps={'auth': 'ok', 'apikey': True, 'subscribe': 'success'}").ok, true);
  assert.strictEqual(P("════ 结果 heidi ok=true steps={'auth': 'ok', 'apikey': True, 'subscribe': 'dryrun'}").ok, true, 'dry-run→成功');
  assert.strictEqual(P("[Selenium] 启动中…"), null);
});

test('reasonFromLine: 提取真因', () => {
  assert.strictEqual(er.reasonFromLine("════ 结果 a ok=false steps={'auth': 'fail:NO_SIGNUP_FORM'}"), 'fail:NO_SIGNUP_FORM');
  assert.strictEqual(er.reasonFromLine("════ 结果 b ok=false steps={'auth': 'ok', 'apikey': False}"), 'apikey:false');
  assert.strictEqual(er.reasonFromLine("════ 结果 c ok=false steps={'auth': 'ok', 'apikey': True, 'subscribe': 'declined'}"), 'subscribe:declined');
  assert.strictEqual(er.reasonFromLine('════ d 结果 ok=false pw=...'), 'see-log');
  assert.notStrictEqual(er.reasonFromLine("steps={'subscribe': 'success'}"), 'subscribe:success');
});

test('classifyIncomplete: banned/坏邮箱/有key/已注册/未跑到', () => {
  const state = {
    banned: new Set(['banned@x.com']),
    badMail: new Set(['bad@y.com', '@deaddomain.com']),
    progress: {
      'haskey@x.com': { api_key: 'k1', registered: true },
      'reg@x.com': { registered: true },
    },
  };
  assert.strictEqual(er.classifyIncomplete('banned@x.com', state).status, 'banned');
  assert.strictEqual(er.classifyIncomplete('bad@y.com', state).status, 'bad-mailbox');
  assert.strictEqual(er.classifyIncomplete('someone@deaddomain.com', state).status, 'bad-mailbox', '整域 404');
  assert.strictEqual(er.classifyIncomplete('haskey@x.com', state).status, 'incomplete');
  assert.match(er.classifyIncomplete('haskey@x.com', state).reason, /Key/);
  assert.match(er.classifyIncomplete('reg@x.com', state).reason, /已注册/);
  assert.strictEqual(er.classifyIncomplete('never@x.com', state).status, 'not-run');
  assert.strictEqual(er.classifyIncomplete('', null).status, 'not-run');
});
