const https = require('https');

const DEFAULT_BASE_URL = 'https://firstmail.ltd';

function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        const contentType = String(res.headers['content-type'] || '');
        let data = null;
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            return reject(new Error(`FIRSTMAIL_API_NON_JSON_RESPONSE status=${res.statusCode || 'NA'} contentType=${contentType || 'NA'} body=${raw.slice(0, 300)}`));
          }
        }

        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          data,
          raw,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`FIRSTMAIL_API_TIMEOUT ${timeoutMs}ms`));
    });
    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function getFirstmailApiConfig(config = {}) {
  const apiKey = String(config.firstmailApiKey || process.env.FIRSTMAIL_API_KEY || '').trim();
  const baseUrl = String(config.firstmailApiBaseUrl || process.env.FIRSTMAIL_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return {
    apiKey,
    baseUrl,
  };
}

function buildLatestMessagePayload(account) {
  return JSON.stringify({
    email: account.email,
    password: account.password,
    folder: 'INBOX',
  });
}

function extractLatestMessage(responseData) {
  if (!responseData) return null;
  if (Array.isArray(responseData?.messages) && responseData.messages.length) return responseData.messages[0];
  if (Array.isArray(responseData?.data) && responseData.data.length) return responseData.data[0];
  if (responseData?.message && typeof responseData.message === 'object') return responseData.message;
  if (responseData?.data && typeof responseData.data === 'object' && !Array.isArray(responseData.data)) return responseData.data;
  if (typeof responseData === 'object' && !Array.isArray(responseData)) return responseData;
  return null;
}

async function fetchLatestMessage({ account, config }) {
  const { apiKey, baseUrl } = getFirstmailApiConfig(config);
  if (!apiKey) {
    throw new Error('FIRSTMAIL_API_KEY_MISSING');
  }

  const payload = buildLatestMessagePayload(account);
  const response = await requestJson(`${baseUrl}/api/v1/email/messages/latest`, {
    method: 'POST',
    timeoutMs: Number(config.firstmailApiTimeoutMs || 30000),
    headers: {
      accept: 'application/json',
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    body: payload,
  });

  if (response.status === 404) {
    const errorText = String(response.data?.error || response.data?.message || response.raw || '').trim();
    if (/No messages found/i.test(errorText)) {
      return {
        response,
        message: null,
        noMessages: true,
      };
    }
  }

  if (response.status >= 400) {
    const errorText = response.data?.error || response.data?.message || response.raw || `HTTP_${response.status}`;
    throw new Error(`FIRSTMAIL_API_HTTP_${response.status}:${errorText}`);
  }

  const message = extractLatestMessage(response.data);
  return {
    response,
    message,
    noMessages: false,
  };
}

function extractCodeFromText(text) {
  const bodyText = String(text || '');
  const contextualPatterns = [
    /verification code[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
    /your code[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
    /code[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
    /confirm[^A-Z0-9]{0,20}([A-Z0-9]{6})/i,
  ];

  for (const pattern of contextualPatterns) {
    const match = bodyText.match(pattern);
    if (match) return match[1];
  }

  const fallbackMatch = bodyText.match(/\b([A-Z0-9]{6})\b/);
  return fallbackMatch ? fallbackMatch[1] : '';
}

function isDreaminaMessage(message) {
  const joined = [
    message?.from,
    message?.from_name,
    message?.sender,
    message?.subject,
    message?.snippet,
    message?.text,
    message?.html,
    message?.body,
    message?.content,
  ].filter(Boolean).join('\n');

  return /Dreamina|dreamina@mail\./i.test(joined);
}

function summarizeMessage(message) {
  return {
    from: String(message?.from || message?.from_name || message?.sender || '').slice(0, 120),
    subject: String(message?.subject || '').slice(0, 160),
    snippet: String(message?.snippet || message?.text || message?.body || message?.content || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}

async function waitForDreaminaCodeViaApi({ account, config, log, accountLabel = '', proxyLabel = '' }) {
  const maxAttempts = Number(config.firstmailApiMaxPollAttempts || config.waitMailAttempts || 18);
  const intervalMs = Number(config.waitMailIntervalMs || 5000);
  const totalBudgetMs = Math.max(0, (maxAttempts - 1) * intervalMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingAttempts = Math.max(0, maxAttempts - attempt);
    const elapsedMs = Math.max(0, (attempt - 1) * intervalMs);
    const remainingMs = Math.max(0, totalBudgetMs - elapsedMs);

    if (typeof log === 'function') {
      log(`Firstmail API 轮询进度 | 当前=${attempt}/${maxAttempts} | 剩余轮次=${remainingAttempts} | 已等待=${Math.round(elapsedMs / 1000)}秒 | 剩余预算=${Math.round(remainingMs / 1000)}秒 | 总预算=${Math.round(totalBudgetMs / 1000)}秒 | 账号=${accountLabel || account.email} | 代理=${proxyLabel || 'NO_PROXY'}`);
    }

    const { response, message, noMessages } = await fetchLatestMessage({ account, config });
    if (typeof log === 'function') {
      const summary = summarizeMessage(message || {});
      log(`Firstmail API 返回摘要 | status=${response.status} | from=${summary.from || 'NA'} | subject=${summary.subject || 'NA'} | snippet=${summary.snippet || 'NA'} | noMessages=${noMessages ? 'true' : 'false'}`);
    }

    if (noMessages) {
      if (typeof log === 'function') {
        log(`Firstmail API latest 当前没有邮件，继续下一轮轮询 | 下一轮前等待=${attempt < maxAttempts ? Math.round(intervalMs / 1000) : 0}秒`);
      }
    } else if (message && isDreaminaMessage(message)) {
      const code = extractCodeFromText([
        message?.subject,
        message?.snippet,
        message?.text,
        message?.html,
        message?.body,
        message?.content,
      ].filter(Boolean).join('\n'));

      if (code) {
        if (typeof log === 'function') {
          log(`Firstmail API 命中 Dreamina 最新邮件并提取到验证码 | code=${code} | 命中轮次=${attempt}/${maxAttempts} | 累计等待=${Math.round(elapsedMs / 1000)}秒`);
        }
        return {
          code,
          message,
          attempt,
        };
      }

      if (typeof log === 'function') {
        log(`Firstmail API 命中 Dreamina 最新邮件，但当前正文里未提取到验证码 | 当前=${attempt}/${maxAttempts}`);
      }
    } else if (typeof log === 'function') {
      log(`Firstmail API 最新邮件不是 Dreamina 邮件，继续等待下一轮 | 当前=${attempt}/${maxAttempts}`);
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`FIRSTMAIL_API_CODE_TIMEOUT maxAttempts=${maxAttempts} totalBudgetSeconds=${Math.round(totalBudgetMs / 1000)}`);
}

module.exports = {
  getFirstmailApiConfig,
  fetchLatestMessage,
  waitForDreaminaCodeViaApi,
  extractCodeFromText,
  isDreaminaMessage,
  summarizeMessage,
};
