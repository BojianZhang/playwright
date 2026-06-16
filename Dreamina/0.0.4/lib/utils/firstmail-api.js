'use strict';

/**
 * shared-utils/firstmail-api.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 通过 Firstmail API 拉取邮箱最新邮件 / 邮件列表 / 未读邮件。
 * ✅ 负责 —— 从邮件正文中提取验证码（正则多策略匹配）。
 * ✅ 负责 —— 带轮询 / 阶梯等待 / jitter 的验证码等待主循环（waitForDreaminaCodeViaApi）。
 * ✅ 负责 —— seenCodes 去重，避免同一验证码在多轮中被重复使用。
 * ❌ 不负责 —— 任何 Playwright / 浏览器操作。
 * ❌ 不负责 —— 阶段决策（不判断验证码是否正确，只负责拉取和提取）。
 * ❌ 不负责 —— 账号管理（不创建 / 删除账号，只读取 email / password 用于 API 鉴权）。
 * ❌ 不负责 —— 吞掉超时错误（超时时抛 FIRSTMAIL_API_CODE_TIMEOUT，属于基础设施错误，向上传播）。
 *
 * 设计说明：
 * - API Key 优先从 config.firstmailApiKey 读取，降级到环境变量 FIRSTMAIL_API_KEY。
 * - 前 latestOnlyAttempts 轮使用 latest-only 模式（仅取最新邮件，速度快）；
 *   之后切换到 latest + messages + unread 三路并行（覆盖更多收邮场景）。
 * - seenCodes 由调用方（verification-adapter）持有，跨轮次共享，避免重复提交旧验证码。
 * - 验证码新鲜度校验：邮件时间戳需 >= triggeredAtMs - acceptedSkewMs，
 *   拒绝早于本轮注册触发时刻的旧邮件中的验证码。
 *
 * 使用场景：
 * - shared-verification/dreamina/verification-adapter.js 的 S3 阶段验证码拉取层
 */

const https = require('https');

/** Firstmail API 默认 base URL。 */
const DEFAULT_BASE_URL = 'https://firstmail.ltd';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 基础层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 发起 HTTPS 请求并将响应解析为 JSON。
 *
 * 边界：
 * - 只做 HTTP 传输，不做任何业务逻辑判断。
 * - 响应体非 JSON 时抛 FIRSTMAIL_API_NON_JSON_RESPONSE 错误（含状态码 / ContentType / 正文摘要）。
 * - timeout 超出时销毁请求并抛 FIRSTMAIL_API_TIMEOUT 错误。
 * - 不处理 HTTP 4xx / 5xx 状态码，由上层调用者判断。
 *
 * @param {string} url - 完整请求 URL
 * @param {{ method?: string, headers?: object, body?: string, timeoutMs?: number }} [options={}]
 * @returns {Promise<{ status: number, headers: object, data: any, raw: string }>}
 */
function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        const contentType = String(res.headers['content-type'] || '');
        let data = null;
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            // 非 JSON 响应时直接拒绝，携带诊断信息方便排查。
            return reject(new Error(
              `FIRSTMAIL_API_NON_JSON_RESPONSE status=${res.statusCode || 'NA'} ` +
              `contentType=${contentType || 'NA'} body=${raw.slice(0, 300)}`
            ));
          }
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, data, raw });
      });
    });

    req.on('timeout', () => {
      // 超时时主动销毁 socket，避免连接泄漏。
      req.destroy(new Error(`FIRSTMAIL_API_TIMEOUT ${timeoutMs}ms`));
    });
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置解析层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 config 中提取 Firstmail API 鉴权配置。
 *
 * 边界：
 * - apiKey 优先从 config.firstmailApiKey 取，降级到环境变量 FIRSTMAIL_API_KEY。
 * - baseUrl 优先从 config.firstmailApiBaseUrl 取，默认为 firstmail.ltd。
 * - 不抛异常；apiKey 为空时由上层调用方抛 FIRSTMAIL_API_KEY_MISSING。
 *
 * @param {object} [config={}]
 * @returns {{ apiKey: string, baseUrl: string }}
 */
function getFirstmailApiConfig(config = {}) {
  const firstmail = config && typeof config.firstmail === 'object' ? config.firstmail : {};
  const apiKey = String(
    config.firstmailApiKey
    || config.FIRSTMAIL_API_KEY
    || firstmail.apiKey
    || process.env.FIRSTMAIL_API_KEY
    || ''
  ).trim();
  const baseUrl = String(
    config.firstmailApiBaseUrl
    || config.FIRSTMAIL_API_BASE_URL
    || firstmail.apiBaseUrl
    || process.env.FIRSTMAIL_API_BASE_URL
    || DEFAULT_BASE_URL
  ).trim().replace(/\/+$/, '');
  return { apiKey, baseUrl };
}

