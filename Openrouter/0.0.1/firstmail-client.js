'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / firstmail-client
//
// 文件定位：Openrouter/0.0.1/firstmail-client.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 调 Firstmail API 读邮箱最新邮件；从邮件中提取 OpenRouter(Clerk) 验证链接。
// ❌ 不负责 —— 浏览器操作（打开链接由 S3 adapter 负责）。
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_BASE = 'https://firstmail.ltd';

/**
 * 取邮箱最新一封邮件（原始 JSON）。
 * @param {object} opts { apiKey, email, password, folder?, baseUrl?, timeoutMs? }
 * @returns {Promise<object>}
 */
async function getLatestMessage(opts = {}) {
  const { apiKey, email, password, folder = 'INBOX', baseUrl = DEFAULT_BASE, timeoutMs = 30000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/api/v1/email/messages/latest`, {
      method: 'POST',
      headers: { accept: 'application/json', 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, folder }),
      signal: ctrl.signal,
    });
    const json = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从邮件 JSON 里提取 Clerk 验证链接 `https://clerk.openrouter.ai/v1/verify?...`。
 * @param {object} messageJson
 * @returns {string|null}
 */
function extractClerkVerifyLink(messageJson) {
  const text = JSON.stringify(messageJson || {});
  const m = text.match(/https:\\?\/\\?\/clerk\.openrouter\.ai\\?\/v1\\?\/verify[^"\\\s]+/);
  if (!m) return null;
  return m[0].replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

/**
 * 从邮件 JSON 里提取验证码（登录二次校验用，通常 6 位数字）。
 * @param {object} messageJson
 * @returns {string|null}
 */
function extractVerifyCode(messageJson) {
  // 优先从可读正文字段提取，避免误抓 header/token 里的数字串。
  const data = messageJson && messageJson.data ? messageJson.data : messageJson;
  const fields = [data && data.text, data && data.html, data && data.subject, JSON.stringify(messageJson || {})];
  for (const f of fields) {
    if (!f) continue;
    const plain = String(f).replace(/<[^>]+>/g, ' ');
    // 优先匹配 "code is 123456" / "verification code 123456" 附近的 6 位
    const near = plain.match(/(?:code|verification|otp)[^0-9]{0,20}(\d{6})/i);
    if (near) return near[1];
    const six = plain.match(/\b(\d{6})\b/);
    if (six) return six[1];
  }
  return null;
}

/**
 * 轮询邮箱直到拿到验证码。
 * @param {object} opts getLatestMessage 参数 + { attempts?, intervalMs?, log? }
 * @returns {Promise<{ code: string|null, attempts: number }>}
 */
async function waitForVerifyCode(opts = {}) {
  const { attempts = 12, intervalMs = 3000, log = () => {} } = opts;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { json } = await getLatestMessage(opts);
      const code = extractVerifyCode(json);
      if (code) { log(`Firstmail 第 ${i + 1} 次轮询：找到验证码 ${code}`); return { code, attempts: i + 1 }; }
      log(`Firstmail 第 ${i + 1} 次轮询：暂无验证码`);
    } catch (e) { log(`Firstmail 轮询出错：${e.message}`); }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return { code: null, attempts };
}

/**
 * 轮询邮箱直到拿到 Clerk 验证链接（注册邮件可能晚到几秒）。
 * @param {object} opts getLatestMessage 的参数 + { attempts?, intervalMs?, log? }
 * @returns {Promise<{ link: string|null, attempts: number }>}
 */
async function waitForClerkVerifyLink(opts = {}) {
  const { attempts = 12, intervalMs = 3000, log = () => {} } = opts;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { json } = await getLatestMessage(opts);
      const link = extractClerkVerifyLink(json);
      if (link) { log(`Firstmail 第 ${i + 1} 次轮询：找到验证链接`); return { link, attempts: i + 1 }; }
      log(`Firstmail 第 ${i + 1} 次轮询：暂无`);
    } catch (e) {
      log(`Firstmail 轮询出错：${e.message}`);
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return { link: null, attempts };
}

/**
 * 修改邮箱密码（Firstmail API）。
 * POST /api/v1/email/password/change/  body: { email, current_password, new_password }
 * @param {object} opts { apiKey, email, currentPassword, newPassword, baseUrl?, timeoutMs? }
 * @returns {Promise<{ ok:boolean, status:number, json:object }>}
 */
async function changePassword(opts = {}) {
  const { apiKey, email, currentPassword, newPassword, baseUrl = DEFAULT_BASE, timeoutMs = 30000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/api/v1/email/password/change/`, {
      method: 'POST',
      headers: { accept: 'application/json', 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, current_password: currentPassword, new_password: newPassword }),
      signal: ctrl.signal,
    });
    const json = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, json };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getLatestMessage, extractClerkVerifyLink, waitForClerkVerifyLink, extractVerifyCode, waitForVerifyCode, changePassword };
