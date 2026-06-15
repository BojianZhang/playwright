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

test('isSuccessRow: 每个关键节点以是否真成功为基准(绑卡/充值失败即使 ok=true 也不算成功)', () => {
  // ★用户实测病根:绑卡撞 hcaptcha 没绑成,但 pipeline 旧码 ok=true → 误算成功。现必须判失败。
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', key: true, card: 'hcaptcha' } }), false, 'hcaptcha 没绑成→失败');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', key: true, card: 'server-error' } }), false);
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', key: true, card: 'unknown' } }), false);
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', card: 'declined' } }), false);
  // 充值失败(pipeline:steps.purchase / hybrid:顶层 r.purchase)即使卡绑成也不算成功(do_purchase 开,待续跑补)
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { card: 'card-bound', purchase: 'declined' } }), false, 'pipeline 充值失败');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { card: 'card-bound' }, purchase: 'error' }), false, 'hybrid 顶层 purchase 失败');
  // 全成:卡绑成 + 充值成功 → 成功
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { card: 'card-bound', purchase: 'success' } }), true);
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { card: 'card-bound' }, purchase: 'success' }), true);
  // ★不误伤:card-bound 是成功标尺 → 即使 steps.key=false(key 经网络钩子抓到/后补)也算成功(既有语义)
  assert.strictEqual(er.isSuccessRow({ ok: false, steps: { auth: 'ok', key: false, card: 'card-bound' } }), true, 'card 绑成即成功,不被 key=false 误伤');
  // 纯取key模式(无 card 步)ok=true 仍算成功(不误伤);changepw 失败不降级(收尾维护步)
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'ok', key: true } }), true, '纯取key成功不误伤');
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { card: 'card-bound', changepw: false } }), true, 'changepw 失败不影响绑卡成功');
  // 注册失败一律失败
  assert.strictEqual(er.isSuccessRow({ ok: true, steps: { auth: 'fail:FORM_NOT_FILLED' } }), false);
});

test('isNotAllowed: 三判据(not_allowed / auth以NOT_ALLOWED结尾 / banned)', () => {
  assert.strictEqual(er.isNotAllowed({ not_allowed: true }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { auth: 'REGISTER_NOT_ALLOWED' } }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { banned: 'not-allowed' } }), true);
  assert.strictEqual(er.isNotAllowed({ steps: { auth: 'ok' } }), false);
  assert.strictEqual(er.isNotAllowed(null), false);
});

test('dedupBySuccess: 成功恒胜失败(success-wins),同态取 at 最近,折叠计数正确', () => {
  // ① 同号先 fail 后 success(AUTO_RETRY)→ 判成功,取成功行
  let { rows, collapsed } = er.dedupBySuccess([
    { email: 'a@x.com', ok: false, at: '1', steps: { card: 'declined' } },
    { email: 'a@x.com', ok: true, at: '2', api_key: 'sk-or-1' },
  ]);
  assert.strictEqual(rows.length, 1); assert.strictEqual(collapsed, 1);
  assert.strictEqual(er.isSuccessRow(rows[0]), true); assert.strictEqual(rows[0].api_key, 'sk-or-1');

  // ② 同号先 success 后【迟到 fail】(绑卡成功后 changepw 报错)→ 绝不降级,仍判成功
  ({ rows } = er.dedupBySuccess([
    { email: 'b@x.com', at: '1', steps: { card: 'card-bound' } },
    { email: 'b@x.com', ok: false, at: '2', steps: { changepw: 'err' } },
  ]));
  assert.strictEqual(rows.length, 1); assert.strictEqual(er.isSuccessRow(rows[0]), true, '成功后迟到失败不许把成功降级');

  // ③ 全失败 → 取 at 最近(保留最新真因)
  ({ rows } = er.dedupBySuccess([
    { email: 'c@x.com', ok: false, at: '1', steps: { auth: 'fail:A' } },
    { email: 'c@x.com', ok: false, at: '2', steps: { auth: 'fail:B' } },
  ]));
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].steps.auth, 'fail:B');

  // ④ 不同号互不影响 + 跳过无 email 行
  ({ rows, collapsed } = er.dedupBySuccess([
    { email: 'd@x.com', ok: true, at: '1' }, { email: 'e@x.com', ok: false, at: '1' }, { ok: true, at: '1' }, null,
  ]));
  assert.strictEqual(rows.length, 2); assert.strictEqual(collapsed, 0);
});