/**
 * 从 config 中提取邮件扫描行为配置。
 *
 * 边界：
 * - 所有字段均有 fallback（subjectKeywords / senderKeywords / scanLimit 等），不会返回 undefined。
 * - 不做任何 API 请求，纯粹的配置解析与归一化。
 *
 * @param {object} [config={}]
 * @returns {{
 *   subjectKeywords: string[],
 *   senderKeywords: string[],
 *   recentMessageScanLimit: number,
 *   pollJitterMinMs: number,
 *   pollJitterMaxMs: number,
 *   codeRegex: string,
 *   fallbackLookbackMs: number,
 *   fallbackEnableFromAttempt: number
 * }}
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// 消息结构适配层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造 latest-message / messages 接口的通用 POST body（仅用于内部兜底，实际由 postFirstmailMessagesEndpoint 构造）。
 *
 * @param {{ email: string, password: string }} account
 * @returns {string} JSON 字符串
 */
function buildLatestMessagePayload(account) {
  return JSON.stringify({
    email: account.email,
    password: account.password,
    folder: 'INBOX',
  });
}

/**
 * 从 API 响应体中提取邮件列表，兼容 Firstmail 多种响应结构。
 *
 * 边界：
 * - 只做结构适配，不做邮件内容判断。
 * - 按优先级依次尝试 messages[] / data[] / message{} / data{} / 根对象本身。
 * - 无法识别的结构返回空数组，不抛异常。
 *
 * @param {any} responseData - API 响应的 data 字段
 * @returns {Array<object>}
 */
function extractMessageList(responseData) {
  if (!responseData) return [];
  if (Array.isArray(responseData?.messages)) return responseData.messages;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (responseData?.message && typeof responseData.message === 'object') return [responseData.message];
  if (responseData?.data && typeof responseData.data === 'object' && !Array.isArray(responseData.data)) return [responseData.data];
  if (typeof responseData === 'object' && !Array.isArray(responseData)) return [responseData];
  return [];
}

/**
 * 从 API 响应体中提取最新一封邮件（取 extractMessageList 结果的第一项）。
 *
 * @param {any} responseData
 * @returns {object|null}
 */
