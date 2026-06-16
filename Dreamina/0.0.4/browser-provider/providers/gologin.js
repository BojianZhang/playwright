'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — GoLogin · ⚠ 按官方 SDK 实现，本机未实测
//
// 优先用官方 Node SDK(`npm i gologin`，惰性 require，缺包只禁用本家)。需 OPENROUTER_GOLOGIN_TOKEN。
//   new GoLogin({ token, profile_id }) → await gl.start() → { wsUrl }(CDP ws) → 用完 gl.stop()。
//   (SDK 负责下载/准备 profile 并本地起浏览器；wsUrl 即接管端点。)
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');
const cfg = () => providerConfig('gologin');
const _instances = new Map(); // envId → GoLogin 实例(为 stop 保留)

function GoLoginCls() { try { return require('gologin'); } catch (_e) { return null; } }
function portOf(s) { const m = String(s || '').match(/:(\d+)(?:\/|$)/); return m ? m[1] : undefined; }

module.exports = {
  name: 'gologin',
  isHealthy: async () => !!(cfg().token && GoLoginCls()),
  // 列表走 GoLogin 云端 REST(GET /browser/v2，Bearer token)。
  list: async () => {
    const token = cfg().token;
    if (!token) return [];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch('https://api.gologin.com/browser/v2', { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      const arr = (j && (j.profiles || j.data || j)) || [];
      return (Array.isArray(arr) ? arr : []).map((e) => ({ id: e.id, name: e.name || '', raw: e }));
    } catch (_e) { return []; } finally { clearTimeout(t); }
  },
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'gologin:ENV_ID_MISSING' };
    const token = cfg().token;
    if (!token) return { ok: false, error: 'gologin:NO_TOKEN(设 OPENROUTER_GOLOGIN_TOKEN)' };
    const GL = GoLoginCls();
    if (!GL) return { ok: false, error: 'gologin:SDK_MISSING(npm i gologin)' };
    try {
      const gl = new GL({ token, profile_id: envId });
      const r = await gl.start();
      const ws = r && (r.wsUrl || r.ws);
      if (!ws) return { ok: false, error: `gologin:${(r && r.status) || 'no wsUrl'}` };
      _instances.set(envId, gl);
      return { ok: true, ws, debugPort: portOf(ws) };
    } catch (e) { return { ok: false, error: `gologin:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => {
    const gl = _instances.get(envId);
    try { if (gl && gl.stop) await gl.stop(); } catch (_e) { /* ignore */ }
    _instances.delete(envId);
  },
};
