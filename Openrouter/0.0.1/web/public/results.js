'use strict';

const $ = (id) => document.getElementById(id);
let ALL = []; // 当前聚合到的账号
let ROLE = 'master'; // master | sub

async function loadNode() {
  try {
    const r = await authFetch('/api/node', {}, true);
    if (r.ok) { const n = await r.json(); $('nodeBadge').textContent = `node: ${n.nodeId}`; ROLE = n.role || 'master'; applyRole(n); }
  } catch (_e) { /* ignore */ }
}

// 角色感知：子节点不展示聚合，只看本机；主机展示自动检测到的子节点。
function applyRole(n) {
  if (ROLE !== 'sub') { const b = $('subBanner'); if (b) b.hidden = true; return; }
  const adv = document.querySelector('.panel.adv'); if (adv) adv.hidden = true; // 子机隐藏整个聚合区
  const b = $('subBanner');
  if (b) { b.hidden = false; $('subNode').textContent = n.nodeId; $('subCentral').textContent = n.centralUrl || '(未配置)'; }
  const h1 = document.querySelector('header h1'); if (h1) h1.textContent = '成功账号（本节点）';
  if ($('includeLocal')) $('includeLocal').checked = true;
  if ($('hosts')) $('hosts').value = ''; // 只看本机
}

// 主机列表来源:localStorage(用户上次填的) > 服务端 cluster 配置。两者都会被聚合(服务端再并配置一次)。
async function initHosts() {
  if (ROLE === 'sub') return; // 子机不聚合其它节点
  const saved = localStorage.getItem('or_hosts');
  if (saved != null && saved.trim()) { $('hosts').value = saved; }
  else {
    try {
      const r = await authFetch('/api/cluster', {}, true);
      if (r.ok) { const c = await r.json(); if (Array.isArray(c.hosts) && c.hosts.length) $('hosts').value = c.hosts.join('\n'); }
    } catch (_e) { /* ignore */ }
  }
  // 记住设置
  const persist = () => {
    localStorage.setItem('or_hosts', $('hosts').value);
    localStorage.setItem('or_dedupe', $('dedupe').value);
    localStorage.setItem('or_local', $('includeLocal').checked ? '1' : '0');
  };
  $('hosts').addEventListener('change', persist);
  $('dedupe').addEventListener('change', persist);
  $('includeLocal').addEventListener('change', persist);
  if (localStorage.getItem('or_dedupe')) $('dedupe').value = localStorage.getItem('or_dedupe');
  if (localStorage.getItem('or_local') != null) $('includeLocal').checked = localStorage.getItem('or_local') === '1';
}

