'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — Dolphin Anty · ⚠ 按官方本地 API 文档实现，本机未实测
//
// 本地服务默认 localhost:3001(可改 OPENROUTER_DOLPHIN_API)。需 OPENROUTER_DOLPHIN_TOKEN。
//   认证(一次): POST /v1.0/auth/login-with-token {token}
//   开: GET /v1.0/browser_profiles/{id}/start?automation=1 → automation.port + automation.wsEndpoint
//       → ws = ws://127.0.0.1:{port}{wsEndpoint}
//   关: GET /v1.0/browser_profiles/{id}/stop
//   ⚠ 免费版不支持自动化(start 不会给 automation.port)。
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');
const cfg = () => providerConfig('dolphin');
let _authed = false;

async function api(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${cfg().apiBase}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    return await r.json().catch(() => ({}));
  } finally { clearTimeout(t); }
}
async function ensureAuth() {
  if (_authed) return;
  const token = cfg().token;
  if (!token) return; // 没 token 不 latch：后配 token(env 每次重读)才有机会再鉴权
  const j = await api('/v1.0/auth/login-with-token', { method: 'POST', body: { token } }).catch(() => null);
  if (j && (j.success === true || j.data || j.token)) _authed = true; // 仅确认成功才 latch，避免一次失败永久标记已认证
}

module.exports = {
  name: 'dolphin',
  isHealthy: async () => { try { await ensureAuth(); const j = await api('/v1.0/browser_profiles?limit=1', { timeoutMs: 5000 }); return !!j; } catch (_e) { return false; } },
  list: async () => {
    try {
      await ensureAuth();
      const j = await api('/v1.0/browser_profiles?limit=100');
      const arr = (j && (j.data || j)) || [];
      return (Array.isArray(arr) ? arr : []).map((e) => ({ id: e.id, name: e.name || '', raw: e }));
    } catch (_e) { return []; }
  },
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'dolphin:ENV_ID_MISSING' };
    try {
      await ensureAuth();
      const j = await api(`/v1.0/browser_profiles/${encodeURIComponent(envId)}/start?automation=1`);
      const a = j && j.automation;
      if (!a || !a.port) return { ok: false, error: `dolphin:${(j && (j.message || j.error)) || 'no automation.port(免费版?)'}` };
      return { ok: true, ws: `ws://127.0.0.1:${a.port}${a.wsEndpoint || ''}`, debugPort: String(a.port) };
    } catch (e) { return { ok: false, error: `dolphin:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => { try { await api(`/v1.0/browser_profiles/${encodeURIComponent(envId)}/stop`, { timeoutMs: 15000 }); } catch (_e) { /* ignore */ } },
};
