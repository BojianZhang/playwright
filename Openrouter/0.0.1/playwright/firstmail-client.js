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

/** 取邮件的发件时间(ms)，无法解析返回 NaN。 */
function messageDateMs(json) {
  const data = json && json.data ? json.data : json;
  const d = (json && (json.date || json.Date)) || (data && (data.date || data.Date || data.received || data.timestamp));
  if (!d) return NaN;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 轮询邮箱直到拿到「本次登录的新」验证码。
 * 关键：用 sinceTs(本次登录开始时间) 过滤旧邮件——只接受发件时间 ≥ sinceTs-skew 的验证码，
 * 避免抓到上一次/上一轮残留的旧验证码（OpenRouter 每次会发新码，旧码会过期）。
 * @param {object} opts getLatestMessage 参数 + { attempts?, intervalMs?, log?, sinceTs?, staleCode?, skewMs? }
 * @returns {Promise<{ code: string|null, attempts: number }>}
 */
async function waitForVerifyCode(opts = {}) {
  const { attempts = 12, intervalMs = 3000, log = () => {}, sinceTs = 0, staleCode = '', skewMs = 60000 } = opts;
  let lastCode = null; // 读到过的最近一个码（兜底用）
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { json } = await getLatestMessage(opts);
      const code = extractVerifyCode(json);
      if (code) {
        lastCode = code;
        const ts = messageDateMs(json);
        const tooOld = sinceTs && Number.isFinite(ts) && ts < sinceTs - skewMs; // 发件早于本次登录 → 可能旧码
        const dup = staleCode && code === staleCode;                            // 与上次用过的码相同 → 旧码
        if (!tooOld && !dup) { log(`Firstmail 第 ${i + 1} 次轮询：找到新验证码 ${code}`); return { code, attempts: i + 1 }; }
        log(`Firstmail 第 ${i + 1} 次轮询：${code} 疑似旧码(${dup ? '与上次相同' : '发件早于本次登录'})，继续等新邮件`);
      } else {
        log(`Firstmail 第 ${i + 1} 次轮询：暂无验证码`);
      }
    } catch (e) { log(`Firstmail 轮询出错：${e.message}`); }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  // 兜底：等到最后都没"确认更新"的码，但确实读到过码 → 仍返回最近一个，
  // 避免因邮件服务器时区/时钟偏差把有效码误判成旧码而导致整账号登录失败。
  if (lastCode) { log(`Firstmail 未确认到更新的码，回退使用最近读到的验证码 ${lastCode}`); return { code: lastCode, attempts, fallback: true }; }
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