function render() {
  const q = ($('search').value || '').toLowerCase();
  const rows = ALL.filter((r) => !q
    || String(r.email || '').toLowerCase().includes(q)
    || String(r.apiKey || '').toLowerCase().includes(q)
    || String(r.nodeId || '').toLowerCase().includes(q));
  const nodes = new Set(ALL.map((r) => r.nodeId));
  $('statCount').textContent = ALL.length;
  $('statNodes').textContent = nodes.size;
  const tb = $('tbl').querySelector('tbody');
  tb.innerHTML = rows.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td>${esc(r.email)}</td>
    <td class="mono">${esc(r.password)}</td>
    <td class="mono">${esc(r.originalPassword)}</td>
    <td class="mono">${esc(r.apiKey)}</td>
    <td>${esc(r.billingStatus || '')}</td>
    <td>${esc(r.charged != null ? r.charged : r.topUpAmount)}</td>
    <td>${r.cardLast4 ? '••' + esc(r.cardLast4) : ''}</td>
    <td>${r.passwordChanged ? '✓' : ''}</td>
    <td>${esc(r.exitIp)}</td>
    <td>${esc(r.nodeId)}</td>
    <td>${esc((r.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
  </tr>`).join('');
}

// ── 卡池 / 充值台账（本节点）──────────────────────────────────────────────
const CARD_STATUS = { active: '可用', exhausted: '用尽', declined: '被拒', disabled: '已禁用' };
function shortTime(s) { if (!s) return '—'; try { return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_e) { return s; } }
async function loadCards() {
  try {
    const r = await authFetch('/api/cards', {}, true); if (!r || !r.ok) return;
    const d = await r.json(); const cards = d.cards || [];
    $('cardSummary').textContent = `共 ${cards.length} 张 · 可用 ${d.available || 0}`;
    const box = $('cardPool');
    if (!cards.length) { box.classList.add('muted'); box.innerHTML = '暂无卡片'; return; }
    box.classList.remove('muted');
    const rows = cards.map((c) => `<tr class="${c.status === 'active' ? 'ok' : (c.status === 'declined' ? 'bad' : 'mute')}">
      <td>${esc(c.masked)}</td><td>${esc(c.exp)}</td><td>${CARD_STATUS[c.status] || c.status}</td>
      <td>${c.usedCount}/${c.maxUses}</td><td><b>${c.remaining}</b></td><td>${c.successCount}</td><td>${c.declineCount}</td>
      <td>${shortTime(c.lastUsedAt)}</td><td class="err" title="${esc(c.lastError)}">${c.lastError ? esc(c.lastError.slice(0, 24)) : '—'}</td>
    </tr>`).join('');
    box.innerHTML = `<table class="card-table"><thead><tr><th>卡号</th><th>有效期</th><th>状态</th><th>已用/上限</th><th>剩余</th><th>成功</th><th>被拒</th><th>最近用</th><th>最近错误</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (_e) { /* ignore */ }
}
async function loadBilling() {
  try {
    const r = await authFetch('/api/billing', {}, true); if (!r || !r.ok) return;
    const s = await r.json(); const box = $('billingLedger');
    const byCard = Object.entries(s.byCard || {}).map(([k, v]) => `••${k}: ${v.count}次/$${v.charged}`).join('　');
    const head = `<div class="bill-summary"><span class="chip cls">总充值 $${s.totalCharged || 0}</span><span class="chip cls">成功 ${s.success || 0}</span><span class="chip">被拒 ${s.declined || 0}</span><span class="muted">${esc(byCard)}</span></div>`;
    const entries = s.entries || [];
    if (!entries.length) { box.classList.remove('muted'); box.innerHTML = head + '<div class="muted">暂无充值记录</div>'; return; }
    box.classList.remove('muted');
    const rows = entries.map((e) => `<tr class="${e.result === 'success' ? 'ok' : (e.result === 'declined' ? 'bad' : 'mute')}">
      <td>${shortTime(e.at)}</td><td>${esc(e.email)}</td><td>${e.cardLast4 ? '••' + esc(e.cardLast4) : '—'}</td>
      <td>${e.charged ? '$' + e.charged : '—'}</td><td>${esc(e.result)}</td><td class="err">${esc(e.error || '')}</td></tr>`).join('');
    box.innerHTML = head + `<table class="card-table"><thead><tr><th>时间</th><th>邮箱</th><th>卡</th><th>金额</th><th>结果</th><th>错误</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (_e) { /* ignore */ }
}

// ── 账号状态：断点续跑进度（本节点）────────────────────────────────────────
async function loadAccounts() {
  try {
    const r = await authFetch('/api/accounts', {}, true); if (!r || !r.ok) return;
    const d = await r.json(); const accts = d.accounts || [];
    $('acctSummary').textContent = `共 ${accts.length} 个账号`;
    const box = $('acctTable');
    if (!accts.length) { box.classList.add('muted'); box.innerHTML = '暂无账号状态（跑过任务后自动记录）'; return; }
    box.classList.remove('muted');
    const yn = (v) => (v ? '✓' : '—');
    const rows = accts.map((a) => `<tr class="${a.blacklisted ? 'bad' : ''}">
      <td>${esc(a.email)}</td>
      <td>${yn(a.registered)}</td>
      <td>${a.apiKey ? '✓' : '—'}</td>
      <td>${esc(a.billingStatus || '—')}</td>
      <td>${a.charged ? '$' + esc(a.charged) : '—'}</td>
      <td>${a.cardLast4 ? '••' + esc(a.cardLast4) : '—'}</td>
      <td>${yn(a.passwordChanged)}</td>
      <td>${esc(a.exitIp || '—')}</td>
      <td>${a.blacklisted ? `<span class="chip" title="${esc(a.blacklistReason || '')}">🚫 拉黑</span>` : '<span class="muted">正常</span>'}</td>
      <td>${esc(shortTime(a.updatedAt))}</td>
      <td class="acts"><button type="button" class="mini danger" data-reset="${esc(a.email)}">${a.blacklisted ? '解黑' : '重置'}</button></td>
    </tr>`).join('');
    box.innerHTML = `<table class="card-table"><thead><tr><th>邮箱</th><th>注册</th><th>Key</th><th>账单</th><th>充值</th><th>卡</th><th>改密</th><th>出口IP</th><th>状态</th><th>更新</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (_e) { /* ignore */ }
}

// ── 错误记录（本节点）────────────────────────────────────────────────────
const ERR_ACTION_LABEL = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑', abort: '放弃' };
async function loadErrors() {
  try {
    const r = await authFetch('/api/errors', {}, true); if (!r || !r.ok) return;
    const d = await r.json(); const entries = d.entries || [];
    $('errSummary').textContent = `共 ${d.total || 0} 条`;
    const chips = []
      .concat(Object.entries(d.byAction || {}).map(([k, v]) => `<span class="chip cls">${ERR_ACTION_LABEL[k] || k}: ${v}</span>`))
      .concat(Object.entries(d.byReason || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`));
    $('errChips').innerHTML = chips.join('');
    const box = $('errTable');
    if (!entries.length) { box.classList.add('muted'); box.innerHTML = '暂无错误记录'; return; }
    box.classList.remove('muted');
    const rows = entries.map((e) => `<tr>
      <td>${esc(shortTime(e.at))}</td>
      <td>${esc(e.email || '—')}</td>
      <td>${esc(e.stage || '—')}</td>
      <td class="err" title="${esc(e.reason)}">${esc(e.reason)}</td>
      <td>${esc(ERR_ACTION_LABEL[e.action] || e.action || '—')}</td>
      <td>${e.attempt != null ? esc(e.attempt) : '—'}</td>
    </tr>`).join('');
    box.innerHTML = `<table class="card-table"><thead><tr><th>时间</th><th>邮箱</th><th>阶段</th><th>错误</th><th>动作</th><th>第几次</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (_e) { /* ignore */ }
}

function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

let loading = false;
let refreshTimer = null;

async function loadData(silent) {
  if (loading) return;
  loading = true;
  const hosts = ($('hosts').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const includeLocal = $('includeLocal').checked;
  const dedupe = $('dedupe').value;
  if (!silent) { $('msg').textContent = '拉取中…'; $('loadBtn').disabled = true; }
  // 保留滚动位置,静默刷新不跳动
  const scroller = document.querySelector('.rtbl')?.closest('div');
  const keepTop = scroller ? scroller.scrollTop : 0;
  try {
    const resp = await authFetch('/api/aggregate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts, includeLocal, dedupe }),
    }, silent);
    if (!resp.ok) {
      if (resp.status === 401) { $('msg').textContent = silent ? '需要令牌:点「拉取/聚合」输入' : '令牌无效或未输入,请点「拉取/聚合」重输'; }
      else { $('msg').textContent = `错误 HTTP ${resp.status}`; }
      return;
    }
    const data = await resp.json();
    ALL = data.accounts || [];
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('msg').textContent = `合计 ${data.total} · 去重后 ${data.count} · 更新于 ${ts}`;
    const srcs = data.sources || [];
    $('sources').innerHTML = srcs.map((s) => {
      const name = String(s.source).replace(/^local\(/, '本机(').replace(/^push\(/, '推送(');
      return `<div class="node ${s.ok ? '' : 'bad'}"><span class="dot"></span><span class="nname">${esc(name)}</span><span class="ncount">${s.ok ? s.count + ' 条' : esc(s.error)}</span></div>`;
    }).join('');
    const advLabel = $('advLabel');
    if (advLabel) advLabel.textContent = `🖧 集群：${srcs.length} 节点 · ${data.count} 账号（点开管理）`;
    render();
    if (scroller) scroller.scrollTop = keepTop;
  } catch (e) {
    if (!silent) $('msg').textContent = `错误: ${e.message}`;
  } finally {
    loading = false;
    $('loadBtn').disabled = false;
  }
}

function setupAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if ($('autoRefresh').checked) {
    refreshTimer = setInterval(() => { loadData(true); loadCards(); loadBilling(); loadAccounts(); loadErrors(); }, 5000);
  }
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 多机聚合区折叠(默认隐藏；记忆用户上次展开/收起)
(() => {
  const t = $('advToggle'); const body = $('advBody');
  if (!t || !body) return;
  const setAdv = (open) => { body.hidden = !open; t.classList.toggle('open', open); localStorage.setItem('or_adv', open ? '1' : '0'); };
  t.addEventListener('click', () => setAdv(body.hidden));
  setAdv(localStorage.getItem('or_adv') === '1'); // 默认收起
})();

$('loadBtn').addEventListener('click', () => loadData(false));
$('autoRefresh').addEventListener('change', setupAutoRefresh);
$('search').addEventListener('input', render);
$('copyBtn').addEventListener('click', () => {
  const txt = ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n');
  navigator.clipboard.writeText(txt).then(() => { $('msg').textContent = '已复制(email:apiKey)'; });
});
const copyPwBtn = $('copyPwBtn');
if (copyPwBtn) copyPwBtn.addEventListener('click', () => {
  const txt = ALL.map((r) => `${r.email || ''}:${r.password || ''}`).join('\n');
  navigator.clipboard.writeText(txt).then(() => { $('msg').textContent = '已复制(email:密码)'; });
});
$('dlTxtBtn').addEventListener('click', () => download('accounts.txt', ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'), 'text/plain'));
$('dlJsonBtn').addEventListener('click', () => download('accounts.json', JSON.stringify(ALL, null, 2), 'application/json'));
const rcBtn = $('refreshCardsBtn'); if (rcBtn) rcBtn.addEventListener('click', loadCards);
const rbBtn = $('refreshBillBtn'); if (rbBtn) rbBtn.addEventListener('click', loadBilling);
const raBtn = $('refreshAcctBtn'); if (raBtn) raBtn.addEventListener('click', loadAccounts);
const reBtn = $('refreshErrBtn'); if (reBtn) reBtn.addEventListener('click', loadErrors);
const ceBtn = $('clearErrBtn'); if (ceBtn) ceBtn.addEventListener('click', async () => {
  if (!confirm('确定清空全部错误记录？')) return;
  await authFetch('/api/errors/clear', { method: 'POST' }); loadErrors();
});
const caBtn = $('clearAcctBtn'); if (caBtn) caBtn.addEventListener('click', async () => {
  if (!confirm('确定清空全部账号状态？清空后重跑将从头执行（不再跳过已完成阶段）。')) return;
  await authFetch('/api/accounts/clear', { method: 'POST' }); loadAccounts();
});
const acctTable = $('acctTable');
if (acctTable) acctTable.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reset]'); if (!btn) return;
  if (!confirm(`重置账号 ${btn.dataset.reset}？该账号下次将从头跑。`)) return;
  await authFetch('/api/accounts/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: btn.dataset.reset }) });
  loadAccounts();
});

(async () => {
  await loadNode();         // 先判定角色(主/子)，子机会隐藏聚合区
  await initHosts();        // 先填好主机列表(localStorage / cluster 配置)
  await loadData(false);    // 再聚合加载
  loadCards(); loadBilling(); loadAccounts(); loadErrors();
  setupAutoRefresh();       // 启动自动刷新(默认每 5s)
})();
