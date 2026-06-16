'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — BitBrowser（比特浏览器） · ⚠ 按官方本地 API 文档实现，本机未实测
//
// 本地服务默认 127.0.0.1:54345(可改 OPENROUTER_BITBROWSER_API)。全部 POST + JSON body。
//   开: POST /browser/open {id}  → data.ws (ws://127.0.0.1:port/devtools/...) + data.http (127.0.0.1:port)
//   关: POST /browser/close {id}
//   列: POST /browser/list {page,pageSize}
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');
const cfg = () => providerConfig('bitbrowser');

async function api(path, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${cfg().apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctrl.signal });
    return await r.json().catch(() => ({}));
  } finally { clearTimeout(t); }
}
// debugPort 统一规整成【纯端口号】(selenium 引擎会拼 127.0.0.1:<port>)。
function portOf(s) { const m = String(s || '').match(/:(\d+)(?:\/|$)/); return m ? m[1] : undefined; }

module.exports = {
  name: 'bitbrowser',
  isHealthy: async () => { try { const j = await api('/health', {}, 5000); return !!(j && (j.success || j.data)); } catch (_e) { return false; } },
  list: async () => {
    try {
      const j = await api('/browser/list', { page: 0, pageSize: 100 });
      const arr = (j && j.data && (j.data.list || j.data)) || [];
      return (Array.isArray(arr) ? arr : []).map((e) => ({ id: e.id, name: e.name || e.remark || '', raw: e }));
    } catch (_e) { return []; }
  },
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'bitbrowser:ENV_ID_MISSING' };
    try {
      const j = await api('/browser/open', { id: envId });
      if (!j || j.success === false) return { ok: false, error: `bitbrowser:${(j && j.msg) || 'open failed'}` };
      const d = j.data || {};
      if (!d.ws) return { ok: false, error: 'bitbrowser:NO_WS' };
      return { ok: true, ws: d.ws, debugPort: portOf(d.http) || portOf(d.ws) };
    } catch (e) { return { ok: false, error: `bitbrowser:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => { try { await api('/browser/close', { id: envId }, 15000); } catch (_e) { /* ignore */ } },
};
