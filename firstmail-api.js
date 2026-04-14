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

function getFirstmailScanConfig(config = {}) {
  const subjectKeywords = Array.isArray(config.firstmailSubjectKeywords)
    ? config.firstmailSubjectKeywords.map(item => String(item || '').trim()).filter(Boolean)
    : ['Dreamina', 'CapCut', 'verification'];
  const senderKeywords = Array.isArray(config.firstmailPreferredSenderKeywords)
    ? config.firstmailPreferredSenderKeywords.map(item => String(item || '').trim()).filter(Boolean)
    : ['dreamina', 'capcut'];
  const recentMessageScanLimit = Math.max(1, Number(config.firstmailRecentMessageScanLimit || 5));
  const pollJitterMinMs = Math.max(0, Number(config.firstmailPollJitterMinMs || 0));
  const pollJitterMaxMs = Math.max(pollJitterMinMs, Number(config.firstmailPollJitterMaxMs || 0));
  const codeRegex = String(config.firstmailCodeRegex || '\\b([A-Z0-9]{6})\\b').trim();
  const fallbackLookbackMs = Math.max(0, Number(config.firstmailFallbackLookbackMs || 180000));
  const fallbackEnableFromAttempt = Math.max(1, Number(config.firstmailFallbackEnableFromAttempt || 3));
  return {
    subjectKeywords,
    senderKeywords,
    recentMessageScanLimit,
    pollJitterMinMs,
    pollJitterMaxMs,
    codeRegex,
    fallbackLookbackMs,
    fallbackEnableFromAttempt,
  };
}

function buildLatestMessagePayload(account) {
  return JSON.stringify({
    email: account.email,
    password: account.password,
    folder: 'INBOX',
  });
}

function extractMessageList(responseData) {
  if (!responseData) return [];
  if (Array.isArray(responseData?.messages)) return responseData.messages;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (responseData?.message && typeof responseData.message === 'object') return [responseData.message];
  if (responseData?.data && typeof responseData.data === 'object' && !Array.isArray(responseData.data)) return [responseData.data];
  if (typeof responseData === 'object' && !Array.isArray(responseData)) return [responseData];
  return [];
}

function extractLatestMessage(responseData) {
  return extractMessageList(responseData)[0] || null;
}

async function postFirstmailMessagesEndpoint(endpointPath, { account, config, payloadOverrides = {} }) {
  const { apiKey, baseUrl } = getFirstmailApiConfig(config);
  if (!apiKey) {
    throw new Error('FIRSTMAIL_API_KEY_MISSING');
  }

  const payload = JSON.stringify({
    email: account.email,
    password: account.password,
    folder: 'INBOX',
    limit: Number(config.firstmailRecentMessageScanLimit || 10),
    ...payloadOverrides,
  });

  const response = await requestJson(`${baseUrl}${endpointPath}`, {
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
        messages: [],
        noMessages: true,
      };
    }
  }

  if (response.status >= 400) {
    const errorText = response.data?.error || response.data?.message || response.raw || `HTTP_${response.status}`;
    throw new Error(`FIRSTMAIL_API_HTTP_${response.status}:${errorText}`);
  }

  const rawMessages = extractMessageList(response.data?.data || response.data);
  const scanConfig = getFirstmailScanConfig(config);
  return {
    response,
    message: rawMessages[0] || null,
    messages: rawMessages.slice(0, scanConfig.recentMessageScanLimit),
    noMessages: rawMessages.length === 0,
  };
}

async function fetchLatestMessage({ account, config }) {
  return await postFirstmailMessagesEndpoint('/api/v1/email/messages/latest', {
    account,
    config,
    payloadOverrides: {},
  });
}

async function fetchMessagesList({ account, config }) {
  return await postFirstmailMessagesEndpoint('/api/v1/email/messages', {
    account,
    config,
    payloadOverrides: {
      limit: Number(config.firstmailRecentMessageScanLimit || 10),
    },
  });
}

async function fetchUnreadMessages({ account, config }) {
  return await postFirstmailMessagesEndpoint('/api/v1/email/messages/unread', {
    account,
    config,
    payloadOverrides: {
      limit: Number(config.firstmailUnreadScanLimit || config.firstmailRecentMessageScanLimit || 10),
    },
  });
}

