'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 多引擎启动器 — Openrouter / web / engine-runner
//
// 把 web 控制台的「开始执行」对接到 Python 流水线:
//   selenium → run.py(纯 Selenium)   hybrid → hybrid_run.py(Playwright+Selenium 混合)
//   split    → 随机分流:groupA 跑 run.py + groupB 跑 hybrid_run.py 并发
// spawn 子进程 → readline 逐行读 stdout/stderr → eventBus.publish(jobId,'log',line);
// 解析单号结果行累加 ok/fail;进程结束读结果文件本次新增行 → job-done + 返回 summary(给 runs-store)。
// 零依赖、CommonJS。playwright(Node)引擎不走这里,仍走 Openrouter-job-runner.runJob。
// ═══════════════════════════════════════════════════════════════════════

const { safeSpawn } = require('./spawn-safe');   // 统一 spawn:默认 windowsHide(防 Windows 弹黑窗),见 spawn-safe.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const tempInputs = require('./temp-inputs');
const procRegistry = require('./proc-registry');
const configRw = require('./config-rw');
const usageStore = require('./usage-store');
const proxyStore = require('./proxy-store');
const adspowerEndpointStore = require('./adspower-endpoint-store');
const serviceKeys = require('./service-keys');
const accountStore = require('../data/account-store');   // 把 Python 引擎结果(注册/key/充值/拉黑)桥接进账号台账,让账号页回显

const SELENIUM_DIR = path.join(__dirname, '..', 'selenium-e2e');
const STATE_DIR = path.join(SELENIUM_DIR, 'state');
const RESULTS = {
  selenium: path.join(STATE_DIR, 'results.jsonl'),
  hybrid: path.join(STATE_DIR, 'hybrid_results.jsonl'),
};

function pythonBin() {
  return process.env.OPENROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch (_e) { return 0; }
}
// stats(可选):{ dropped } 累加无法解析的行数 —— 调用方据此告警「部分结果行损坏」,
// 不再把坏行静默丢弃当作"没有这些账号"(be-4)。不传 stats 时行为与原来完全一致(向后兼容,failure-analytics 仍可用)。
function readTail(file, fromLine, stats) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(fromLine);
    const out = [];
    let dropped = 0;
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch (_e) { dropped += 1; } }
    if (stats && dropped) stats.dropped = (stats.dropped || 0) + dropped;
    return out;
  } catch (_e) { return []; }
}
// Python 结果行成功判定 —— ★用户原则「每个【已运行的关键节点】都必须真成功,其余=失败」:
//   原来只 `ok===true || card==='card-bound'`,会被上游(pipeline 旧码 ok=true 不看 card)污染的假成功行带歪
//   ——绑卡失败(hcaptcha/declined/server-error/unknown)却 ok=true 被误算成功。这里【从 steps 逐节点 gate】:
//   任一已运行的关键节点失败即判不成功,即时修正已写坏的历史行 + 防御未来任何引擎再写错 ok。
//   节点:注册(auth)/取key(key,仅显式 false)/加卡(card)/充值(purchase:pipeline 写 steps.purchase、hybrid 写顶层 r.purchase,两处都查)。
//   changepw 是收尾维护步(失败不丢账号价值)→ 不纳入,与 pipeline ok 口径一致。
function isSuccessRow(r) {
  if (!r) return false;
  const s = r.steps || {};
  if (s.auth != null && s.auth !== 'ok') return false;            // 注册失败(card-bound 行 auth 必为 ok,不误伤)
  if (s.card != null && s.card !== 'card-bound') return false;    // ★加卡跑了却没绑成(hcaptcha/declined/server-error/unknown)→ 失败(用户实测病根)
  const pur = (s.purchase != null) ? s.purchase : r.purchase;     // 充值:pipeline=steps.purchase / hybrid=顶层 r.purchase
  if (pur != null && pur !== 'success') return false;             // 充值跑了却没成(do_purchase 开)→ 失败,待续跑补
  return r.ok === true || s.card === 'card-bound';                // 通过所有已运行节点 + 确有产出
  // 注:不拦 key=false —— 「加卡绑成但 steps.key=false(key 经网络钩子抓到/或后补)」是既有成功语义(card-bound 为成功标尺,见单测),拦了会误伤真绑成号。
}

// ★每 email 唯一化,且【成功恒胜失败】(success-wins),非 last-wins。这是「成功号不许再出现在失败里」的硬不变量。
//   背景(实测病根):同一 job 内 AUTO_RETRY 会对失败号追加【第二行成功结果】(同 email/job_id,先 fail 后 success);
//   旧逻辑用 last-wins(按文件/at 顺序)——一旦有【迟到的失败行】(如绑卡成功后 changepw 再报错、二次衔接、回填撞车)排在成功之后,
//   成功号会被降级成失败 → 同号既进 successRows 又进 failedRows(运行详情快照里成功表/失败表同时出现该号)。
//   规则:① 任一成功行存在 → 该 email 判成功(取最近一条成功行,带 api_key/卡尾号);② 全是失败行 → 取 at 最近的失败行(保留最新真因)。
//   纯函数、可单测(有迹可查);返回去重后的行数组 + 折叠掉的重复数(供调用方落日志审计)。
function dedupBySuccess(rows) {
  const best = new Map();
  let collapsed = 0;
  for (const r of rows) {
    if (!r || !r.email) continue;
    const prev = best.get(r.email);
    if (!prev) { best.set(r.email, r); continue; }
    collapsed += 1;                                   // 同 email 第二次起即为一次折叠(无论谁胜)
    const rs = isSuccessRow(r), ps = isSuccessRow(prev);
    if (rs && !ps) { best.set(r.email, r); continue; }            // 成功胜失败
    if (!rs && ps) continue;                                       // 已有成功 → 失败行丢弃(绝不降级)
    if (String(r.at || '') >= String(prev.at || '')) best.set(r.email, r);  // 同态:取 at 更近者
  }
  return { rows: [...best.values()], collapsed };
}

// 统一「号被 OpenRouter 永久拒绝(拉黑)」判据 —— 覆盖两引擎:
//   hybrid 写 res["not_allowed"]=True;纯Sel(run.py:131)靠 steps.auth 以 NOT_ALLOWED 结尾;另兼容 steps.banned 标记。
function isNotAllowed(r) {
  if (!r) return false;
  if (r.not_allowed) return true;
  const s = r.steps || {};
  if (typeof s.auth === 'string' && /NOT_ALLOWED$/.test(s.auth)) return true;
  if (s.banned === 'not-allowed') return true;
  return false;
}

// Python 失败行 → 原因/阶段(供详情表展示)
function pyFailReason(r) {
  const s = r.steps || {};
  if (r.fail_reason) return String(r.fail_reason).slice(0, 80);          // ★pipeline 已归因好(不做糊涂账),直接用
  if (typeof s.auth === 'string' && s.auth.indexOf('fail') === 0) return s.auth;
  if (s.card && s.card !== 'card-bound') return 'card:' + s.card;
  if (s.pw === false && s.pw_reason) return 'pw:' + s.pw_reason;
  if (s.purchase && s.purchase !== 'success') return 'charge:' + s.purchase;   // 补漏:充值拒付/未成功(原来落到 JSON 糊涂账)
  if (s.key === false) return 'key:' + (r.key_reason || 'fail');               // 补漏:取key 失败
  if (r.giveup_permanent) return 'giveup' + (r.steps && r.steps.giveup ? ':' + r.steps.giveup : '');
  if (s.giveup) return 'giveup:' + s.giveup;                                   // 混合加卡放弃(card-deadline/all-segments-502/…)
  const _pur = (s.purchase != null) ? s.purchase : r.purchase;                 // 混合 purchase 在顶层 r.purchase
  if (_pur && _pur !== 'success') return 'charge:' + _pur;
  if (isNotAllowed(r)) return 'ACCOUNT_NOT_ALLOWED';
  if (r.error) return String(r.error).slice(0, 80);
  // ★兜底:绝不把裸 JSON.stringify(steps) 丢给用户 —— 按 steps 最远到达的阶段说一句人话。
  if (s.auth === 'ok') {
    if (s.card === 'card-bound') return '充值/收尾未完成';                      // 卡绑成但整体判失败 → 多为充值/改密没过
    if (s.key === true || s.pw === true || r.api_key) return '加卡未完成(未绑卡)';
    return '已注册·后续阶段未完成';
  }
  if (s.auth) return 'auth:' + s.auth;                                         // auth 非 ok 又非 fail 前缀(如 REGISTER_UNCONFIRMED)
  return Object.keys(s).length ? '未完成(详见运行日志)' : 'unknown';
}

