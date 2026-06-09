'use strict';

// 前端控制台逻辑：提交表单 → POST /jobs → 用 jobId 打开 SSE → 实时渲染。

const $ = (id) => document.getElementById(id);

const els = {
  form: $('jobForm'),
  startBtn: $('startBtn'),
  formMsg: $('formMsg'),
  statTotal: $('statTotal'),
  statSuccess: $('statSuccess'),
  statFailed: $('statFailed'),
  statBrowsers: $('statBrowsers'),
  statQueued: $('statQueued'),
  workerGrid: $('workerGrid'),
  successLog: $('successLog'),
  failureStats: $('failureStats'),
  runLog: $('runLog'),
  downloadBtn: $('downloadBtn'),
  cardPool: $('cardPool'),
  cardMsg: $('cardMsg'),
  failLog: $('failLog'),
  failTable: $('failTable'),
  downloadFailedBtn: $('downloadFailedBtn'),
  requeueFailedBtn: $('requeueFailedBtn'),
};

// 失败账号累积（供失败明细表 + 重跑登录模式）。
const failedAccounts = [];

if (els.downloadBtn) {
  els.downloadBtn.addEventListener('click', () => {
    if (currentJobId) window.open(withToken(`/download?jobId=${encodeURIComponent(currentJobId)}`), '_blank');
  });
}
if (els.downloadFailedBtn) {
  els.downloadFailedBtn.addEventListener('click', () => {
    if (currentJobId) window.open(withToken(`/download?type=failed&jobId=${encodeURIComponent(currentJobId)}`), '_blank');
  });
}
// 重跑失败账号：把失败的 email:原密码 填回账号框 + 切「仅登录」+ 滚到顶。
// 对应「账号已存在 → 勾登录 → 继续取 Key/充值」的省时操作。
if (els.requeueFailedBtn) {
  els.requeueFailedBtn.addEventListener('click', () => {
    if (!failedAccounts.length) return;
    const lines = failedAccounts.map((d) => `${d.email}:${d.originalPassword || d.password || ''}`).join('\n');
    if (els.form.elements.accountsRaw) els.form.elements.accountsRaw.value = lines;
    if (els.form.elements.mode) els.form.elements.mode.value = 'login';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    els.formMsg.textContent = `已把 ${failedAccounts.length} 个失败账号填回（已切「仅登录」），核对后点开始执行`;
  });
}

