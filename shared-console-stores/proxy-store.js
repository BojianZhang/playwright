'use strict';
// ⟦共享规范实现(工厂) · 改这里;各项目 web/proxy-store.js 是注入 dataDir 的 re-export shim,勿改⟧ 见 shared-console-stores/README.md

// ═══════════════════════════════════════════════════════════════════════
// 代理/IP 池 — 规范实现(工厂 · 历史出处 Openrouter/0.0.1/web/proxy-store.js)
//
// 边界:**只管出口代理**(host:port:user:pass)的增删改 + 连通性测试结果。
// 不管 AdsPower 浏览器环境(那是 adspower-store)。落盘 data/proxies.json(含账密,已 gitignore)。
// 零依赖、CommonJS。内存真相源 + 同步原子写(tmp+rename),范式同 strategies-store/runs-store。
// activeLines() 回拼成 server.js parseProxies 认的多行文本,供运行时"从池选用"。
// 脱敏:list() 不回明文 pass(只回 passSet 布尔),与 captcha/mailbox/adspower-endpoint 一致;
// 明文 pass 仅 activeLines() 内部回拼用,绝不进 HTTP 响应。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

module.exports = function createProxyStore({ dataDir }) {
const FILE = path.join(dataDir, 'proxies.json');
let _list = null;
let _seq = 0;
function _genId() { return 'px' + Date.now().toString(36) + (_seq++).toString(36); }

function _load() {
  if (_list) return _list;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8')); _list = Array.isArray(a) ? a : [];
  } catch (_e) {
    _list = [];
    // 【C3 修】区分"文件不存在"(正常,空池)与"文件损坏"(必须告警并备份,否则下次 _persist 用 [] 覆盖→静默丢光代理)
    if (fs.existsSync(FILE)) {
      try { console.error(`[proxy-store] ${FILE} 解析失败,已备份为 .corrupt 并以空池启动:`, _e.message); fs.copyFileSync(FILE, FILE + '.corrupt'); } catch (_e2) { /* ignore */ }
    }
  }
  return _list;
}
function _persist() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_list, null, 2)); fs.renameSync(tmp, FILE); } catch (_e) { /* 落盘失败不致命 */ }
}
// 解析一行代理。支持:host:port[:user:pass](裸,type 留空→add 默认 socks5)、
// scheme://user:pass@host:port、scheme://host:port[:user:pass](scheme=http/https/socks5/socks5h)。
const _normType = (t) => { t = String(t || '').toLowerCase(); return (t === 'socks' || t === 'socks5h') ? 'socks5' : t; };
function _parseLine(line) {
  let s = String(line).trim();
  let type = '';
  const sm = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.*)$/);
  if (sm) {
    type = _normType(sm[1]);
    s = sm[2];
    if (s.includes('@')) {                       // user:pass@host:port
      const at = s.lastIndexOf('@'); const cred = s.slice(0, at); const hp = s.slice(at + 1);
      const ci = cred.indexOf(':');
      const user = (ci >= 0 ? cred.slice(0, ci) : cred).trim();
      const pass = (ci >= 0 ? cred.slice(ci + 1) : '').trim();
      const hpp = hp.split(':'); const host = (hpp[0] || '').trim(); const port = Number(hpp[1]) || 0;
      if (!host || !port) return null;
      return { type, host, port, user, pass };
    }
  }
  const parts = s.split(':');                     // host:port[:user:pass]
  const host = (parts[0] || '').trim(); const port = Number(parts[1]) || 0;
  const user = (parts[2] || '').trim(); const pass = parts.slice(3).join(':').trim();
  if (!host || !port) return null;
  return { type, host, port, user, pass };
}
const _key = (x) => `${x.host}:${x.port}:${x.user || ''}`;

// 脱敏视图(HTTP 用):保留 host/port/user(非密),明文 pass → passSet 布尔。
function list() {
  return _load().map((x) => ({
    id: x.id, host: x.host, port: x.port, user: x.user, passSet: !!(x.pass && String(x.pass).trim()),
    type: x.type || 'socks5', label: x.label, status: x.status, addedAt: x.addedAt, lastTestedAt: x.lastTestedAt,
    lastOk: x.lastOk, latencyMs: x.latencyMs, exitIp: x.exitIp, failCount: x.failCount,
  }));
}
function get(id) { return _load().find((x) => x.id === id) || null; }

// 批量添加:多行 host:port[:user:pass];按 host:port:user 去重。
function add(raw) {
  const lst = _load(); let added = 0, dup = 0;
  String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).forEach((line) => {
    const p = _parseLine(line); if (!p) return;
    if (lst.some((x) => _key(x) === _key(p))) { dup++; return; }
    lst.push({ id: _genId(), host: p.host, port: p.port, user: p.user, pass: p.pass, type: p.type || 'socks5', label: '', status: 'active', addedAt: Date.now(), lastTestedAt: null, lastOk: null, latencyMs: null, exitIp: '', failCount: 0 });
    added++;
  });
  _persist();
  return { added, dup, total: lst.length };
}
function update(id, patch) {
  const it = _load().find((x) => x.id === id); if (!it) return null;
  if ('label' in patch) it.label = String(patch.label || '').slice(0, 60);
  if ('status' in patch) it.status = patch.status === 'disabled' ? 'disabled' : 'active';
  if ('host' in patch) it.host = String(patch.host || '').trim();
  if ('port' in patch) it.port = Number(patch.port) || it.port;
  if ('user' in patch) it.user = String(patch.user || '').trim();
  if ('pass' in patch) it.pass = String(patch.pass || '');
  if ('type' in patch) { const t = _normType(patch.type); if (['http', 'https', 'socks5'].includes(t)) it.type = t; }
  _persist(); return it;
}
// 批量把全部代理设为某类型(AdsPower 对 socks5 自检常失败,改 http 多数代理商也支持且兼容性更好)。
function setAllType(type) {
  const t = ['http', 'https', 'socks5'].includes(_normType(type)) ? _normType(type) : 'socks5';
  const lst = _load(); lst.forEach((x) => { x.type = t; }); _persist();
  return { type: t, total: lst.length };
}
function remove(id) { _list = _load().filter((x) => x.id !== id); _persist(); return true; }
function clear() { _list = []; _persist(); return true; }
function recordTest(id, res) {
  const it = _load().find((x) => x.id === id); if (!it) return null;
  it.lastTestedAt = Date.now(); it.lastOk = !!res.ok; it.latencyMs = res.latencyMs != null ? res.latencyMs : null;
  if (res.exitIp) it.exitIp = res.exitIp;
  if (!res.ok) it.failCount = (it.failCount || 0) + 1;
  _persist(); return it;
}
// 运行时"从池选用":回拼成 parseProxies / Python _parse_one 都认的多行文本(仅 active)。
// socks5(默认)→ 裸 host:port:user:pass(两引擎行为与历史一致,无回归);
// http/https → 带协议 scheme://user:pass@host:port,让 Python 传 AdsPower 的 proxy_type=http、Playwright 也用对协议。
function activeLines() {
  return _load().filter((x) => x.status === 'active').map((x) => {
    const t = x.type || 'socks5';
    if (t === 'socks5') return x.user ? `${x.host}:${x.port}:${x.user}:${x.pass}` : `${x.host}:${x.port}`;
    return x.user ? `${t}://${x.user}:${x.pass}@${x.host}:${x.port}` : `${t}://${x.host}:${x.port}`;
  }).join('\n');
}

return { list, get, add, update, remove, clear, recordTest, setAllType, activeLines, _FILE: FILE };
};
