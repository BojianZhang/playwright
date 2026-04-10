const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { runRegisterTask } = require('./task-register');
const { loadWindowLayoutProfile, summarizeProfile: summarizeWindowLayoutProfile } = require('./window-layout-profile-loader');
const { logSystem, logAccount, logProxy, logStage, logSuccess, logFail, logWarn, logInfo } = require('./logger');

const baseDir = __dirname;
const accountsPath = path.join(baseDir, 'accounts.txt');
const proxiesPath = path.join(baseDir, 'proxies.txt');
const configPath = path.join(baseDir, 'config.json');
const healthyProxyPath = path.join(baseDir, 'results', 'proxy-ok.txt');
const weakProxyPath = path.join(baseDir, 'results', 'proxy-weak.txt');
const badProxyPath = path.join(baseDir, 'results', 'proxy-bad.txt');

function createMutex() {
  let current = Promise.resolve();
  return async (task) => {
    const run = current.then(() => task());
    current = run.catch(() => {});
    return run;
  };
}

function getScreenSize() {
  const width = Number(process.env.OPENCLAW_SCREEN_WIDTH || process.env.SCREEN_WIDTH || 1920);
  const height = Number(process.env.OPENCLAW_SCREEN_HEIGHT || process.env.SCREEN_HEIGHT || 1080);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1920,
    height: Number.isFinite(height) && height > 0 ? height : 1080,
  };
}

function resolveRunMode(config = {}) {
  return String(config.runMode || 'run').trim().toLowerCase();
}

function isTestMode(config = {}) {
  return resolveRunMode(config) === 'test';
}

function shouldCaptureScreenshots(config = {}) {
  const runMode = resolveRunMode(config);
  if (runMode === 'test' && typeof config.testEnableScreenshots === 'boolean') return config.testEnableScreenshots;
  if (runMode === 'run' && typeof config.runEnableScreenshots === 'boolean') return config.runEnableScreenshots;
  if (typeof config.enableScreenshots === 'boolean') return config.enableScreenshots;
  return isTestMode(config);
}

function resolveSlowMo(config = {}) {
  if (isTestMode(config)) return Number(config.testSlowMo ?? config.slowMo ?? 120);
  return Number(config.runSlowMo ?? 0);
}

function resolveHumanPauseRange(config = {}) {
  if (isTestMode(config)) {
    return { min: Number(config.testHumanPauseMinMs ?? 800), max: Number(config.testHumanPauseMaxMs ?? 1800) };
  }
  return { min: Number(config.runHumanPauseMinMs ?? 0), max: Number(config.runHumanPauseMaxMs ?? 0) };
}

function resolveAllowedProxySpeedTiers(config = {}) {
  const raw = isTestMode(config) ? config.testProxySpeedTiers : config.runProxySpeedTiers;
  const arr = Array.isArray(raw) ? raw : [];
  const normalized = arr.map(item => String(item || '').trim().toUpperCase()).filter(Boolean);
  return normalized.length ? normalized : ['FAST'];
}

function extractProxySpeedTier(rawLine = '') {
  const match = String(rawLine).match(/\bspeed=([A-Z_]+)/i);
  return match ? String(match[1]).toUpperCase() : '';
}

function filterProxyLinesBySpeed(lines, config = {}) {
  const allowed = new Set(resolveAllowedProxySpeedTiers(config));
  return lines.filter(line => {
    const speed = extractProxySpeedTier(line);
    if (!speed) return false;
    return allowed.has(speed);
  });
}

function getWindowLayoutRuntime() {
  const profile = loadWindowLayoutProfile();
  return {
    profile,
    summary: summarizeWindowLayoutProfile(profile),
  };
}

function buildUniformGridWindowSlots(concurrency, screen, profile) {
  const margin = Number(profile.margin || 8);
  const gap = Number(profile.gap || 12);
  const topInset = Number(profile.topInset || 8);
  const bottomInset = Number(profile.bottomInset || 48);
  const usableWidth = Math.max(1, screen.width - margin * 2);
  const usableHeight = Math.max(1, screen.height - topInset - bottomInset);
  const singleMinWidth = Number(profile.singleMinWidth || 960);
  const singleMinHeight = Number(profile.singleMinHeight || 720);
  const minWindowWidth = Number(profile.minWindowWidth || 640);
  const minWindowHeight = Number(profile.minWindowHeight || 420);

  if (concurrency <= 1) {
    const width = Math.min(Math.max(singleMinWidth, usableWidth), usableWidth);
    const height = Math.min(Math.max(singleMinHeight, usableHeight), usableHeight);
    return [{
      row: 0,
      col: 0,
      cols: 1,
      rows: 1,
      x: margin,
      y: topInset,
      width,
      height,
      layout: 'uniform-grid-1x1',
    }];
  }

  const preferredColumns = Number(profile.preferredColumns?.[String(concurrency)] || 0);
  let cols = preferredColumns > 0 ? preferredColumns : Math.ceil(Math.sqrt(concurrency));
  let rows = Math.ceil(concurrency / cols);

  while (cols > 1) {
    const cellWidth = Math.floor((usableWidth - gap * (cols - 1)) / cols);
    const cellHeight = Math.floor((usableHeight - gap * (rows - 1)) / rows);
    if (cellWidth >= minWindowWidth && cellHeight >= minWindowHeight) break;
    cols -= 1;
    rows = Math.ceil(concurrency / cols);
  }

  const rawWidth = Math.floor((usableWidth - gap * (cols - 1)) / cols);
  const rawHeight = Math.floor((usableHeight - gap * (rows - 1)) / rows);
  const finalWidth = Math.max(320, Math.min(usableWidth, rawWidth));
  const finalHeight = Math.max(240, Math.min(usableHeight, rawHeight));
  const maxX = Math.max(margin, screen.width - finalWidth - margin);
  const maxY = Math.max(topInset, screen.height - bottomInset - finalHeight);

  const slots = [];
  for (let index = 0; index < concurrency; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const rawX = margin + col * (finalWidth + gap);
    const rawY = topInset + row * (finalHeight + gap);
    slots.push({
      row,
      col,
      cols,
      rows,
      x: Math.min(rawX, maxX),
      y: Math.min(rawY, maxY),
      width: finalWidth,
      height: finalHeight,
      layout: `uniform-grid-${cols}x${rows}`,
    });
  }
  return slots;
}