// 失败明细：按错误类型分 tab + 每类的恢复策略 + 自动配置重跑。
const ESC = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const ACTION_LABEL = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑(不重试)', abort: '放弃' };
let failType = '__all__';
const POLICY_MAP = {}; // code -> { why, action, maxRetries }
async function loadPolicyMap() {
  try {
    const r = await authFetch('/api/policy', {}, true); if (!r || !r.ok) return;
    const d = await r.json();
    (d.policy || []).forEach((p) => { POLICY_MAP[p.code] = { why: p.why, action: p.effective && p.effective.action, maxRetries: p.effective && p.effective.maxRetries }; });
    renderFailDetail();
  } catch (_e) { /* ignore */ }
}
function failGroups() {
  const g = {};
  failedAccounts.forEach((d) => { const k = d.reason || 'UNKNOWN'; (g[k] = g[k] || []).push(d); });
  return g;
}
function dominantStage(list) {
  const c = {}; let best = '', n = 0;
  list.forEach((d) => { const s = d.stage || ''; c[s] = (c[s] || 0) + 1; if (c[s] > n) { n = c[s]; best = s; } });
  return best;
}
function setCb(id, val) { const cb = $(id); if (cb && cb.checked !== val) { cb.checked = val; cb.dispatchEvent(new Event('change')); } }
function applyTargetStage(stage) {
  // 按主要失败步骤把表单阶段配好；其余靠断点续跑自动补/跳过。
  if (stage === 'api-key') setCb('pkApiKey', true);
  else if (stage === 'billing-card-topup') setCb('pkCharge', true);
  else if (stage === 'export') {
    setCb('pkApiKey', true); setCb('pkCharge', true);
    const pw = $('pkPwd'); if (pw && !pw.disabled) { pw.checked = true; pw.dispatchEvent(new Event('change')); }
  }
  // 注册/邮箱/代理阶段失败 → 不强改阶段，走全流程
}
function autoConfigRerun(code, list) {
  if (!list.length) return;
  const pol = POLICY_MAP[code] || {}; const action = pol.action || 'retry';
  const F = els.form.elements;
  if (F.accountsRaw) F.accountsRaw.value = list.map((d) => `${d.email}:${d.originalPassword || d.password || ''}`).join('\n');
  if (F.resume) F.resume.checked = true;
  if (F.mode) F.mode.value = (action === 'relogin' || code === 'ACCOUNT_ALREADY_EXISTS') ? 'login' : 'auto';
  applyTargetStage(dominantStage(list));
  let note = `已按【${ACTION_LABEL[action] || action}】策略填入 ${list.length} 个「${code}」账号`;
  if (action === 'blacklist') note += '；⚠ 这些账号已判拉黑，需先到「成功账号/聚合」页的账号状态里解黑再跑';
  else if (action === 'retry-new-proxy') note += '；建议在「代理」框换一批新代理再跑';
  else if (dominantStage(list) === 'export' && !String((F.unifiedPassword && F.unifiedPassword.value) || '').trim()) note += '；改密需先填「统一密码」';
  els.formMsg.textContent = `${note}，核对后点「开始执行」`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderFailDetail() {
  if (!els.failTable) return;
  const groups = failGroups();
  const codes = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const bar = $('failTypeBar');
  if (bar) {
    bar.innerHTML = failedAccounts.length
      ? [`<button type="button" class="ftab ${failType === '__all__' ? 'on' : ''}" data-ft="__all__">全部 (${failedAccounts.length})</button>`]
        .concat(codes.map((c) => `<button type="button" class="ftab ${failType === c ? 'on' : ''}" data-ft="${ESC(c)}">${ESC(c)} (${groups[c].length})</button>`)).join('')
      : '';
  }
  if (failType !== '__all__' && !groups[failType]) failType = '__all__';
  const list = failType === '__all__' ? failedAccounts : (groups[failType] || []);
  const strat = $('failStrategy');
  if (strat) {
    if (failType === '__all__' || !failedAccounts.length) strat.innerHTML = '';
    else {
      const pol = POLICY_MAP[failType] || {}; const act = pol.action || 'retry';
      strat.innerHTML = `<div class="fs-box">
        <div><b>${ESC(failType)}</b>${pol.why ? ` — ${ESC(pol.why)}` : ''}</div>
        <div class="muted">恢复策略：<b>${ACTION_LABEL[act] || act}</b>${pol.maxRetries != null ? ` · 重试 ${pol.maxRetries} 次` : ''}（运行时按此自动执行；下面按钮把表单也配好）</div>
        <button type="button" class="link-btn" id="autoCfgBtn">🔧 自动配置重跑（${list.length}）</button>
      </div>`;
    }
  }
  if (!list.length) { els.failTable.classList.add('muted'); els.failTable.innerHTML = '暂无失败'; return; }
  els.failTable.classList.remove('muted');
  const rows = list.map((d) => `<tr class="bad">
    <td>${ESC(d.email || '')}</td>
    <td>${ESC(STAGE_LABELS[d.stage] || d.stage || '—')}</td>
    <td>${ESC(d.reason || '')}</td>
    <td>${d.attempts || 1}</td>
    <td class="err" title="${ESC(d.detail || '')}">${ESC((d.detail || '').slice(0, 40))}</td>
  </tr>`).join('');
  els.failTable.innerHTML = `<table class="card-table">
    <thead><tr><th>邮箱</th><th>失败步骤</th><th>原因</th><th>尝试</th><th>详情</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
// 失败类型 tab 切换 + 自动配置按钮（事件委托）。
document.addEventListener('click', (e) => {
  const tab = e.target.closest('#failTypeBar .ftab');
  if (tab) { failType = tab.dataset.ft; renderFailDetail(); return; }
  if (e.target.closest('#autoCfgBtn') && failType !== '__all__') {
    const list = failGroups()[failType] || [];
    autoConfigRerun(failType, list);
  }
});

// ── 卡池统计 ──────────────────────────────────────────────────────────────
const STATUS_LABEL = { active: '可用', exhausted: '用尽', declined: '被拒', disabled: '已禁用' };
function shortTime(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_e) { return s; }
}
function renderCardPool(cards) {
  if (!els.cardPool) return;
  if (!cards || !cards.length) { els.cardPool.classList.add('muted'); els.cardPool.innerHTML = '尚无卡片，去左侧「卡池导入」'; return; }
  els.cardPool.classList.remove('muted');
  const rows = cards.map((c) => {
    const cls = c.status === 'active' ? 'ok' : (c.status === 'declined' ? 'bad' : 'mute');
    const toggle = (c.status === 'disabled')
      ? `<button data-act="enable" data-id="${c.id}" class="mini">启用</button>`
      : `<button data-act="disable" data-id="${c.id}" class="mini">禁用</button>`;
    return `<tr class="${cls}">
      <td>${c.masked}</td><td>${c.exp}</td>
      <td>${STATUS_LABEL[c.status] || c.status}${c.inUse ? ' ·用中' : ''}</td>
      <td class="maxcell"><input type="number" class="maxedit" data-id="${c.id}" value="${c.maxUses}" min="1" max="100" title="可改：每张卡能用几次" /></td>
      <td>${c.usedCount}</td><td><b>${c.remaining}</b></td>
      <td>${c.successCount}</td><td>${c.declineCount}</td>
      <td>${shortTime(c.lastUsedAt)}</td>
      <td class="err" title="${(c.lastError || '').replace(/"/g, '&quot;')}">${c.lastError ? (c.lastError.slice(0, 22)) : '—'}</td>
      <td class="acts">${toggle}
        <button data-act="reset" data-id="${c.id}" class="mini">重置</button>
        <button data-act="remove" data-id="${c.id}" class="mini danger">删除</button>
      </td>
    </tr>`;
  }).join('');
  els.cardPool.innerHTML = `<table class="card-table">
    <thead><tr><th>卡号</th><th>有效期</th><th>状态</th><th>可用次数</th><th>已用</th><th>剩余</th><th>成功</th><th>被拒</th><th>最近用</th><th>最近错误</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
