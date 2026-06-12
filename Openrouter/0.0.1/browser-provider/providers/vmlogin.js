'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — VMLogin · ⚠ 按官方本地 API 实现，本机未实测
//
// 客户端「我的账户→浏览器自动化设置」开启端口(默认 127.0.0.1:35000)。
//   开: GET /api/v1/profile/start?profileId=X&skiplock=true → { value:"http://127.0.0.1:PORT" }(debuggerAddress)
//   关: GET /api/v1/profile/stop?profileId=X
//   列: GET /api/v1/profile/list?start=0&limit=N
// connectOverCDP 接受 http CDP 端点 → 直接用 value(http://127.0.0.1:PORT)。
// 文档：vmlogin.us/help/api/start-browser-profile.html
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');
const cfg = () => providerConfig('vmlogin');

async function api(path, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(`${cfg().apiBase}${path}`, { signal: ctrl.signal }); return await r.json().catch(() => ({})); }
  finally { clearTimeout(t); }
}
function portOf(s) { const m = String(s || '').match(/:(\d+)(?:\/|$)/); return m ? m[1] : undefined; }

module.exports = {
  name: 'vmlogin',
  isHealthy: async () => { try { const j = await api('/api/v1/profile/list?start=0&limit=1', 5000); return !!j; } catch (_e) { return false; } },
  list: async () => {
    try {
      const j = await api('/api/v1/profile/list?start=0&limit=100');
      const arr = (j && (j.data || j.value || j)) || [];
      return (Array.isArray(arr) ? arr : []).map((e) => ({ id: e.id || e.profileId, name: e.name || '', raw: e }));
    } catch (_e) { return []; }
  },
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'vmlogin:ENV_ID_MISSING' };
    try {
      const j = await api(`/api/v1/profile/start?profileId=${encodeURIComponent(envId)}&skiplock=true`);
      const val = j && (j.value || (j.data && j.data.value));
      if (!val) return { ok: false, error: `vmlogin:${(j && (j.msg || j.status)) || 'no value(开启自动化端口?)'}` };
      const ws = /^(https?|ws):/.test(val) ? val : `http://${val}`;
      return { ok: true, ws, debugPort: portOf(val) };
    } catch (e) { return { ok: false, error: `vmlogin:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => { try { await api(`/api/v1/profile/stop?profileId=${encodeURIComponent(envId)}`, 15000); } catch (_e) { /* ignore */ } },
};
