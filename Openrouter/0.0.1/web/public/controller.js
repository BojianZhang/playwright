/* ===========================================================
   OpenRouter 控制台 — 新 UI ↔ 现有后端 桥接层
   - 构造与旧版等价的 /jobs payload
   - SSE 实时 → 新 DOM
   - 卡池/台账/账号状态/错误记录 走真实 /api/*
   =========================================================== */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const af = (u, o, silent) => (window.authFetch ? window.authFetch(u, o, silent) : fetch(u, o));
  const wtk = (u) => (window.withToken ? window.withToken(u) : u);

  /* ===================================================
     文件上传：逐行按字段格式抽取，只留匹配的，忽略杂质
     （移植自现版 app.js，含地址富 CSV 解析）
     =================================================== */
  const unq = (s) => s.replace(/^["']|["']$/g, '').trim();
  const LINE_EXTRACT = {
    account(line) {
      const em = line.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
      if (!em) return null;
      const email = em[0];
      const after = line.slice(em.index + email.length);
      const pm = after.match(/[\s:|,;\t]+(\S[^\s|,;\t]*)/);
      return `${email}:${pm ? unq(pm[1]) : ''}`;
    },
    proxy(line) {
      const t = unq(line.split(/\s+\|\s+/)[0]);
      let m = t.match(/^([^\s:@]+):([^\s:@]+)@([A-Za-z0-9.\-]+):(\d{1,5})$/);
      if (m) return `${m[3]}:${m[4]}:${m[1]}:${m[2]}`;
      m = t.match(/^([A-Za-z0-9.\-]+):(\d{1,5})(?::(.+))?$/);
      if (m) return m[3] != null ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
      return null;
    },
    card(line) {
      const compact = line.replace(/[ \-]/g, '');
      return /(?:^|\D)\d{13,19}(?:\D|$)/.test(compact) ? line.trim() : null;
    },
  };
  function lineParse(text, ex) {
    const kept = []; let ignored = 0;
    text.split(/\r?\n/).forEach((line) => {
      const s = line.trim();
      if (!s || s.startsWith('#')) return;
      const out = ex(s);
      if (out) kept.push(out); else ignored += 1;
    });
    return { kept, ignored };
  }
  // CSV（引号字段/字段内逗号/"" 转义/BOM/CRLF）
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
  function splitUsAddress(addr) {
    let parts = String(addr).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length && /^(united states|usa|u\.?s\.?a?\.?)$/i.test(parts[parts.length - 1])) parts.pop();
    if (parts.length < 3) return null;
    const sz = parts.pop().match(/^(.+?)\s+(\d{5}(?:-\d{4})?)$/);
    if (!sz) return null;
    const state = sz[1].trim(); const zip = sz[2];
    const city = parts.pop();
    const line1 = parts.join(' ').replace(/\s+/g, ' ').trim();
    return (line1 && city && state && zip) ? { line1, city, state, zip } : null;
  }
  function rowToAddress(cells, nameIdx, addrIdx) {
    const name = (nameIdx >= 0 ? cells[nameIdx] : cells[0] || '').trim();
    let addr = addrIdx >= 0 ? (cells[addrIdx] || '').trim()
      : (cells.find((c) => /\d{5}(?:-\d{4})?\s*,\s*united states/i.test(c) || /,\s*[A-Za-z][A-Za-z .]+\s+\d{5}(?:-\d{4})?\b/.test(c)) || '').trim();
    if (!name || !addr) return null;
    const c = splitUsAddress(addr);
    return c ? [name, c.line1, c.city, c.state, c.zip].join('|') : null;
  }
  function parseAddressSmart(text) {
    const rows = csvRows(text);
    const kept = []; let ignored = 0;
    let nameIdx = -1, addrIdx = -1, start = 0;
    if (rows.length) {
      rows[0].forEach((c, i) => { const h = String(c).toLowerCase(); if (nameIdx < 0 && /(name|姓名)/.test(h)) nameIdx = i; if (addrIdx < 0 && /(address|地址)/.test(h)) addrIdx = i; });
      if (nameIdx >= 0 && addrIdx >= 0) start = 1;
    }
    for (let r = start; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || !cells.join('').trim()) continue;
      if (cells.length === 1 && cells[0].includes('|')) {
        const p = cells[0].split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
        if (p.length >= 4) { kept.push(p.join('|')); continue; }
        ignored += 1; continue;
      }
      const canon = rowToAddress(cells, nameIdx, addrIdx);
      if (canon) { kept.push(canon); continue; }
      const flat = cells.map((s) => s.trim()).filter(Boolean);
      if (flat.length >= 4 && /\d{5}/.test(flat[flat.length - 1] || flat[flat.length - 2])) { kept.push(flat.join('|')); continue; }
      ignored += 1;
    }
    return { kept, ignored };
  }
  const KIND_LABEL = { account: '邮箱:密码', proxy: 'host:port:user:pass', card: '银行卡', address: '姓名|街道|城市|州|邮编' };
  const PARSE = {
    account: (t) => lineParse(t, LINE_EXTRACT.account),
    proxy: (t) => lineParse(t, LINE_EXTRACT.proxy),
    card: (t) => lineParse(t, LINE_EXTRACT.card),
    address: parseAddressSmart,
  };

  function applyParsed(field, text, kind) {
    const ta = field.querySelector('textarea');
    const fn = field.querySelector('[data-fname]');
    const { kept, ignored } = (PARSE[kind] || ((t) => ({ kept: t.split(/\r?\n/).filter(Boolean), ignored: 0 })))(text);
    if (!kept.length) {
      if (fn) { fn.className = 'fname err'; fn.textContent = `✕ 没识别出符合「${KIND_LABEL[kind] || kind}」的数据（忽略 ${ignored} 行）—— 传错文件了？`; }
      return;
    }
    if (ta) { const prev = ta.value.replace(/\s+$/, ''); ta.value = prev ? `${prev}\n${kept.join('\n')}` : kept.join('\n'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    if (fn) { fn.className = 'fname ok'; fn.textContent = `✓ 解析出 ${kept.length} 条${ignored ? ` · 忽略 ${ignored} 行` : ''}`; }
  }

  $$('.upload input[type=file]').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const field = e.target.closest('.field'); if (!field) return;
      const kind = field.dataset.format;
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { applyParsed(field, String(reader.result), kind); if (kind === 'card') {/* 卡需点导入入池 */} };
      reader.onerror = () => { const fn = field.querySelector('[data-fname]'); if (fn) { fn.className = 'fname err'; fn.textContent = '✕ 读取失败'; } };
      reader.readAsText(file);
      e.target.value = '';
    });
  });
  // 手动编辑文本框：清掉上传提示，避免遗留旧计数
  $$('.field[data-format] textarea').forEach((ta) => {
    ta.addEventListener('input', (e) => {
      if (!e.isTrusted) return;
      const fn = ta.closest('.field').querySelector('[data-fname]');
      if (fn) { fn.className = 'fname'; fn.textContent = ''; }
    });
  });

  const fieldText = (kind) => { const ta = $(`.field[data-format="${kind}"] textarea`); return ta ? ta.value : ''; };

  /* ===================================================
     阶段 chips —— 统一按执行流程跑（所见即所跑）
     账单链：绑地址 ⊂ 加卡 ⊂ 充值（勾后者自动点亮前者，取消前者自动熄后者）
     改密：点一下自动点亮其依赖的整条路径（取Key+充值，连带加卡+绑地址）；缺统一密码则提示
     取Key：独立
     =================================================== */
  const stageEl = (k) => $(`.stage[data-stage="${k}"]`);
  const stageOn = (k) => { const e = stageEl(k); return !!(e && e.classList.contains('on')); };
  const setStage = (k, on) => { const e = stageEl(k); if (e) e.classList.toggle('on', !!on); };
  const upwd = $('#unifiedPwd');
  const BILL_CHAIN = ['addr', 'card', 'charge']; // 由浅到深，亮的集合永远是它的前缀

  function pwdGateOk() { return stageOn('key') && stageOn('charge') && !!(upwd && upwd.value.trim()); }
  function syncStages() {
    const pwd = stageEl('pwd');
    if (pwd) {
      const canClick = !!(upwd && upwd.value.trim());
      pwd.style.opacity = canClick ? '' : '.5';
      pwd.title = canClick ? '改密（点一下会自动点亮 取Key+充值 等前置）' : '改密需先填上方「统一密码」';
      if (pwd.classList.contains('on') && !pwdGateOk()) pwd.classList.remove('on'); // 前置被取消 → 改密自动熄
    }
  }
  function clickChip(stage) {
    if (stage === 'key') { setStage('key', !stageOn('key')); }
    else if (stage === 'pwd') {
      if (stageOn('pwd')) { setStage('pwd', false); }
      else if (!(upwd && upwd.value.trim())) { flashHint('改密需先填「统一密码」'); }
      else { setStage('key', true); BILL_CHAIN.forEach((s) => setStage(s, true)); setStage('pwd', true); } // 点亮整条改密路径
    } else { // 账单链：前缀语义
      const idx = BILL_CHAIN.indexOf(stage); const turnOn = !stageOn(stage);
      if (turnOn) for (let i = 0; i <= idx; i++) setStage(BILL_CHAIN[i], true);   // 点亮它 + 所有更浅的
      else for (let i = idx; i < BILL_CHAIN.length; i++) setStage(BILL_CHAIN[i], false); // 熄灭它 + 所有更深的
    }
    syncStages();
  }
  $$('.stage[data-stage]').forEach((s) => s.addEventListener('click', () => clickChip(s.dataset.stage)));
  if (upwd) upwd.addEventListener('input', syncStages);
  function deriveBillingAction() { return stageOn('charge') ? 'charge' : stageOn('card') ? 'card' : stageOn('addr') ? 'address' : 'none'; }

  /* ===================================================
     统一密码必填校验（沿用新 UI 的 hero invalid 提示）
     =================================================== */
  const hero = upwd ? upwd.closest('.set-hero') : null;
  function checkPwd(show) {
    const empty = !upwd || !upwd.value.trim();
    if (hero && show) hero.classList.toggle('invalid', empty);
    return !empty;
  }
  if (upwd) upwd.addEventListener('input', () => { if (hero && hero.classList.contains('invalid')) checkPwd(true); });

  const runHint = $('#runHint');
  function flashHint(msg) { if (runHint) runHint.innerHTML = `<b style="color:var(--danger)">${esc(msg)}</b>`; }

  /* ===================================================
     tabs
     =================================================== */
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('on'));
    $$('.tabpane').forEach((p) => p.classList.remove('on'));
    tab.classList.add('on');
    const pane = $(`[data-pane="${tab.dataset.tab}"]`); if (pane) pane.classList.add('on');
  }));

  /* ===================================================
     下方面板：卡池 / 台账 / 账号状态 / 错误记录（真实 /api）
     =================================================== */
  const CARD_STATUS = { active: '可用', exhausted: '用尽', declined: '被拒', disabled: '已禁用' };
  function shortTime(s) { if (!s) return '—'; try { return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_e) { return s; } }

  async function loadPool() {
    const host = $('[data-pooltab]'); if (!host) return;
    let d; try { const r = await af('/api/cards', {}, true); if (!r || !r.ok) return; d = await r.json(); } catch (_e) { return; }
    const cards = d.cards || [];
    const cnt = $('[data-pooltabcnt]'); if (cnt) cnt.textContent = cards.length;
    if (!cards.length) { host.outerHTML = `<div class="empty-note" data-pooltab>尚无卡片，去上方「卡池」粘贴或上传后点「导入卡池」。</div>`; return; }
    const avail = d.available != null ? d.available : cards.filter((c) => c.status === 'active').length;
    host.outerHTML = `<div class="tbl-wrap" data-pooltab style="max-height:460px">
      <table class="tbl"><thead><tr>
        <th>卡号 (末4)</th><th>有效期</th><th>状态</th><th>可用次数</th><th>已用</th><th>剩余</th><th>成功</th><th>被拒</th><th>最近用</th><th>最近错误</th><th style="text-align:right">操作</th>
      </tr></thead><tbody>
      ${cards.map((c) => {
        const banned = c.status === 'disabled' || c.status === 'declined';
        const badge = c.status === 'active' ? '<span class="kbadge ok">可用</span>'
          : c.status === 'exhausted' ? '<span class="kbadge fail">已用尽</span>'
          : `<span class="kbadge neutral">${CARD_STATUS[c.status] || c.status}</span>`;
        return `<tr class="${banned ? 'is-banned' : (c.status === 'exhausted' ? 'is-used' : '')}">
        <td class="mono">${esc(c.masked)}</td>
        <td class="mono">${esc(c.exp)}</td>
        <td>${badge}</td>
        <td><input class="cell-num" type="number" min="1" max="100" value="${c.maxUses}" data-cardmax="${c.id}"></td>
        <td class="mono">${c.usedCount}</td>
        <td class="mono"><b>${c.remaining}</b></td>
        <td class="mono" style="color:var(--success)">${c.successCount}</td>
        <td class="mono" style="color:var(--danger)">${c.declineCount}</td>
        <td class="mono" style="color:var(--text-3)">${shortTime(c.lastUsedAt)}</td>
        <td class="mono" style="color:${c.lastError ? 'var(--danger)' : 'var(--text-4)'}" title="${esc(c.lastError)}">${c.lastError ? esc(String(c.lastError).slice(0, 22)) : '—'}</td>
        <td><div class="row-actions">
          <button class="btn btn-ghost btn-sm" data-card="${c.status === 'disabled' ? 'enable' : 'disable'}" data-id="${c.id}">${c.status === 'disabled' ? '启用' : '禁用'}</button>
          <button class="btn btn-ghost btn-sm" data-card="reset" data-id="${c.id}">重置</button>
          <button class="btn btn-danger-soft btn-sm" data-card="remove" data-id="${c.id}">删除</button>
        </div></td>
      </tr>`;
      }).join('')}
      </tbody></table>
      <div style="padding:9px 12px;border-top:1px solid var(--border);font-size:11.5px;color:var(--text-2)">共 <b style="font-family:var(--mono);color:var(--text)">${cards.length}</b> 张 · 可用 <b style="font-family:var(--mono);color:var(--success)">${avail}</b></div>
    </div>`;
  }
  async function cardAction(act, body) {
    try { const r = await af(`/api/cards/${act}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); if (r.ok) await loadPool(); } catch (_e) { /* ignore */ }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-card]'); if (!b) return;
    if (b.dataset.card === 'remove' && !confirm('从卡池删除这张卡？')) return;
    cardAction(b.dataset.card, { id: b.dataset.id });
  });
  document.addEventListener('change', (e) => {
    const inp = e.target.closest('[data-cardmax]'); if (!inp) return;
    const v = Math.max(1, Math.min(100, Number(inp.value) || 1)); inp.value = v;
    cardAction('update', { id: inp.dataset.cardmax, maxUses: v });
  });

  async function loadLedger() {
    const host = $('[data-ledgertab]'); if (!host) return;
    let s; try { const r = await af('/api/billing', {}, true); if (!r || !r.ok) return; s = await r.json(); } catch (_e) { return; }
    const t = $('[data-led-total]'); if (t) t.textContent = `总充值 $${s.totalCharged || 0}`;
    const o = $('[data-led-ok]'); if (o) o.textContent = `成功 ${s.success || 0}`;
    const f = $('[data-led-fail]'); if (f) f.textContent = `被拒 ${s.declined || 0}`;
    const entries = s.entries || [];
    const BILL = { success: '<span class="kbadge ok">✓ 成功</span>', declined: '<span class="kbadge fail">✕ 被拒</span>', 'card-bound': '<span class="kbadge info">✓ 加卡</span>', 'address-bound': '<span class="kbadge info">✓ 地址</span>', 'no-card': '<span class="kbadge neutral">无卡</span>', 'no-address': '<span class="kbadge neutral">无地址</span>', 'page-closed': '<span class="kbadge fail">页面关闭</span>' };
    if (!entries.length) { host.outerHTML = `<div class="empty-note" data-ledgertab>暂无充值记录。</div>`; return; }
    host.outerHTML = `<div class="tbl-wrap" data-ledgertab style="max-height:460px">
      <table class="tbl"><thead><tr><th>时间</th><th>邮箱</th><th>卡</th><th>金额</th><th>结果</th><th>错误</th></tr></thead><tbody>
      ${entries.map((e) => `<tr class="${e.result === 'declined' ? 'is-banned' : ''}">
        <td class="mono" style="color:var(--text-3)">${shortTime(e.at)}</td>
        <td class="mono">${esc(e.email)}</td>
        <td class="mono">${e.cardLast4 ? '•••• ' + esc(e.cardLast4) : '—'}</td>
        <td class="mono">${e.charged ? '$' + esc(e.charged) : '—'}</td>
        <td>${BILL[e.result] || esc(e.result)}</td>
        <td class="mono" style="color:${e.error ? 'var(--danger)' : 'var(--text-4)'}" title="${esc(e.error)}">${e.error ? esc(String(e.error).slice(0, 24)) : '—'}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }

  async function loadStatus() {
    const host = $('[data-statustab]'); if (!host) return;
    let d; try { const r = await af('/api/accounts', {}, true); if (!r || !r.ok) return; d = await r.json(); } catch (_e) { return; }
    const accts = d.accounts || [];
    const cnt = $('[data-statuscnt]'); if (cnt) cnt.textContent = accts.length;
    const hint = $('[data-statushint]'); if (hint) hint.innerHTML = `本节点 · 共 <b style="color:var(--text)">${accts.length}</b> 个账号`;
    if (!accts.length) { host.outerHTML = `<div class="empty-note" data-statustab>暂无账号状态。运行后自动记录。</div>`; return; }
    const yn = (v) => v ? '<span style="color:var(--success);font-weight:700">✓</span>' : '<span class="mini-x">—</span>';
    host.outerHTML = `<div class="tbl-wrap" data-statustab style="max-height:520px">
      <table class="tbl"><thead><tr>
        <th>邮箱</th><th>注册</th><th>Key</th><th>账单</th><th>充值</th><th>卡</th><th>改密</th><th>出口 IP</th><th>状态</th><th>更新</th><th style="text-align:right">操作</th>
      </tr></thead><tbody>
      ${accts.map((a) => `<tr class="${a.blacklisted ? 'is-banned' : ''}">
        <td class="mono">${esc(a.email)}</td>
        <td>${yn(a.registered)}</td>
        <td>${a.apiKey ? '<span style="color:var(--success);font-weight:700">✓</span>' : '<span class="mini-x">—</span>'}</td>
        <td class="mono" style="color:var(--text-2)">${esc(a.billingStatus || '—')}</td>
        <td>${yn(a.charged)}</td>
        <td>${a.cardLast4 ? '<span class="mono">•••• ' + esc(a.cardLast4) + '</span>' : '<span class="mini-x">—</span>'}</td>
        <td>${yn(a.passwordChanged)}</td>
        <td class="mono" style="color:var(--text-2)">${esc(a.exitIp || '—')}</td>
        <td>${a.blacklisted ? '<span class="kbadge fail">⊘ 拉黑</span>' : '<span class="kbadge ok">正常</span>'}</td>
        <td class="mono" style="color:var(--text-3)">${shortTime(a.updatedAt)}</td>
        <td><div class="row-actions"><button class="btn ${a.blacklisted ? 'btn-danger-soft' : 'btn-ghost'} btn-sm" data-acc="reset" data-email="${esc(a.email)}">${a.blacklisted ? '解黑' : '重置'}</button></div></td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-acc="reset"]'); if (!b) return;
    if (!confirm(`重置账号 ${b.dataset.email}？下次将从头跑（解黑/清进度）。`)) return;
    await af('/api/accounts/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: b.dataset.email }) });
    loadStatus();
  });

  const ERR_ACTION = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑', abort: '放弃' };
  async function loadErrors() {
    const host = $('[data-errtab]'); if (!host) return;
    let d; try { const r = await af('/api/errors', {}, true); if (!r || !r.ok) return; d = await r.json(); } catch (_e) { return; }
    const entries = d.entries || [];
    const cnt = $('[data-errcnt]'); if (cnt) cnt.textContent = d.total || 0;
    const hint = $('[data-errhint]'); if (hint) hint.innerHTML = `本节点 · 共 <b style="color:var(--text)">${d.total || 0}</b> 条`;
    const sum = $('[data-errsummary]');
    if (sum) sum.innerHTML = []
      .concat(Object.entries(d.byAction || {}).map(([k, v]) => `<span class="err-chip act">${esc(ERR_ACTION[k] || k)} <b>${v}</b></span>`))
      .concat(Object.entries(d.byReason || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `<span class="err-chip code">${esc(k)} <b>${v}</b></span>`)).join('');
    if (!entries.length) { host.outerHTML = `<div class="empty-note" data-errtab>暂无错误记录。</div>`; return; }
    host.outerHTML = `<div class="tbl-wrap" data-errtab style="max-height:420px">
      <table class="tbl"><thead><tr><th>时间</th><th>邮箱</th><th>阶段</th><th>错误</th><th>动作</th><th>第几次</th></tr></thead><tbody>
      ${entries.map((e) => `<tr>
        <td class="mono" style="color:var(--text-3)">${shortTime(e.at)}</td>
        <td class="mono">${esc(e.email || '—')}</td>
        <td class="mono" style="color:var(--text-2)">${esc(e.stage || '—')}</td>
        <td class="mono" style="color:var(--danger)">${esc(e.reason)}</td>
        <td><span class="kbadge ${e.action === 'blacklist' ? 'fail' : 'warn'}">${esc(ERR_ACTION[e.action] || e.action || '—')}</span></td>
        <td class="mono">${e.attempt != null ? esc(e.attempt) : '—'}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }

  // refresh / clear 按钮
  $$('[data-refresh]').forEach((b) => b.addEventListener('click', () => ({ pool: loadPool, ledger: loadLedger, status: loadStatus, errors: loadErrors }[b.dataset.refresh] || (() => {}))()));
  $$('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.clear;
    const ep = { pool: '/api/cards/clear', ledger: '/api/billing/clear', status: '/api/accounts/clear', errors: '/api/errors/clear' }[k];
    const warn = { pool: '清空整个卡池？', ledger: '清空充值台账？', status: '清空全部账号状态？清空后重跑将从头执行。', errors: '清空全部错误记录？' }[k];
    if (!ep || !confirm(warn)) return;
    await af(ep, { method: 'POST' });
    ({ pool: loadPool, ledger: loadLedger, status: loadStatus, errors: loadErrors }[k] || (() => {}))();
  }));

  // 导入卡池
  const importBtn = $('#importCardsBtn');
  if (importBtn) importBtn.addEventListener('click', async () => {
    const raw = fieldText('card');
    const fn = $('.field[data-format="card"] [data-fname]');
    if (!raw.trim()) { if (fn) { fn.className = 'fname err'; fn.textContent = '卡池框为空'; } return; }
    if (fn) { fn.className = 'fname'; fn.textContent = '导入中…'; }
    try {
      const r = await af('/api/cards/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardsRaw: raw, maxUses: Number(($('#cardMax') || {}).value) || 10 }) });
      const d = await r.json();
      if (fn) { fn.className = 'fname ok'; fn.textContent = `✓ 新增 ${d.added || 0} · 更新 ${d.updated || 0} · 可用 ${d.available || 0}${(d.parseErrors || []).length ? ` · ${d.parseErrors.length} 行无法解析` : ''}`; }
      const ta = $('.field[data-format="card"] textarea'); if (ta) ta.value = '';
      loadPool();
    } catch (err) { if (fn) { fn.className = 'fname err'; fn.textContent = `导入失败：${err.message}`; } }
  });

  /* ===================================================
     提交跑批 + SSE
     =================================================== */
  const els = {
    total: $('[data-stat="total"]'), ok: $('[data-stat="ok"]'), fail: $('[data-stat="fail"]'),
    br: $('[data-stat="br"]'), q: $('[data-stat="q"]'),
    workerList: $('#workerList'), workerCount: $('#workerCount'),
    okBox: $('[data-okbox]'), failBox: $('[data-failbox]'), okCount: $('[data-okcount]'), failCount: $('[data-failcount]'),
    log: $('#logBox'), runBtn: $('#runBtn'),
  };
  const STAGE_LABELS = { 'waiting-slot': '排队等待', 'proxy-precheck': '代理预检', 'email-password-change': '邮箱改密', 'openrouter-register': '注册', 'magic-link-login': '邮箱验证', 'api-key': '创建Key', 'billing-card-topup': '充值', 'export': '导出' };
  const STAGE_ORDER = ['proxy-precheck', 'email-password-change', 'openrouter-register', 'magic-link-login', 'api-key', 'billing-card-topup', 'export'];

  let evtSource = null, currentJobId = null, browsersMax = 0;
  const counters = { total: 0, ok: 0, fail: 0 };
  const workers = {};
  const failedAccounts = [];

  function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
  function log(msg, cls) {
    if (!els.log) return;
    if (els.log.textContent === '等待开始…') els.log.textContent = '';
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:var(--text-4)">${ts()}</span>  ` + (cls ? `<span class="${cls}">${esc(msg)}</span>` : esc(msg));
    els.log.appendChild(line); els.log.scrollTop = els.log.scrollHeight;
  }
  function setStat(el, v) { if (el) el.textContent = v; }
  function renderWorkers() {
    const alive = Object.keys(workers).filter((id) => { const w = workers[id]; return w && w.status !== 'done' && w.status !== 'idle' && w.status !== 'failed'; });
    if (els.workerCount) els.workerCount.textContent = `${alive.length} 个线程`;
    if (!els.workerList) return;
    const ids = Object.keys(workers).map(Number).sort((a, b) => a - b);
    if (!ids.length) return;
    els.workerList.innerHTML = ids.map((id) => {
      const w = workers[id];
      const idx = STAGE_ORDER.indexOf(w.stage);
      const pct = w.status === 'done' ? 100 : Math.max(2, Math.round(((idx < 0 ? 0 : idx) / (STAGE_ORDER.length - 1)) * 100));
      const stage = STAGE_LABELS[w.stage] || w.stage || w.status || '';
      return `<div class="worker-row">
        <span class="wid">#${id}</span>
        <div><div class="wmail">${esc(w.account || '')}</div><div class="wstage">阶段：${esc(stage)}</div></div>
        <div style="display:flex;align-items:center;gap:10px"><div class="wbar"><i style="width:${pct}%"></i></div><span style="font-family:var(--mono);font-size:11px;color:var(--text-3);min-width:34px;text-align:right">${pct}%</span></div>
      </div>`;
    }).join('');
  }
  function appendIO(box, cls, text) {
    if (!box) return;
    box.classList.remove('empty');
    if (box.dataset.seeded !== '1') { box.innerHTML = ''; box.dataset.seeded = '1'; }
    const div = document.createElement('div'); div.className = cls; div.textContent = text;
    box.appendChild(div); box.scrollTop = box.scrollHeight;
  }

  function resetRun(total) {
    counters.total = total; counters.ok = 0; counters.fail = 0;
    Object.keys(workers).forEach((k) => delete workers[k]);
    failedAccounts.length = 0;
    setStat(els.total, total); setStat(els.ok, '0'); setStat(els.fail, '0'); setStat(els.br, '0/0'); setStat(els.q, '0');
    if (els.okBox) { els.okBox.classList.add('empty'); els.okBox.textContent = '运行中…'; els.okBox.dataset.seeded = '0'; }
    if (els.failBox) { els.failBox.classList.add('empty'); els.failBox.textContent = '运行中…'; els.failBox.dataset.seeded = '0'; }
    if (els.log) els.log.textContent = '';
    if (els.workerList) els.workerList.innerHTML = '<div class="worker-empty">启动中…</div>';
    ['dlOkBtn', 'dlFailBtn', 'requeueBtn'].forEach((id) => { const b = $('#' + id); if (b) b.disabled = true; });
  }

  function openStream(jobId) {
    if (evtSource) evtSource.close();
    evtSource = new EventSource(wtk(`/events?jobId=${encodeURIComponent(jobId)}`));
    evtSource.addEventListener('connected', () => log(`SSE 已连接 (${jobId})`));
    evtSource.addEventListener('log', (e) => log(JSON.parse(e.data)));
    evtSource.addEventListener('worker-update', (e) => {
      const w = (JSON.parse(e.data) || {}).worker || {};
      if (w.workerId == null) return;
      const prev = workers[w.workerId] || {};
      workers[w.workerId] = { status: w.status || prev.status, stage: w.stage || prev.stage, account: w.account || prev.account };
      renderWorkers();
    });
    evtSource.addEventListener('runtime-stats', (e) => {
      const s = JSON.parse(e.data) || {}; browsersMax = s.browsersMax || browsersMax;
      setStat(els.br, `${s.browsersActive || 0}/${s.browsersMax || 0}`);
      setStat(els.q, String(s.browsersQueued || 0));
    });
    evtSource.addEventListener('account-success', (e) => {
      const d = JSON.parse(e.data) || {}; counters.ok += 1; setStat(els.ok, counters.ok); if (els.okCount) els.okCount.textContent = counters.ok;
      appendIO(els.okBox, 'ln-ok', d.rendered || JSON.stringify(d.raw || {}));
      const b = $('#dlOkBtn'); if (b) b.disabled = false;
    });
    evtSource.addEventListener('account-failed', (e) => {
      const d = JSON.parse(e.data) || {}; counters.fail += 1; setStat(els.fail, counters.fail); if (els.failCount) els.failCount.textContent = counters.fail;
      appendIO(els.failBox, 'ln-fail', d.rendered || `${d.email || ''} | ${d.reason || ''}`);
      log(`✗ ${d.email || ''} → ${d.reason || ''} (${d.failClass || ''})`, 'ln-fail');
      failedAccounts.push(d);
      $('#dlFailBtn') && ($('#dlFailBtn').disabled = false);
      $('#requeueBtn') && ($('#requeueBtn').disabled = false);
    });
    evtSource.addEventListener('card-stats', (e) => {
      const d = JSON.parse(e.data) || {};
      loadPool();
      if (d.last && d.last.last4) { const r = d.last.result === 'success' ? '✓充值成功' : (d.last.result === 'declined' ? '✗被拒' : (d.last.result || '')); log(`卡 •••• ${d.last.last4} ${r}${d.last.error ? ' ' + d.last.error : ''}`); }
    });
    evtSource.addEventListener('billing-stats', () => loadLedger());
    evtSource.addEventListener('failure-stats', () => { loadErrors(); });
    evtSource.addEventListener('job-done', (e) => {
      const s = JSON.parse(e.data) || {};
      setStat(els.br, `0/${browsersMax}`); setStat(els.q, '0');
      log(`■ 任务结束：成功 ${s.success || 0} · 失败 ${s.failed || 0} · 用时 ${s.durationMs || 0}ms`, 'ln-ok');
      stopUI(true, s);
      loadPool(); loadLedger(); loadStatus(); loadErrors();
      if (evtSource) { evtSource.close(); evtSource = null; }
    });
    evtSource.onerror = () => log('SSE 连接中断');
  }

  function buildPayload() {
    return {
      accountsRaw: fieldText('account'),
      proxiesRaw: fieldText('proxy'),
      cardsRaw: fieldText('card'),
      billingAddressesRaw: fieldText('address'),
      headed: !!($('#headedChk') && $('#headedChk').checked),
      resume: !!($('#resumeChk') && $('#resumeChk').checked),
      concurrency: Number(($('#concInput') || {}).value) || 1,
      count: Number(($('#countInput') || {}).value) || 0,
      mode: ($('#modeSel') || {}).value === 'login' ? 'login' : 'register',
      unifiedPassword: (upwd && upwd.value.trim()) || '',
      apiKeyName: (($('#keyName') || {}).value || '').trim(),
      apiKeyExpiration: ($('#keyExp') || {}).value || 'No expiration',
      billingAction: deriveBillingAction(),
      doApiKey: stageOn('key'),
      doPasswordChange: stageOn('pwd') && pwdGateOk(),
      topUpAmount: Math.max(5, Number(($('#topUp') || {}).value) || 5),
      maxCardTries: Math.max(1, Math.min(10, Number(($('#maxCardTries') || {}).value) || 3)),
      cardMaxUses: Number(($('#cardMax') || {}).value) || 10,
      addressMode: fieldText('address').trim() ? 'pool' : 'random',
      addressStates: 'Oregon, Delaware, Montana, New Hampshire',
      billingAddressStrategy: 'random',
      successTemplate: ($('#inlineTplSuccess') || {}).value || '',
      failureTemplate: ($('#inlineTplFail') || {}).value || '',
    };
  }

  function stopUI(done, s) {
    if (els.runBtn) {
      els.runBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg> 开始执行';
      els.runBtn.classList.add('btn-primary'); els.runBtn.classList.remove('btn-danger-soft'); els.runBtn.disabled = false;
    }
    if (done && runHint) runHint.innerHTML = `本批完成 —— 成功 <b style="color:var(--success)">${(s && s.success) || counters.ok}</b> · 失败 <b style="color:var(--danger)">${(s && s.failed) || counters.fail}</b>。可在 <a href="results.html" style="color:var(--primary-text)">聚合页</a> 查看下载。`;
    if (els.workerList) els.workerList.innerHTML = `<div class="worker-empty">本批已结束。重新点 <b style="color:var(--text)">「开始执行」</b> 可再跑一批。</div>`;
  }

  let running = false;
  if (els.runBtn) els.runBtn.addEventListener('click', async () => {
    if (running) { // 停止：关闭 SSE（后端任务仍会自然结束/排空）
      running = false; if (evtSource) { evtSource.close(); evtSource = null; }
      stopUI(false); if (runHint) runHint.innerHTML = '已停止监听。断点续跑已记录进度，再次执行会自动跳过已完成阶段。';
      return;
    }
    if (!checkPwd(true)) { upwd && upwd.focus(); flashHint('请先填写「统一密码」—— 不能留空，否则后续改密很麻烦'); return; }
    if (!fieldText('account').trim()) { flashHint('请先填写或上传「账号凭证」'); return; }
    els.runBtn.disabled = true;
    if (runHint) runHint.textContent = '提交中…';
    try {
      const r = await af('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload()) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || '提交失败');
      currentJobId = d.jobId; running = true;
      resetRun(d.accepted || 0);
      if (runHint) runHint.innerHTML = `已接受 <b>${d.accepted}</b> 个账号 · 运行中 —— 实时进度见下方面板。`;
      els.runBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg> 停止';
      els.runBtn.classList.remove('btn-primary'); els.runBtn.classList.add('btn-danger-soft'); els.runBtn.disabled = false;
      openStream(d.jobId);
    } catch (err) { if (runHint) flashHint('错误：' + err.message); els.runBtn.disabled = false; }
  });

  // 下载 / 重跑
  $('#dlOkBtn') && $('#dlOkBtn').addEventListener('click', () => { if (currentJobId) window.open(wtk(`/download?jobId=${encodeURIComponent(currentJobId)}`), '_blank'); });
  $('#dlFailBtn') && $('#dlFailBtn').addEventListener('click', () => { if (currentJobId) window.open(wtk(`/download?type=failed&jobId=${encodeURIComponent(currentJobId)}`), '_blank'); });
  $('#requeueBtn') && $('#requeueBtn').addEventListener('click', () => {
    if (!failedAccounts.length) return;
    const lines = failedAccounts.map((d) => `${d.email}:${d.originalPassword || d.password || ''}`).join('\n');
    const ta = $('.field[data-format="account"] textarea'); if (ta) ta.value = lines;
    const m = $('#modeSel'); if (m) m.value = 'login';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (runHint) runHint.innerHTML = `已把 ${failedAccounts.length} 个失败账号回填（已切「仅登录续跑」），核对后点开始执行。`;
  });

  /* ---------- node 名 ---------- */
  (async () => {
    try { const r = await af('/api/node', {}, true); if (r && r.ok) { const n = await r.json(); const b = $('#nodeBadge'); if (b) b.innerHTML = `<span class="dot"></span>node&nbsp;${esc(n.nodeId || '本机')}`; } } catch (_e) { /* ignore */ }
  })();

  /* ---------- init ---------- */
  syncStages();
  loadPool(); loadLedger(); loadStatus(); loadErrors();
})();