async function fetchCardPool() {
  try {
    const resp = await authFetch('/api/cards', {}, true);
    if (!resp || !resp.ok) return;
    const d = await resp.json();
    renderCardPool(d.cards);
  } catch (_e) { /* ignore */ }
}
async function cardAction(act, body) {
  const resp = await authFetch(`/api/cards/${act}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const d = await resp.json();
  if (d.cards) renderCardPool(d.cards);
  return d;
}
// 事件委托：禁用/启用/重置/删除按钮
if (els.cardPool) {
  els.cardPool.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'remove' && !confirm('确定从卡池删除这张卡？')) return;
    try { await cardAction(btn.dataset.act, { id: btn.dataset.id }); } catch (_e) { /* ignore */ }
  });
  // 内联修改「可用次数」：失焦或回车即保存。
  const saveMax = async (inp) => {
    const v = Math.max(1, Math.min(100, Number(inp.value) || 1));
    inp.value = v;
    try { await cardAction('update', { id: inp.dataset.id, maxUses: v }); } catch (_e) { /* ignore */ }
  };
  els.cardPool.addEventListener('change', (e) => { const inp = e.target.closest('input.maxedit'); if (inp) saveMax(inp); });
  els.cardPool.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const inp = e.target.closest('input.maxedit'); if (inp) { inp.blur(); } } });
}
function bindBtn(id, fn) { const b = $(id); if (b) b.addEventListener('click', fn); }
bindBtn('importCardsBtn', async () => {
  const raw = (els.form.elements.cardsRaw && els.form.elements.cardsRaw.value) || '';
  const maxUses = (els.form.elements.cardMaxUses && els.form.elements.cardMaxUses.value) || 10;
  if (!raw.trim()) { if (els.cardMsg) els.cardMsg.textContent = '卡池导入框为空'; return; }
  if (els.cardMsg) els.cardMsg.textContent = '导入中…';
  try {
    const resp = await authFetch('/api/cards/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardsRaw: raw, maxUses: Number(maxUses) || 10 }),
    });
    const d = await resp.json();
    renderCardPool(d.cards);
    const errN = (d.parseErrors || []).length;
    if (els.cardMsg) els.cardMsg.textContent = `新增 ${d.added} · 更新 ${d.updated}${errN ? ` · ${errN} 行无法解析` : ''} · 可用 ${d.available}`;
    // 成功导入后清空输入框（已进卡池，避免重复粘贴误导）。
    if (els.form.elements.cardsRaw) els.form.elements.cardsRaw.value = '';
  } catch (err) { if (els.cardMsg) els.cardMsg.textContent = `导入失败：${err.message}`; }
});
bindBtn('refreshCardsBtn', fetchCardPool);
bindBtn('refreshCards2Btn', fetchCardPool);
bindBtn('clearCardsBtn', async () => {
  if (!confirm('确定清空整个卡池？此操作不可撤销。')) return;
  try { await cardAction('clear', {}); if (els.cardMsg) els.cardMsg.textContent = '卡池已清空'; } catch (_e) { /* ignore */ }
});
window.addEventListener('load', fetchCardPool);

// ── 充值台账（按邮箱记账）─────────────────────────────────────────────────
const BILL_LABEL = { success: '✓充值', 'card-bound': '✓加卡', 'address-bound': '✓地址', declined: '✗被拒', 'no-card': '无卡', 'no-address': '无地址', skipped: '跳过' };
function renderBilling(s) {
  const box = $('billingLedger');
  if (!box || !s) return;
  const entries = s.entries || [];
  const byCard = Object.entries(s.byCard || {}).map(([k, v]) => `••${k}: ${v.count}次/$${v.charged}`).join('　');
  const head = `<div class="bill-summary">
    <span class="chip cls">总充值 $${s.totalCharged || 0}</span>
    <span class="chip cls">成功 ${s.success || 0}</span>
    <span class="chip">被拒 ${s.declined || 0}</span>
    <span class="muted">${byCard}</span>
    <button type="button" id="clearBillBtn" class="link-btn">清空台账</button>
  </div>`;
  if (!entries.length) { box.classList.remove('muted'); box.innerHTML = head + '<div class="muted">暂无充值记录</div>'; return; }
  box.classList.remove('muted');
  const rows = entries.map((e) => `<tr class="${e.result === 'success' ? 'ok' : (e.result === 'declined' ? 'bad' : 'mute')}">
    <td>${shortTime(e.at)}</td><td>${e.email}</td><td>${e.cardLast4 ? '••' + e.cardLast4 : '—'}</td>
    <td>${e.charged ? '$' + e.charged : '—'}</td><td>${BILL_LABEL[e.result] || e.result}</td>
    <td class="err" title="${(e.error || '').replace(/"/g, '&quot;')}">${e.error ? e.error.slice(0, 22) : ''}</td>
  </tr>`).join('');
  box.innerHTML = head + `<table class="card-table">
    <thead><tr><th>时间</th><th>邮箱</th><th>卡</th><th>金额</th><th>结果</th><th>错误</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  const cb = $('clearBillBtn');
  if (cb) cb.addEventListener('click', async () => {
    if (!confirm('确定清空充值台账？')) return;
    try { const r = await authFetch('/api/billing/clear', { method: 'POST' }); renderBilling(await r.json()); } catch (_e) { /* ignore */ }
  });
}
async function fetchBilling() {
  try { const r = await authFetch('/api/billing', {}, true); if (r && r.ok) renderBilling(await r.json()); } catch (_e) { /* ignore */ }
}
bindBtn('refreshBillBtn', fetchBilling);
window.addEventListener('load', fetchBilling);

// 地址来源切换：手动池 ↔ 随机生成。

// 地址来源切换：手动池 ↔ 随机生成（随机模式显示「免税州」，手动模式显示地址池）。
(function () {
  const sel = $('addressMode');
  const wrap = $('addressPoolWrap');
  const states = $('statesWrap');
  if (!sel) return;
  const sync = () => {
    const pool = sel.value === 'pool';
    if (wrap) wrap.style.display = pool ? '' : 'none';
    if (states) states.style.display = pool ? 'none' : '';
  };
  sel.addEventListener('change', sync);
  sync();
})();

