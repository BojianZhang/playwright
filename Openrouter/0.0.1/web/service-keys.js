'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 服务 key 选用 — Openrouter / web / service-keys.js
//
// 运行时从「验证码池 / 邮箱池」挑一个可用 key(失效转移:池里第一个 active 可用的);
// 池空 → 回退 config.local 的 captcha/mailbox 单值 / 环境变量(向后兼容)。
// applyToConfig:Node 用(克隆 CONFIG 换 key);envPatch:Python 用(engine-runner.buildEnv 注入 env)。
// 只换"用哪个 key",不碰求解/收信逻辑。
// ═══════════════════════════════════════════════════════════════════════

const captchaStore = require('./captcha-store');
const mailboxStore = require('./mailbox-store');
const configRw = require('./config-rw');

function _cfg() { try { return configRw.readMerged() || {}; } catch (_e) { return {}; } }

function pickCaptcha() {
  const k = captchaStore.pickActive();
  if (k && k.apiKey) return { provider: k.provider, apiKey: k.apiKey, source: 'pool', id: k.id };
  const c = _cfg().captcha || {};
  return { provider: c.provider || 'capsolver', apiKey: (c.apiKey && String(c.apiKey).trim()) || process.env.OPENROUTER_CAPTCHA_KEY || '', source: 'config' };
}
function pickMailbox() {
  const k = mailboxStore.pickActive();
  if (k && k.apiKey) return { provider: k.provider, apiKey: k.apiKey, apiBaseUrl: k.apiBaseUrl, source: 'pool', id: k.id };
  const m = _cfg().mailbox || {};
  return { provider: m.provider || 'firstmail', apiKey: (m.apiKey && String(m.apiKey).trim()) || process.env.OPENROUTER_FIRSTMAIL_KEY || '', apiBaseUrl: m.apiBaseUrl || 'https://firstmail.ltd', source: 'config' };
}

// Node:克隆 CONFIG,把 captcha/mailbox 的 key/provider/baseUrl 换成池选用值(池空则保持原值)。
// overrides(可选):跨节点下发时,中心机随 payload 复制了它生效的 key → 子机优先用下发的
// (覆盖本机池/config)。读 overrides.captchaApiKey/captchaProvider/mailboxApiKey/mailboxApiBaseUrl。
function applyToConfig(CONFIG, overrides) {
  const C = CONFIG || {};
  const o = overrides || {};
  const cap = pickCaptcha(); const mb = pickMailbox();
  const capKey = (o.captchaApiKey && String(o.captchaApiKey).trim()) || cap.apiKey || (C.captcha || {}).apiKey;
  const capProv = o.captchaProvider || cap.provider || (C.captcha || {}).provider;
  const mbKey = (o.mailboxApiKey && String(o.mailboxApiKey).trim()) || mb.apiKey || (C.mailbox || {}).apiKey;
  const mbBase = o.mailboxApiBaseUrl || mb.apiBaseUrl || (C.mailbox || {}).apiBaseUrl;
  return {
    ...C,
    captcha: { ...(C.captcha || {}), provider: capProv, apiKey: capKey },
    mailbox: { ...(C.mailbox || {}), provider: mb.provider || (C.mailbox || {}).provider, apiKey: mbKey, apiBaseUrl: mbBase },
  };
}

// Python:engine-runner.buildEnv 注入这些环境变量(common/config.py 读它们)。
function envPatch() {
  const cap = pickCaptcha(); const mb = pickMailbox(); const env = {};
  if (cap.apiKey) { env.OPENROUTER_CAPTCHA_KEY = cap.apiKey; env.OPENROUTER_CAPTCHA_PROVIDER = cap.provider || ''; }
  if (mb.apiKey) { env.OPENROUTER_FIRSTMAIL_KEY = mb.apiKey; if (mb.apiBaseUrl) env.OPENROUTER_FIRSTMAIL_BASE = mb.apiBaseUrl; }
  return env;
}

module.exports = { pickCaptcha, pickMailbox, applyToConfig, envPatch };