test('classifyIncomplete: 未完整号逐号归因(banned/坏邮箱/checkpoint阶段/未跑到)', () => {
  const state = {
    banned: new Set(['banned@x.com']),
    badMail: new Set(['bad@y.com', '@deaddomain.com']),
    progress: {
      'haskey@x.com': { api_key: 'sk-or-1', registered: true, billing_status: 'address-bound' },
      'addr@x.com': { registered: true, billing_status: 'address-bound' },
      'reg@x.com': { registered: true },
      'vague@x.com': { env_id: 'e1' },
    },
  };
  assert.strictEqual(er.classifyIncomplete('banned@x.com', state).status, 'banned', '被拒号');
  assert.strictEqual(er.classifyIncomplete('BANNED@x.com', state).status, 'banned', '大小写不敏感');
  assert.strictEqual(er.classifyIncomplete('bad@y.com', state).status, 'bad-mailbox', '整邮箱坏');
  assert.strictEqual(er.classifyIncomplete('someone@deaddomain.com', state).status, 'bad-mailbox', '整域 404 也算坏邮箱');
  assert.strictEqual(er.classifyIncomplete('haskey@x.com', state).status, 'incomplete');
  assert.match(er.classifyIncomplete('haskey@x.com', state).reason, /已取到 Key/);
  assert.match(er.classifyIncomplete('addr@x.com', state).reason, /address-bound/, '到加卡前的 checkpoint 阶段可见');
  assert.match(er.classifyIncomplete('reg@x.com', state).reason, /已注册/);
  assert.strictEqual(er.classifyIncomplete('vague@x.com', state).status, 'incomplete', 'checkpoint 有记录但阶段不明仍算 incomplete');
  // 三份状态都查不到 → not-run(本批没跑到/丢结果,可续跑)
  const nr = er.classifyIncomplete('never@x.com', state);
  assert.strictEqual(nr.status, 'not-run');
  assert.match(nr.reason, /可续跑/);
  // 空 state 不崩
  assert.strictEqual(er.classifyIncomplete('x@x.com', {}).status, 'not-run');
  assert.strictEqual(er.classifyIncomplete('', null).status, 'not-run');
});

test('purchaseOutcome: 充值结果明确归一(成功/失败/已充跳过/未充值),消除 charged=0 歧义', () => {
  // 未充值:do_purchase 关 / 没走到充值(无 purchase 信号、无 charged)→ not-attempted(不是 $0)
  assert.strictEqual(er.purchaseOutcome({ steps: { card: 'card-bound' } }).status, 'not-attempted', '只加卡未充值 → not-attempted');
  assert.strictEqual(er.purchaseOutcome({}).status, 'not-attempted');
  // 成功:纯Sel steps.purchase / 混合顶层 r.purchase / charged>0 任一
  assert.strictEqual(er.purchaseOutcome({ steps: { purchase: 'success' }, charged: 5 }).status, 'success');
  assert.strictEqual(er.purchaseOutcome({ purchase: 'success' }).status, 'success', '混合顶层 purchase');
  assert.strictEqual(er.purchaseOutcome({ charged: 5 }).status, 'success', 'charged>0 即成功');
  assert.strictEqual(er.purchaseOutcome({ steps: { purchase: 'success' }, charged: 5 }).amount, 5);
  // 失败:purchase 非 success 且非空 → failed 带真因
  assert.strictEqual(er.purchaseOutcome({ steps: { purchase: 'declined' } }).status, 'failed');
  assert.strictEqual(er.purchaseOutcome({ steps: { purchase: 'declined' } }).reason, 'declined');
  assert.strictEqual(er.purchaseOutcome({ purchase: 'error' }).status, 'failed', '混合顶层失败');
  // 已充跳过:续跑 skipped_charge → skipped(优先于成功判定,语义更准)
  assert.strictEqual(er.purchaseOutcome({ skipped_charge: true, charged: 5 }).status, 'skipped');
  assert.strictEqual(er.purchaseOutcome({ skipped_charge: true, steps: { purchase: 'success' } }).status, 'skipped');
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
  assert.strictEqual(row.billingStatus, 'success', 'C1: charged>0 → 账单达 success 等级(防续跑重扣)');
  assert.strictEqual(row.charged, 5);
  assert.strictEqual(row.passwordChanged, true);
  assert.strictEqual(row.cardLast4, '4242');
  assert.strictEqual(row.exitIp, '1.2.3.4', 'exitIp 取 proxy 的 host 段');
  // charged 兜底:无 charged 用 charge,再无→0
  assert.strictEqual(er.mapRow({ email: 'a@x.com', ok: true, charge: 3, steps: { card: 'card-bound' } }, acc)[1].charged, 3);
  assert.strictEqual(er.mapRow({ email: 'a@x.com', ok: true, steps: { card: 'card-bound' } }, acc)[1].charged, 0);
});