// 阶段勾选清单 → 推导 billingAction（隐藏域）+ 级联联动 + 流程条高亮 + chargeOpts 显隐。
(function () {
  const billing = $('billingAction'); // 隐藏域，承载推导出的 none/address/card/charge
  const opts = $('chargeOpts');
  const cbKey = $('pkApiKey'); const cbAddr = $('pkAddress'); const cbCard = $('pkCard'); const cbCharge = $('pkCharge'); const cbPwd = $('pkPwd');
  if (!billing || !cbAddr) return;
  const pwd = els.form.elements.unifiedPassword;
  // 账单档位 = 勾选里最深的一档（独立勾选、不级联；底层依赖由 billing 阶段/断点续跑自动补齐）。
  const deriveAction = () => (cbCharge.checked ? 'charge' : cbCard.checked ? 'card' : cbAddr.checked ? 'address' : 'none');
  const updateStageFlow = () => {
    const on = { register: true, apikey: cbKey.checked, address: cbAddr.checked, card: cbCard.checked, charge: cbCharge.checked, pwd: cbPwd.checked };
    document.querySelectorAll('#stageFlow .stg').forEach((s) => s.classList.toggle('on', !!on[s.dataset.stg]));
  };
  // 改密前置（用户规则）：取Key + 充值 + 统一密码 三者齐全才可勾；缺一即禁用置灰。
  const syncPwd = () => {
    const ok = !!(pwd && pwd.value.trim()) && cbKey.checked && cbCharge.checked;
    cbPwd.disabled = !ok;
    if (cbPwd.parentElement) cbPwd.parentElement.classList.toggle('disabled', !ok);
    if (!ok) cbPwd.checked = false;
    else if (!cbPwd.dataset.touched) cbPwd.checked = true;
  };
  const sync = () => {
    billing.value = deriveAction();
    if (opts) opts.style.display = (cbCard.checked || cbCharge.checked) ? '' : 'none';
    syncPwd();
    updateStageFlow();
  };
  // 独立勾选，互不联动；任一变化只重新推导档位/前置/流程条。
  [cbAddr, cbCard, cbCharge, cbKey].forEach((cb) => cb.addEventListener('change', sync));
  cbPwd.addEventListener('change', () => { cbPwd.dataset.touched = '1'; updateStageFlow(); });
  if (pwd) pwd.addEventListener('input', sync);
  sync();
})();

// 标签页切换（卡池 / 台账 / 失败明细 / 日志）。
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
}
(function () {
  const tabs = document.getElementById('tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab); });
})();
// 「失败明细」跳转链接：切到该标签并滚到可见处。
(function () {
  const lnk = $('failJumpLink');
  if (lnk) lnk.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab('faildetail');
    const p = document.querySelector('.tab-pane[data-pane="faildetail"]');
    if (p) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
})();
// 失败标签红点：显示失败数。
function updateFailBadge() {
  const tab = document.querySelector('.tab[data-tab="faildetail"]');
  if (!tab) return;
  const n = failedAccounts.length;
  let b = tab.querySelector('.badge-n');
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'badge-n'; tab.appendChild(b); }
  b.textContent = n;
}

let evtSource = null;
let currentJobId = null;
const counters = { total: 0, success: 0, failed: 0 };
const workers = {}; // workerId -> { status, stage, account }

const STAGE_LABELS = {
  'waiting-slot': '排队等待', 'proxy-precheck': '代理预检', 'email-password-change': '邮箱改密',
  'openrouter-register': '注册', 'magic-link-login': '邮箱验证', 'api-key': '创建Key',
  'billing-card-topup': '充值', 'export': '导出',
};

function renderWorkerGrid() {
  const ids = Object.keys(workers).map(Number).sort((a, b) => a - b);
  if (!ids.length) { els.workerGrid.innerHTML = '尚未开始'; els.workerGrid.classList.add('muted'); return; }
  els.workerGrid.classList.remove('muted');
  els.workerGrid.innerHTML = ids.map((id) => {
    const w = workers[id];
    const cls = w.status === 'queued' ? 'queued'
      : (w.status === 'done' || w.status === 'idle') ? 'done'
        : w.status === 'failed' ? 'failed' : 'running';
    const stage = STAGE_LABELS[w.stage] || w.stage || w.status || '';
    return `<div class="wk ${cls}"><div class="wk-id">W${id}</div><div class="wk-stage">${stage}</div><div class="wk-acct">${w.account || ''}</div></div>`;
  }).join('');
}

function resetView(total) {
  counters.total = total;
  counters.success = 0;
  counters.failed = 0;
  Object.keys(workers).forEach((k) => delete workers[k]);
  els.statTotal.textContent = total;
  els.statSuccess.textContent = '0';
  els.statFailed.textContent = '0';
  els.statBrowsers.textContent = '0/0';
  els.statQueued.textContent = '0';
  renderWorkerGrid();
  els.successLog.textContent = '';
  els.failureStats.textContent = '暂无';
  els.failureStats.classList.add('muted');
  els.runLog.textContent = '';
  // 清空失败面板
  failedAccounts.length = 0;
  failType = '__all__';
  if (els.failLog) els.failLog.textContent = '';
  const jump = $('failJump'); if (jump) jump.hidden = true;
  renderFailDetail();
  if (els.downloadFailedBtn) els.downloadFailedBtn.disabled = true;
  if (els.requeueFailedBtn) els.requeueFailedBtn.disabled = true;
  if (typeof updateFailBadge === 'function') updateFailBadge();
}

