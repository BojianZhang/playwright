'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — Multilogin · ⚠ 按官方 API 实现，本机未实测
//
// Multilogin 6 本地启动器(默认 127.0.0.1:35000)：
//   开: GET /api/v1/profile/start?automation=true&profileId=X → { status:'OK', value:'http://127.0.0.1:PORT' }
//   关: GET /api/v1/profile/stop?profileId=X
// Multilogin X(v2)走云端启动器 launcher.mlx.yt:45001 + 账号 token：
//   设 OPENROUTER_MULTILOGIN_API=https://launcher.mlx.yt:45001 + OPENROUTER_MULTILOGIN_TOKEN，
//   端点 /api/v2/profile/f/{folder}/p/{profile}/start?automation_type=… ；如用 X 版按需在此扩展。
// 文档：multilogin.com/help/en_US/api-desktop
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');
const cfg = () => providerConfig('multilogin');

async function api(path, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {};
  const token = cfg().token;
  if (token) headers.Authorization = `Bearer ${token}`;
  try { const r = await fetch(`${cfg().apiBase}${path}`, { headers, signal: ctrl.signal }); return await r.json().catch(() => ({})); }
  finally { clearTimeout(t); }
}
function portOf(s) { const m = String(s || '').match(/:(\d+)(?:\/|$)/); return m ? m[1] : undefined; }

module.exports = {
  name: 'multilogin',
  // 健康探测走【只读】端点(绝不调 /start，那会真启动一个环境)。
  isHealthy: async () => { try { const j = await api('/api/v1/profile/active', 4000); return !!j; } catch (_e) { return false; } },
  list: async () => [], // 列表走云端 REST(按账号)，这里从略
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'multilogin:ENV_ID_MISSING' };
    try {
      const j = await api(`/api/v1/profile/start?automation=true&profileId=${encodeURIComponent(envId)}`);
      let val = j && (j.value || (j.data && j.data.value));
      if (!val && j && j.data && j.data.port) val = `http://127.0.0.1:${j.data.port}`;
      if (!val) return { ok: false, error: `multilogin:${(j && (j.status || j.message)) || 'no value'}` };
      const ws = /^(https?|ws):/.test(val) ? val : `http://${val}`;
      return { ok: true, ws, debugPort: portOf(val) };
    } catch (e) { return { ok: false, error: `multilogin:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => { try { await api(`/api/v1/profile/stop?profileId=${encodeURIComponent(envId)}`, 15000); } catch (_e) { /* ignore */ } },
};
