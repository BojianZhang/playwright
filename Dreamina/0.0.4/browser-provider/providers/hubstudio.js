'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — HubStudio · ⚠ 最佳努力实现，本机未实测，字段请对照 HubStudio 官方 API 文档核对
//
// 本地 API 默认 127.0.0.1:6873。常见模式：
//   开: POST /api/v1/browser/start {containerCode} → data 内含 debuggingPort / wsEndpoint
//   关: POST /api/v1/browser/stop {containerCode}
//   列: POST /api/v1/env/list {current,size}
// 若字段名与你的版本不符，照本文件 + template.js 调整即可。
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');
const cfg = () => providerConfig('hubstudio');

async function api(path, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(`${cfg().apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctrl.signal }); return await r.json().catch(() => ({})); }
  finally { clearTimeout(t); }
}
function portOf(s) { const m = String(s || '').match(/:(\d+)(?:\/|$)/); return m ? m[1] : undefined; }

module.exports = {
  name: 'hubstudio',
  isHealthy: async () => { try { const j = await api('/api/v1/env/list', { current: 1, size: 1 }, 5000); return !!j; } catch (_e) { return false; } },
  list: async () => {
    try {
      const j = await api('/api/v1/env/list', { current: 1, size: 100 });
      const arr = (j && j.data && (j.data.list || j.data.rows || j.data)) || [];
      return (Array.isArray(arr) ? arr : []).map((e) => ({ id: e.containerCode || e.id, name: e.containerName || e.name || '', raw: e }));
    } catch (_e) { return []; }
  },
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'hubstudio:ENV_ID_MISSING' };
    try {
      const j = await api('/api/v1/browser/start', { containerCode: envId });
      const d = (j && j.data) || {};
      const ws = d.ws || d.wsEndpoint || (d.debuggingPort && `http://127.0.0.1:${d.debuggingPort}`);
      if (!ws) return { ok: false, error: `hubstudio:${(j && (j.msg || j.message)) || 'no ws(字段名请对照文档)'}` };
      return { ok: true, ws, debugPort: d.debuggingPort ? String(d.debuggingPort) : portOf(ws) };
    } catch (e) { return { ok: false, error: `hubstudio:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => { try { await api('/api/v1/browser/stop', { containerCode: envId }, 15000); } catch (_e) { /* ignore */ } },
};