// 跨引擎衔接(split 第二轮)分类:某失败行该转去哪个引擎再试一次,返回 'hybrid'|'selenium'|null。
// ★结果行不含 engine 字段 → 「当前引擎」由【来源结果文件】决定(results.jsonl=selenium / hybrid_results.jsonl=hybrid),
//   故 sourceEngine 必须由调用方按文件传入,绝不从行里读。只对失败行判定。
//   - selenium 失败且 steps.key===false(取 key 向导进了但抓不到 key,WIZARD_NO_KEY)→ 转 hybrid(Playwright 能过新页面)。
//   - hybrid 失败且加卡人机验证过不去(card==='hcaptcha' / giveup_reason==='hcaptcha' / card_hcaptcha)→ 转 selenium。
//   其它失败(declined / not_allowed / 代理网络 / 注册 Turnstile)不转。
function handoffTarget(row, sourceEngine) {
  if (!row || isSuccessRow(row)) return null;
  const s = row.steps || {};
  if (sourceEngine === 'selenium') return s.key === false ? 'hybrid' : null;
  if (sourceEngine === 'hybrid') {
    const hcap = s.card === 'hcaptcha' || row.giveup_reason === 'hcaptcha' || row.card_hcaptcha === true;
    return hcap ? 'selenium' : null;
  }
  return null;
}
// ★账单状态取【候选里最高账单等级】(C1 修):混合引擎里 billing_status 在 Playwright 前置阶段
//   早早被写成 'address-bound',之后 Selenium 绑卡/充值成功【只升级 steps.card / charged,从不回写
//   billing_status】→ 旧式 `r.billing_status || steps.card` 会被真值 'address-bound' 短路,把真正的
//   card-bound/success 丢掉 → 台账记成 level-1 → Playwright/混合续跑 billingSatisfied 误判未达标 →
//   对【已绑卡/已充值】号重新加卡/充值(真金白银,不可回滚)。故按 attainedLevel 取最高等级,
//   候选 = billing_status / steps.card / (purchase==success || charged>0 → 'success')。
function bestBillingStatus(r) {
  if (!r) return '';
  const charged = r.charged != null ? r.charged : (r.charge != null ? r.charge : 0);
  const cands = [
    r.billing_status,
    r.steps && r.steps.card,
    (r.purchase === 'success' || (charged != null && charged > 0)) ? 'success' : '',
  ];
  let best = '';
  for (const c of cands) {
    if (c && accountStore.attainedLevel(c) > accountStore.attainedLevel(best)) best = c;
  }
  // best 为空(全是 level-0 的非空标记,如 'declined')→ 回退旧式首个真值,保持显示不变(桥接侧仍有单调护栏兜底)。
  return best || r.billing_status || (r.steps && r.steps.card) || '';
}

// ★充值结果归一化(用户要求「充值成功/失败要有相应字段」):消除 charged=0 的歧义 —— 区分
//   success(充成 +金额)/ failed(拒付/未确认,带真因)/ skipped(续跑已充跳过)/ not-attempted(do_purchase 关或没走到充值)。
//   纯Sel 充值结果在 steps.purchase、混合在顶层 r.purchase → 二者取一(与 isSuccessRow/classifyBlame 同口径)。
function purchaseOutcome(r) {
  const s = r.steps || {};
  const pur = (s.purchase != null) ? s.purchase : r.purchase;
  const charged = r.charged != null ? r.charged : (r.charge != null ? r.charge : null);
  if (r.skipped_charge) return { status: 'skipped', label: '已充值(续跑跳过)', amount: charged, reason: '' };
  if (pur === 'success' || (charged || 0) > 0) return { status: 'success', label: '成功', amount: charged, reason: '' };
  if (pur != null && pur !== 'success') return { status: 'failed', label: '失败', amount: null, reason: String(pur) };
  return { status: 'not-attempted', label: '未充值', amount: null, reason: '' };   // do_purchase 关 / 没走到充值阶段
}
// Python 结果行 → 前端账号表形状(success / failed)。accByEmail:把输入账号的原密码 join 回来(结果文件不含密码)。
function mapRow(r, accByEmail) {
  const exitIp = String(r.proxy || '').split(':')[0] || '';
  const orig = (accByEmail && accByEmail.get(r.email)) || '';
  const po = purchaseOutcome(r);   // 充值结果归一化(成功/失败/已充跳过/未充值)
  const durationSec = (r.timings && r.timings.total != null) ? r.timings.total : null;   // 单号端到端耗时(纯Sel/混合都写 timings.total)→ 详情可见,排查谁慢
  if (isSuccessRow(r)) {
    // ★充值额键名:hybrid 写 res["charged"]、纯Sel 也补写 charged;旧 r.charge 兜底。balance_after=充值后真实积分余额。
    const _charged = r.charged != null ? r.charged : (r.charge != null ? r.charge : 0);
    return ['success', { email: r.email, password: r.password || orig, originalPassword: orig, apiKey: r.api_key || '', apiKeyName: r.api_key_name || '', billingStatus: bestBillingStatus(r), charged: _charged, balanceAfter: r.balance_after != null ? r.balance_after : null, purchaseStatus: po.status, purchaseReason: po.reason, cardLast4: r.card_last4 || '', passwordChanged: !!(r.steps && r.steps.changepw), exitIp, proxy: r.proxy || '', durationSec, createdAt: r.at || '' }];
  }
  // ★失败号也带【现密码=op_pw(统一密码优先)】+【原密码】,否则重跑这些号(尤其已注册的 key:false)拿不到能登录的密码。
  return ['failed', { email: r.email, password: r.password || orig, originalPassword: orig, reason: pyFailReason(r), stage: r.fail_stage || (r.steps && (typeof r.steps.auth === 'string' ? 'auth' : (r.steps.purchase && r.steps.purchase !== 'success' ? 'charge' : (r.steps.card && r.steps.card !== 'card-bound' ? 'card' : (r.steps.key === false ? 'key' : (r.steps.pw === false ? 'register' : '')))))) || '', failClass: r.hcap_mode || '', attempts: r.crash_restarts != null ? r.crash_restarts : (r.reopen_count || 0), purchaseStatus: po.status, purchaseReason: po.reason, blacklisted: isNotAllowed(r), blacklistReason: isNotAllowed(r) ? 'ACCOUNT_NOT_ALLOWED' : '', proxy: r.proxy || '', durationSec, createdAt: r.at || '' }];
}

const DETAILS_DIR = path.join(__dirname, '..', 'data', 'run-details');
const NODE_RESULTS_DIR = path.join(__dirname, '..', 'data', 'batch-results');

