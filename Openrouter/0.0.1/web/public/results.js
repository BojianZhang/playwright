'use strict';

const $ = (id) => document.getElementById(id);
let ALL = []; // 当前聚合到的账号

async function loadNode() {
  try { const n = await (await fetch('/api/node')).json(); $('nodeBadge').textContent = `node: ${n.nodeId}`; } catch (_e) { /* ignore */ }
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

async function loadData() {
  const hosts = ($('hosts').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const includeLocal = $('includeLocal').checked;
  const dedupe = $('dedupe').value;
  $('msg').textContent = '拉取中…';
  $('loadBtn').disabled = true;
  try {
    const resp = await fetch('/api/aggregate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts, includeLocal, dedupe }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '失败');
    ALL = data.accounts || [];
    $('msg').textContent = `合计 ${data.total} · 去重后 ${data.count}`;
    $('sources').innerHTML = (data.sources || []).map((s) => `<div>${s.ok ? '✅' : '❌'} ${esc(s.source)} — ${s.ok ? s.count + ' 条' : esc(s.error)}</div>`).join('');
    render();
  } catch (e) {
    $('msg').textContent = `错误: ${e.message}`;
  } finally {
    $('loadBtn').disabled = false;
  }
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('loadBtn').addEventListener('click', loadData);
$('search').addEventListener('input', render);
$('copyBtn').addEventListener('click', () => {
  const txt = ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n');
  navigator.clipboard.writeText(txt).then(() => { $('msg').textContent = '已复制到剪贴板'; });
});
$('dlTxtBtn').addEventListener('click', () => download('accounts.txt', ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'), 'text/plain'));
$('dlJsonBtn').addEventListener('click', () => download('accounts.json', JSON.stringify(ALL, null, 2), 'application/json'));

loadNode();
loadData(); // 进页面先加载本节点
