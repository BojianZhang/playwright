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
};

if (els.downloadBtn) {
  els.downloadBtn.addEventListener('click', () => {
    if (currentJobId) window.open(`/download?jobId=${encodeURIComponent(currentJobId)}`, '_blank');
  });
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
  evtSource = new EventSource(`/events?jobId=${encodeURIComponent(jobId)}`);

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
    appendLine(els.runLog, `[${ts()}] ✗ ${d.email || ''} → ${d.reason} (${d.failClass})`);
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
    timeoutMs: fd.get('timeoutMs'),
    apiKeyName: fd.get('apiKeyName') || '',
    apiKeyExpiration: fd.get('apiKeyExpiration') || 'No expiration',
    topUpAmount: fd.get('topUpAmount'),
    cardNumber: fd.get('cardNumber') || '',
    expMonth: fd.get('expMonth') || '',
    expYear: fd.get('expYear') || '',
    cvc: fd.get('cvc') || '',
    cardName: fd.get('cardName') || '',
    successTemplate: fd.get('successTemplate') || '',
  };

  els.startBtn.disabled = true;
  els.formMsg.textContent = '提交中…';
  try {
    const resp = await fetch('/jobs', {
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
