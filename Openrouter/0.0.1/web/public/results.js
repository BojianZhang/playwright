'use strict';

const $ = (id) => document.getElementById(id);
let ALL = []; // 当前聚合到的账号

async function loadNode() {
  try { const n = await (await authFetch('/api/node')).json(); $('nodeBadge').textContent = `node: ${n.nodeId}`; } catch (_e) { /* ignore */ }
}

// 主机列表来源:localStorage(用户上次填的) > 服务端 cluster 配置。两者都会被聚合(服务端再并配置一次)。
async function initHosts() {
  const saved = localStorage.getItem('or_hosts');
  if (saved != null && saved.trim()) { $('hosts').value = saved; }
  else {
    try {
      const c = await (await authFetch('/api/cluster')).json();
      if (Array.isArray(c.hosts) && c.hosts.length) $('hosts').value = c.hosts.join('\n');
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
    <td>${esc(r.nodeId)}</td>
    <td>${esc(r.email)}</td>
    <td class="mono">${esc(r.apiKey)}</td>
    <td>${esc(r.exitIp)}</td>
    <td>${esc(r.topUpAmount)}</td>
    <td>${esc((r.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
  </tr>`).join('');
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
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '失败');
    ALL = data.accounts || [];
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('msg').textContent = `合计 ${data.total} · 去重后 ${data.count} · 更新于 ${ts}`;
    $('sources').innerHTML = (data.sources || []).map((s) => `<div>${s.ok ? '✅' : '❌'} ${esc(s.source)} — ${s.ok ? s.count + ' 条' : esc(s.error)}</div>`).join('');
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
    refreshTimer = setInterval(() => loadData(true), 5000);
  }
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('loadBtn').addEventListener('click', () => loadData(false));
$('autoRefresh').addEventListener('change', setupAutoRefresh);
$('search').addEventListener('input', render);
$('copyBtn').addEventListener('click', () => {
  const txt = ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n');
  navigator.clipboard.writeText(txt).then(() => { $('msg').textContent = '已复制到剪贴板'; });
});
$('dlTxtBtn').addEventListener('click', () => download('accounts.txt', ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'), 'text/plain'));
$('dlJsonBtn').addEventListener('click', () => download('accounts.json', JSON.stringify(ALL, null, 2), 'application/json'));

(async () => {
  loadNode();
  await initHosts();        // 先填好主机列表(localStorage / cluster 配置)
  await loadData(false);    // 再聚合加载
  setupAutoRefresh();       // 启动自动刷新(默认每 5s)
})();