test('C1 bestBillingStatus: 取候选最高账单等级,address-bound 不短路盖掉真实 card-bound/success', () => {
  const acc = new Map([['a@x.com', 'origpw']]);
  const bs = (r) => er.mapRow(r, acc)[1].billingStatus;
  // ★混合:billing_status 在 Playwright 前置写成 address-bound,绑卡成功只升 steps.card → 不得被 address-bound 短路盖掉
  assert.strictEqual(bs({ email: 'a@x.com', ok: true, billing_status: 'address-bound', steps: { card: 'card-bound' } }), 'card-bound', 'address-bound 不得盖掉真实 card-bound');
  // ★混合已充值:charged>0 → success 等级(否则续跑 billingSatisfied charge 误判未达标 → 真重扣)
  assert.strictEqual(bs({ email: 'a@x.com', ok: true, billing_status: 'address-bound', steps: { card: 'card-bound' }, charged: 5 }), 'success', '已充值混合号 → success');
  assert.strictEqual(bs({ email: 'a@x.com', ok: true, billing_status: 'address-bound', purchase: 'success', steps: { card: 'card-bound' } }), 'success', 'purchase==success → success');
  // 仅绑卡未充值 → card-bound;纯 Sel 无 billing_status → 取 steps.card
  assert.strictEqual(bs({ email: 'a@x.com', ok: true, steps: { card: 'card-bound' } }), 'card-bound', '仅绑卡未充值 → card-bound');
});

test('mapRow 失败行: reason=真因, blacklisted=拉黑判定, 密码回退原密码', () => {
  const acc = new Map([['b@x.com', 'origpw']]);
  const [kind, row] = er.mapRow({ email: 'b@x.com', steps: { auth: 'ok', key: false } }, acc);
  assert.strictEqual(kind, 'failed');
  assert.strictEqual(row.password, 'origpw', '失败行无 res.password 时回退到输入的原密码');
  // ★失败号也要带【现密码=op_pw/统一密码】(已注册的 key:false 号重跑要用它登录)——与成功分支一致,不能丢
  const [, urow] = er.mapRow({ email: 'b@x.com', password: '@Unified2026', steps: { auth: 'ok', key: false } }, acc);
  assert.strictEqual(urow.password, '@Unified2026', '失败行 password=op_pw(统一密码)');
  assert.strictEqual(urow.originalPassword, 'origpw', '失败行 originalPassword 仍=原密码(两者都在,重跑参数齐)');
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

test('parseResultLine: 实时成功判定与最终 isSuccessRow 同口径(全套流程不在加卡那刻误判成功)', () => {
  const P = (line) => er.parseResultLine(line);
  // ★用户痛点:全套流程(do_purchase 开)——加卡绑成但充值 declined → 最终失败,实时也必须判失败(原来 ||cardBound 会闪成功)
  assert.strictEqual(P("════ 结果 alice ok=false steps={'auth': 'ok', 'key': True, 'card': 'card-bound', 'purchase': 'declined'}").ok, false, 'card-bound 但充值declined → 失败');
  // 只加卡(do_purchase 关):card-bound 即成功
  assert.strictEqual(P("════ 结果 bob ok=true steps={'auth': 'ok', 'key': True, 'card': 'card-bound'}").ok, true);
  // 选了加卡但只到 hcaptcha/declined/unknown(没绑成)→ 失败(即使 python 误写 ok=true 也按 steps 纠正)
  assert.strictEqual(P("════ 结果 carol ok=true steps={'auth': 'ok', 'key': True, 'card': 'hcaptcha'}").ok, false, 'card=hcaptcha 即使 python ok=true 也判失败');
  assert.strictEqual(P("════ 结果 dave ok=true steps={'auth': 'ok', 'key': True, 'card': 'unknown'}").ok, false);
  // 注册失败 → 失败
  assert.strictEqual(P("════ 结果 eve ok=false steps={'auth': 'fail:FORM_NOT_FILLED'}").ok, false);
  // 纯取key模式(无 card 步)ok=true → 成功(不误伤)
  assert.strictEqual(P("════ 结果 frank ok=true steps={'auth': 'ok', 'key': True}").ok, true);
  // 充值成功 → 成功
  assert.strictEqual(P("════ 结果 grace ok=true steps={'auth': 'ok', 'card': 'card-bound', 'purchase': 'success'}").ok, true);
  // hybrid 行格式(steps 可能不在行内)→ 回退 python ok
  assert.strictEqual(P("════ henry 结果 ok=true pw=...").ok, true);
  assert.strictEqual(P("════ ivan 结果 ok=false pw=...").ok, false);
  // 非结果行 → null
  assert.strictEqual(P("[Selenium] 启动中…"), null);
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