function computeGridWindowBounds(workerId, concurrency) {
  const screen = getScreenSize();
  const { profile } = getWindowLayoutRuntime();
  const slotIndex = Math.max(0, workerId - 1);
  const slots = buildUniformGridWindowSlots(concurrency, screen, profile);
  const slot = slots[Math.min(slotIndex, Math.max(0, slots.length - 1))] || slots[0];
  return {
    screen,
    row: slot.row,
    col: slot.col,
    cols: slot.cols,
    rows: slot.rows,
    x: slot.x,
    y: slot.y,
    width: slot.width,
    height: slot.height,
    layout: slot.layout,
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function parseAccount(line) {
  if (line.includes('----')) {
    const [email, password] = line.split('----');
    return { email: email.trim(), password: password.trim(), raw: line };
  }
  const firstColon = line.indexOf(':');
  if (firstColon > 0) {
    const email = line.slice(0, firstColon).trim();
    const password = line.slice(firstColon + 1).trim();
    return { email, password, raw: line };
  }
  throw new Error(`无法解析账号格式: ${line}`);
}

function parseProxy(line) {
  const cleanLine = line.split(' | ')[0].trim();
  const parts = cleanLine.split(':');
  if (parts.length < 4) throw new Error(`无法解析代理格式: ${line}`);
  const host = parts[0].trim();
  const port = parts[1].trim();
  const username = parts[2].trim();
  const password = parts.slice(3).join(':').trim();
  return { host, port, username, password, server: `http://${host}:${port}`, raw: cleanLine };
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

function formatBooleanLabel(value) {
  return value ? '是' : '否';
}

function buildBasicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function getProxyPrecheckConfig(config = {}) {
  const url = String(config.proxyPrecheckUrl || 'https://www.google.com/').trim();
  const method = String(config.proxyPrecheckMethod || 'GET').trim().toUpperCase();
  const okMinStatus = Number(config.proxyPrecheckOkMinStatus || 200);
  const okMaxStatus = Number(config.proxyPrecheckOkMaxStatus || 399);
  const timeoutMs = Number(config.proxyConnectivityTimeoutMs || 15000);
  const exitIpUrl = String(config.proxyExitIpUrl || 'https://api.ipify.org?format=json').trim();
  const exitIpMethod = String(config.proxyExitIpMethod || 'GET').trim().toUpperCase();
  const secondaryUrl = String(config.proxyPrecheckSecondaryUrl || 'https://www.capcut.com/').trim();
  const secondaryMethod = String(config.proxyPrecheckSecondaryMethod || 'GET').trim().toUpperCase();
  const secondaryOkMinStatus = Number(config.proxyPrecheckSecondaryOkMinStatus || 200);
  const secondaryOkMaxStatus = Number(config.proxyPrecheckSecondaryOkMaxStatus || 399);
  return { url, method, okMinStatus, okMaxStatus, timeoutMs, exitIpUrl, exitIpMethod, secondaryUrl, secondaryMethod, secondaryOkMinStatus, secondaryOkMaxStatus };
}

function extractIpFromResponseBody(body) {
  const text = String(body || '').trim();
  if (!text) return '';
  const jsonMatch = text.match(/"ip"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) return jsonMatch[1].trim();
  const plainIpMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return plainIpMatch ? plainIpMatch[0].trim() : '';
}

function extractProxyCountryCode(proxy) {
  const raw = String(proxy?.raw || '');
  const match = raw.match(/-cc-([A-Za-z]{2})-sessid-/i);
  return match ? match[1].toUpperCase() : '';
}

function getCountryNameZh(countryCode) {
  const map = {
    US: '美国',
    GB: '英国',
    UK: '英国',
    CA: '加拿大',
    AU: '澳大利亚',
    NZ: '新西兰',
    SG: '新加坡',
    HK: '中国香港',
    TW: '中国台湾',
    JP: '日本',
    KR: '韩国',
    DE: '德国',
    FR: '法国',
    IT: '意大利',
    ES: '西班牙',
    NL: '荷兰',
    SE: '瑞典',
    NO: '挪威',
    DK: '丹麦',
    FI: '芬兰',
    CH: '瑞士',
    AT: '奥地利',
    BE: '比利时',
    IE: '爱尔兰',
    PT: '葡萄牙',
    PL: '波兰',
    CZ: '捷克',
    HU: '匈牙利',
    RO: '罗马尼亚',
    BG: '保加利亚',
    GR: '希腊',
    TR: '土耳其',
    RU: '俄罗斯',
    UA: '乌克兰',
    BR: '巴西',
    MX: '墨西哥',
    AR: '阿根廷',
    CL: '智利',
    CO: '哥伦比亚',
    PE: '秘鲁',
    IN: '印度',
    ID: '印度尼西亚',
    MY: '马来西亚',
    TH: '泰国',
    VN: '越南',
    PH: '菲律宾',
    AE: '阿联酋',
    SA: '沙特',
    ZA: '南非',
    EG: '埃及',
    NG: '尼日利亚'
  };
  const code = String(countryCode || '').trim().toUpperCase();
  return map[code] || '未知国家';
}

function normalizeCookieSessionValue(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return '';
  const match = raw.match(/^[^=]+=([^\s]+)$/);
  return match ? match[1].trim() : raw;
}

function extractSessionName(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return '';
  const match = raw.match(/^([^=]+)=/);
  return match ? match[1].trim() : '';
}

function buildSessionFormats(proxy, sessionId) {
  const countryCode = extractProxyCountryCode(proxy);
  const countryNameZh = getCountryNameZh(countryCode);
  const cookieSessionValue = normalizeCookieSessionValue(sessionId);
  const sessionIdPlain = cookieSessionValue;
  const sessionIdWithCountry = countryCode && sessionIdPlain ? `${countryCode}-${countryNameZh}-${sessionIdPlain}` : sessionIdPlain;
  return { countryCode, countryNameZh, cookieSessionValue, sessionIdPlain, sessionIdWithCountry };
}

function getProxyPenaltyConfig(config = {}) {
  const hardProxyFailureReasons = Array.isArray(config.hardProxyFailureReasons) ? config.hardProxyFailureReasons.map(item => String(item || '').trim()).filter(Boolean) : ['DREAMINA_WHITE_SCREEN', 'DREAMINA_FIRST_LOAD_DEAD_PAGE', 'DREAMINA_BIRTHDAY_STAGE_UNREACHABLE'];
  const businessFailureReasons = Array.isArray(config.businessFailureReasons) ? config.businessFailureReasons.map(item => String(item || '').trim()).filter(Boolean) : ['ACCOUNT_ALREADY_EXISTS', 'WRONG_VERIFICATION_CODE', 'SIGNUP_REJECTED'];
  return {
    hardProxyFailureReasons,
    businessFailureReasons,
    proxyFailureDowngradeThreshold: Math.max(1, Number(config.proxyFailureDowngradeThreshold || 2)),
    noIdleProxyRetryWaitMs: Math.max(0, Number(config.noIdleProxyRetryWaitMs || 2000)),
  };
}

function matchesFailureReason(reason, configuredReasons = []) {
  const text = String(reason || '').trim();
  return configuredReasons.some(item => {
    const normalized = String(item || '').trim();
    if (!normalized) return false;
    return text === normalized || text.startsWith(normalized);
  });
}

function isHardProxyFailureReason(reason, config = {}) {
  return matchesFailureReason(reason, getProxyPenaltyConfig(config).hardProxyFailureReasons);
}

function isBusinessFailureReason(reason, config = {}) {
  return matchesFailureReason(reason, getProxyPenaltyConfig(config).businessFailureReasons);
}

function normalizeFailureReason(reason = '') {
  const raw = String(reason || '').trim();
  if (!raw) return { raw: '', code: '', detail: '' };
  const [code, ...rest] = raw.split('|');
  return { raw, code: String(code || '').trim(), detail: rest.join('|').trim() };
}

function classifyFailureReason(reason, config = {}) {
  const normalized = normalizeFailureReason(reason);
  const text = normalized.code;
  if (text === 'ACCOUNT_ALREADY_EXISTS') return 'ACCOUNT_EXISTS';
  if (text.startsWith('WRONG_VERIFICATION_CODE')) return 'WRONG_CODE';
  if (text === 'SIGNUP_REJECTED' || text === 'SIGNUP_REJECTED_IP_BANNED') return 'SIGNUP_REJECTED';
  if (text === 'VERIFICATION_CODE_RATE_LIMITED') return 'VERIFICATION_CODE_RATE_LIMITED';
  if (text.startsWith('PROXY_PRECHECK_FAILED')) return 'PRECHECK_FAIL';
  if (isHardProxyFailureReason(text, config)) return 'HARD_PROXY';
  return 'GENERAL_FAIL';
}

function inferFailurePhase(reason = '') {
  const text = normalizeFailureReason(reason).code;
  if (!text) return 'unknown';
  if (text.startsWith('PROXY_PRECHECK_FAILED') || text.startsWith('PRECHECK_') || text.startsWith('PROXY_CONNECT_') || text.startsWith('HTTP_')) return 'precheck_connectivity';
  if (text === 'DREAMINA_WHITE_SCREEN' || text === 'DREAMINA_FIRST_LOAD_DEAD_PAGE' || text.startsWith('DREAMINA_OPEN_')) return 'register_open_dreamina';
  if (text.startsWith('WRONG_VERIFICATION_CODE') || text === 'VERIFICATION_CODE_RATE_LIMITED') return 'verification_code';
  if (text === 'ACCOUNT_ALREADY_EXISTS' || text === 'SIGNUP_REJECTED' || text === 'SIGNUP_REJECTED_IP_BANNED') return 'signup_result';
  if (text === 'DREAMINA_POST_REGISTER_READY_NOT_FOUND' || text === 'DREAMINA_BIRTHDAY_STAGE_UNREACHABLE') return 'post_register';
  return 'general';
}

function requestViaHttpProxy(proxy, url, method, timeoutMs) {
  const targetUrl = new URL(url);
  const targetLabel = `${method} ${targetUrl.toString()}`;
  const proxyAuth = buildBasicAuthHeader(proxy.username, proxy.password);
  return new Promise((resolve) => {
    const connectReq = http.request({ host: proxy.host, port: Number(proxy.port), method: 'CONNECT', path: `${targetUrl.hostname}:${targetUrl.port || 443}`, headers: { Host: `${targetUrl.hostname}:${targetUrl.port || 443}`, 'Proxy-Authorization': proxyAuth } });
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`)));
    connectReq.on('connect', (res, socket) => {
      if ((res.statusCode || 0) !== 200) {
        socket.destroy();
        finish({ success: false, reason: `PROXY_CONNECT_HTTP_${res.statusCode || 'NA'}`, status: res.statusCode || null, finalUrl: targetUrl.toString(), target: targetLabel, body: '' });
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: targetUrl.hostname, rejectUnauthorized: false }, () => {
        const req = https.request({ host: targetUrl.hostname, port: Number(targetUrl.port || 443), path: `${targetUrl.pathname || '/'}${targetUrl.search || ''}`, method, createConnection: () => tlsSocket, agent: false, headers: { Host: targetUrl.host, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36', Accept: '*/*', Connection: 'close' } }, (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { raw += chunk; });
          response.on('end', () => {
            tlsSocket.end();
            finish({ success: true, reason: 'OK', status: response.statusCode || 0, finalUrl: targetUrl.toString(), target: targetLabel, body: raw });
          });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`)));
        req.on('error', (error) => {
          tlsSocket.destroy();
          finish({ success: false, reason: error.message || 'HTTPS_REQUEST_ERROR', status: null, finalUrl: targetUrl.toString(), target: targetLabel, body: '' });
        });
        req.end();
      });
      tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`)));
      tlsSocket.on('error', (error) => finish({ success: false, reason: error.message || 'TLS_CONNECT_ERROR', status: null, finalUrl: targetUrl.toString(), target: targetLabel, body: '' }));
    });
    connectReq.on('error', (error) => finish({ success: false, reason: error.message || 'PROXY_CONNECT_ERROR', status: null, finalUrl: targetUrl.toString(), target: targetLabel, body: '' }));
    connectReq.end();
  });
}

async function fetchProxyExitIp(proxy, config = {}) {
  const target = getProxyPrecheckConfig(config);
  const response = await requestViaHttpProxy(proxy, target.exitIpUrl, target.exitIpMethod, target.timeoutMs);
  const ip = response.success ? extractIpFromResponseBody(response.body) : '';
  return { success: Boolean(response.success && ip), ip, response, reason: response.success ? (ip ? 'OK' : 'EXIT_IP_PARSE_FAILED') : response.reason };
}

async function checkConnectivityTarget(proxy, url, method, okMinStatus, okMaxStatus, timeoutMs) {
  const response = await requestViaHttpProxy(proxy, url, method, timeoutMs);
  const ok = Boolean(response.success && response.status >= okMinStatus && response.status <= okMaxStatus);
  return { success: ok, response, reason: ok ? 'OK' : (response.success ? `HTTP_${response.status}` : response.reason) };
}

async function precheckProxy(proxy, config = {}) {
  const target = getProxyPrecheckConfig(config);
  const primary = await checkConnectivityTarget(proxy, target.url, target.method, target.okMinStatus, target.okMaxStatus, target.timeoutMs);
  const secondary = await checkConnectivityTarget(proxy, target.secondaryUrl, target.secondaryMethod, target.secondaryOkMinStatus, target.secondaryOkMaxStatus, target.timeoutMs);
  const exitIp = await fetchProxyExitIp(proxy, config);
  const primarySuccess = primary.success;
  const secondarySuccess = secondary.success;
  const overallSuccess = primarySuccess && secondarySuccess;
  return {
    success: overallSuccess,
    level: overallSuccess ? 'OK' : ((primarySuccess || secondarySuccess || exitIp.success) ? 'WEAK' : 'BAD'),
    reason: overallSuccess ? 'OK' : `PRIMARY=${primary.reason};SECONDARY=${secondary.reason}`,
    status: secondary.response.status || primary.response.status,
    finalUrl: secondary.response.finalUrl || primary.response.finalUrl,
    title: '',
    target: `${primary.response.target} + ${secondary.response.target}`,
    primary,
    secondary,
    exitIp,
  };
}

function buildRunSummary({ config, allAccounts, accounts, proxies, proxySourcePath, requestedConcurrency, concurrency, doneAccountRawSet, resultsDir, allowedProxySpeedTiers, proxyPenaltyConfig }) {
  const estimatedMailWaitSeconds = Math.round((Number(config.firstmailApiMaxPollAttempts || config.waitMailAttempts || 0) * Number(config.waitMailIntervalMs || 0)) / 1000);
  const proxyPrecheck = getProxyPrecheckConfig(config);
  const runMode = resolveRunMode(config);
  const actualSlowMo = resolveSlowMo(config);
  const pauseRange = resolveHumanPauseRange(config);
  const screenshotEnabled = shouldCaptureScreenshots(config);
  const layoutSummary = getWindowLayoutRuntime().summary;
  return [
    '=== 本次运行摘要 ===',
    `账号文件：${accountsPath}`,
    `代理文件：${proxySourcePath}`,
    `结果目录：${resultsDir}`,
    `账号总数：${allAccounts.length}`,
    `待跑账号数：${accounts.length}`,
    `已跳过成功账号数：${doneAccountRawSet.size}`,
    `可用代理数：${proxies.length}`,
    `运行模式：${runMode}`,
    `截图开关：${formatBooleanLabel(screenshotEnabled)}`,
    `实际 SlowMo：${actualSlowMo}ms`,
    `实际 HumanPause：${pauseRange.min}-${pauseRange.max}ms`,
    `允许代理速度档：${allowedProxySpeedTiers.join(', ')}`,
    `代理策略：${config.proxyPolicy}`,
    `请求并发数：${requestedConcurrency}`,
    `实际并发数：${concurrency}`,
    `浏览器可见：${formatBooleanLabel(!Boolean(config.headless))}`,
    `每账号最大代理重试：${Number(config.maxProxyRetriesPerAccount || 0)} 次`,
    `代理降级阈值：${proxyPenaltyConfig.proxyFailureDowngradeThreshold} 次`,
    `空闲代理重试等待：${proxyPenaltyConfig.noIdleProxyRetryWaitMs}ms`,
    `窗口布局：${layoutSummary.mode} | gap=${layoutSummary.gap} | margin=${layoutSummary.margin} | min=${layoutSummary.minWindowWidth}x${layoutSummary.minWindowHeight}`,
    `代理预检主目标：${proxyPrecheck.method} ${proxyPrecheck.url} | 通过状态=${proxyPrecheck.okMinStatus}-${proxyPrecheck.okMaxStatus} | timeout=${proxyPrecheck.timeoutMs}ms`,
    `代理预检副目标：${proxyPrecheck.secondaryMethod} ${proxyPrecheck.secondaryUrl} | 通过状态=${proxyPrecheck.secondaryOkMinStatus}-${proxyPrecheck.secondaryOkMaxStatus}`,
    `出口IP获取：${proxyPrecheck.exitIpMethod} ${proxyPrecheck.exitIpUrl}`,
    `验证码最大等待：约 ${estimatedMailWaitSeconds} 秒（${Number(config.firstmailApiMaxPollAttempts || config.waitMailAttempts || 0)} 次 × ${Number(config.waitMailIntervalMs || 0)}ms）`,
    `Dreamina 恢复上限：${Number(config.dreaminaMaxRecoveries || 0)} 次`,
    `恢复后顺延等待：${Number(config.dreaminaRecoveryBonusMs || 0)}ms`,
    `断点续跑：${doneAccountRawSet.size ? '开启（将自动跳过已成功账号）' : '未检测到已成功账号记录'}`,
    '====================',
  ];
}

function removeProxyFromList(filePath, targetRaw) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const nextLines = lines.filter(line => line.trim() !== targetRaw.trim());
  fs.writeFileSync(filePath, nextLines.join('\n'), 'utf8');
}

(async () => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const allAccounts = readLines(accountsPath).map(parseAccount);
  const resultsDir = path.join(baseDir, config.resultsDir || 'results');
  ensureDir(resultsDir);
  const doneAccountsFile = path.join(resultsDir, 'accounts-done.txt');
  const doneAccountRawSet = new Set(readLines(doneAccountsFile));
  const verificationRateLimitedFile = path.join(resultsDir, 'verification-rate-limited.txt');
  const verificationRateLimitedAccounts = new Set(readLines(verificationRateLimitedFile).map(line => line.split(' | ')[0].trim()));
  const accounts = allAccounts.filter(account => !doneAccountRawSet.has(account.raw) && !verificationRateLimitedAccounts.has(`${account.email}:${account.password}`));
  const rawProxySourcePath = fs.existsSync(healthyProxyPath) ? healthyProxyPath : proxiesPath;
  const rawProxyLines = readLines(rawProxySourcePath);
  const filteredProxyLines = rawProxySourcePath === healthyProxyPath ? filterProxyLinesBySpeed(rawProxyLines, config) : rawProxyLines;
  const proxies = filteredProxyLines.map(parseProxy);
  const allowedProxySpeedTiers = resolveAllowedProxySpeedTiers(config);
  const proxyPenaltyConfig = getProxyPenaltyConfig(config);
  const proxySourcePath = rawProxySourcePath;

  const successFile = path.join(resultsDir, 'success.txt');
  const failedFile = path.join(resultsDir, 'failed.txt');
  const alreadyExistsFile = path.join(resultsDir, 'already-exists.txt');
  const wrongCodeFile = path.join(resultsDir, 'wrong-code.txt');
  const signupRejectedFile = path.join(resultsDir, 'signup-rejected.txt');
  const verificationRateLimitedFileOutput = path.join(resultsDir, 'verification-rate-limited.txt');
  const runLogFile = path.join(resultsDir, 'run-log.txt');
  const precheckFile = path.join(resultsDir, 'runner-precheck.txt');
  const sessionFile = path.join(resultsDir, 'sessions.txt');
  const sessionWithCountryFile = path.join(resultsDir, 'sessions-with-country.txt');
  const storageFile = path.join(resultsDir, 'storage-paths.txt');
  const failureEventsFile = path.join(resultsDir, 'failure-events.jsonl');

  const state = { roundRobinIndex: 0, accountCursor: 0 };
  const proxyFailureMap = new Map();
  const proxyInUseSet = new Set();
  const withStateLock = createMutex();
  const withFileLock = createMutex();
  const requestedConcurrency = Number(config.concurrency || 1);
  const limitedByAccounts = Math.max(1, Math.min(requestedConcurrency, accounts.length || 1));
  const concurrency = Math.max(1, Math.min(limitedByAccounts, proxies.length || 1));

  const runSummaryLines = buildRunSummary({ config, allAccounts, accounts, proxies, proxySourcePath, requestedConcurrency, concurrency, doneAccountRawSet, resultsDir, allowedProxySpeedTiers, proxyPenaltyConfig });
  appendLine(runLogFile, `=== RUN START ${new Date().toISOString()} ===`);
  appendLine(runLogFile, `accounts_total=${allAccounts.length}, accounts_pending=${accounts.length}, raw_proxies=${rawProxyLines.length}, filtered_proxies=${proxies.length}, policy=${config.proxyPolicy}, source=${proxySourcePath}, concurrency=${concurrency}, requestedConcurrency=${requestedConcurrency}, runMode=${resolveRunMode(config)}, actualSlowMo=${resolveSlowMo(config)}, screenshots=${shouldCaptureScreenshots(config)}, allowedProxySpeedTiers=${allowedProxySpeedTiers.join(',')}`);
  for (const line of runSummaryLines) appendLine(runLogFile, line);
  for (const line of runSummaryLines) logSystem(line);
  if (rawProxySourcePath === healthyProxyPath) logInfo(`代理速度档过滤：源=${rawProxyLines.length} 条 -> 命中允许档位 ${allowedProxySpeedTiers.join(', ')} 后剩余 ${proxies.length} 条`);
  if (concurrency < requestedConcurrency) logWarn(`并发数已自动收缩到 ${concurrency}，避免超过待跑账号数或可用代理数`);
  if (!proxies.length) {
    logFail(`当前模式 ${resolveRunMode(config)} 下没有命中允许速度档位 ${allowedProxySpeedTiers.join(', ')} 的代理，请先重新预检或放宽档位`);
    appendLine(runLogFile, `[FATAL] no proxies after speed-tier filter | source=${proxySourcePath} | allowed=${allowedProxySpeedTiers.join(',')}`);
    return;
  }

  for (const account of allAccounts) {
    if (doneAccountRawSet.has(account.raw)) {
      appendLine(runLogFile, `[SKIP_ACCOUNT] ${account.email} already_done=true`);
      logInfo(`跳过已成功账号：${account.email}`);
      continue;
    }
    if (verificationRateLimitedAccounts.has(`${account.email}:${account.password}`)) {
      appendLine(runLogFile, `[SKIP_ACCOUNT] ${account.email} verification_rate_limited=true`);
      logInfo(`跳过验证码发送次数受限账号：${account.email}`);
    }
  }

  async function appendLineSafe(filePath, line) {
    await withFileLock(async () => appendLine(filePath, line));
  }

  async function removeProxyFromListSafe(filePath, targetRaw) {
    await withFileLock(async () => removeProxyFromList(filePath, targetRaw));
  }

  async function appendFailureEventSafe(event) {
    await withFileLock(async () => appendLine(failureEventsFile, JSON.stringify(event)));
  }

  async function acquireNextAccount() {
    return withStateLock(async () => {
      if (state.accountCursor >= accounts.length) return null;
      const account = accounts[state.accountCursor];
      state.accountCursor += 1;
      return account;
    });
  }

  async function acquireProxy(workerId) {
    return withStateLock(async () => {
      if (!proxies.length) throw new Error('代理列表为空');
      const availableIndexes = [];
      for (let i = 0; i < proxies.length; i++) if (!proxyInUseSet.has(proxies[i].raw)) availableIndexes.push(i);
      if (!availableIndexes.length) return null;
      let index;
      if (config.proxyPolicy === 'random') index = availableIndexes[Math.floor(Math.random() * availableIndexes.length)];
      else {
        const sortedIndexes = availableIndexes.sort((a, b) => a - b);
        index = sortedIndexes[state.roundRobinIndex % sortedIndexes.length];
        state.roundRobinIndex += 1;
      }
      const proxy = proxies[index];
      proxyInUseSet.add(proxy.raw);
      return { proxy, index, workerId };
    });
  }

  async function releaseProxy(proxyRaw) {
    await withStateLock(async () => { proxyInUseSet.delete(proxyRaw); });
  }

  async function updateProxyFailure(proxyRaw, updater) {
    return withStateLock(async () => {
      const current = proxyFailureMap.get(proxyRaw) || 0;
      const next = updater(current);
      proxyFailureMap.set(proxyRaw, next);
      return next;
    });
  }

  async function processAccount(account, workerId) {
    let success = false;
    let lastReason = 'UNKNOWN';
    let lastPhase = 'unknown';
    const windowBounds = computeGridWindowBounds(workerId, concurrency);
    await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} START worker=${workerId} window=${windowBounds.width}x${windowBounds.height}@${windowBounds.x},${windowBounds.y}`);
    logAccount(`[线程${workerId}] 开始处理账号：${account.email}`);
    logInfo(`[线程${workerId}] 窗口布局：${windowBounds.width}x${windowBounds.height} @ (${windowBounds.x}, ${windowBounds.y}) | 网格=${windowBounds.cols}x${windowBounds.rows} | 分档=${windowBounds.layout}`);

    for (let attempt = 1; attempt <= config.maxProxyRetriesPerAccount; attempt++) {
      const acquired = await acquireProxy(workerId);
      if (!acquired) {
        lastReason = 'NO_IDLE_PROXY_AVAILABLE';
        logWarn(`[线程${workerId}] 当前没有空闲代理，等待其他线程释放后重试`);
        await appendLineSafe(runLogFile, `[WAIT_PROXY] account=${account.email} worker=${workerId} reason=${lastReason} waitMs=${proxyPenaltyConfig.noIdleProxyRetryWaitMs}`);
        await new Promise(resolve => setTimeout(resolve, proxyPenaltyConfig.noIdleProxyRetryWaitMs));
        attempt -= 1;
        continue;
      }

      const { proxy, index } = acquired;
      try {
        await appendLineSafe(runLogFile, `[TRY] account=${account.email} attempt=${attempt} worker=${workerId} proxyIndex=${index} proxy=${proxy.server}`);
        logProxy(`[线程${workerId}] 第 ${attempt} 次尝试，选中代理：${proxy.server}（索引 ${index}）`);
        logProxy(`当前账号：${account.email}`);

        const precheck = await precheckProxy(proxy, config);
        const exitIpText = precheck.exitIp.ip || precheck.exitIp.reason;
        logProxy(`代理出口 IP：${exitIpText}`);
        await appendLineSafe(precheckFile, `[EXIT_IP] proxy=${proxy.server} | exitIp=${exitIpText} | exitIpReason=${precheck.exitIp.reason} | account=${account.email} | worker=${workerId}`);
        const precheckTarget = getProxyPrecheckConfig(config);
        logProxy(`正在预检代理（主=${precheckTarget.method} ${precheckTarget.url} | 副=${precheckTarget.secondaryMethod} ${precheckTarget.secondaryUrl}）：${proxy.server}`);
        await appendLineSafe(precheckFile, `[PRECHECK] proxy=${proxy.server} -> ${precheck.level} | ${precheck.reason} | primary=${precheck.primary.response.target} | primaryReason=${precheck.primary.reason} | primaryStatus=${precheck.primary.response.status || 'NA'} | secondary=${precheck.secondary.response.target} | secondaryReason=${precheck.secondary.reason} | secondaryStatus=${precheck.secondary.response.status || 'NA'} | account=${account.email} | worker=${workerId}`);

        if (precheck.level === 'OK') logSuccess(`代理预检通过：${proxy.server} | 出口IP：${exitIpText} | 主=${precheck.primary.response.target} | 副=${precheck.secondary.response.target}`);
        else if (precheck.level === 'WEAK') {
          logWarn(`代理预检为 WEAK：${proxy.server} | 出口IP：${exitIpText} | 原因：${precheck.reason}`);
          logInfo(`预检落点：primary=${precheck.primary.reason} | secondary=${precheck.secondary.reason}`);
        } else {
          logFail(`代理预检失败：${proxy.server} | 出口IP：${exitIpText} | 原因：${precheck.reason}`);
          logInfo(`预检落点：primary=${precheck.primary.reason} | secondary=${precheck.secondary.reason}`);
        }

        if (precheck.level === 'BAD') {
          lastReason = `PROXY_PRECHECK_FAILED:${precheck.reason}`;
          lastPhase = 'precheck_connectivity';
          await appendFailureEventSafe({ time: new Date().toISOString(), account: account.email, proxy: proxy.server, proxyRaw: proxy.raw, workerId, phase: lastPhase, precheckLevel: precheck.level, proxySpeedTier: precheck.speedTier || 'UNKNOWN', failureKind: 'PRECHECK_FAIL', reason: lastReason });
          await appendLineSafe(runLogFile, `[SKIP] account=${account.email} proxy=${proxy.server} worker=${workerId} level=${precheck.level} reason=${lastReason}`);
          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= proxyPenaltyConfig.proxyFailureDowngradeThreshold) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，打入坏代理池：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
          continue;
        }

        try {
          logStage(`真实注册流程开始 | 账号=${account.email} | 代理=${proxy.server} | 出口IP=${exitIpText} | 浏览器模式=有头 | 工作线程=${workerId} | 验证码来源=Firstmail API | 预检等级=${precheck.level} | 代理速度档=${precheck.speedTier || 'UNKNOWN'}`);
          logAccount(`[线程${workerId}] 已进入真实注册流程：${account.email} | precheck=${precheck.level} | proxySpeedTier=${precheck.speedTier || 'UNKNOWN'}`);
          const result = await runRegisterTask({ account, proxy, config, attempt, workerId, windowBounds, resolvedExitIp: exitIpText, precheckLevel: precheck.level, proxySpeedTier: precheck.speedTier || 'UNKNOWN' });

          if (result.success) {
            const timingText = result.timings ? Object.entries(result.timings).map(([key, value]) => `${key}=${Number(value || 0)}ms`).join(' | ') : '';
            const sessionFormats = buildSessionFormats(proxy, result.sessionId || '');
            const sessionName = extractSessionName(result.sessionId || '');
            const accountSessionId = sessionFormats.cookieSessionValue || normalizeCookieSessionValue(result.sessionId || '');
            const accountSessionIdWithCountry = sessionFormats.countryCode && accountSessionId
              ? `${account.email}----${sessionFormats.countryCode}----${sessionFormats.countryNameZh}----${accountSessionId}`
              : (accountSessionId ? `${account.email}----UNKNOWN----未知国家----${accountSessionId}` : '');
            await appendLineSafe(successFile, `${account.email}:${account.password} | proxy=${proxy.raw} | status=success | worker=${workerId} | precheck=${precheck.level}`);
            await appendLineSafe(doneAccountsFile, account.raw);
            await appendLineSafe(storageFile, `${account.email} | storage=${result.storagePath || ''}`);
            if (accountSessionId) await appendLineSafe(sessionFile, accountSessionId);
            if (accountSessionIdWithCountry) await appendLineSafe(sessionWithCountryFile, accountSessionIdWithCountry);
            await appendLineSafe(runLogFile, `[SUCCESS] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} proxySpeedTier=${precheck.speedTier || 'UNKNOWN'} storage=${result.storagePath || ''} session_name=${sessionName || ''} sessionid=${accountSessionId || ''} sessionid_with_country=${accountSessionIdWithCountry || ''}${timingText ? ` | timings=${timingText}` : ''}`);
            logSuccess(`账号注册成功：${account.email}`);
            logInfo(`登录态文件：${result.storagePath || ''}`);
            logInfo(`Session字段：${sessionName || ''}`);
            logInfo(`SessionID：${accountSessionId || ''}`);
            logInfo(`国家+SessionID：${accountSessionIdWithCountry || ''}`);
            await updateProxyFailure(proxy.raw, () => 0);
            success = true;
            break;
          }

          lastReason = result.reason || 'UNKNOWN_FAIL';
          const failureKind = classifyFailureReason(lastReason, config);
          lastPhase = inferFailurePhase(lastReason);
          await appendFailureEventSafe({ time: new Date().toISOString(), account: account.email, proxy: proxy.server, proxyRaw: proxy.raw, workerId, phase: lastPhase, precheckLevel: precheck.level, proxySpeedTier: precheck.speedTier || 'UNKNOWN', failureKind, reason: lastReason });
          const failureTimingText = result.timings ? Object.entries(result.timings).map(([key, value]) => `${key}=${Number(value || 0)}ms`).join(' | ') : '';
          await appendLineSafe(runLogFile, `[FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} proxySpeedTier=${precheck.speedTier || 'UNKNOWN'} failureKind=${failureKind} stageSummary=打开Dreamina/填写邮箱密码并提交/FirstmailAPI拉验证码/回填验证码和生日/保存登录态 reason=${lastReason}${failureTimingText ? ` | timings=${failureTimingText}` : ''}`);
          logFail(`真实注册流程失败：${account.email} | 原因：${lastReason}`);
          if (result.timings) {
            logInfo(`阶段耗时：${Object.entries(result.timings).map(([key, value]) => `${key}=${Number(value || 0)}ms`).join(' | ')}`);
          }

          if (failureKind === 'ACCOUNT_EXISTS') {
            await appendLineSafe(alreadyExistsFile, `${account.email}:${account.password} | status=exists | worker=${workerId} | proxy=${proxy.raw}`);
            break;
          }
          if (failureKind === 'WRONG_CODE') {
            await appendLineSafe(wrongCodeFile, `${account.email}:${account.password} | status=wrong_code | worker=${workerId} | proxy=${proxy.raw} | reason=${lastReason}`);
            break;
          }
          if (failureKind === 'SIGNUP_REJECTED') {
            await appendLineSafe(signupRejectedFile, `${account.email}:${account.password} | status=signup_rejected | worker=${workerId} | proxy=${proxy.raw} | reason=${lastReason}`);
            break;
          }
          if (failureKind === 'VERIFICATION_CODE_RATE_LIMITED') {
            await appendLineSafe(verificationRateLimitedFileOutput, `${account.email}:${account.password} | status=verification_code_rate_limited | worker=${workerId} | proxy=${proxy.raw} | reason=${lastReason}`);
            await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_VERIFICATION_CODE_RATE_LIMITED reason=${lastReason}`);
            break;
          }
          if (lastReason === 'SIGNUP_REJECTED_IP_BANNED') {
            await appendLineSafe(signupRejectedFile, `${account.email}:${account.password} | status=signup_rejected_ip_banned | worker=${workerId} | proxy=${proxy.raw} | reason=${lastReason}`);
            await appendLineSafe(runLogFile, `[IP_BANNED] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} reason=${lastReason}`);
            logWarn(`命中 IP/代理被拉黑信号，立即剔除当前代理：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | ip-banned by runner | reason=${lastReason}`);
            await updateProxyFailure(proxy.raw, () => Number(config.maxProxyRetriesPerAccount || 3));
            continue;
          }
          if (isHardProxyFailureReason(lastReason, config)) {
            await appendLineSafe(runLogFile, `[HARD_PROXY_FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} reason=${lastReason}`);
            logWarn(`命中代理强失败，立即剔除当前代理：${proxy.server} | 原因=${lastReason}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | hard-failed by runner | reason=${lastReason}`);
            await updateProxyFailure(proxy.raw, () => Number(config.maxProxyRetriesPerAccount || 3));
            continue;
          }
          if (!isBusinessFailureReason(lastReason, config)) {
            const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
            if (currentFail >= proxyPenaltyConfig.proxyFailureDowngradeThreshold) {
              await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to weak/bad pool`);
              logWarn(`代理连续失败 ${currentFail} 次，降级处理：${proxy.server}`);
              await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
              const targetFile = precheck.level === 'WEAK' ? weakProxyPath : badProxyPath;
              await appendLineSafe(targetFile, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
            }
          } else {
            await appendLineSafe(runLogFile, `[BUSINESS_FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} reason=${lastReason} | skip_proxy_penalty=true`);
          }
        } catch (error) {
          lastReason = error.message || 'EXCEPTION';
          const failureKind = classifyFailureReason(lastReason, config);
          lastPhase = inferFailurePhase(lastReason);
          await appendFailureEventSafe({ time: new Date().toISOString(), account: account.email, proxy: proxy.server, proxyRaw: proxy.raw, workerId, phase: lastPhase, precheckLevel: precheck.level, proxySpeedTier: precheck.speedTier || 'UNKNOWN', failureKind, reason: lastReason });
          await appendLineSafe(runLogFile, `[ERROR] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} proxySpeedTier=${precheck.speedTier || 'UNKNOWN'} failureKind=${failureKind} stageSummary=打开Dreamina/填写邮箱密码并提交/FirstmailAPI拉验证码/回填验证码和生日/保存登录态 reason=${lastReason}`);
          logFail(`真实注册流程异常：账号=${account.email} | 原因=${lastReason}`);
          if (isHardProxyFailureReason(lastReason, config)) {
            await appendLineSafe(runLogFile, `[HARD_PROXY_FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} reason=${lastReason}`);
            logWarn(`命中代理强失败，立即剔除当前代理：${proxy.server} | 原因=${lastReason}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | hard-failed by runner | reason=${lastReason}`);
            await updateProxyFailure(proxy.raw, () => Number(config.maxProxyRetriesPerAccount || 3));
            continue;
          }
          if (!isBusinessFailureReason(lastReason, config)) {
            const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
            if (currentFail >= proxyPenaltyConfig.proxyFailureDowngradeThreshold) {
              await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to weak/bad pool`);
              logWarn(`代理连续失败 ${currentFail} 次，降级处理：${proxy.server}`);
              await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
              const targetFile = precheck.level === 'WEAK' ? weakProxyPath : badProxyPath;
              await appendLineSafe(targetFile, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
            }
          } else {
            await appendLineSafe(runLogFile, `[BUSINESS_FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} reason=${lastReason} | skip_proxy_penalty=true`);
            break;
          }
        }
      } finally {
        await releaseProxy(proxy.raw);
      }
    }

    if (!success) {
      const failureKind = classifyFailureReason(lastReason, config);
      if (failureKind === 'ACCOUNT_EXISTS') {
        logWarn(`账号已存在：${account.email}`);
        await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_EXISTS reason=${lastReason}`);
        return;
      }
      if (failureKind === 'WRONG_CODE') {
        logWarn(`验证码错误：${account.email}`);
        await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_WRONG_CODE reason=${lastReason}`);
        return;
      }
      if (failureKind === 'SIGNUP_REJECTED' || lastReason === 'SIGNUP_REJECTED_IP_BANNED') {
        logWarn(`注册被拒：${account.email}`);
        await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_SIGNUP_REJECTED reason=${lastReason}`);
        return;
      }
      if (failureKind === 'VERIFICATION_CODE_RATE_LIMITED') {
        logWarn(`验证码发送次数受限，后续跳过该账号：${account.email}`);
        await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_VERIFICATION_CODE_RATE_LIMITED reason=${lastReason}`);
        return;
      }
      await appendLineSafe(failedFile, `${account.email}:${account.password} | status=failed | phase=${lastPhase} | reason=${lastReason} | worker=${workerId}`);
      await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_FAIL stageSummary=打开Dreamina/填写邮箱密码并提交/FirstmailAPI拉验证码/回填验证码和生日/保存登录态 reason=${lastReason}`);
      logFail(`账号最终失败：${account.email} | 原因：${lastReason}`);
    }
  }

  async function workerLoop(workerId) {
    while (true) {
      const account = await acquireNextAccount();
      if (!account) return;
      await processAccount(account, workerId);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1)));
  appendLine(runLogFile, `=== RUN END ${new Date().toISOString()} ===`);
  logSystem('批量框架执行完成');
  logSystem(`结果目录：${resultsDir}`);
  logSystem(`当前代理来源：${proxySourcePath}`);
  logSystem(`自动跳过成功账号数：${allAccounts.length - accounts.length}`);
})();