function extractLatestMessage(responseData) {
  return extractMessageList(responseData)[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// API 请求封装层（latest / messages / unread）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 向 Firstmail 邮件接口发送 POST 请求的通用封装。
 *
 * 边界：
 * - apiKey 缺失时直接抛 FIRSTMAIL_API_KEY_MISSING（不发请求）。
 * - HTTP 404 + "No messages found" → 视为正常的空收件箱（不抛异常，返回 noMessages: true）。
 * - 其他 4xx / 5xx → 抛 FIRSTMAIL_API_HTTP_xxx 错误，由调用方决定是否重试。
 * - 返回的 messages 列表已按 scanConfig.recentMessageScanLimit 截断。
 *
 * @param {string} endpointPath - 接口路径（如 '/api/v1/email/messages/latest'）
 * @param {{ account: object, config: object, payloadOverrides?: object }} param
 * @returns {Promise<{ response: object, message: object|null, messages: object[], noMessages: boolean }>}
 */
async function postFirstmailMessagesEndpoint(endpointPath, { account, config, payloadOverrides = {} }) {
  const { apiKey, baseUrl } = getFirstmailApiConfig(config);
  if (!apiKey) {
    throw new Error('FIRSTMAIL_API_KEY_MISSING');
  }

  // 构造请求体，payloadOverrides 允许各接口覆写 limit 等字段。
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

  // 404 + "No messages found" 属于正常情况（收件箱为空），不作为错误处理。
  if (response.status === 404) {
    const errorText = String(response.data?.error || response.data?.message || response.raw || '').trim();
    if (/No messages found/i.test(errorText)) {
      return { response, message: null, messages: [], noMessages: true };
    }
  }

  // 其他 4xx / 5xx 视为 API 错误，向上抛出。
  if (response.status >= 400) {
    const errorText = response.data?.error || response.data?.message || response.raw || `HTTP_${response.status}`;
    throw new Error(`FIRSTMAIL_API_HTTP_${response.status}:${errorText}`);
  }

  // 兼容 response.data.data 和 response.data 两种结构，提取邮件列表。
  const rawMessages = extractMessageList(response.data?.data || response.data);
  const scanConfig = getFirstmailScanConfig(config);
  return {
    response,
    message: rawMessages[0] || null,
    messages: rawMessages.slice(0, scanConfig.recentMessageScanLimit),
    noMessages: rawMessages.length === 0,
  };
}

/**
 * 拉取收件箱最新一封邮件（latest 接口，最快）。
 *
 * 边界：不做内容解析，只做 HTTP 请求和结构适配。
 *
 * @param {{ account: object, config: object }} param
 * @returns {Promise<{ response: object, message: object|null, messages: object[], noMessages: boolean }>}
 */
async function fetchLatestMessage({ account, config }) {
  return await postFirstmailMessagesEndpoint('/api/v1/email/messages/latest', {
    account,
    config,
    payloadOverrides: {},
  });
}

/**
 * 拉取收件箱最近 N 封邮件列表（按 recentMessageScanLimit 限制数量）。
 *
 * 边界：不做内容解析，只做 HTTP 请求和结构适配。
 *
 * @param {{ account: object, config: object }} param
 * @returns {Promise<{ response: object, message: object|null, messages: object[], noMessages: boolean }>}
 */
async function fetchMessagesList({ account, config }) {
  return await postFirstmailMessagesEndpoint('/api/v1/email/messages', {
    account,
    config,
    payloadOverrides: {
      limit: Number(config.firstmailRecentMessageScanLimit || 10),
    },
  });
}

/**
 * 拉取收件箱未读邮件列表（按 firstmailUnreadScanLimit 或 recentMessageScanLimit 限制数量）。
 *
 * 边界：不做内容解析，只做 HTTP 请求和结构适配。
 *
 * @param {{ account: object, config: object }} param
 * @returns {Promise<{ response: object, message: object|null, messages: object[], noMessages: boolean }>}
 */
async function fetchUnreadMessages({ account, config }) {
  return await postFirstmailMessagesEndpoint('/api/v1/email/messages/unread', {
    account,
    config,
    payloadOverrides: {
      limit: Number(config.firstmailUnreadScanLimit || config.firstmailRecentMessageScanLimit || 10),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 验证码提取层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从邮件正文文本中提取验证码，采用多策略匹配顺序：
 *  1. 上下文正则（"verification code: XXXX" 等场景专用）
 *  2. config.firstmailCodeRegex 自定义正则
 *  3. 通用候选池（过滤品牌词后取剩余唯一 token）
 *
 * 边界：
 * - 输入文本会先去除 HTML 标签、&nbsp; 和多余空白。
 * - 优先返回有明确上下文语义的验证码（见 contextualPatterns）。
 * - 全部策略均无命中时返回空字符串，不抛异常。
 *
 * @param {string} text - 邮件正文（HTML 或纯文本）
 * @param {object} [config={}]
 * @returns {string} 提取到的验证码，未命中时为空字符串
 */
function extractCodeFromText(text, config = {}) {
  // 预处理：去标签、去 &nbsp;、折叠空白，便于正则匹配。
  const bodyText = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const scanConfig = getFirstmailScanConfig(config);

  // 策略 1：带上下文的语义正则，优先级最高，命中即返回。
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

  // 策略 2：config 自定义正则（允许运营层调整匹配规则）。
  try {
    const customPattern = new RegExp(scanConfig.codeRegex, 'i');
    const customMatch = bodyText.match(customPattern);
    if (customMatch) return customMatch[1] || customMatch[0] || '';
  } catch (error) {
    // 自定义正则非法时静默跳过，降级到策略 3。
  }

  // 策略 3：通用候选池，提取所有 4-8 位大写字母数字 token，过滤品牌词后取剩余。
  const allCandidates = [...bodyText.matchAll(/\b([A-Z0-9]{4,8})\b/g)]
    .map(match => String(match[1] || '').trim())
    .filter(Boolean);
  const filteredCandidates = allCandidates.filter(
    token => !/dreamina|capcut|verify|login|email/i.test(token)
  );
  if (filteredCandidates.length === 1) return filteredCandidates[0];
  if (filteredCandidates.length > 1) {
    // 多个候选时优先取含数字的 token（验证码通常含数字）。
    const digitHeavy = filteredCandidates.filter(token => /\d/.test(token));
    if (digitHeavy.length >= 1) return digitHeavy[0];
    return filteredCandidates[0];
  }

  return '';
}

/**
 * 判断一封邮件是否来自 Dreamina / CapCut（通过 sender / subject 关键词匹配）。
 *
 * 边界：
 * - 只读取邮件字段，不做任何 API 调用或状态修改。
 * - 匹配范围：from / from_name / sender / subject / snippet / text / html / body / content。
 * - senderKeywords / subjectKeywords 可通过 config 覆写，降低误判率。
 *
 * @param {object} message - Firstmail 邮件对象
 * @param {object} [config={}]
 * @returns {boolean}
 */
function isDreaminaMessage(message, config = {}) {
  // 将所有相关字段拼接为一个字符串，便于关键词扫描。
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
  const senderHit = scanConfig.senderKeywords.some(kw => lowerJoined.includes(kw.toLowerCase()));
  const subjectHit = scanConfig.subjectKeywords.some(kw => lowerJoined.includes(kw.toLowerCase()));
  // 内置兜底模式：即使 config 关键词为空，也能识别 Dreamina 品牌邮件。
  return senderHit || subjectHit || /dreamina|dreamina@mail\.|capcut/i.test(joined);
}

/**
 * 从邮件对象中提取用于日志展示的摘要字段（截断至安全长度）。
 *
 * 边界：
 * - 只读取邮件字段，不做任何修改。
 * - 所有字段均有 fallback，不会返回 undefined。
 *
 * @param {object} message - Firstmail 邮件对象
 * @returns {{ from: string, subject: string, snippet: string }}
 */
function summarizeMessage(message) {
  return {
    from: String(message?.from || message?.from_name || message?.sender || '').slice(0, 120),
    subject: String(message?.subject || '').slice(0, 160),
    snippet: String(message?.snippet || message?.text || message?.body || message?.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, 220),
  };
}

/**
 * 从邮件对象中提取时间戳（毫秒）。兼容多种字段名和值类型（number / string / ISO 日期）。
 *
 * 边界：
 * - 尝试顺序：date / created_at / createdAt / received_at / receivedAt / timestamp / time / internalDate。
 * - 数值型时间戳若 < 1e12（秒级），自动转换为毫秒级。
 * - 所有字段均无效时返回 0（表示时间戳未知）。
 *
 * @param {object} message - Firstmail 邮件对象
 * @returns {number} 毫秒时间戳，未知时为 0
 */
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
    // 数值型：直接判断是否需要 ×1000 转换。
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }
    const text = String(value).trim();
    if (!text) continue;
    // 纯数字字符串：同样做毫秒/秒判断。
    if (/^\d+$/.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
    }
    // ISO / RFC 日期字符串：交由 Date.parse 解析。
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 验证码候选构造与筛选层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从单封邮件中尝试提取验证码候选对象。
 *
 * 边界：
 * - 合并 subject / snippet / text / html / body / content 后调用 extractCodeFromText。
 * - 未能提取到验证码时返回 null（由调用方跳过）。
 *
 * @param {object} message - Firstmail 邮件对象
 * @param {object} [config={}]
 * @returns {{ message: object, messageTs: number, code: string, sourcePreview: string }|null}
 */
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
    // sourcePreview 用于日志中展示命中验证码的上下文，截断至 260 字符。
    sourcePreview: parts.join(' | ').replace(/\s+/g, ' ').slice(0, 260),
  };
}

/**
 * 从多封邮件中筛选出 Dreamina 验证码候选列表，并去重排序。
 *
 * 边界：
 * - 按 recentMessageScanLimit 截断输入列表（避免扫描过多历史邮件）。
 * - 过滤规则：isDreaminaMessage 精确匹配 + seenCodes 全局去重 + emittedCodes 本批次内去重。
 * - 返回结果按 messageTs 降序排列（最新邮件优先）。
 * - matchMode 字段：第一个候选为 'recent-primary'，后续为 'recent-list'。
 *
 * @param {Array<object>} messages - 候选邮件列表
 * @param {{ config?: object, seenCodes?: Set<string> }} [options={}]
 * @returns {Array<{ message: object, messageTs: number, code: string, matchMode: string, sourcePreview: string }>}
 */
function pickRecentCandidateMessages(messages, { config = {}, seenCodes = new Set() } = {}) {
  const scanConfig = getFirstmailScanConfig(config);
  // 按 scanLimit 截断，避免扫描过多历史邮件导致误匹配。
  const limited = Array.isArray(messages) ? messages.slice(0, scanConfig.recentMessageScanLimit) : [];
  const candidates = [];
  const emittedCodes = new Set(); // 本次调用内部的去重集合，独立于 seenCodes。

  for (const message of limited) {
    if (!isDreaminaMessage(message, config)) continue; // 过滤非 Dreamina 邮件
    const candidate = buildCandidateFromMessage(message, config);
    if (!candidate) continue;             // 提取不到验证码
    if (seenCodes.has(candidate.code)) continue;    // 已在历史轮次中使用过
    if (emittedCodes.has(candidate.code)) continue; // 本批次已输出过相同 code
    emittedCodes.add(candidate.code);
    candidates.push({
      ...candidate,
      matchMode: candidates.length === 0 ? 'recent-primary' : 'recent-list',
    });
  }

  // 按时间戳降序排列，最新邮件的验证码排在最前。
  return candidates.sort((left, right) => Number(right.messageTs || 0) - Number(left.messageTs || 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// 轮询调度层
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算本轮的随机 jitter 延迟（毫秒），用于轮询间隔的随机化，减少并发冲突。
 *
 * 边界：
 * - pollJitterMaxMs <= pollJitterMinMs 时直接返回 pollJitterMinMs（无随机）。
 * - 返回值在 [pollJitterMinMs, pollJitterMaxMs] 区间内均匀随机。
 *
 * @param {object} [config={}]
 * @returns {number} jitter 毫秒数
 */
function resolvePollJitterMs(config = {}) {
  const scanConfig = getFirstmailScanConfig(config);
  if (scanConfig.pollJitterMaxMs <= scanConfig.pollJitterMinMs) {
    return scanConfig.pollJitterMinMs;
  }
  return scanConfig.pollJitterMinMs +
    Math.floor(Math.random() * (scanConfig.pollJitterMaxMs - scanConfig.pollJitterMinMs + 1));
}

/**
 * 构造轮询等待时间序列（每轮对应一个延迟值，毫秒）。
 *
 * 边界：
 * - 若 config.firstmailPollScheduleMs 已配置且合法，直接使用该序列（优先）。
 * - 否则使用默认阶梯序列 [0, 1200, 1800, 2500, baseIntervalMs]。
 * - 序列长度不足 maxAttempts 时，末尾用最后一个值补充（不会 index out of bounds）。
 *
 * @param {object} [config={}]
 * @param {number} [maxAttempts=1]
 * @returns {number[]} 长度为 maxAttempts 的延迟数组（ms）
 */
function buildFirstmailPollSchedule(config = {}, maxAttempts = 1) {
  const baseIntervalMs = Math.max(0, Number(config.waitMailIntervalMs || 5000));
  const configuredSchedule = Array.isArray(config.firstmailPollScheduleMs)
    ? config.firstmailPollScheduleMs
        .map(value => Math.max(0, Number(value || 0)))
        .filter(value => Number.isFinite(value))
    : [];

  // 优先用 config 配置的阶梯序列，缺失时用内置默认序列。
  const stagedSchedule = configuredSchedule.length > 0
    ? configuredSchedule
    : [0, 1200, 1800, 2500, baseIntervalMs];

  const delays = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 超出序列长度时复用最后一项。
    const scheduled = stagedSchedule[Math.min(attempt - 1, stagedSchedule.length - 1)];
    delays.push(Math.max(0, Number.isFinite(scheduled) ? scheduled : baseIntervalMs));
  }
  return delays;
}

/**
 * 计算第 attempt 轮之前已经累计等待的总毫秒数（不含第 attempt 轮本身的等待）。
 *
 * 边界：
 * - attempt <= 1 时返回 0（第一轮不等待）。
 * - 用于日志中展示"已等待 N 秒"。
 *
 * @param {number[]} delays - buildFirstmailPollSchedule 返回的延迟数组
 * @param {number} [attempt=1]
 * @returns {number} 累计等待毫秒数
 */
function sumDelaysBeforeAttempt(delays = [], attempt = 1) {
  if (attempt <= 1) return 0;
  // slice(1, attempt)：跳过第 1 轮（第 1 轮延迟通常为 0，已体现在轮次内）。
  return delays.slice(1, attempt).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
}

/**
 * 为邮件对象构造唯一 key（用于跨数据源的去重）。
 *
 * 边界：
 * - 优先用 id / uid，缺失时以 subject|date|from 拼合作为 fallback key。
 * - key 可能不完全唯一（fallback 场景），但足以过滤明显重复的邮件。
 *
 * @param {object} [item={}]
 * @returns {string}
 */
function buildMessageKey(item = {}) {
  return String(
    item?.id || item?.uid || `${item?.subject || ''}|${item?.date || ''}|${item?.from || ''}`
  ).trim();
}

/**
 * 将多个 API 数据源（latest / messages / unread）的邮件列表合并去重并按时间排序。
 *
 * 边界：
 * - 以 buildMessageKey 做去重，同一封邮件在多个数据源中只保留一份。
 * - 返回结果按 extractMessageTimestampMs 降序排列（最新在前）。
 *
 * @param {Array<{ messages?: object[] }>} [sources=[]]
 * @returns {object[]} 去重合并后的邮件列表
 */
function mergeMessageSources(sources = []) {
  const mergedMessages = [];
  const seenMessageKeys = new Set();

  for (const source of sources) {
    for (const item of Array.isArray(source?.messages) ? source.messages : []) {
      const key = buildMessageKey(item);
      if (!key || seenMessageKeys.has(key)) continue;
      seenMessageKeys.add(key);
      mergedMessages.push(item);
    }
  }

  // 按时间戳降序，保证最新邮件排在最前，便于快速命中验证码。
  mergedMessages.sort((left, right) => extractMessageTimestampMs(right) - extractMessageTimestampMs(left));
  return mergedMessages;
}

// ─────────────────────────────────────────────────────────────────────────────
// 验证码等待主循环
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 轮询 Firstmail API，等待并提取 Dreamina 验证码。
 *
 * 核心流程（每轮）：
 *  1. 按阶梯延迟（+ jitter）等待（第 1 轮跳过等待，直接拉取）。
 *  2. 拉取 latest 邮件（始终执行）；超过 latestOnlyAttempts 轮后额外并行拉取 messages + unread。
 *  3. 合并去重，按"最新优先"顺序扫描验证码候选：
 *     a. latest 直接命中（最快路径）
 *     b. 候选池命中（messages / unread 补充路径）
 *  4. 验证码新鲜度校验：拒绝早于 triggeredAtMs - acceptedSkewMs 的旧邮件。
 *  5. seenCodes 去重：已使用的验证码不会再次返回。
 *
 * 边界：
 * - maxAttempts 耗尽仍无验证码时抛 FIRSTMAIL_API_CODE_TIMEOUT 错误（含 fetchTrace）。
 * - seenCodes 由调用方（Set）持有并跨轮次共享；传入非 Set 时内部创建临时 Set。
 * - log 函数可选，传入时每轮输出轮询进度和返回摘要（用于 stage 日志）。
 * - 函数内部所有 API 调用均做 .catch 兜底，单次网络失败不中断轮询。
 *
 * @param {{
 *   account: { email: string, password: string },
 *   config: object,
 *   log?: Function,
 *   accountLabel?: string,
 *   proxyLabel?: string,
 *   triggeredAtMs?: number,
 *   seenCodes?: Set<string>
 * }} param
 * @returns {Promise<{
 *   code: string,
 *   message: object,
 *   attempt: number,
 *   messageTs: number,
 *   matchMode: string,
 *   candidateCodes: string[],
 *   fetchTrace: object
 * }>}
 * @throws {Error} FIRSTMAIL_API_CODE_TIMEOUT — 超出最大轮次仍未获取到验证码
 */
async function waitForDreaminaCodeViaApi({
  account,
  config,
  log,
  accountLabel = '',
  proxyLabel = '',
  triggeredAtMs,
  seenCodes: externalSeenCodes,
}) {
  const maxAttempts = Number(config.firstmailApiMaxPollAttempts || config.waitMailAttempts || 18);
  const scanConfig = getFirstmailScanConfig(config);
  // seenCodes 由调用方持有（跨轮次）；非 Set 时创建临时空 Set（不跨轮次去重）。
  const seenCodes = externalSeenCodes instanceof Set ? externalSeenCodes : new Set();
  const pollScheduleMs = buildFirstmailPollSchedule(config, maxAttempts);
  const totalBudgetMs = pollScheduleMs.slice(1).reduce((sum, val) => sum + Math.max(0, Number(val || 0)), 0);
  // minAcceptMessageTs：邮件时间戳阈值，低于此值的邮件（含容差）将被跳过，避免使用旧验证码。
  const minAcceptMessageTs = Number(triggeredAtMs || 0);
  const acceptedSkewMs = Number(config.firstmailAcceptOlderThanTriggerSkewMs || 15000);
  const latestOnlyAttempts = Math.max(0, Number(config.firstmailLatestOnlyAttempts || 2));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingAttempts = Math.max(0, maxAttempts - attempt);
    const elapsedMs = sumDelaysBeforeAttempt(pollScheduleMs, attempt);
    const remainingMs = Math.max(0, totalBudgetMs - elapsedMs);
    const currentDelayMs = Math.max(0, Number(pollScheduleMs[attempt - 1] || 0));
    // 前 latestOnlyAttempts 轮只拉 latest（速度最快），之后三路并行。
    const useLatestOnly = attempt <= latestOnlyAttempts;

    // 从第 2 轮开始，按阶梯延迟等待（加随机 jitter 防止并发请求集中）。
    if (attempt > 1 && currentDelayMs > 0) {
      const jitterMs = resolvePollJitterMs(config);
      await new Promise((resolve) => setTimeout(resolve, currentDelayMs + jitterMs));
    }

    // 输出本轮进度日志（如果调用方提供了 log 函数）。
    if (typeof log === 'function') {
      log(
        `Firstmail API 轮询进度 | 当前=${attempt}/${maxAttempts}` +
        ` | 模式=${useLatestOnly ? 'latest-only' : 'latest+messages+unread'}` +
        ` | 剩余轮次=${remainingAttempts}` +
        ` | 已等待=${Math.round(elapsedMs / 1000)}秒` +
        ` | 剩余预算=${Math.round(remainingMs / 1000)}秒` +
        ` | 总预算=${Math.round(totalBudgetMs / 1000)}秒` +
        ` | 本轮延迟=${Math.round(currentDelayMs / 1000)}秒` +
        ` | 账号=${accountLabel || account.email}` +
        ` | 代理=${proxyLabel || 'NO_PROXY'}` +
        ` | triggeredAtMs=${minAcceptMessageTs || 0}` +
        ` | scanLimit=${scanConfig.recentMessageScanLimit}`
      );
    }

    // 拉取 latest 邮件（网络失败时 catch 为 { error }，不中断本轮）。
    const fetchStartedAt = Date.now();
    const latestResult = await fetchLatestMessage({ account, config }).catch(error => ({ error }));
    const latestLatencyMs = Date.now() - fetchStartedAt;

    // 将成功的数据源加入 sources 列表，用于后续合并去重。
    const sources = [];
    if (!latestResult?.error) {
      sources.push({ kind: 'latest', ...latestResult });
    }

    let messageListResult = null;
    let unreadResult = null;
    let messageListLatencyMs = 0;
    let unreadLatencyMs = 0;

    // 超过 latestOnlyAttempts 轮后，额外并行拉取 messages + unread（提升覆盖率）。
    if (!useLatestOnly) {
      const parallelStartedAt = Date.now();
      [messageListResult, unreadResult] = await Promise.all([
        fetchMessagesList({ account, config }).catch(error => ({ error })),
        fetchUnreadMessages({ account, config }).catch(error => ({ error })),
      ]);
      const parallelLatencyMs = Date.now() - parallelStartedAt;
      messageListLatencyMs = parallelLatencyMs;
      unreadLatencyMs = parallelLatencyMs;
      if (!messageListResult?.error) sources.push({ kind: 'messages', ...messageListResult });
      if (!unreadResult?.error)     sources.push({ kind: 'unread',   ...unreadResult });
    }

    // primarySource 为首个成功的数据源（通常是 latest）。
    const primarySource = sources[0] || { response: { status: 0 }, message: null, messages: [], noMessages: true, kind: 'none' };
    const response       = primarySource.response;
    const message        = primarySource.message;
    const noMessages     = sources.length === 0 || sources.every(src => src.noMessages);
    const mergedMessages = mergeMessageSources(sources);
    const latestMessageTs = extractMessageTimestampMs(message);
    const summary        = summarizeMessage(message || {});
    const latestCandidate = buildCandidateFromMessage(message, config);
    // 新鲜度校验：邮件时间戳需在 triggeredAtMs - acceptedSkewMs 之后。
    const latestCandidateFreshEnough = !latestCandidate ||
      (latestCandidate.messageTs || 0) >= (minAcceptMessageTs - acceptedSkewMs);

    // 输出本轮 API 返回摘要日志。
    if (typeof log === 'function') {
      log(
        `Firstmail API 返回摘要 | mode=${useLatestOnly ? 'latest-only' : 'latest+messages+unread'}` +
        ` | status=${response.status}` +
        ` | from=${summary.from || 'NA'} | subject=${summary.subject || 'NA'}` +
        ` | snippet=${summary.snippet || 'NA'}` +
        ` | noMessages=${noMessages ? 'true' : 'false'}` +
        ` | messageTs=${latestMessageTs || 0}` +
        ` | scanned=${mergedMessages.length}` +
        ` | latestLatencyMs=${latestLatencyMs}` +
        ` | messagesLatencyMs=${messageListLatencyMs}` +
        ` | unreadLatencyMs=${unreadLatencyMs}`
      );
    }

    // 快速路径：latest 邮件直接命中验证码，且新鲜、未使用、属于 Dreamina。
    if (latestCandidate &&
        latestCandidateFreshEnough &&
        !seenCodes.has(latestCandidate.code) &&
        isDreaminaMessage(message, config)) {
      seenCodes.add(latestCandidate.code);
      if (typeof log === 'function') {
        log(
          `Firstmail API latest 直接命中验证码 | code=${latestCandidate.code}` +
          ` | mode=${useLatestOnly ? 'latest-only' : 'latest-primary'}` +
          ` | 命中轮次=${attempt}/${maxAttempts}` +
          ` | 累计等待=${Math.round(elapsedMs / 1000)}秒` +
          ` | messageTs=${latestCandidate.messageTs || 0}`
        );
      }
      return {
        code: latestCandidate.code,
        message,
        attempt,
        messageTs: latestCandidate.messageTs,
        matchMode: useLatestOnly ? 'latest-only' : 'latest-primary',
        candidateCodes: [latestCandidate.code],
        fetchTrace: {
          hitAttempt: attempt,
          strategy: useLatestOnly ? 'latest-only' : 'latest-primary',
          latestOnlyAttempts,
          pollScheduleMs,
          latestLatencyMs,
          messagesLatencyMs: messageListLatencyMs,
          unreadLatencyMs,
          scannedMessageCount: mergedMessages.length,
        },
      };
    }

    if (noMessages) {
      // 本轮收件箱为空，等待下一轮。
      if (typeof log === 'function') {
        log(
          `Firstmail API 当前轮无邮件` +
          ` | mode=${useLatestOnly ? 'latest-only' : 'full-scan'}` +
          ` | 下一轮前等待=${attempt < maxAttempts ? Math.round(Number(pollScheduleMs[attempt] || 0) / 1000) : 0}秒`
        );
      }
    } else {
      // 有邮件但 latest 未命中，尝试从候选池中找新鲜验证码。
      const candidates = pickRecentCandidateMessages(mergedMessages, { config, seenCodes })
        .filter(c => (c.messageTs || 0) >= (minAcceptMessageTs - acceptedSkewMs));

      if (candidates.length > 0) {
        const candidate = candidates[0];
        seenCodes.add(candidate.code);
        if (typeof log === 'function') {
          log(
            `Firstmail API 在最近候选邮件池中命中验证码 | code=${candidate.code}` +
            ` | mode=${candidate.matchMode || 'recent-list'}` +
            ` | candidates=${candidates.map(c => c.code).join(',')}` +
            ` | 命中轮次=${attempt}/${maxAttempts}` +
            ` | 累计等待=${Math.round(elapsedMs / 1000)}秒` +
            ` | messageTs=${candidate.messageTs || 0}` +
            ` | preview=${String(candidate.sourcePreview || '').slice(0, 180)}`
          );
        }
        return {
          code: candidate.code,
          message: candidate.message,
          attempt,
          messageTs: candidate.messageTs,
          matchMode: candidate.matchMode || 'recent-list',
          candidateCodes: candidates.map(c => c.code),
          fetchTrace: {
            hitAttempt: attempt,
            strategy: candidate.matchMode || 'recent-list',
            latestOnlyAttempts,
            pollScheduleMs,
            latestLatencyMs,
            messagesLatencyMs: messageListLatencyMs,
            unreadLatencyMs,
            scannedMessageCount: mergedMessages.length,
          },
        };
      }

      // 有邮件但本轮无新验证码候选，记录原因并继续。
      if (typeof log === 'function' && seenCodes.size > 0) {
        log(`Firstmail API 当前轮未找到未使用的新验证码候选 | seenCodes=${seenCodes.size} | 当前=${attempt}/${maxAttempts} | mode=${useLatestOnly ? 'latest-only' : 'full-scan'}`);
      }

      const latestIsDreamina = mergedMessages[0] && isDreaminaMessage(mergedMessages[0], config);
      if (typeof log === 'function') {
        if (latestIsDreamina) {
          log(`Firstmail API latest 为 Dreamina 邮件，但本轮未提取到可用验证码，继续等待 | 当前=${attempt}/${maxAttempts}`);
        } else {
          log(`Firstmail API latest 不是目标邮件，继续等待下一轮 | 当前=${attempt}/${maxAttempts}`);
        }
      }
    }
  }

  // 所有轮次耗尽，抛超时错误并携带 fetchTrace（供调用层记录诊断信息）。
  const timeoutError = new Error(
    `FIRSTMAIL_API_CODE_TIMEOUT maxAttempts=${maxAttempts} totalBudgetSeconds=${Math.round(totalBudgetMs / 1000)}`
  );
  timeoutError.fetchTrace = {
    hitAttempt: 0,
    strategy: 'timeout',
    latestOnlyAttempts,
    pollScheduleMs,
  };
  throw timeoutError;
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
