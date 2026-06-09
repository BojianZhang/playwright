/* ===========================================================
   Modals — 错误策略(真实 /api/policy) + 成功/失败回显模板编辑器
   =========================================================== */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const af = (u, o, silent) => (window.authFetch ? window.authFetch(u, o, silent) : fetch(u, o));

  /* ---------- open / close ---------- */
  function open(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.removeAttribute('hidden');
    requestAnimationFrame(() => m.classList.add('open'));
    document.body.style.overflow = 'hidden';
    if (m._onOpen) m._onOpen();
  }
  function close(m) {
    m.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => m.setAttribute('hidden', ''), 180);
  }
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => open(b.dataset.open)));
  $$('.modal-overlay').forEach((ov) => {
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(ov); });
    $$('[data-close]', ov).forEach((b) => b.addEventListener('click', () => close(ov)));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const o = $('.modal-overlay.open'); if (o) close(o); } });

  /* ===================================================
     回显模板编辑器（success / fail）— 回写内联 textarea
     =================================================== */
  const SEP = { space: ' ', pipe: ' | ', colon: ':', comma: ',', nl: '\n' };
  const SUCCESS_VARS = [
    { k: 'email', label: '邮箱', desc: '账号邮箱', sample: 'user1@firstmail.com' },
    { k: 'password', label: '密码', desc: '当前密码：设了统一密码并改密成功后＝新密码，否则＝原密码', sample: 'MyNewPass#2026' },
    { k: 'originalPassword', label: '原密码', desc: '邮箱原始密码（注册时用的）', sample: 'oldpw123' },
    { k: 'apiKey', label: 'key', desc: 'OpenRouter API Key', sample: 'sk-or-v1-abcd…ef01' },
    { k: 'billingStatus', label: 'billing', desc: 'skipped 未操作 / address-bound 已绑地址 / card-bound 已加卡 / success 已充值 / declined 被拒', sample: 'success' },
    { k: 'charged', label: '充值', desc: '实际充值金额（美元，未充值为 0）', sample: '10' },
    { k: 'cardLast4', label: 'card', desc: '本次所用卡号末 4 位', sample: '8695' },
    { k: 'passwordChanged', label: '改密', desc: '邮箱密码是否改为统一密码（true / false）', sample: 'true' },
    { k: 'exitIp', label: 'ip', desc: '代理出口 IP（该线路实际出网 IP）', sample: '203.0.113.7' },
  ];
  const FAIL_VARS = [
    { k: 'email', label: '邮箱', desc: '账号邮箱', sample: 'user2@firstmail.com' },
    { k: 'password', label: '密码', desc: '密码（失败时为原密码）', sample: 'oldpw456' },
    { k: 'reason', label: '原因', desc: '失败原因码（如 ACCOUNT_LOCKED、TURNSTILE_FAILED）', sample: 'ACCOUNT_LOCKED' },
    { k: 'stage', label: '阶段', desc: '失败发生的阶段', sample: 'signup' },
    { k: 'failClass', label: '分类', desc: '失败分类（便于统计归类）', sample: 'account' },
    { k: 'attempts', label: '尝试', desc: '实际尝试次数', sample: '3' },
    { k: 'detail', label: '详情', desc: '失败详情（最多 300 字）', sample: '账号在注册后被锁定' },
  ];
  function setupEcho(rootId, inlineId, vars) {
    const root = document.getElementById(rootId); if (!root) return;
    const ta = $('[data-tpl]', root); const prev = $('[data-preview]', root); const list = $('[data-varlist]', root);
    const inline = document.getElementById(inlineId);
    list.innerHTML = vars.map((v) => `<div class="vrow">
      <div class="vname"><span class="vvar">{{${v.k}}}</span><span class="vlabel">${esc(v.label)}</span></div>
      <div class="vdesc">${esc(v.desc)}</div>
      <button class="btn btn-soft btn-sm" data-ins="{{${v.k}}}">插入</button>
      <button class="btn btn-ghost btn-sm" data-ins="${esc(v.label)}:{{${v.k}}}">带名</button>
    </div>`).join('');
    function render() { let out = ta.value; vars.forEach((v) => { out = out.split('{{' + v.k + '}}').join(v.sample); }); prev.innerHTML = out ? esc(out) : '<span class="ph">（格式为空）</span>'; }
    function insert(text) {
      const s = ta.selectionStart ?? ta.value.length; const e = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      const pos = s + text.length; ta.focus(); ta.setSelectionRange(pos, pos); render();
    }
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-ins]'); if (b) insert(b.dataset.ins); });
    $$('[data-sep]', root).forEach((b) => b.addEventListener('click', () => insert(SEP[b.dataset.sep])));
    ta.addEventListener('input', render);
    $('[data-clear]', root).addEventListener('click', () => { ta.value = ''; render(); ta.focus(); });
    $('[data-done]', root).addEventListener('click', () => { if (inline) inline.value = ta.value; close(root); });
    root._onOpen = () => { if (inline) ta.value = inline.value; render(); };
    render();
  }
  setupEcho('modal-success', 'inlineTplSuccess', SUCCESS_VARS);
  setupEcho('modal-fail', 'inlineTplFail', FAIL_VARS);

  /* ===================================================
     错误策略表 — 真实 /api/policy（加载 effective、保存覆盖、重置）
     =================================================== */
  const ACTION_LABEL = { retry: '同代理重试', 'retry-new-proxy': '换代理重试', relogin: '重新登录', blacklist: '拉黑(不重试)', abort: '放弃' };
  (function setupErrors() {
    const root = document.getElementById('modal-errors'); if (!root) return;
    const erows = $('[data-erows]', root); const fbrows = $('[data-fbrows]', root);
    let ACTIONS = ['retry', 'retry-new-proxy', 'relogin', 'blacklist', 'abort'];

    function renderRows(list) {
      const settable = list.filter((p) => p.settable !== false && !String(p.code).startsWith('_'));
      const fallback = list.filter((p) => p.settable === false || String(p.code).startsWith('_'));
      erows.innerHTML = settable.map((p) => {
        const eff = p.effective || {}; const overridden = !!p.override;
        const opts = ACTIONS.map((a) => `<option value="${a}"${a === eff.action ? ' selected' : ''}>${ACTION_LABEL[a] || a}</option>`).join('');
        return `<div class="erow" data-code="${esc(p.code)}">
          <div><div class="ecode">${esc(p.code)}</div><div class="edesc">${esc(p.why || '')}</div></div>
          <select class="esel">${opts}</select>
          <input class="eretry" type="number" value="${Number(eff.maxRetries) || 0}" min="0" max="10">
          <span class="ebadge ${overridden ? 'changed' : 'neutral'}" data-badge>${overridden ? '已覆盖' : '内置'}</span>
          <button class="btn btn-soft btn-sm" data-save>保存</button>
          <button class="btn btn-ghost btn-sm" data-reset>重置</button>
        </div>`;
      }).join('');
      if (fbrows) fbrows.innerHTML = fallback.map((p) => `<div class="erow fallback">
        <div><div class="ecode">${esc(p.code)}</div><div class="edesc">${esc(p.why || '')}</div></div>
        <span class="fb-act">${esc(ACTION_LABEL[(p.effective || {}).action] || (p.effective || {}).action || '')}</span>
      </div>`).join('');
    }
    async function loadPolicy() {
      erows.innerHTML = '<div class="empty-note">加载中…</div>';
      try {
        const r = await af('/api/policy', {}, true); if (!r || !r.ok) { erows.innerHTML = '<div class="empty-note">加载失败（检查令牌）</div>'; return; }
        const d = await r.json(); if (Array.isArray(d.actions) && d.actions.length) ACTIONS = d.actions;
        renderRows(d.policy || []);
      } catch (_e) { erows.innerHTML = '<div class="empty-note">加载失败</div>'; }
    }
    function flash(btn, txt) { const old = btn.textContent; btn.textContent = txt; btn.disabled = true; setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 900); }

    erows.addEventListener('click', async (e) => {
      const row = e.target.closest('.erow[data-code]'); if (!row) return;
      const code = row.dataset.code; const badge = $('[data-badge]', row);
      if (e.target.closest('[data-save]')) {
        const action = $('.esel', row).value; const maxRetries = Number($('.eretry', row).value) || 0;
        const r = await af('/api/policy/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, action, maxRetries }) });
        if (r.ok) { const d = await r.json(); renderRows(d.policy || []); flash(e.target.closest('[data-save]'), '已保存'); }
        else { const d = await r.json().catch(() => ({})); alert('保存失败：' + (d.error || r.status)); }
      } else if (e.target.closest('[data-reset]')) {
        const r = await af('/api/policy/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
        if (r.ok) { const d = await r.json(); renderRows(d.policy || []); if (badge) { badge.textContent = '内置'; badge.className = 'ebadge neutral'; } }
      }
    });
    erows.addEventListener('change', (e) => {
      const row = e.target.closest('.erow'); if (!row) return;
      const badge = $('[data-badge]', row); if (badge && badge.textContent !== '已覆盖') { badge.textContent = '待保存'; badge.className = 'ebadge changed'; }
    });
    const resetAll = $('[data-resetall]', root);
    if (resetAll) resetAll.addEventListener('click', async () => {
      if (!confirm('把所有错误策略恢复为内置默认？')) return;
      const r = await af('/api/policy/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (r.ok) { const d = await r.json(); renderRows(d.policy || []); }
    });
    root._onOpen = loadPolicy;
  })();
})();
