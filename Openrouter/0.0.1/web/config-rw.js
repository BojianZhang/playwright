'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 配置读写 — Openrouter / web / config-rw
//
// 设置中心用:脱敏读合并配置(密钥只回 set:bool,绝不回明文)、安全写 config.local.json
// (密钥空值不覆盖、只动白名单字段、绝不写 config.json)。零依赖、CommonJS。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_JSON = path.join(CONFIG_DIR, 'config.json');
const CONFIG_LOCAL = path.join(CONFIG_DIR, 'config.local.json');

// 密钥字段:读时只回 set:bool;写时空值不覆盖。
const SECRETS = ['captcha.apiKey', 'mailbox.apiKey', 'security.token', 'adspower.apiKey'];
// 设置中心可写的字段白名单(绝不允许任意键写入)。
const WRITABLE = new Set([
  'mailbox.provider', 'mailbox.apiKey', 'mailbox.apiBaseUrl', 'mailbox.apiTimeoutMs', 'mailbox.passwordChangeMode',
  'captcha.enabled', 'captcha.provider', 'captcha.apiKey', 'captcha.solveTimeoutMs',
  'cluster.hosts', 'cluster.centralUrl', 'cluster.selfUrl',
  'security.token', 'security.gateStatic', 'security.allowIps', 'security.allowHosts', 'security.trustForwardedFor',
  'adspower.apiBase', 'adspower.apiKey',
]);
const ARRAY_FIELDS = new Set(['cluster.hosts', 'security.allowIps', 'security.allowHosts']);
const BOOL_FIELDS = new Set(['captcha.enabled', 'security.gateStatic', 'security.trustForwardedFor']);
const NUM_FIELDS = new Set(['mailbox.apiTimeoutMs', 'captcha.solveTimeoutMs']);

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    // ★文件【存在却损坏】(非缺失)→ 备份 .corrupt(固定名,不刷屏)再退 {}。否则 writeLocal 会把 {}+新补丁原子写回 config.local.json
    //   → 静默丢光其它配置/密钥(token/captcha/mailbox key…)。缺失(ENOENT)=正常,不备份。与 address/proxy/account-store 同款守卫。
    if (e && e.code !== 'ENOENT') {
      try { fs.copyFileSync(file, file + '.corrupt'); console.error('[config-rw] ' + file + ' 解析失败,已备份 .corrupt 并按空配置继续:', e.message); } catch (_e2) { /* 备份失败也不卡死 */ }
    }
    return {};
  }
}
function deepMerge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) out[k] = deepMerge(a[k], b[k]);
    else out[k] = b[k];
  }
  return out;
}
function getPath(obj, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, dotted, val) {
  const ks = dotted.split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
  o[ks[ks.length - 1]] = val;
}

function readMerged() { return deepMerge(loadJson(CONFIG_JSON), loadJson(CONFIG_LOCAL)); }

// 给设置中心的脱敏视图:只暴露我们管的几组;密钥不回明文,只在 secretsSet 给布尔。
function view() {
  const m = readMerged();
  const mb = m.mailbox || {}; const cp = m.captcha || {}; const cl = m.cluster || {}; const se = m.security || {}; const ap = m.adspower || {};
  return {
    mailbox: { provider: mb.provider || '', apiBaseUrl: mb.apiBaseUrl || '', apiTimeoutMs: mb.apiTimeoutMs || 30000, passwordChangeMode: mb.passwordChangeMode || 'skip' },
    captcha: { enabled: cp.enabled !== false, provider: cp.provider || '', solveTimeoutMs: cp.solveTimeoutMs || 120000 },
    cluster: { hosts: cl.hosts || [], centralUrl: cl.centralUrl || '', selfUrl: cl.selfUrl || '' },
    security: { gateStatic: !!se.gateStatic, allowIps: se.allowIps || [], allowHosts: se.allowHosts || [], trustForwardedFor: !!se.trustForwardedFor },
    adspower: { apiBase: ap.apiBase || '' },
    secretsSet: {
      'captcha.apiKey': !!(cp.apiKey && String(cp.apiKey).trim()),
      'mailbox.apiKey': !!(mb.apiKey && String(mb.apiKey).trim()),
      'security.token': !!(se.token && String(se.token).trim()),
      'adspower.apiKey': !!(ap.apiKey && String(ap.apiKey).trim()),
    },
  };
}

// 配置自检(给 /api/health 用):哪些密钥已设、关键告警。
function secretsState() {
  const m = readMerged();
  return {
    captchaKeySet: !!(getPath(m, 'captcha.apiKey') || process.env.OPENROUTER_CAPTCHA_KEY),
    mailboxKeySet: !!(getPath(m, 'mailbox.apiKey') || process.env.OPENROUTER_FIRSTMAIL_KEY),
    tokenSet: !!(getPath(m, 'security.token') || process.env.OPENROUTER_AUTH_TOKEN),
    captchaProvider: getPath(m, 'captcha.provider') || '',
    mailboxProvider: getPath(m, 'mailbox.provider') || '',
    gateStatic: !!getPath(m, 'security.gateStatic'),
  };
}

function coerce(dotted, val) {
  if (BOOL_FIELDS.has(dotted)) return val === true || val === 'true' || val === 1;
  if (NUM_FIELDS.has(dotted)) { const n = Number(val); return Number.isFinite(n) ? n : undefined; }
  if (ARRAY_FIELDS.has(dotted)) {
    if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
    return String(val || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  return typeof val === 'string' ? val : (val == null ? '' : String(val));
}

// 安全写:flatPatch = { 'captcha.apiKey':'xxx', 'cluster.hosts':[...], ... }。
//   只写白名单;密钥空值不覆盖;只落 config.local.json;返回 { ok, written:[...], skipped:[...] }。
function writeLocal(flatPatch) {
  const local = loadJson(CONFIG_LOCAL);
  const written = []; const skipped = [];
  for (const [dotted, raw] of Object.entries(flatPatch || {})) {
    if (!WRITABLE.has(dotted)) { skipped.push(dotted); continue; }
    if (SECRETS.includes(dotted)) {
      // 显式清除密钥用哨兵 '__CLEAR__'(置空);普通空值仍"不覆盖"(防误清),解决 be-9「UI 无法清密钥」。
      if (raw === '__CLEAR__') { setPath(local, dotted, ''); written.push(dotted + '(已清除)'); continue; }
      if (raw === '' || raw == null) { skipped.push(dotted + '(空值不覆盖)'); continue; }
    }
    const v = coerce(dotted, raw);
    if (v === undefined) { skipped.push(dotted + '(无效值)'); continue; }
    setPath(local, dotted, v);
    written.push(dotted);
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_LOCAL + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(local, null, 2));
  fs.renameSync(tmp, CONFIG_LOCAL);   // 原子替换;绝不写 config.json
  return { ok: true, written, skipped };
}

// 按需取单个密钥明文(给设置中心「显示」用;仅允许 3 个密钥字段;接口受 token 保护)。
function getSecret(key) {
  if (!SECRETS.includes(key)) return null;
  const v = getPath(readMerged(), key);
  return v == null ? '' : String(v);
}

module.exports = { view, writeLocal, secretsState, readMerged, getSecret, SECRETS, CONFIG_LOCAL };