// 把本次 job 的结果行桥接进【账号台账 accountStore】(账号页 /api/accounts + 续跑读它)。
// 根因:Python 引擎(selenium/hybrid/split)结果只进 results.jsonl,从不更新台账 → 账号页对它们一片空白
//   (充值不回显、拉黑不体现)。这里在每个 job 收口时,把结果(注册/key/billing/充值/卡/改密/拉黑)合并进台账。
// 安全:只写【有意义的字段】(不拿空 key/卡/充值去覆盖既有数据);accountStore.update 是幂等 upsert+原子落盘。
async function bridgeToAccountStore(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const byEmail = new Map();
  for (const r of rows) { if (r && r.email) byEmail.set(r.email, r); }   // 同号多行 → 取最后一行(最新)
  const ups = [];
  for (const r of byEmail.values()) {
    try {
      const prior = accountStore.get(r.email) || {};
      const success = isSuccessRow(r);
      const patch = {};
      if (r.api_key) { patch.apiKey = r.api_key; patch.registered = true; }
      if (r.api_key_name) patch.apiKeyName = r.api_key_name;
      if (r.registered || success) patch.registered = true;
      // ★GAP-1:Python 引擎也把【当前登录密码=op_pw(统一密码优先,Python res 已写)】落台账,与 Playwright snap.loginPassword 口径一致。
      //   否则某号被 Python 跑过后台账 loginPassword 始终为空 → 后续 Playwright 续跑/账号页展示回退成原密码(本次"失败号显原密码"的跨引擎同根病灶)。
      if (r.password) patch.loginPassword = r.password;
      // ★billingStatus 单调护栏(防二次扣款):只在新状态【账单等级 ≥ 旧状态】时才覆盖。否则失败行(declined/hcaptcha
      //   写进 steps.card)会把已达标的 card-bound/success 降级 → Playwright 续跑读 billingSatisfied 误判未达标
      //   → 对【已绑卡/已充值】号重新加卡/充值(真金白银,不可回滚)。
      // ★C1:用 bestBillingStatus 取候选最高等级(billing_status/steps.card/charged>0→success),修「混合 billing_status
      //   早写 address-bound 短路盖掉真实 card-bound/success → 台账记 level-1 → 续跑重加卡/重扣」。
      const billing = bestBillingStatus(r);
      if (billing && accountStore.attainedLevel(billing) >= accountStore.attainedLevel(prior.billingStatus)) patch.billingStatus = billing;
      // 充值额:只写【正数】真实充值。失败/跳过会写 charged=0(hybrid_run),若覆盖已有正充值额同样造成降级误判 → 只升不降。
      const charged = r.charged != null ? r.charged : (r.charge != null ? r.charge : null);
      if (charged != null && charged > 0) patch.charged = charged;
      // 成功元数据(充值后余额、绑成卡尾号)只在【成功行】写,避免失败行(declined 卡尾号/0 余额)污染已成功记录。
      if (success && r.balance_after != null) patch.balanceAfter = r.balance_after;
      if (success && r.card_last4) patch.cardLast4 = r.card_last4;
      if (r.steps && r.steps.changepw) patch.passwordChanged = true;
      const exitIp = String(r.proxy || '').split(':')[0];
      if (exitIp) patch.exitIp = exitIp;   // 最近一次出口 IP(诊断用),失败行也更新无妨
      if (isNotAllowed(r)) { patch.blacklisted = true; patch.blacklistReason = 'ACCOUNT_NOT_ALLOWED'; }
      else if (success) { patch.blacklisted = false; patch.blacklistReason = ''; }   // ★成功(--no-resume 救回)→ 翻转拉黑,避免"既拉黑又有key"矛盾态
      ups.push(Promise.resolve(accountStore.update(r.email, patch)).catch(() => { /* 单号失败不致命 */ }));
    } catch (_e) { /* 单号桥接失败不影响其它号 */ }
  }
  if (ups.length) await Promise.allSettled(ups);
}
// ★未完整号归因:本批无结果行、历史也回填不到的号 —— 读已有状态文件给出「为啥未完整」,不再静默丢弃(每个输入号都有归宿)。
function _readIncompleteState() {
  const st = { banned: new Set(), badMail: new Set(), progress: {} };
  try {
    for (const line of fs.readFileSync(path.join(STATE_DIR, 'banned_accounts.txt'), 'utf8').split('\n')) {
      const e = line.trim().split(/[\s,|]+/)[0];
      if (e && e.includes('@')) st.banned.add(e.toLowerCase());
    }
  } catch (_e) { /* 没有就空 */ }
  try {
    const bm = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'bad_mailboxes.json'), 'utf8'));
    const arr = Array.isArray(bm) ? bm : Object.keys(bm || {});
    for (const x of arr) { const em = (typeof x === 'string' ? x : (x && x.email)) || ''; if (em) st.badMail.add(String(em).toLowerCase()); }
  } catch (_e) { /* */ }
  try { st.progress = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'account_progress.json'), 'utf8')) || {}; } catch (_e) { /* */ }
  return st;
}
// 纯函数(可单测):给一个【本批没结果、历史也回填不到】的号判「为啥未完整 + 最远到哪一步」。state 由 _readIncompleteState 预读。
function classifyIncomplete(email, state) {
  const e = String(email || '').toLowerCase();
  const s = state || {};
  if (s.banned && s.banned.has(e)) return { status: 'banned', reason: '号被拒(NOT_ALLOWED,历史已登记)— 永久跳过,不重跑' };
  // 坏邮箱:整邮箱登记 或【整域 404】登记(bad_mailboxes.json 可存 @domain 域级条目)
  const _domain = e.includes('@') ? '@' + e.split('@')[1] : '';
  if (s.badMail && (s.badMail.has(e) || (_domain && s.badMail.has(_domain)))) return { status: 'bad-mailbox', reason: '坏邮箱/整域不可达(收不到验证邮件,历史已登记)— 换邮箱源' };
  const p = (s.progress && (s.progress[email] || s.progress[e])) || null;
  if (p) {
    if (p.api_key) return { status: 'incomplete', reason: '中途中断:已取到 Key(' + (p.billing_status || '未到加卡') + ')— 续跑补后续' };
    if (p.billing_status) return { status: 'incomplete', reason: '中途中断:已到「' + p.billing_status + '」,未取 Key/未完成 — 可续跑' };
    if (p.registered) return { status: 'incomplete', reason: '中途中断:已注册,未取 Key — 可续跑' };
    return { status: 'incomplete', reason: '中途中断(checkpoint 有进度,阶段不明)— 可续跑' };
  }
  return { status: 'not-run', reason: '本批未产出结果(疑中途被 kill / 并发未排到 / 子进程丢结果)— 可续跑' };
}
function writeDetail(jobId, engine, successRows, failedRows, incompleteRows) {
  try {
    fs.mkdirSync(DETAILS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DETAILS_DIR, jobId + '.json'), JSON.stringify({ jobId, engine, success: successRows.slice(0, 5000), failed: failedRows.slice(0, 5000), incomplete: (incompleteRows || []).slice(0, 5000) }));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }   // 失败不再静默(be-8):返回给调用方告警
}
function readDetail(jobId) {
  try { return JSON.parse(fs.readFileSync(path.join(DETAILS_DIR, jobId + '.json'), 'utf8')); } catch (_e) { return null; }
}
// 模板渲染({{field}} 替换),与 Node 引擎回显一致
function renderTpl(tpl, row) {
  if (!tpl) return `${row.email || ''}:${row.apiKey || row.password || ''}`;
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_m, k) => { const v = row[k]; return v == null ? '' : String(v); });
}
// 写 Node 同款 batch-results 文件 → /download、/api/results、聚合页 对 Python 任务也生效
function writeBatchResults(jobId, successRows, failedRows, successTpl, failureTpl) {
  try {
    fs.mkdirSync(NODE_RESULTS_DIR, { recursive: true });
    const jsonl = (arr) => (arr.length ? arr.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-success.jsonl`), jsonl(successRows));
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-failed.jsonl`), jsonl(failedRows));
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-success.txt`), successRows.map((r) => renderTpl(successTpl, r)).join('\n'));
    fs.writeFileSync(path.join(NODE_RESULTS_DIR, `${jobId}-failed.txt`), failedRows.map((r) => renderTpl(failureTpl, r)).join('\n'));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message) }; }   // 失败不再静默(be-8):磁盘满时让调用方告警,而非假"完成"
}

// stdout 单号结果行解析(run.py / hybrid 两种格式)
// 实时成功判定必须与 isSuccessRow 对齐:ok=true 或 steps.card=='card-bound' 都算成功。
// 否则实时面板只按 ok= 单判 → 「加卡绑成但没取到 Key」的号被流成 account-failed,
// 与最终聚合/运行详情/结果聚合(card-bound 计成功)对不上,成功账号面板空着不回显。
function parseResultLine(line) {
  const cardBound = /['"]card['"]\s*:\s*['"]card-bound['"]/.test(line); // 行内 steps 是 Python repr(单引号)
  let m = line.match(/════\s*结果\s+(\S+?)\s+ok=(\w+)\s+steps=/);   // run.py:  ════ 结果 NAME ok=B steps=...
  if (m) return { name: m[1], ok: /^true$/i.test(m[2]) || cardBound };
  m = line.match(/════\s+(\S+?)\s+结果\s+ok=(\w+)/);                // hybrid:  ════ NAME 结果 ok=B pw=...
  if (m) return { name: m[1], ok: /^true$/i.test(m[2]) || cardBound };
  return null;
}

// 从 stdout 结果行尽力提取失败真因(run.py 行内含 Python repr 的 steps)→ 让实时 account-failed 事件带真因,
// 不再只显示占位 'see-log'(本会话痛点:跑批时看不到失败原因)。提取不到(如 hybrid 行格式不同)回退 'see-log',无回归。
function reasonFromLine(line) {
  try {
    let m = line.match(/['"]auth['"]\s*:\s*['"](fail[^'"]*)['"]/i);   // 注册/登录失败:fail:FORM_NOT_FILLED 等
    if (m) return m[1];
    m = line.match(/['"]card['"]\s*:\s*['"]([^'"]+)['"]/i);            // 加卡态(card-bound 是成功,不进失败分支)
    if (m && m[1] !== 'card-bound') return 'card:' + m[1];
    if (/['"]key['"]\s*:\s*(False|false)\b/.test(line)) return 'key:false';
    m = line.match(/['"]giveup['"]\s*:\s*['"]([^'"]+)['"]/i);
    if (m) return 'giveup:' + m[1];
  } catch (_e) { /* 行格式异常→回退 see-log */ }
  return 'see-log';
}

// 有限数才用,否则回退默认;不要用 `Number(x) || d`(会把合法的 0 顶成默认)。
// 但空串/空白 = 字段留空 → 用默认(Number('')===0 会误判成显式 0,故先判空)。
function _numOr(v, d) { const s = String(v == null ? '' : v).trim(); if (s === '') return d; const n = Number(s); return Number.isFinite(n) ? n : d; }

// ★并发硬上限(防 AdsPower 在高并发下批量掉线 session-deleted)。高级参数页 maxConcurrency 设了就把【任何 job】
//   的每进程并发钳到 ≤ 它,无论控制台请求多少;留空/<=0 = 不限(老行为逐字节不变)。读 advanced-store(持久),
//   每次起 job 时算 → 设一次以后都生效,不用每次手调。split 模式两引擎各跑 _clampConc 个 = 总 2× 上限,注意。
function _clampConc(req, jobId) {
  const c = Math.max(1, Number(req) || 1);
  let cap = 0;
  try { cap = Number((require('./advanced-store').get() || {}).maxConcurrency) || 0; } catch (_e) { cap = 0; }
  if (cap > 0 && c > cap) {
    try { console.error(`[engine-runner] 并发 ${c} 超过高级参数上限 ${cap} → 钳制为 ${cap}${jobId ? ` (job ${jobId})` : ''}`); } catch (_e) { /* 日志失败不影响钳制 */ }
    return cap;
  }
  return c;
}

// UI 选项 → run.py 参数
function seleniumArgs(accFile, pxFile, p, jobId) {
  const a = ['--accounts', accFile, '--proxies', pxFile, '--concurrency', String(_clampConc(p.concurrency, jobId))];
  a.push(p.doApiKey === false ? '--no-key' : '--do-key');
  if (p.doCard) a.push('--do-card');
  if (p.doPurchase) { a.push('--do-purchase', '--amount', String(Math.max(5, Number(p.amount) || 5))); }
  // 统一密码=OpenRouter 登录密码:设了就下发(与混合 hybridArgs 的 --op-pw 同口径,不再被「改密」开关门控)。
  //   原来仅 (doChangePw && unifiedPassword) 才下发 → 用户设了统一密码但没开改密时,纯Sel 拿不到 unified_pw
  //   → run.py 里 op_pw 回退邮箱原密码 → 注册与回显(成功+失败号)都成原密码。--do-changepw 单独开关,目标已由 --unified-pw 带入。
  if (p.unifiedPassword) a.push('--unified-pw', p.unifiedPassword);
  if (p.doChangePw && p.unifiedPassword) a.push('--do-changepw');
  if (Number(p.proxyOffset)) a.push('--proxy-offset', String(Number(p.proxyOffset)));
  if (Number(p.gap)) a.push('--gap', String(Number(p.gap)));
  if (p.noDeleteEnv) a.push('--no-delete-env');
  if (p.resume === false) a.push('--no-resume'); // 「断点续跑」取消勾选 → 忽略已完成/坏邮箱状态、整组强制重跑
  if (jobId) a.push('--job-id', String(jobId)); // 结果行写 job_id → web 按 job 隔离取结果,防同引擎并发串号
  a.push('--auto-hcaptcha-only'); // web 无人值守:hCaptcha 只走自动(求解模式由 FIXC_SOLVE_HCAPTCHA 控),不停下等人工
  return a;
}
// UI 选项 → hybrid_run.py 参数(混合全流程:注册→取key→绑地址→加卡)
function hybridArgs(accFile, pxFile, p, jobId) {
  const a = ['--accounts', accFile, '--proxies', pxFile, '--concurrency', String(_clampConc(p.concurrency, jobId))];
  if (p.unifiedPassword) a.push('--op-pw', p.unifiedPassword);
  if (p.doChangePw && p.unifiedPassword) a.push('--do-changepw'); // 改密目标=统一密码(已由 --op-pw 带入);混合现支持改密
  a.push('--max-rotations', String(_numOr(p.maxRotations, 3)));
  a.push('--cooldown-hours', String(_numOr(p.cooldownHours, 3)));
  a.push('--max-reopen', String(_numOr(p.maxReopen, 3)));
  if (p.doPurchase) { a.push('--do-purchase', '--amount', String(Math.max(5, Number(p.amount) || 5))); }
  if (p.isolate) a.push('--isolate');
  if (p.manualCard) a.push('--manual-card');
  if (p.noDeleteEnv) a.push('--no-delete-env');
  if (p.noGc) a.push('--no-gc');
  if (p.resume === false) a.push('--no-resume'); // 「断点续跑」取消勾选 → 忽略已绑/被拒/冷却状态、整组强制重跑
  if (jobId) a.push('--job-id', String(jobId)); // 结果行写 job_id → web 按 job 隔离取结果,防同引擎并发串号
  return a;
}

// 透传/覆盖给 Python 的环境变量(求解模式/止损/熔断等)
function buildEnv(p) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  // 验证码/邮箱 key 池:挑一个可用 key 注入 env(Python common/config.py 读它们);池空回退 config。
  try { Object.assign(env, serviceKeys.envPatch()); } catch (_e) { /* 用 config 兜底 */ }
  // 高级参数(全局/共用调优旋钮 advanced-store):只注用户【显式设的覆盖值】(空=Python 用内置默认)。
  // 放在下方引擎配置 FIXC_*/WIZARD_* 显式注入【之前】→ 引擎配置(per-engine)优先;且两边键去重不重叠,互不覆盖。
  try { Object.assign(env, require('./advanced-store').envPatch()); } catch (_e) { /* 覆盖失败不致命,用默认 */ }
  // 元素选择器覆盖(selectors-store → ORSEL_*):页面改了关键元素定位规则就注进去;common.selectors.sel() 读,空=用内置默认。
  try { Object.assign(env, require('./selectors-store').envPatch()); } catch (_e) { /* 覆盖失败不致命,用内置默认 */ }
  // 跨节点下发:中心机随 payload 复制了它生效的验证码/邮箱 key → 子机优先用下发的(覆盖本机池/config)。
  if (p.captchaApiKey) { env.OPENROUTER_CAPTCHA_KEY = String(p.captchaApiKey); if (p.captchaProvider) env.OPENROUTER_CAPTCHA_PROVIDER = String(p.captchaProvider); }
  if (p.mailboxApiKey) { env.OPENROUTER_FIRSTMAIL_KEY = String(p.mailboxApiKey); if (p.mailboxApiBaseUrl) env.OPENROUTER_FIRSTMAIL_BASE = String(p.mailboxApiBaseUrl); }
  // AdsPower 端点:优先端点池(本机有多个端点时选一个;p.adspowerEndpoint 指定 id,否则首个 active);
  // 端点池为空 → 回退 config.local.json 的 adspower.*(单端点向后兼容)。Python 一批用一个端点。
  try {
    const eps = adspowerEndpointStore.activeFull();
    let chosen = null;
    if (eps.length) chosen = (p.adspowerEndpoint && eps.find((e) => e.id === p.adspowerEndpoint)) || eps[0];
    if (chosen) {
      env.OPENROUTER_ADSPOWER_API = chosen.apiBase;
      if (chosen.apiKey && String(chosen.apiKey).trim()) env.OPENROUTER_ADSPOWER_TOKEN = String(chosen.apiKey).trim();
    } else {
      const ap = (configRw.readMerged() || {}).adspower || {};
      if (ap.apiBase && String(ap.apiBase).trim()) env.OPENROUTER_ADSPOWER_API = String(ap.apiBase).trim();
      if (ap.apiKey && String(ap.apiKey).trim()) env.OPENROUTER_ADSPOWER_TOKEN = String(ap.apiKey).trim();
    }
  } catch (_e) { /* 配置读失败用默认端点 */ }
  if (p.solveHcaptcha && ['on', 'off', 'random', 'solve', 'swap'].includes(String(p.solveHcaptcha))) env.FIXC_SOLVE_HCAPTCHA = String(p.solveHcaptcha);
  if (Number(p.cardDeadline) > 0) env.FIXC_CARD_DEADLINE = String(Number(p.cardDeadline));
  if (Number(p.solveFutileCap) >= 0 && p.solveFutileCap !== undefined && p.solveFutileCap !== '') env.FIXC_SOLVE_FUTILE_CAP = String(Number(p.solveFutileCap));
  // 只在是有限数时注入,否则非数字会把字符串 'NaN' 塞进子进程环境变量(Python 解析报错/取默认)。
  const _nSwaps = Number(p.maxHcaptchaCardSwaps);
  if (p.maxHcaptchaCardSwaps !== undefined && p.maxHcaptchaCardSwaps !== '' && Number.isFinite(_nSwaps)) env.MAX_HCAPTCHA_CARD_SWAPS = String(_nSwaps);
  const _nCardSwaps = Number(p.maxCardSwaps);
  if (p.maxCardSwaps !== undefined && p.maxCardSwaps !== '' && Number.isFinite(_nCardSwaps)) env.MAX_CARD_SWAPS = String(_nCardSwaps);
  // 点框后复检等待(秒):Fix C 点完 I am human 后轮询复检框是否消失的时间窗(控制台可配)
  const _nRecheck = Number(p.hcRecheckWait);
  if (p.hcRecheckWait !== undefined && p.hcRecheckWait !== '' && Number.isFinite(_nRecheck)) env.FIXC_HC_RECHECK_WAIT = String(_nRecheck);
  // 绑卡结果等待上限(秒):点 Save 后轮询绑成/被拒结果的上限,到点转去刷新核验(fixc_core 读 FIXC_RESULT_WAIT)。引擎配置可调。
  const _nResWait = Number(p.cardResultWait);
  if (p.cardResultWait !== undefined && p.cardResultWait !== '' && Number.isFinite(_nResWait) && _nResWait > 0) env.FIXC_RESULT_WAIT = String(_nResWait);
  // Save card 存卡弹窗处理(fixc_core 读 FIXC_SAVECARD):默认 dismiss=秒关弹窗立即判绑成(不注 env);仅显式选 wait
  //   才注入 → 还原"不关、等满 FIXC_RESULT_WAIT 再核验"旧行为(供用户对照测试,默认逐字节是 dismiss 快路径)。
  if (p.cardSaveDialog === 'wait') env.FIXC_SAVECARD = 'wait';
  // 取key卡死自救阈值(秒):某一屏卡过这么久不前进 → 刷新逃逸(steps_key 读 WIZARD_STALL_REFRESH)。仅纯 Selenium 取key 用。
  const _nStall = Number(p.wizardStallRefresh);
  if (p.wizardStallRefresh !== undefined && p.wizardStallRefresh !== '' && Number.isFinite(_nStall) && _nStall > 0) env.WIZARD_STALL_REFRESH = String(_nStall);
  // 每引擎「走法」变体(引擎配置预设里设;空=不注=Python 用内置默认 → 默认运行逐字节不变)。
  // 放在 advanced-store(line 195)之后 → 每引擎设了就覆盖全局;各项枚举/数值白名单后才写,手改 JSON 也注不进任意 env。
  if (['address', 'later', 'random'].includes(String(p.wizardPayMode))) env.WIZARD_PAY_MODE = String(p.wizardPayMode);
  if (['skip', 'credits', 'random'].includes(String(p.wizardCreditMode))) env.WIZARD_CREDIT_MODE = String(p.wizardCreditMode);
  if (['random', 'spread', 'concentrate'].includes(String(p.cardStrategy))) env.CARD_STRATEGY = String(p.cardStrategy);
  const _nZip = Number(p.zipRetry);
  if (p.zipRetry !== undefined && p.zipRetry !== '' && Number.isFinite(_nZip) && _nZip >= 0) env.ZIP_RETRY = String(_nZip);
  if (String(p.cardFillMethod) === 'selenium') env.FIXC = '0';   // 旧 Selenium 填卡;Fix C(默认)绝不显式设 FIXC,保持与今天一致
  // 自动重试失败号(run.py 读 AUTO_RETRY_FAILED + AUTO_RETRY_FAILED_TIMES):一批跑完后 resume 语义重跑失败号 N 轮,降失败率。
  //   默认关=不注 env=run.py range(0) 不重试,行为逐字节不变。resume 复用 prior_key/charged 防重复取key/扣款;NOT_ALLOWED/坏邮箱不重试。
  if (p.autoRetryFailed) {
    env.AUTO_RETRY_FAILED = '1';
    const _nRetry = Number(p.autoRetryTimes);
    env.AUTO_RETRY_FAILED_TIMES = String(Number.isFinite(_nRetry) && _nRetry > 0 ? Math.min(_nRetry, 5) : 1);
  }
  // ★失败恢复策略(Stage 2):全局激活预设 → 引擎可覆盖(payload.recoveryOverride,与上面"引擎覆盖全局"同序)→
  //   合成单个 OPENROUTER_RECOVERY_JSON,run.py AUTO_RETRY 按 fail_stage 决定各失败类型是否重试。
  //   默认全 'on' = 现状重试所有非永久失败,逐字节等价(Python 侧没配/解析失败也退默认全重试)。
  try {
    let _recOpts = require('./recovery-store').activeOpts();
    if (p.recoveryOverride && typeof p.recoveryOverride === 'object') _recOpts = { ..._recOpts, ...p.recoveryOverride };   // 引擎覆盖(可选,空=用全局)
    const _recJson = require('./recovery-schema').recoveryEnvJson(_recOpts);
    if (_recJson && _recJson !== '{"retry":{}}') env.OPENROUTER_RECOVERY_JSON = _recJson;
  } catch (_e) { /* 恢复策略可选:读失败不注 → Python 退默认全重试,不影响跑 */ }
  return env;
}

// 起一个子进程 spec。返回 Promise<void>(进程结束 resolve)。计数写进 shared.counters。
function runSpec(jobId, spec, publish, shared) {
  if (!shared.exits) shared.exits = [];
  return new Promise((resolve) => {
    let child;
    try {
      child = safeSpawn(pythonBin(), [spec.script, ...spec.args], {
        cwd: SELENIUM_DIR, env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // unix:独立进程组,便于杀树
        // windowsHide 由 safeSpawn 默认开 → 不给 python.exe 弹黑色控制台窗(stdout/stderr 已走管道)
      });
    } catch (e) {
      publish(jobId, 'log', `${spec.label}启动失败: ${e && e.message}`);
      shared.exits.push({ started: false });
      return resolve();
    }
    if (!child.pid) { publish(jobId, 'log', `${spec.label}未拿到 pid(python 未安装?设 OPENROUTER_PYTHON)`); shared.exits.push({ started: false }); return resolve(); }
    procRegistry.register(jobId, child.pid, shared.engine);
    publish(jobId, 'log', `${spec.label}已启动(pid=${child.pid}):${path.basename(spec.script)} ${spec.args.join(' ')}`);

    const onLine = (line) => {
      if (!line) return;
      // 逐号阶段进度标记(Python common.log_stage 发):转成 worker-update 画线程进度条,并吞掉这行不刷屏运行日志。
      // 格式与 base.py 对齐:@@STAGE@@ slot=<int> stage=<name> status=<running|done> email=<email>
      const sm = line.match(/@@STAGE@@\s+slot=(\d+)\s+stage=(\S+)\s+status=(\S+)\s+email=(\S+)/);
      if (sm) {
        publish(jobId, 'worker-update', { worker: {
          workerId: Number(sm[1]) + (spec.slotBase || 0),   // split 两子进程槽位都从 0 起 → 按 spec 偏移防 workerId 撞车
          status: sm[3] === 'done' ? 'done' : 'running', stage: sm[2], account: sm[4],
        } });
        return;
      }
      const tagged = spec.tag ? `${spec.tag} ${line}` : line;
      publish(jobId, 'log', tagged);
      const r = parseResultLine(line);
      if (r) {
        // 结果行去重:onLine 同时挂在 stdout+stderr,且 Python 偶有重复打印 → 按账号名只计一次,防成败双计、UI 双事件。
        if (shared.seenResults.has(r.name)) return;
        shared.seenResults.add(r.name);
        if (r.ok) shared.counters.ok += 1; else shared.counters.fail += 1;
        // ★M5:实时结果行的 r.name 是 email 的 local-part(stdout 只打 local-part)→ 用【local-part→密码】表查,
        //   原来查 email-keyed 的 accByEmail 永远 miss → 无统一密码时实时事件密码恒空,「重跑(登录)」回填不进。
        //   跨域同名 local-part 撞车只影响实时显示(非权威,收口仍按全 email 的 mapRow),可接受;accByEmail 兜底兼容全 email 名。
        const _orig = (shared.accByLocal && shared.accByLocal.get(r.name)) || (shared.accByEmail && shared.accByEmail.get(r.name)) || '';
        // 现密码=统一密码(设了就用)否则原密码 → 与收口 mapRow(password=r.password||orig,r.password=op_pw)对齐。
        //   无统一密码时 shared.unifiedPw='' → 回退 _orig,默认逐字节不变。仅驱动 LIVE UI「重跑(登录)」回填,
        //   不参与续跑权威参数(走 successRows/failedRows 的 mapRow)/billing/charged → 无降级/重复扣款风险。
        const _pw = shared.unifiedPw || _orig;
        publish(jobId, r.ok ? 'account-success' : 'account-failed', { email: r.name, rendered: tagged, reason: r.ok ? '' : reasonFromLine(tagged), password: _pw, originalPassword: _orig });
        publish(jobId, 'runtime-stats', { jobDone: shared.counters.ok + shared.counters.fail, jobTotal: shared.total, browsersActive: 0, browsersMax: 0 });
      }
    };
    // 【B3 修】readline 接口存引用 + 挂 'error' 兜底:子进程被 kill 时 stdout/stderr 异常关闭会 emit error,
    //   原来没监听 → 未捕获 error 冒泡可能崩主进程;且 close 时主动 .close() 释放接口。
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on('line', onLine); rlOut.on('error', () => { /* 子进程被杀,流异常,忽略 */ });
    // ★崩溃可诊断:缓存本子进程 stderr 末尾若干行(python traceback/导入错都在 stderr)→ 崩溃(无结果)时落进
    //   summary.error + error-log,不再只甩一句"见运行日志"(日志本就没持久化)。环形缓冲只留最后 25 行,内存可控。
    const errBuf = [];
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on('line', (l) => { if (l) { errBuf.push(l); if (errBuf.length > 25) errBuf.shift(); } onLine(l); });
    rlErr.on('error', () => { /* 同上 */ });
    child.on('error', (e) => { publish(jobId, 'log', `${spec.label}进程错误: ${e && e.message}`); });
    child.on('close', (code, signal) => {
      try { rlOut.close(); rlErr.close(); } catch (_e) { /* ignore */ }
      procRegistry.unregister(jobId, child.pid);
      publish(jobId, 'log', `${spec.label}结束(code=${code}${signal ? ' signal=' + signal : ''})`);
      // 仅非零退出(且非被信号杀=非用户主动停)才带 stderr 尾,正常结束不留(免噪声/省内存)。
      const _crash = (typeof code === 'number' && code !== 0 && !signal);
      shared.exits.push({ started: true, code, signal, label: spec.label, stderrTail: _crash ? errBuf.slice(-15) : [] });
      resolve();
    });
  });
}

// 主入口:engine ∈ selenium | hybrid | split。payload 已带 accounts/proxies(server 解析好)。
// 返回 Promise<summary>(给 runsStore.finish)。
async function spawnEngine(jobId, engine, payload, publish) {
  const startedAt = Date.now();
  const env = buildEnv(payload);
  // 邮箱→原密码映射(结果行不含密码):流式 account-failed 带上它,前端「重跑(登录)」才能回填 email:密码,否则只剩 email: 空密码登不进。
  const shared = { engine, counters: { ok: 0, fail: 0 }, total: (payload.accounts || []).length, accByEmail: new Map((payload.accounts || []).map((a) => [a.email, a.password || ''])), accByLocal: new Map((payload.accounts || []).map((a) => [String(a.email || '').split('@')[0], a.password || ''])), unifiedPw: String(payload.unifiedPassword || '').trim(), seenResults: new Set() };

  // 并发钳制可见提示:maxConcurrency 把请求并发压低时,在【运行日志】显式告知(此前只 console.error 进服务端 stderr,
  //   控制台看不到→用户以为按填的并发在跑)。spawnEngine 内只算/发一次,避免 selenium/hybridArgs 重复打日志。
  try {
    const _reqC = Math.max(1, Number(payload.concurrency) || 1);
    const _clampedC = _clampConc(payload.concurrency, jobId);
    if (_clampedC < _reqC) {
      publish(jobId, 'log', `⚙ 并发已从 ${_reqC} 钳制到 ${_clampedC} 以保护 AdsPower(高级参数·并发硬上限 maxConcurrency)`
        + (engine === 'split' ? `;split 两引擎各 ${_clampedC} = 共 ${_clampedC * 2}` : ''));
    }
  } catch (_e) { /* 提示失败不影响起 job */ }

  let specs = [];
  let resultFiles = [];
  let startLines = {};
  try {
    if (engine === 'split') {
      const w = tempInputs.writeSplit(jobId, payload.accounts, payload.proxies, Number(payload.splitRatio));
      publish(jobId, 'log', `两引擎随机分流:Selenium 组 ${w.groupA.count} 个 / 混合组 ${w.groupB.count} 个`);
      startLines.selenium = countLines(RESULTS.selenium);
      startLines.hybrid = countLines(RESULTS.hybrid);
      // 多引擎共屏:两进程各自 slot 都从 0 起会叠窗(layout.py 用 GRID_TOTAL/GRID_SLOT_OFFSET 统一网格)。
      // 各进程跑 concurrency 个 worker(slot 0..C-1)→ 共同 GRID_TOTAL=2C,A 偏移 0、B 偏移 C → 两组窗口不重叠。
      const _c = _clampConc(payload.concurrency, jobId);   // 钳制后再算网格,保证窗口布局与实际 worker 数一致
      // 跨引擎衔接开 → 第一轮【秒关/快速失败】:Selenium 组撞新版取key向导即弃(转混合)、混合组绑卡撞图片九宫格即弃(转纯Sel)。
      // 引擎专属标志,互不误伤;第二轮(衔接重试)用 base env 不注 → 最终引擎全力尝试。
      const _ho = payload.crossHandoff !== false;
      const envA = { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: '0', ...(_ho ? { OPENROUTER_FAST_HANDOFF_KEY: '1' } : {}) };
      const envB = { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: String(_c), ...(_ho ? { OPENROUTER_FAST_HANDOFF_CARD: '1' } : {}) };
      specs = [
        { script: path.join(SELENIUM_DIR, 'run.py'), args: seleniumArgs(w.groupA.accFile, w.pxFile, payload, jobId), env: envA, label: '[引擎A·Selenium]', tag: '[A]', slotBase: 0 },
        { script: path.join(SELENIUM_DIR, 'hybrid_run.py'), args: hybridArgs(w.groupB.accFile, w.pxFile, payload, jobId), env: envB, label: '[引擎B·混合]', tag: '[B]', slotBase: _c },
      ];
      resultFiles = [RESULTS.selenium, RESULTS.hybrid];
      shared._splitPxFile = w.pxFile;   // 第二轮(跨引擎衔接)复用同一 proxies.txt(不重写代理)
      shared._splitClampC = _c;          // 第二轮沿用同一网格基数 GRID_TOTAL=2C
    } else {
      const w = tempInputs.write(jobId, payload.accounts, payload.proxies);
      const isHybrid = engine === 'hybrid';
      const script = path.join(SELENIUM_DIR, isHybrid ? 'hybrid_run.py' : 'run.py');
      const args = isHybrid ? hybridArgs(w.accFile, w.pxFile, payload, jobId) : seleniumArgs(w.accFile, w.pxFile, payload, jobId);
      const rf = isHybrid ? RESULTS.hybrid : RESULTS.selenium;
      startLines[isHybrid ? 'hybrid' : 'selenium'] = countLines(rf);
      specs = [{ script, args, env, label: isHybrid ? '[混合]' : '[Selenium]' }];
      resultFiles = [rf];
    }
  } catch (e) {
    publish(jobId, 'log', `准备输入文件失败: ${e && e.message}`);
    publish(jobId, 'job-done', { jobId, error: String(e && e.message) });
    tempInputs.cleanup(jobId);   // 早退也清临时输入(rel-1:writeSplit/write 可能已半写文件)
    return { jobId, total: shared.total, success: 0, failed: 0, durationMs: Date.now() - startedAt, error: String(e && e.message) };
  }

  try {
  await Promise.all(specs.map((s) => runSpec(jobId, s, publish, shared)));

  // 进程都结束 → 读结果文件本次新增行,作为权威结果。
  // 同引擎并发(两个 selenium/两个 hybrid 同时跑)会往同一 append-only 文件交错写,纯按行号 tail 会把对方的行算进自己 → 串号。
  // 故按【行级】判定:留本 job 的行(job_id===jobId)+ 无 job_id 的行(旧 Python 未重启,无从区分→保留);
  // 排除其它 job(不同 job_id)的行。比"文件级 all-or-nothing"稳:新旧 Python 混跑时不会把本 job 的结果整批丢掉。
  const _tailStats = { dropped: 0 };
  const harvest = (file, startLine) => readTail(file, startLine, _tailStats).filter((r) => r && (!r.job_id || r.job_id === jobId));
  let rows = [];
  if (engine === 'split' && payload.crossHandoff !== false) {
    // 跨引擎衔接:第一轮分别 harvest 两文件(用【来源文件】判定当前引擎),按规则分两桶,再跑唯一一轮第二轮,按 email 合并(第二轮覆盖)。
    const selRows = harvest(RESULTS.selenium, startLines.selenium);
    const hybRows = harvest(RESULTS.hybrid, startLines.hybrid);
    const toHybrid = new Set();    // selenium 新页面过不去 → 转混合
    const toSelenium = new Set();  // 混合 加卡人机验证过不去 → 转 selenium
    for (const r of selRows) if (r && r.email && handoffTarget(r, 'selenium') === 'hybrid') toHybrid.add(r.email);
    for (const r of hybRows) if (r && r.email && handoffTarget(r, 'hybrid') === 'selenium') toSelenium.add(r.email);
    // ★M3:收【原始行】不在此 last-wins 预折叠(预折叠会把"成功后又有迟到失败行"降级成失败,且后续无从恢复);
    //   最终统一用 dedupBySuccess(成功恒胜失败 + 同态取 at 最近)去重 → 第二轮成功仍覆盖第一轮失败,语义不变且更安全。
    rows = [...selRows, ...hybRows];

    if (toHybrid.size === 0 && toSelenium.size === 0) {
      // 无可衔接 → 跳过第二轮(零额外开销);rows 已含第一轮全部行
    } else {
      publish(jobId, 'log', `衔接重试:${toHybrid.size} 个新页面失败转混合 / ${toSelenium.size} 个人机验证失败转Selenium`);
      // 实时计数清账(仅影响 LIVE UI):被转号第一轮已 account-failed 且 local-part 进了 seenResults,
      // 删掉让第二轮结果能重新 emit 并回退 fail 计数;最终 summary 由合并 rows 重算,与此无关(best-effort,local-part 跨域撞车只影响实时显示)。
      for (const em of toHybrid)   { const nm = String(em).split('@')[0]; if (shared.seenResults.delete(nm)) shared.counters.fail -= 1; }
      for (const em of toSelenium) { const nm = String(em).split('@')[0]; if (shared.seenResults.delete(nm)) shared.counters.fail -= 1; }
      const pxFile = shared._splitPxFile;                                   // 复用第一轮的 proxies.txt
      const _c = shared._splitClampC || _clampConc(payload.concurrency, jobId);
      const p2specs = [];
      if (toHybrid.size) {
        const w2 = tempInputs.writeSubset(jobId, payload.accounts, toHybrid, 'accounts.handoff-hybrid.txt');
        if (w2.count) p2specs.push({ script: path.join(SELENIUM_DIR, 'hybrid_run.py'), args: hybridArgs(w2.accFile, pxFile, payload, jobId), env: { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: '0' }, label: '[衔接·混合]', tag: '[H→混合]', slotBase: 0 });
      }
      if (toSelenium.size) {
        const w2 = tempInputs.writeSubset(jobId, payload.accounts, toSelenium, 'accounts.handoff-selenium.txt');
        if (w2.count) p2specs.push({ script: path.join(SELENIUM_DIR, 'run.py'), args: seleniumArgs(w2.accFile, pxFile, payload, jobId), env: { ...env, GRID_TOTAL: String(_c * 2), GRID_SLOT_OFFSET: String(_c) }, label: '[衔接·Selenium]', tag: '[S→Sel]', slotBase: _c });
      }
      // 先记第二轮 startLines,再跑,只 harvest 第二轮新增行 → 与第一轮隔离
      const p2start = { selenium: countLines(RESULTS.selenium), hybrid: countLines(RESULTS.hybrid) };
      if (p2specs.length) await Promise.all(p2specs.map((s) => runSpec(jobId, s, publish, shared)));
      rows.push(...harvest(RESULTS.selenium, p2start.selenium), ...harvest(RESULTS.hybrid, p2start.hybrid));  // 第二轮新增行(成功覆盖第一轮由 dedupBySuccess 保证)
    }
  } else if (engine === 'split') {
    // ★F1/M3:收原始行,最终 dedupBySuccess 去重。AUTO_RETRY 让 run.py 对失败号追加【第二行结果】(同 email/job_id),
    //   不去重则同号既进 successRows 又进 failedRows → 双计 + 同号写进 success.jsonl 和 failed.jsonl + usage 记两条 + completeness>100%。
    rows = [...harvest(RESULTS.selenium, startLines.selenium), ...harvest(RESULTS.hybrid, startLines.hybrid)];
  } else {
    const key = engine === 'hybrid' ? 'hybrid' : 'selenium';
    // ★F1/M3:同上,收原始行交给 dedupBySuccess(成功恒胜)——AUTO_RETRY 重试成功行覆盖首轮失败行,每号唯一(不双计/不双写导出/不双记 usage)。
    rows = [...harvest(RESULTS[key], startLines[key])];
  }
  // ★第三桶「未完整/未运行」:本批无结果、历史也回填不到的号收进这里(逐号标原因),不再静默丢弃 → 每个输入号都有归宿。
  const incompleteRows = [];
  // 续跑被跳过的号(已完成/被拒/冷却/坏邮箱)本 job 没有结果行 → 控制台「本次任务」详情/计数看不到「跑过的号」。
  //   用它们【历史最近一行】回填进本 job 视图,让这些号可见。★只读回填、按 email 取历史 latest、ok/steps 原样(banned→failed、
  //   已绑→success),【绝不伪造成功】;只进 per-job 快照(writeDetail/writeBatchResults),不写 append-only results.jsonl(不污染权威源)。
  try {
    const haveEmails = new Set(rows.map((r) => r && r.email).filter(Boolean));
    const wantAccts = (payload.accounts || []).filter((a) => a && a.email && !haveEmails.has(a.email));
    if (wantAccts.length) {
      const files = engine === 'split' ? [RESULTS.selenium, RESULTS.hybrid] : [engine === 'hybrid' ? RESULTS.hybrid : RESULTS.selenium];
      // email → 历史代表行,【成功恒胜失败】(success-wins),非纯 at-latest。
      //   病因:跳过号若历史是「先成功(card-bound)后又有一条迟到失败行」(再跑加额度/改密失败),纯 at-latest 会回填那条失败行
      //   → 已成功的跳过号在本次视图里显示成失败(用户实测:"重跑成功的号还在失败里")。改 success-wins:有过成功就回填成功行。
      const latest = new Map();
      for (const f of files) {
        for (const r of readTail(f, 0, { dropped: 0 })) {
          if (!r || !r.email) continue;
          const prev = latest.get(r.email);
          if (!prev) { latest.set(r.email, r); continue; }
          const rs = isSuccessRow(r), ps = isSuccessRow(prev);
          if (rs && !ps) { latest.set(r.email, r); continue; }            // 成功胜失败
          if (!rs && ps) continue;                                         // 已有成功 → 保留,失败行不覆盖
          if (String(r.at || '') >= String(prev.at || '')) latest.set(r.email, r);  // 同态:取 at 更近者
        }
      }
      let _back = 0;
      for (const a of wantAccts) {
        const r = latest.get(a.email);
        if (r) { rows.push({ ...r, job_id: jobId, _resumed_skip: true }); _back += 1; }
        // 回填不到历史的号【不在这里处理】→ 交给后面 mapRow 之后的【未完整桶最终对账】(独立于本 try,抛错也不丢账)。
      }
      if (_back) publish(jobId, 'log', `续跑:${_back} 个已完成/跳过的号用历史结果回填进本次视图(不重跑、不改判定、不污染结果源)`);
    }
  } catch (_e) { /* 回填失败不致命,仅本 job 视图少几个跳过号(未完整桶最终对账仍会兜住它们) */ }
  // ★M3:全 email 唯一化 + 成功恒胜失败(success-wins),一处兜底替代各分支 last-wins —— 杜绝同号既进 success 又进 failed
  //   (双计 / 同号双写 success.jsonl+failed.jsonl / usage 双记 / completeness>100% / 成功号被迟到失败行降级)。回填行已是 success-wins,此处幂等。
  {
    const _dd = dedupBySuccess(rows);
    if (_dd.collapsed) publish(jobId, 'log', `去重:折叠 ${_dd.collapsed} 条同号重复结果行(成功恒胜失败)`);
    rows = _dd.rows;
  }
  // 把输入账号的原密码 join 回结果(结果文件不含密码)→ 导出/重跑能拿到 email:原密码
  const accByEmail = new Map((payload.accounts || []).map((a) => [a.email, a.password || '']));
  const successRows = [];
  const failedRows = [];
  for (const r of rows) { const [k, v] = mapRow(r, accByEmail); (k === 'success' ? successRows : failedRows).push(v); }
  // ★第三桶「未完整」最终对账(robust):每个【唯一输入邮箱】既不在成功也不在失败 → 收进未完整并标原因。
  //   独立于上面的回填 try(即便那里抛错也能兜住);按【唯一邮箱】去重天然不双计(修审计 DEFECT 2 的重复邮箱重计);
  //   无邮箱行 parseAccounts 已滤、这里再跳一次(DEFECT 1);_readIncompleteState 内部已防御,外层再 try 包住不致命。
  try {
    const _done = new Set();
    for (const v of successRows) if (v && v.email) _done.add(String(v.email).toLowerCase());
    for (const v of failedRows) if (v && v.email) _done.add(String(v.email).toLowerCase());
    const _seen = new Set();
    const _incState = _readIncompleteState();
    for (const a of (payload.accounts || [])) {
      const em = a && a.email ? String(a.email) : '';
      if (!em) continue;                                  // 无邮箱(理论上 parseAccounts 已滤)→ 跳
      const k = em.toLowerCase();
      if (_done.has(k) || _seen.has(k)) continue;         // 已成/已败 或 同邮箱已计 → 不双计
      _seen.add(k);
      const ci = classifyIncomplete(em, _incState);
      incompleteRows.push({ email: em, password: a.password || '', status: ci.status, reason: ci.reason });
    }
    if (incompleteRows.length) publish(jobId, 'log', `未完整:${incompleteRows.length} 个号本批没产出结果且历史查不到 → 收进「未完整」桶并逐号标原因(可只续跑这些)`);
  } catch (e) { publish(jobId, 'log', `⚠ 未完整桶对账失败(不影响成功/失败结果展示):${e && e.message}`); }
  // 桥接进账号台账(账号页/续跑读它):注册/key/billing/充值/卡/拉黑都合并进去,修"账号页对 Python 引擎一片空白"。
  try { await bridgeToAccountStore(rows); } catch (_e) { /* 桥接失败不影响 job 收口 */ }
  let success = successRows.length;
  let failed = failedRows.length;
  // 结果文件没拿到行(被中途 kill / 没写)→ 退回 stdout 解析计数
  if (!rows.length) { success = shared.counters.ok; failed = shared.counters.fail; }
  // 子进程异常退出(没起来 / 自行非零退出且非被 kill)且零结果 → 这是真失败,不能登记成 0/0 的"完成"。
  const exits = shared.exits || [];
  const crashed = exits.some((e) => !e.started || (typeof e.code === 'number' && e.code !== 0 && !e.signal));
  // ★崩溃可诊断:带上崩溃子进程的 stderr 末尾(python traceback/导入错)→ 落进 summary.error(runs.json 持久化、
  //   运行详情「异常」chip 可见),不再只甩"见运行日志"(日志没持久化,等于查不到)。
  const _crashExit = exits.find((e) => e && e.stderrTail && e.stderrTail.length);
  const _tail = _crashExit ? _crashExit.stderrTail : [];
  const crashError = (crashed && success === 0 && failed === 0)
    ? ('Python 子进程异常退出(无结果,python 未安装/导入失败/启动报错?)'
       + (_tail.length ? ' ‖ stderr末尾:' + _tail.join(' ⏎ ').slice(0, 600) : ' ‖ 无 stderr 输出(可能根本没启动)'))
    : '';
  if (_tail.length) { try { console.error('[' + jobId + '] Python 崩溃 stderr 末尾:\n' + _tail.join('\n')); } catch (_e) { /* ignore */ } }
  // 资源使用记录(诊断/排查用):host 反查 proxyId;Python 自动建环境 → envId 留空(诚实)。
  try {
    const pxByHost = new Map(proxyStore.list().map((p) => [p.host, p.id]));
    const host = (s) => String(s || '').split(':')[0];
    const usage = [
      ...successRows.map((v) => ({ jobId, engine, email: v.email, host: host(v.proxy), exitIp: v.exitIp || '', proxyId: pxByHost.get(host(v.proxy)) || '', cardLast4: v.cardLast4 || '', envId: '', endpoint: '', stage: 'done', ok: true, reason: '' })),
      ...failedRows.map((v) => ({ jobId, engine, email: v.email, host: host(v.proxy), exitIp: '', proxyId: pxByHost.get(host(v.proxy)) || '', cardLast4: '', envId: '', endpoint: '', stage: v.stage || '', ok: false, reason: v.reason || '' })),
    ];
    usageStore.recordMany(usage);
  } catch (_e) { /* 使用记录失败不致命 */ }
  // 结果落盘:失败不再静默(be-8)。tail 丢行(be-4)/落盘失败都告警到运行日志,
  // 避免前端看到"完成"却拿到残缺的下载/详情而毫无提示。
  if (_tailStats.dropped) publish(jobId, 'log', `⚠ 结果文件有 ${_tailStats.dropped} 行无法解析被跳过 —— 这些账号可能未计入结果(磁盘/编码/半写?)`);
  const _wd = writeDetail(jobId, engine, successRows, failedRows, incompleteRows);   // 每 job 详情快照(成功/失败/未完整三桶;Python 结果文件是 append-only 非 per-job)
  // 写 Node 同款 batch-results(txt 按用户模板渲染 + jsonl 映射后形状)→ 下载/聚合/详情 对 Python 也生效
  const _wb = writeBatchResults(jobId, successRows, failedRows, payload.successTemplate, payload.failureTemplate);
  if ((_wd && !_wd.ok) || (_wb && !_wb.ok)) publish(jobId, 'log', `⚠ 结果落盘失败(下载/详情/聚合可能不全): ${(_wd && _wd.error) || ''} ${(_wb && _wb.error) || ''}`.trim());
  // 结果对账(split 尤其需要):有结果但【不足总数】= 某分流组/子进程疑似中途退出、丢了那批账号的结果。
  //   不改判定(成败仍按真实结果),只【标记 + 告警】让运行日志/历史可见,提示可「续跑这批」补齐。
  const resultCount = success + failed;
  const completenessPct = Math.round((100 * resultCount) / Math.max(1, shared.total));
  const partial = resultCount > 0 && resultCount < shared.total;   // >0 且 <total:部分结果(区别于 crashError 的零结果整崩)
  const summary = { jobId, total: shared.total, success, failed, incomplete: incompleteRows.length, durationMs: Date.now() - startedAt, engine, resultFiles, completenessPct, ...(partial ? { partial: true } : {}), ...(crashError ? { error: crashError } : {}) };
  if (partial) publish(jobId, 'log', `⚠ 结果可能未完整:${resultCount}/${shared.total}(${completenessPct}%)—— 某分流组/子进程疑似中途退出丢了部分账号结果,可用「续跑这批」补齐`);
  if (crashError) publish(jobId, 'log', crashError);
  publish(jobId, 'job-done', summary);
  return summary;
  } finally {
    tempInputs.cleanup(jobId);   // ★ 不管 Promise.all/后处理是否抛错,临时输入文件都必清(rel-1)
  }
}

// 部署引导用:真跑一次 adspower_env.py --selftest(建→启→接管→停→删)验证 AdsPower 能否【真开浏览器】——
//   光 ping /status 不够,license/额度/内核不匹配等只有真开才暴露。带死线+SIGKILL 兜底;python 自测自身 finally 删环境防孤儿。
//   串行锁 _selftestRunning:同一时刻只允许一个自测;"勿与真任务同跑"由调用方(server)用 procRegistry 把关。
let _selftestRunning = false;
function adspowerSelftest({ timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    if (_selftestRunning) return resolve({ ok: false, busy: true, detail: '已有一个 AdsPower 自测在跑,请稍候再试' });
    _selftestRunning = true;
    let out = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; _selftestRunning = false; resolve(r); };
    let child;
    try {
      child = safeSpawn(pythonBin(), [path.join(SELENIUM_DIR, 'services', 'adspower_env.py'), '--selftest'], { cwd: SELENIUM_DIR, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish({ ok: false, detail: 'python 启动失败: ' + (e && e.message) }); }
    if (!child.pid) return finish({ ok: false, detail: '未拿到 pid(python 未安装?设环境变量 OPENROUTER_PYTHON)' });
    const cap = (b) => { out += String(b); if (out.length > 24000) out = out.slice(-24000); };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    // ★超时 SIGKILL 会绕过 python 的 finally(删环境)→ 若此时环境已建会残留 `_selftest_` 孤儿。
    //   根治:杀掉后【自动跑一次 --cleanup-selftest 扫删孤儿】(独立短进程、best-effort、自带 20s 死线),不再依赖被杀进程跑 finally。
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_e) { /* 已退出 */ }
      let cleaned = false;
      try {
        const cl = safeSpawn(pythonBin(), [path.join(SELENIUM_DIR, 'services', 'adspower_env.py'), '--cleanup-selftest'], { cwd: SELENIUM_DIR, env: process.env, stdio: 'ignore' });
        cleaned = !!(cl && cl.pid);
        const clKill = setTimeout(() => { try { cl.kill('SIGKILL'); } catch (_e) { /* 已退出 */ } }, 20000);
        cl.on('close', () => clearTimeout(clKill));
        cl.on('error', () => clearTimeout(clKill));
      } catch (_e) { /* 清理进程都起不来→只能提示手动删 */ }
      finish({ ok: false, detail: `自测超时(>${Math.round(timeoutMs / 1000)}s)被终止 —— AdsPower 未响应或开浏览器太慢;`
        + (cleaned ? '已自动清理可能残留的 _selftest 环境(后台进行)。' : '★可能残留一个「_selftest_」环境,请到 AdsPower 客户端手动删除。'), log: out.slice(-1500) });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(killer); finish({ ok: false, detail: '进程错误: ' + (e && e.message), log: out.slice(-1500) }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      const ok = /指纹一致性/.test(out);   // 真开成浏览器 + 读到指纹 = 通过(环境已在 python finally 删)
      const detail = ok
        ? 'AdsPower 可正常开浏览器(已建→启→接管→停→删,无残留环境)'
        : /启动\/接管异常/.test(out) ? '建了环境但开浏览器/接管失败 —— 见日志(内核版本 / license?)'
          : '建环境失败 —— 检查 AdsPower 是否开着、Local API、额度或密钥';
      finish({ ok, detail, code, log: out.slice(-1500) });
    });
  });
}

module.exports = { spawnEngine, RESULTS, isSuccessRow, dedupBySuccess, classifyIncomplete, purchaseOutcome, readTail, countLines, readDetail, mapRow, renderTpl, handoffTarget, bridgeToAccountStore, isNotAllowed, pyFailReason, reasonFromLine, adspowerSelftest };
