/* ===========================================================
   结果聚合页 — 真实 /api/aggregate + /api/cards + /api/node
   =========================================================== */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const af = (u, o, silent) => (window.authFetch ? window.authFetch(u, o, silent) : fetch(u, o));
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));
  function shortTime(s) { if (!s) return '—'; try { return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_e) { return s; } }

  let ALL = [];

  async function loadNode() {
    try { const r = await af('/api/node', {}, true); if (r && r.ok) { const n = await r.json(); const b = $('nodeBadge'); if (b) b.innerHTML = `<span class="dot"></span>node&nbsp;${esc(n.nodeId || '本机')}`; } } catch (_e) { /* ignore */ }
  }

  /* ---------- accounts table ---------- */
  function renderAccounts() {
    const body = $('accBody'); if (!body) return;
    const q = ($('search').value || '').trim().toLowerCase();
    const rows = ALL.filter((r) => !q || (String(r.email || '') + String(r.apiKey || '') + String(r.nodeId || '')).toLowerCase().includes(q));
    $('accTotal').textContent = ALL.length; $('accTotal2').textContent = ALL.length;
    body.innerHTML = rows.length ? rows.map((a, i) => `<tr>
      <td class="mono" style="color:var(--text-3)">${i + 1}</td>
      <td class="mono">${esc(a.email)}</td>
      <td class="mono" style="color:var(--text-2)">${esc(a.password)}</td>
      <td class="mono" style="color:var(--text-3)">${esc(a.originalPassword)}</td>
      <td class="mono" style="color:var(--primary-text)" title="${esc(a.apiKey)}">${esc(trunc(a.apiKey, 24))}</td>
      <td>${a.billingStatus === 'success' ? '<span class="kbadge ok">success</span>' : (a.billingStatus ? `<span class="kbadge warn">${esc(a.billingStatus)}</span>` : '<span class="kbadge neutral">—</span>')}</td>
      <td class="mono">${a.charged != null ? '$' + esc(a.charged) : (a.topUpAmount != null ? '$' + esc(a.topUpAmount) : '—')}</td>
      <td class="mono">${a.cardLast4 ? '•••• ' + esc(a.cardLast4) : '—'}</td>
      <td>${a.passwordChanged ? '<span class="kbadge ok">已改</span>' : '<span class="kbadge neutral">未改</span>'}</td>
      <td class="mono" style="color:var(--text-2)">${esc(a.exitIp || '—')}</td>
      <td class="mono" style="color:var(--text-3)">${esc(a.nodeId || '')}</td>
      <td class="mono" style="color:var(--text-3)">${esc((a.createdAt || '').replace('T', ' ').slice(0, 19))}</td>
    </tr>`).join('') : `<tr><td colspan="12" class="tbl-empty">${q ? '没有匹配「' + esc(q) + '」的账号' : '暂无成功账号，去控制台跑一批'}</td></tr>`;
  }

  /* ---------- card pool (read-only summary) ---------- */
  const CARD_STATUS = { active: '可用', exhausted: '已用尽', declined: '被拒', disabled: '已禁用' };
  async function loadCards() {
    const body = $('poolBody'); if (!body) return;
    let d; try { const r = await af('/api/cards', {}, true); if (!r || !r.ok) return; d = await r.json(); } catch (_e) { return; }
    const cards = d.cards || [];
    const sum = $('poolSummary'); if (sum) sum.innerHTML = `本节点 · 共 <b style="color:var(--text)">${cards.length}</b> 张 · 可用 <b style="color:var(--success)">${d.available || 0}</b>`;
    body.innerHTML = cards.length ? cards.map((c) => {
      const badge = c.status === 'active' ? '<span class="kbadge ok">可用</span>' : c.status === 'exhausted' ? '<span class="kbadge fail">已用尽</span>' : `<span class="kbadge neutral">${CARD_STATUS[c.status] || c.status}</span>`;
      return `<tr><td class="mono">${esc(c.masked)}</td><td class="mono">${esc(c.exp)}</td><td class="mono">${c.usedCount} / ${c.maxUses}</td><td>${badge}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="tbl-empty">暂无卡片</td></tr>';
  }

  /* ---------- aggregate ---------- */
  let loading = false;
  async function loadData(silent) {
    if (loading) return; loading = true;
    const includeLocal = $('includeLocal') ? $('includeLocal').checked : true;
    const dedupe = $('dedupe') ? $('dedupe').value : 'email+apiKey';
    const hosts = ($('hosts') && $('hosts').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    try {
      const r = await af('/api/aggregate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hosts, includeLocal, dedupe }) }, silent);
      if (!r.ok) return;
      const data = await r.json();
      ALL = data.accounts || [];
      if ($('updatedAt')) $('updatedAt').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      if ($('totalAll')) $('totalAll').textContent = data.total != null ? data.total : ALL.length;
      const srcs = data.sources || [];
      if ($('nodeCount')) $('nodeCount').textContent = srcs.length || 1;
      const nl = $('nodeList');
      if (nl) nl.innerHTML = srcs.map((s) => {
        const name = String(s.source).replace(/^local\(/, '本机(').replace(/^push\(/, '推送(');
        return `<span class="node-chip"><span class="dot" style="${s.ok ? '' : 'background:var(--danger);box-shadow:0 0 0 3px var(--danger-weak)'}"></span>${esc(name)} <em>${s.ok ? s.count + ' 条' : esc(s.error)}</em></span>`;
      }).join('') || '<span class="node-chip"><span class="dot"></span>本机 <em>0 条</em></span>';
      renderAccounts();
    } catch (_e) { /* ignore */ } finally { loading = false; }
  }

  /* ---------- export ---------- */
  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  let timer = null;
  function setupAuto() {
    if (timer) { clearInterval(timer); timer = null; }
    if ($('autoRefresh') && $('autoRefresh').checked) timer = setInterval(() => { loadData(true); loadCards(); }, 5000);
  }

  $('search') && $('search').addEventListener('input', renderAccounts);
  $('loadBtn') && $('loadBtn').addEventListener('click', () => { loadData(false); loadCards(); });
  $('autoRefresh') && $('autoRefresh').addEventListener('change', setupAuto);
  $('refreshPoolBtn') && $('refreshPoolBtn').addEventListener('click', loadCards);
  $('dedupe') && $('dedupe').addEventListener('change', () => loadData(false));
  $('includeLocal') && $('includeLocal').addEventListener('change', () => loadData(false));
  $('copyBtn') && $('copyBtn').addEventListener('click', () => navigator.clipboard.writeText(ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n')));
  $('copyPwBtn') && $('copyPwBtn').addEventListener('click', () => navigator.clipboard.writeText(ALL.map((r) => `${r.email || ''}:${r.password || ''}`).join('\n')));
  $('dlTxtBtn') && $('dlTxtBtn').addEventListener('click', () => download('accounts.txt', ALL.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'), 'text/plain'));
  $('dlJsonBtn') && $('dlJsonBtn').addEventListener('click', () => download('accounts.json', JSON.stringify(ALL, null, 2), 'application/json'));

  (async () => { await loadNode(); await loadData(false); loadCards(); setupAuto(); })();
})();
