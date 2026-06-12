'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider 模板 —— 复制本文件改名即可新增一家指纹浏览器
//
// 步骤(详见 ../README.md)：
//   1. 复制本文件为 providers/<yourname>.js，改 NAME。
//   2. 在 ../index.js 的 LOADERS 里加一行 `<yourname>: () => require('./providers/<yourname>')`。
//   3. 在 ../config.js 的 BUILTIN 里加默认 apiBase；敏感 token 走 env(OPENROUTER_<NAME>_TOKEN)。
//   4. 在 web/server.js 的 browserProvider 白名单数组 + web/public/index.html 的 <select> 各加一项。
//   5. 实现下面 4 个方法：start 必须返回 { ok, ws, debugPort?, error }，ws 是 CDP 端点。
//
// Provider【只做厂商本地 API 的 HTTP/SDK 细节】，绝不碰 connectOverCDP(那段在 base.js 统一做)。
// 注：本文件不在 index.js 的 LOADERS 里，不会被加载——它只是给你照抄的骨架。
// ═══════════════════════════════════════════════════════════════════════

const { providerConfig } = require('../config');

const NAME = 'template';
const cfg = () => providerConfig(NAME); // { apiBase, token? }

// 小工具：带超时的 fetch。
async function api(url, { method = 'GET', body, headers, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    return await r.json().catch(() => ({}));
  } finally { clearTimeout(timer); }
}

module.exports = {
  name: NAME,

  // 本地 API 是否可达。
  isHealthy: async () => {
    try { const j = await api(`${cfg().apiBase}/status`, { timeoutMs: 5000 }); return !!j; } catch (_e) { return false; }
  },

  // 枚举环境(尽力；不支持就返回 [])。返回 [{ id, name?, raw? }]。
  list: async () => [],

  // 启动某环境 → 返回 { ok, ws, debugPort?, error }。ws 必须是 CDP websocket。
  start: async (envId, _opts = {}) => {
    if (!envId) return { ok: false, error: `${NAME}:ENV_ID_MISSING` };
    try {
      // const j = await api(`${cfg().apiBase}/browser/open`, { method: 'POST', body: { id: envId } });
      // const ws = j && j.data && j.data.ws;
      // const debugPort = (j && j.data && j.data.http) || (ws && (ws.match(/:(\d+)\//) || [])[1]);
      // if (!ws) return { ok: false, error: `${NAME}:NO_WS` };
      // return { ok: true, ws, debugPort };
      return { ok: false, error: `NOT_IMPLEMENTED:${NAME}` };
    } catch (e) { return { ok: false, error: `${NAME}:${String((e && e.message) || e).slice(0, 100)}` }; }
  },

  // 停止某环境。
  stop: async (envId) => {
    try { /* await api(`${cfg().apiBase}/browser/close`, { method: 'POST', body: { id: envId } }); */ } catch (_e) { /* ignore */ }
  },
};
