'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Provider — AdsPower（参考实现 · 生产已验证）
//
// 文件定位：Openrouter/0.0.1/browser-provider/providers/adspower.js
//
// 薄封装：start/stop/isHealthy 纯委托现有 ../../openrouter-adspower.js（不重复 HTTP），
// 故 AdsPower 路径行为与改造前【逐位一致】。openrouter-adspower.js 本体不动(adspower-ipcheck.js 还 import 它)。
// ═══════════════════════════════════════════════════════════════════════

const ads = require('../../openrouter-adspower');
const { providerConfig } = require('../config');

const API = () => providerConfig('adspower').apiBase;

module.exports = {
  name: 'adspower',
  isHealthy: () => ads.isApiUp(API()),
  // 纯委托：返回 { ok, ws, debugPort, error }(与 Provider 接口同形)。
  start: (envId, opts = {}) => ads.startEnv(envId, Object.assign({ apiBase: API() }, opts)),
  stop: (envId, opts = {}) => ads.stopEnv(envId, Object.assign({ apiBase: API() }, opts)),
  // 只读枚举环境(镜像 adspower-ipcheck.js 的 /api/v1/user/list 调法)。
  list: async () => {
    const out = [];
    try {
      for (let page = 1; page <= 20; page += 1) {
        const r = await fetch(`${API()}/api/v1/user/list?page=${page}&page_size=100`);
        const j = await r.json().catch(() => ({}));
        const arr = (j && j.data && j.data.list) || [];
        if (!arr.length) break;
        for (const e of arr) out.push({ id: e.user_id, name: e.name || '', raw: e });
        if (arr.length < 100) break;
      }
    } catch (_e) { /* API 未就绪 → 返回已收集 */ }
    return out;
  },
};