function appendLine(el, text) {
  el.textContent += (el.textContent ? '\n' : '') + text;
  el.scrollTop = el.scrollHeight;
}

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function openStream(jobId) {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(withToken(`/events?jobId=${encodeURIComponent(jobId)}`));

  evtSource.addEventListener('connected', () => appendLine(els.runLog, `[${ts()}] SSE 已连接 (${jobId})`));

  evtSource.addEventListener('log', (e) => appendLine(els.runLog, `[${ts()}] ${JSON.parse(e.data)}`));

  evtSource.addEventListener('worker-update', (e) => {
    const d = JSON.parse(e.data) || {};
    const w = d.worker || {};
    if (w.workerId != null) {
      const prev = workers[w.workerId] || {};
      // stage/account 为空时保留上一次的值,避免编排层的空 stage 覆盖真实阶段。
      workers[w.workerId] = {
        status: w.status || prev.status,
        stage: w.stage || prev.stage,
        account: w.account || prev.account,
      };
      renderWorkerGrid();
    }
  });

  evtSource.addEventListener('runtime-stats', (e) => {
    const s = JSON.parse(e.data) || {};
    els.statBrowsers.textContent = `${s.browsersActive || 0}/${s.browsersMax || 0}`;
    els.statQueued.textContent = String((s.browsersQueued || 0));
  });

  evtSource.addEventListener('account-success', (e) => {
    const d = JSON.parse(e.data) || {};
    counters.success += 1;
    els.statSuccess.textContent = counters.success;
    appendLine(els.successLog, d.rendered || JSON.stringify(d.raw));
  });

  evtSource.addEventListener('account-failed', (e) => {
    const d = JSON.parse(e.data) || {};
    counters.failed += 1;
    els.statFailed.textContent = counters.failed;
    // 失败回显行（email:密码 | 原因）
    appendLine(els.failLog, d.rendered || `${d.email || ''} | ${d.reason || ''}`);
    appendLine(els.runLog, `[${ts()}] ✗ ${d.email || ''} → ${d.reason} (${d.failClass})`);
    failedAccounts.push(d);
    renderFailDetail();
    updateFailBadge();
    const jump = $('failJump'); if (jump) jump.hidden = false; // 出现失败即提示去「失败明细」看分组
    if (els.downloadFailedBtn) els.downloadFailedBtn.disabled = false;
    if (els.requeueFailedBtn) els.requeueFailedBtn.disabled = false;
  });

  evtSource.addEventListener('card-stats', (e) => {
    const d = JSON.parse(e.data) || {};
    if (d.pool) renderCardPool(d.pool);
    if (d.last && d.last.last4) {
      const r = d.last.result === 'success' ? '✓充值成功' : (d.last.result === 'declined' ? '✗被拒' : '✗错误');
      appendLine(els.runLog, `[${ts()}] 卡 ••${d.last.last4} ${r}${d.last.error ? ' ' + d.last.error : ''}`);
    }
  });

  evtSource.addEventListener('billing-stats', (e) => {
    const d = JSON.parse(e.data) || {};
    if (d.summary) renderBilling(d.summary);
  });

  evtSource.addEventListener('failure-stats', (e) => {
    const s = JSON.parse(e.data) || {};
    els.failureStats.classList.remove('muted');
    const byReason = Object.entries(s.byReason || {})
      .map(([k, v]) => `<span class="chip">${k}: ${v}</span>`).join('');
    const byClass = Object.entries(s.byClass || {})
      .map(([k, v]) => `<span class="chip cls">${k}: ${v}</span>`).join('');
    els.failureStats.innerHTML = `<div>合计 ${s.total || 0}</div><div class="chips">${byClass}${byReason}</div>`;
  });

  evtSource.addEventListener('job-done', (e) => {
    const s = JSON.parse(e.data) || {};
    els.statBrowsers.textContent = '0/' + (els.statBrowsers.textContent.split('/')[1] || '0');
    els.statQueued.textContent = '0';
    appendLine(els.runLog, `[${ts()}] ✓ 任务结束：成功 ${s.success || 0} / 失败 ${s.failed || 0} / 用时 ${s.durationMs || 0}ms`);
    els.startBtn.disabled = false;
    evtSource.close();
    evtSource = null;
  });

  evtSource.onerror = () => appendLine(els.runLog, `[${ts()}] SSE 连接中断`);
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(els.form);
  const payload = {
    accountsRaw: fd.get('accountsRaw') || '',
    proxiesRaw: fd.get('proxiesRaw') || '',
    headed: fd.get('headed') === 'on',
    resume: fd.get('resume') === 'on',
    concurrency: fd.get('concurrency'),
    count: fd.get('count'),
    mode: fd.get('mode') || 'register',
    unifiedPassword: fd.get('unifiedPassword') || '',
    apiKeyName: fd.get('apiKeyName') || '',
    apiKeyExpiration: fd.get('apiKeyExpiration') || 'No expiration',
    topUpAmount: fd.get('topUpAmount'),
    billingAction: fd.get('billingAction') || 'none',
    doApiKey: fd.get('doApiKey') === 'on',
    doPasswordChange: fd.get('doPasswordChange') === 'on',
    maxCardTries: fd.get('maxCardTries') || 3,
    addressMode: fd.get('addressMode') || 'random',
    addressStates: fd.get('addressStates') || '',
    billingAddressesRaw: fd.get('billingAddressesRaw') || '',
    billingAddressStrategy: fd.get('billingAddressStrategy') || 'random',
    cardsRaw: fd.get('cardsRaw') || '',
    cardMaxUses: fd.get('cardMaxUses') || 10,
    successTemplate: fd.get('successTemplate') || '',
    failureTemplate: fd.get('failureTemplate') || '',
  };

  els.startBtn.disabled = true;
  els.formMsg.textContent = '提交中…';
  try {
    const resp = await authFetch('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || data.error || '提交失败');
    els.formMsg.textContent = `已接受 ${data.accepted} 个账号 · ${data.jobId}`;
    currentJobId = data.jobId;
    if (els.downloadBtn) els.downloadBtn.disabled = false;
    resetView(data.accepted);
    openStream(data.jobId);
  } catch (err) {
    els.formMsg.textContent = `错误：${err.message}`;
    els.startBtn.disabled = false;
  }
});

