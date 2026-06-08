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

// 失败明细表：每个账号卡在哪一步、为什么。
function renderFailTable() {
  if (!els.failTable) return;
  if (!failedAccounts.length) { els.failTable.classList.add('muted'); els.failTable.innerHTML = '暂无失败'; return; }
  els.failTable.classList.remove('muted');
  const rows = failedAccounts.map((d) => `<tr class="bad">
    <td>${d.email || ''}</td>
    <td>${STAGE_LABELS[d.stage] || d.stage || '—'}</td>
    <td>${d.reason || ''}</td>
    <td>${d.failClass || ''}</td>
    <td>${d.attempts || 1}</td>
    <td class="err" title="${(d.detail || '').replace(/"/g, '&quot;')}">${d.detail ? d.detail.slice(0, 40) : ''}</td>
  </tr>`).join('');
  els.failTable.innerHTML = `<table class="card-table">
    <thead><tr><th>邮箱</th><th>失败步骤</th><th>原因</th><th>类型</th><th>尝试</th><th>详情</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

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

// 账单动作切换：none/address 时隐藏「充值金额/试卡数」(那些只对 card/charge 有意义)。
(function () {
  const sel = $('billingAction');
  const opts = $('chargeOpts');
  if (!sel || !opts) return;
  const sync = () => { opts.style.display = (sel.value === 'card' || sel.value === 'charge') ? '' : 'none'; };
  sel.addEventListener('change', sync);
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
  if (els.failLog) els.failLog.textContent = '';
  if (els.failTable) { els.failTable.classList.add('muted'); els.failTable.innerHTML = '暂无失败'; }
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
    renderFailTable();
    updateFailBadge();
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
    concurrency: fd.get('concurrency'),
    count: fd.get('count'),
    mode: fd.get('mode') || 'register',
    unifiedPassword: fd.get('unifiedPassword') || '',
    apiKeyName: fd.get('apiKeyName') || '',
    apiKeyExpiration: fd.get('apiKeyExpiration') || 'No expiration',
    topUpAmount: fd.get('topUpAmount'),
    billingAction: fd.get('billingAction') || 'none',
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
