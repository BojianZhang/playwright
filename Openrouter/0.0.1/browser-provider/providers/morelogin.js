'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — MoreLogin · ⚠ 按官方本地 API 实现，本机未实测
//
// 本地 API 默认 127.0.0.1:40000(客户端 Settings→Local API 开启，需 v2.15.0+)。
//   开: POST /api/env/start {envId} → data.debugPort
//   关: POST /api/env/close {envId}
//   列: POST /api/env/page {pageNo,pageSize}
// 鉴权(MoreLogin 本地 API 需要)：头 X-Api-Id=appId、X-Nonce-Id=毫秒时间戳、
//   Authorization=md5(appId+secretKey+nonceId)。appId/secret 走 OPENROUTER_MORELOGIN_APPID / _SECRET。
// connectOverCDP 接受 http CDP 端点 → ws 用 http://127.0.0.1:<debugPort>。
// 文档：guide.morelogin.com/api-reference/local-api
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { providerConfig } = require('../config');
const cfg = () => providerConfig('morelogin');

function authHeaders() {
  const { appId, secret } = cfg();
  if (!appId || !secret) return {}; // 未配 → 不加签(本地 API 若强制鉴权会返回错误，start 优雅落链)
  const nonceId = String(Date.now());
  const sign = crypto.createHash('md5').update(`${appId}${secret}${nonceId}`).digest('hex');
  return { 'X-Api-Id': appId, 'X-Nonce-Id': nonceId, Authorization: sign };
}
async function api(path, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${cfg().apiBase}${path}`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), body: JSON.stringify(body || {}), signal: ctrl.signal });
    return await r.json().catch(() => ({}));
  } finally { clearTimeout(t); }
}

module.exports = {
  name: 'morelogin',
  isHealthy: async () => { try { const j = await api('/api/env/page', { pageNo: 1, pageSize: 1 }, 5000); return !!j && j.code !== undefined; } catch (_e) { return false; } },
  list: async () => {
    try {
      const j = await api('/api/env/page', { pageNo: 1, pageSize: 100 });
      const arr = (j && j.data && (j.data.dataList || j.data.list || j.data)) || [];
      return (Array.isArray(arr) ? arr : []).map((e) => ({ id: String(e.id || e.envId), name: e.envName || e.name || '', raw: e }));
    } catch (_e) { return []; }
  },
  start: async (envId) => {
    if (!envId) return { ok: false, error: 'morelogin:ENV_ID_MISSING' };
    try {
      const j = await api('/api/env/start', { envId: String(envId) });
      if (j && j.code !== 0 && j.code !== undefined) return { ok: false, error: `morelogin:${(j && j.msg) || j.code}` };
      const port = j && j.data && j.data.debugPort;
      if (!port) return { ok: false, error: 'morelogin:NO_DEBUG_PORT(需配 appId/secret 鉴权?)' };
      return { ok: true, ws: `http://127.0.0.1:${port}`, debugPort: String(port) };
    } catch (e) { return { ok: false, error: `morelogin:${String((e && e.message) || e).slice(0, 100)}` }; }
  },
  stop: async (envId) => { try { await api('/api/env/close', { envId: String(envId) }, 15000); } catch (_e) { /* ignore */ } },
};