// ── 回显模板：可用变量 / 编辑格式 弹出框 ──────────────────────────────────
// 每项：[变量名, 中文简称(带名插入时作前缀), 含义说明]
const TPL_VARS = {
  successTemplate: [
    ['email', '邮箱', '账号邮箱'],
    ['password', '密码', '当前密码：设了统一密码并改密成功后=新密码，否则=原密码'],
    ['originalPassword', '原密码', '邮箱原始密码（注册时用的）'],
    ['apiKey', 'key', 'OpenRouter API Key'],
    ['billingStatus', 'billing', '账单状态：skipped未操作 / address-bound已绑地址 / card-bound已加卡 / success已充值 / declined被拒'],
    ['charged', '充值', '实际充值金额（美元，未充值为 0）'],
    ['cardLast4', 'card', '本次所用卡号末 4 位'],
    ['passwordChanged', '改密', '邮箱密码是否已改为统一密码（true / false）'],
    ['exitIp', 'ip', '代理出口 IP（该线路实际出网 IP）'],
  ],
  failureTemplate: [
    ['email', '邮箱', '账号邮箱'],
    ['password', '密码', '密码（失败时为原密码）'],
    ['reason', '原因', '失败原因码（如 ACCOUNT_LOCKED、TURNSTILE_FAILED）'],
    ['stage', '阶段', '失败发生的阶段'],
    ['failClass', '分类', '失败分类（便于统计归类）'],
    ['attempts', '尝试', '实际尝试次数'],
    ['detail', '详情', '失败详情（最多 300 字）'],
  ],
};
const TPL_SAMPLE = {
  successTemplate: { email: 'user1@firstmail.com', password: 'MyNewPass#2026', originalPassword: 'oldpw123', apiKey: 'sk-or-v1-abcd…ef01', billingStatus: 'success', charged: 10, cardLast4: '8695', passwordChanged: true, exitIp: '203.0.113.7' },
  failureTemplate: { email: 'user2@firstmail.com', password: 'oldpw456', reason: 'ACCOUNT_LOCKED', stage: 'signup', failClass: 'account', attempts: 3, detail: 'account is restricted' },
};
function renderTpl(tpl, sample) {
  return String(tpl || '').replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, k) => (k in sample ? String(sample[k]) : ''));
}

const varsModal = $('varsModal');
if (varsModal) {
  let varsTarget = 'successTemplate';
  const fmtEdit = $('varsFormatEdit');
  const fieldOf = (id) => els.form.elements[id];
  const updatePreview = () => { $('varsPreview').textContent = renderTpl(fmtEdit.value, TPL_SAMPLE[varsTarget]) || '（空）'; };
  const refreshTplPreview = (id) => {
    const f = fieldOf(id);
    const pv = document.querySelector(`.tpl-preview[data-for="${id}"]`);
    if (pv) pv.textContent = (f && f.value) ? f.value : '（未设置，点此编辑）';
  };
  const syncBack = () => { const f = fieldOf(varsTarget); if (f) f.value = fmtEdit.value; refreshTplPreview(varsTarget); };
  const open = (targetId) => {
    varsTarget = targetId;
    $('varsModalTitle').textContent = (targetId === 'successTemplate' ? '成功回显' : '失败回显') + ' — 可用变量 / 编辑格式';
    const f = fieldOf(targetId);
    fmtEdit.value = f ? f.value : '';
    $('varsTable').innerHTML = TPL_VARS[targetId].map(([k, abbr, d]) =>
      `<div class="vrow"><code>{{${k}}}</code><span class="vabbr">${abbr}</span><span class="vdesc">${d}</span>`
      + `<button type="button" class="vins" data-ins="{{${k}}}">插入</button>`
      + `<button type="button" class="vins ghost2" data-ins="${abbr}:{{${k}}}">带名</button></div>`).join('');
    updatePreview();
    varsModal.hidden = false;
  };
  const close = () => { syncBack(); varsModal.hidden = true; };

  document.querySelectorAll('.vars-btn').forEach((b) => b.addEventListener('click', () => open(b.dataset.target)));
  document.querySelectorAll('.tpl-preview').forEach((pv) => { refreshTplPreview(pv.dataset.for); pv.addEventListener('click', () => open(pv.dataset.for)); });
  fmtEdit.addEventListener('input', () => { updatePreview(); syncBack(); });
  // 在光标处插入文本。autoSpace=true 时(插变量)若紧挨上一个变量/单词，自动补空格分隔
  const insertText = (text, autoSpace) => {
    const s = fmtEdit.selectionStart, en = fmtEdit.selectionEnd;
    const before = fmtEdit.value.slice(0, s);
    let t = text;
    if (autoSpace && before && /[}\w]$/.test(before)) t = ' ' + t;
    fmtEdit.value = before + t + fmtEdit.value.slice(en);
    const pos = s + t.length; fmtEdit.focus(); fmtEdit.setSelectionRange(pos, pos);
    updatePreview(); syncBack();
  };
  $('varsTable').addEventListener('click', (e) => {
    const ins = e.target.closest('[data-ins]'); if (!ins) return;
    insertText(ins.dataset.ins, true);
  });
  $('varsSeps').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sep]'); if (!s) return;
    insertText(s.dataset.sep === 'newline' ? '\n' : s.dataset.sep, false);
  });
  const clearBtn = $('varsClear');
  if (clearBtn) clearBtn.addEventListener('click', () => { fmtEdit.value = ''; fmtEdit.focus(); updatePreview(); syncBack(); });
  varsModal.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', close));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !varsModal.hidden) close(); });
}