function extractCodeFromText(text, config = {}) {
  const bodyText = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  const scanConfig = getFirstmailScanConfig(config);
  const contextualPatterns = [
    /verification code[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
    /your code[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
    /confirmation code[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
    /one[- ]time code[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
    /enter code[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
    /confirm[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
    /\bcode\b[^A-Z0-9]{0,40}([A-Z0-9]{4,8})/i,
  ];

  for (const pattern of contextualPatterns) {
    const match = bodyText.match(pattern);
    if (match) return match[1];
  }

  try {
    const customPattern = new RegExp(scanConfig.codeRegex, 'i');
    const customMatch = bodyText.match(customPattern);
    if (customMatch) return customMatch[1] || customMatch[0] || '';
  } catch (error) {
  }

  const allCandidates = [...bodyText.matchAll(/\b([A-Z0-9]{4,8})\b/g)].map(match => String(match[1] || '').trim()).filter(Boolean);
  const filteredCandidates = allCandidates.filter(token => !/dreamina|capcut|verify|login|email/i.test(token));
  if (filteredCandidates.length === 1) return filteredCandidates[0];
  if (filteredCandidates.length > 1) {
    const digitHeavy = filteredCandidates.filter(token => /\d/.test(token));
    if (digitHeavy.length === 1) return digitHeavy[0];
    if (digitHeavy.length > 1) return digitHeavy[0];
    return filteredCandidates[0];
  }

  return '';
}

function isDreaminaMessage(message, config = {}) {
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

  const lowerJoined = joined.toLowerCase();
  const scanConfig = getFirstmailScanConfig(config);
  const senderHit = scanConfig.senderKeywords.some(keyword => lowerJoined.includes(keyword.toLowerCase()));
  const subjectHit = scanConfig.subjectKeywords.some(keyword => lowerJoined.includes(keyword.toLowerCase()));
  return senderHit || subjectHit || /dreamina|dreamina@mail\.|capcut/i.test(joined);
}

function summarizeMessage(message) {
  return {
    from: String(message?.from || message?.from_name || message?.sender || '').slice(0, 120),
    subject: String(message?.subject || '').slice(0, 160),
    snippet: String(message?.snippet || message?.text || message?.body || message?.content || '').replace(/\s+/g, ' ').slice(0, 220),
  };
}

function extractMessageTimestampMs(message) {
  const candidates = [
    message?.date,
    message?.created_at,
    message?.createdAt,
    message?.received_at,
    message?.receivedAt,
    message?.timestamp,
    message?.time,
    message?.internalDate,
  ];

  for (const value of candidates) {
    if (value == null || value === '') continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }
    const text = String(value).trim();
    if (!text) continue;
    if (/^\d+$/.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric)) {
        return numeric > 1e12 ? numeric : numeric * 1000;
      }
    }
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function buildCandidateFromMessage(message, config = {}) {
  const parts = [
    message?.subject,
    message?.snippet,
    message?.text,
    message?.html,
    message?.body,
    message?.content,
  ].filter(Boolean);
  const code = extractCodeFromText(parts.join('\n'), config);
  if (!code) return null;
  return {
    message,
    messageTs: extractMessageTimestampMs(message),
    code,
    sourcePreview: parts.join(' | ').replace(/\s+/g, ' ').slice(0, 260),
  };
}

function pickRecentCandidateMessages(messages, { config = {}, seenCodes = new Set() } = {}) {
  const scanConfig = getFirstmailScanConfig(config);
  const limited = Array.isArray(messages) ? messages.slice(0, scanConfig.recentMessageScanLimit) : [];
  const candidates = [];
  const emittedCodes = new Set();

  for (const message of limited) {
    if (!isDreaminaMessage(message, config)) continue;
    const candidate = buildCandidateFromMessage(message, config);
    if (!candidate) continue;
    if (seenCodes.has(candidate.code)) continue;
    if (emittedCodes.has(candidate.code)) continue;
    emittedCodes.add(candidate.code);
    candidates.push({
      ...candidate,
      matchMode: candidates.length === 0 ? 'recent-primary' : 'recent-list',
    });
  }

  return candidates.sort((left, right) => Number(right.messageTs || 0) - Number(left.messageTs || 0));
}

function resolvePollJitterMs(config = {}) {
  const scanConfig = getFirstmailScanConfig(config);
  if (scanConfig.pollJitterMaxMs <= scanConfig.pollJitterMinMs) {
    return scanConfig.pollJitterMinMs;
  }
  return scanConfig.pollJitterMinMs + Math.floor(Math.random() * (scanConfig.pollJitterMaxMs - scanConfig.pollJitterMinMs + 1));
}

async function waitForDreaminaCodeViaApi({ account, config, log, accountLabel = '', proxyLabel = '', triggeredAtMs, seenCodes: externalSeenCodes }) {
  const maxAttempts = Number(config.firstmailApiMaxPollAttempts || config.waitMailAttempts || 18);
  const intervalMs = Number(config.waitMailIntervalMs || 5000);
  const totalBudgetMs = Math.max(0, (maxAttempts - 1) * intervalMs);
  const minAcceptMessageTs = Number(triggeredAtMs || 0);
  const acceptedSkewMs = Number(config.firstmailAcceptOlderThanTriggerSkewMs || 15000);
  const scanConfig = getFirstmailScanConfig(config);
  const seenCodes = externalSeenCodes instanceof Set ? externalSeenCodes : new Set();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingAttempts = Math.max(0, maxAttempts - attempt);
    const elapsedMs = Math.max(0, (attempt - 1) * intervalMs);
    const remainingMs = Math.max(0, totalBudgetMs - elapsedMs);

    if (typeof log === 'function') {
      log(`Firstmail API 轮询进度 | 当前=${attempt}/${maxAttempts} | 剩余轮次=${remainingAttempts} | 已等待=${Math.round(elapsedMs / 1000)}秒 | 剩余预算=${Math.round(remainingMs / 1000)}秒 | 总预算=${Math.round(totalBudgetMs / 1000)}秒 | 账号=${accountLabel || account.email} | 代理=${proxyLabel || 'NO_PROXY'} | triggeredAtMs=${minAcceptMessageTs || 0} | scanLimit=${scanConfig.recentMessageScanLimit}`);
    }

    const sources = [];
    const [messageListResult, unreadResult, latestResult] = await Promise.all([
      fetchMessagesList({ account, config }).catch(error => ({ error })),
      fetchUnreadMessages({ account, config }).catch(error => ({ error })),
      fetchLatestMessage({ account, config }).catch(error => ({ error })),
    ]);
    if (!messageListResult?.error) {
      sources.push({ kind: 'messages', ...messageListResult });
    }

    if (!unreadResult?.error) {
      sources.push({ kind: 'unread', ...unreadResult });
    }

    if (!latestResult?.error) {
      sources.push({ kind: 'latest', ...latestResult });
    }

    const primarySource = sources[0] || { response: { status: 0 }, message: null, messages: [], noMessages: true, kind: 'none' };
    const response = primarySource.response;
    const message = primarySource.message;
    const noMessages = sources.every(source => source.noMessages);
    const mergedMessages = [];
    const seenMessageKeys = new Set();
    for (const source of sources) {
      for (const item of Array.isArray(source.messages) ? source.messages : []) {
        const key = String(item?.id || item?.uid || `${item?.subject || ''}|${item?.date || ''}|${item?.from || ''}`).trim();
        if (!key || seenMessageKeys.has(key)) continue;
        seenMessageKeys.add(key);
        mergedMessages.push(item);
      }
    }
    mergedMessages.sort((left, right) => extractMessageTimestampMs(right) - extractMessageTimestampMs(left));
    const latestMessageTs = extractMessageTimestampMs(message);
    if (typeof log === 'function') {
      const summary = summarizeMessage(message || {});
      log(`Firstmail API 返回摘要 | status=${response.status} | from=${summary.from || 'NA'} | subject=${summary.subject || 'NA'} | snippet=${summary.snippet || 'NA'} | noMessages=${noMessages ? 'true' : 'false'} | messageTs=${latestMessageTs || 0} | scanned=${Array.isArray(messages) ? messages.length : 0}`);
    }

    if (noMessages) {
      if (typeof log === 'function') {
        log(`Firstmail API latest 当前没有邮件，继续下一轮轮询 | 下一轮前等待=${attempt < maxAttempts ? Math.round(intervalMs / 1000) : 0}秒`);
      }
    } else {
      const candidates = pickRecentCandidateMessages(mergedMessages, {
        config,
        seenCodes,
      });

      if (candidates.length > 0) {
        const candidate = candidates[0];
        seenCodes.add(candidate.code);
        if (typeof log === 'function') {
          log(`Firstmail API 在最近候选邮件池中命中验证码 | code=${candidate.code} | mode=${candidate.matchMode || 'recent-list'} | candidates=${candidates.map(item => item.code).join(',')} | 命中轮次=${attempt}/${maxAttempts} | 累计等待=${Math.round(elapsedMs / 1000)}秒 | messageTs=${candidate.messageTs || 0} | preview=${String(candidate.sourcePreview || '').slice(0, 180)}`);
        }
        return {
          code: candidate.code,
          message: candidate.message,
          attempt,
          messageTs: candidate.messageTs,
          matchMode: candidate.matchMode || 'recent-list',
          candidateCodes: candidates.map(item => item.code),
        };
      }

      if (typeof log === 'function' && seenCodes.size > 0) {
        log(`Firstmail API 当前轮未找到未使用的新验证码候选 | seenCodes=${seenCodes.size} | 当前=${attempt}/${maxAttempts}`);
      }

      const latestIsDreamina = mergedMessages[0] && isDreaminaMessage(mergedMessages[0], config);
      if (latestIsDreamina) {
        if (typeof log === 'function') {
          log(`Firstmail API latest 为 Dreamina 邮件，但本轮未提取到可用验证码，继续等待 | 当前=${attempt}/${maxAttempts}`);
        }
      } else if (typeof log === 'function') {
        log(`Firstmail API latest 不是目标邮件，继续等待下一轮 | 当前=${attempt}/${maxAttempts}`);
      }
    }

    if (attempt < maxAttempts) {
      const jitterMs = resolvePollJitterMs(config);
      await new Promise((resolve) => setTimeout(resolve, intervalMs + jitterMs));
    }
  }

  throw new Error(`FIRSTMAIL_API_CODE_TIMEOUT maxAttempts=${maxAttempts} totalBudgetSeconds=${Math.round(totalBudgetMs / 1000)}`);
}

module.exports = {
  getFirstmailApiConfig,
  getFirstmailScanConfig,
  fetchLatestMessage,
  fetchMessagesList,
  fetchUnreadMessages,
  waitForDreaminaCodeViaApi,
  extractCodeFromText,
  isDreaminaMessage,
  summarizeMessage,
  extractMessageTimestampMs,
  pickRecentCandidateMessages,
};