// ── 错误策略 / 说明 弹出框 ────────────────────────────────────────────────
const policyModal = $('policyModal');
if (policyModal) {
  const ACTION_LABEL = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑(不重试)', abort: '放弃' };
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let ACTIONS = ['retry', 'retry-new-proxy', 'relogin', 'blacklist', 'abort'];
  const render = (list) => {
    const box = $('policyTable'); box.classList.remove('muted');
    box.innerHTML = list.map((p) => {
      const eff = p.effective || {}; const overridden = !!p.override;
      if (!p.settable) {
        return `<div class="prow mute"><code>${esc(p.code)}</code><span class="pdesc">${esc(p.why)}</span><span class="pact">${ACTION_LABEL[eff.action] || eff.action || ''}</span></div>`;
      }
      const opts = ACTIONS.map((a) => `<option value="${a}"${a === eff.action ? ' selected' : ''}>${ACTION_LABEL[a]}</option>`).join('');
      return `<div class="prow" data-code="${esc(p.code)}">
        <code>${esc(p.code)}</code>
        <span class="pdesc">${esc(p.why)}</span>
        <select class="pol-action">${opts}</select>
        <input class="pol-max" type="number" min="0" max="10" value="${Number(eff.maxRetries) || 0}" title="重试次数(0=首错即止)" />
        <span class="pbadge ${overridden ? 'on' : ''}">${overridden ? '已覆盖' : '内置'}</span>
        <button type="button" class="vins pol-save">保存</button>
        <button type="button" class="vins ghost2 pol-reset">重置</button>
      </div>`;
    }).join('');
  };
  const load = async () => {
    try {
      const r = await authFetch('/api/policy', {}, true); if (!r || !r.ok) return;
      const d = await r.json(); if (Array.isArray(d.actions) && d.actions.length) ACTIONS = d.actions;
      render(d.policy || []);
    } catch (_e) { /* ignore */ }
  };
  const openModal = () => { $('policyTable').classList.add('muted'); $('policyTable').textContent = '加载中…'; policyModal.hidden = false; load(); };
  const closeModal = () => { policyModal.hidden = true; };
  const policyBtn = $('policyBtn'); if (policyBtn) policyBtn.addEventListener('click', openModal);
  policyModal.querySelectorAll('[data-close]').forEach((x) => x.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !policyModal.hidden) closeModal(); });
  $('policyTable').addEventListener('click', async (e) => {
    const row = e.target.closest('.prow[data-code]'); if (!row) return;
    const code = row.dataset.code;
    if (e.target.closest('.pol-save')) {
      const action = row.querySelector('.pol-action').value;
      const maxRetries = Number(row.querySelector('.pol-max').value) || 0;
      const r = await authFetch('/api/policy/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, action, maxRetries }) });
      if (r.ok) { const d = await r.json(); render(d.policy || []); }
      else { const d = await r.json().catch(() => ({})); alert('保存失败：' + (d.error || r.status)); }
    } else if (e.target.closest('.pol-reset')) {
      const r = await authFetch('/api/policy/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (r.ok) { const d = await r.json(); render(d.policy || []); }
    }
  });
  const resetAll = $('policyResetAll');
  if (resetAll) resetAll.addEventListener('click', async () => {
    if (!confirm('把所有错误策略恢复为内置默认？')) return;
    const r = await authFetch('/api/policy/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (r.ok) { const d = await r.json(); render(d.policy || []); }
  });
}

// ── 文件上传 / 实时解析（账号·代理·卡池·地址池）──────────────────────────
// 上传 .txt/.csv 或把文件拖到框里：逐行按「该字段的格式」抽取，只保留匹配的行，
// 不符的行（订单抬头、JWT、混进来的别的类型…）一律忽略并计数。这样无论文件里夹带
// 多少杂质，每个框拿到的都是它该有的数据。
(function () {
  const KIND_LABEL = { accounts: '邮箱:密码', proxies: 'host:port:user:pass', cards: '银行卡(卡号 有效期 CVV)', address: '姓名|地址|城市|州|邮编' };
  const unq = (s) => s.replace(/^["']|["']$/g, '').trim();
  // 单行抽取器：返回规范化后的字符串(保留)，或 null(丢弃)。
  const EXTRACT = {
    // 锚定邮箱；其后第一个分隔符起、到下个空白/竖线/逗号前为密码（冒号可出现在密码里）。
    accounts(line) {
      const em = line.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
      if (!em) return null;
      const email = em[0];
      const after = line.slice(em.index + email.length);
      const pm = after.match(/[\s:|,;\t]+(\S[^\s|,;\t]*)/);
      const pass = pm ? unq(pm[1]) : '';
      return `${email}:${pass}`;
    },
    // host:port[:user:pass]，或 user:pass@host:port；先剥掉本工具导出的 " | key=val" 元数据。
    proxies(line) {
      const t = unq(line.split(/\s+\|\s+/)[0]);
      let m = t.match(/^([^\s:@]+):([^\s:@]+)@([A-Za-z0-9.\-]+):(\d{1,5})$/);
      if (m) return `${m[3]}:${m[4]}:${m[1]}:${m[2]}`;
      m = t.match(/^([A-Za-z0-9.\-]+):(\d{1,5})(?::(.+))?$/);
      if (m) return m[3] != null ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
      return null;
    },
    // 必须含 13–19 位卡号（去掉卡号内空格/连字符后判定）；可排除代理IP(≤12位)与普通文本。
    cards(line) {
      const compact = line.replace(/[ \-]/g, '');
      return /(?:^|\D)\d{13,19}(?:\D|$)/.test(compact) ? line.trim() : null;
    },
  };
  // 逐行抽取 → {kept, ignored}
  function lineParse(text, ex) {
    const kept = []; let ignored = 0;
    text.split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;          // 空行/注释：静默跳过
      const out = ex(s);
      if (out) kept.push(out); else ignored += 1;
    });
    return { kept, ignored };
  }
  // ── CSV 解析（支持引号字段、字段内逗号、"" 转义、BOM、CRLF）────────────────
  function csvRows(text) {
    const s = String(text).replace(/^﻿/, '');
    const rows = []; let row = [], cell = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  // 美式整串地址 "line1, city, State ZIP, United States" → 各字段
  function splitUsAddress(addr) {
    let parts = String(addr).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length && /^(united states|usa|u\.?s\.?a?\.?)$/i.test(parts[parts.length - 1])) parts.pop();
    if (parts.length < 3) return null;
    const sz = parts.pop().match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
    if (!sz) return null;
    const state = sz[1].trim(); const zip = sz[2];
    const city = parts.pop();
    const line1 = parts.join(' ').replace(/\s+/g, ' ').trim(); // 去掉逗号，避免与后端按逗号再切冲突
    return (line1 && city && state && zip) ? { line1, city, state, zip } : null;
  }
  // 一行 CSV 单元 → "姓名|地址|城市|州|邮编"，失败返回 null
  function rowToAddress(cells, nameIdx, addrIdx) {
    const name = (nameIdx >= 0 ? cells[nameIdx] : cells[0] || '').trim();
    let addr = addrIdx >= 0 ? (cells[addrIdx] || '').trim()
      : (cells.find((c) => /\d{5}(?:-\d{4})?\s*,\s*united states/i.test(c) || /,\s*[A-Za-z][A-Za-z .]+\s+\d{5}(?:-\d{4})?\b/.test(c)) || '').trim();
    if (!name || !addr) return null;
    const c = splitUsAddress(addr);
    return c ? [name, c.line1, c.city, c.state, c.zip].join('|') : null;
  }
  // 地址池智能解析：既吃旧的「姓名|地址|城市|州|邮编」竖线格式，也吃富 CSV（带表头/引号/整串地址）。
  function parseAddressSmart(text) {
    const rows = csvRows(text);
    const kept = []; let ignored = 0;
    let nameIdx = -1, addrIdx = -1, start = 0;
    if (rows.length) {
      rows[0].forEach((c, i) => { const h = String(c).toLowerCase(); if (nameIdx < 0 && /(name|姓名)/.test(h)) nameIdx = i; if (addrIdx < 0 && /(address|地址)/.test(h)) addrIdx = i; });
      if (nameIdx >= 0 && addrIdx >= 0) start = 1; // 识别到表头才跳过首行
    }
    for (let r = start; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || !cells.join('').trim()) continue;
      if (cells.length === 1 && cells[0].includes('|')) { // 旧的竖线格式
        const p = cells[0].split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
        if (p.length >= 4) { kept.push(p.join('|')); continue; }
        ignored += 1; continue;
      }
      const canon = rowToAddress(cells, nameIdx, addrIdx); // 富 CSV（姓名 + 整串地址）
      if (canon) { kept.push(canon); continue; }
      const flat = cells.map((s) => s.trim()).filter(Boolean); // 朴素 CSV：姓名,地址,城市,州,邮编
      if (flat.length >= 4 && /\d{5}/.test(flat[flat.length - 1] || flat[flat.length - 2])) { kept.push(flat.join('|')); continue; }
      ignored += 1;
    }
    return { kept, ignored };
  }
  const PARSE = {
    accounts: (t) => lineParse(t, EXTRACT.accounts),
    proxies: (t) => lineParse(t, EXTRACT.proxies),
    cards: (t) => lineParse(t, EXTRACT.cards),
    address: parseAddressSmart,
  };
  async function readFiles(fileList) {
    const parts = [];
    for (const f of Array.from(fileList)) {
      try { parts.push(f.text ? await f.text() : await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); })); }
      catch (_e) { /* 跳过读不了的文件 */ }
    }
    return parts.join('\n');
  }
  async function loadInto(fileList, kind, targetName) {
    if (!fileList || !fileList.length) return;
    const msgEl = document.querySelector(`.up-msg[data-msg="${targetName}"]`);
    if (msgEl) { msgEl.textContent = '解析中…'; msgEl.classList.remove('warn'); }
    const raw = (await readFiles(fileList)).replace(/^﻿/, '');
    const parser = PARSE[kind] || ((t) => lineParse(t, (l) => l || null));
    const { kept, ignored } = parser(raw);
    const ta = els.form.elements[targetName];
    if (!ta) return;
    const prev = ta.value.replace(/\s+$/, '');
    if (kept.length) ta.value = prev ? `${prev}\n${kept.join('\n')}` : kept.join('\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    if (!msgEl) return;
    if (!kept.length) {
      msgEl.classList.add('warn');
      msgEl.textContent = `✗ 没找到符合「${KIND_LABEL[kind]}」格式的数据（忽略 ${ignored} 行）——文件传错了？`;
    } else {
      msgEl.textContent = `✓ 解析出 ${kept.length} 条${ignored ? ` · 忽略 ${ignored} 行(不符格式)` : ''}`;
    }
  }
  // 上传按钮 → 触发隐藏 file input
  document.querySelectorAll('.up-btn').forEach((btn) => {
    const inp = document.querySelector(`.up-input[data-for="${btn.dataset.up}"]`);
    if (inp) btn.addEventListener('click', () => inp.click());
  });
  // file input 选择后载入
  document.querySelectorAll('.up-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const btn = document.querySelector(`.up-btn[data-up="${inp.dataset.for}"]`);
      await loadInto(inp.files, btn ? btn.dataset.kind : 'accounts', inp.dataset.for);
      inp.value = ''; // 允许重复选同一文件
    });
  });
  // 拖拽文件到文本框 → 同样解析载入
  document.querySelectorAll('textarea[data-drop]').forEach((ta) => {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ta.addEventListener('dragover', (e) => { stop(e); ta.classList.add('dragging'); });
    ta.addEventListener('dragleave', (e) => { stop(e); ta.classList.remove('dragging'); });
    ta.addEventListener('drop', async (e) => {
      stop(e); ta.classList.remove('dragging');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) await loadInto(files, ta.dataset.drop, ta.getAttribute('name'));
    });
  });
})();

// 启动：拉一次错误策略表（失败分类的恢复策略展示用）。
loadPolicyMap();
