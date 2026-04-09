const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { runRegisterTask } = require('./task-register');
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

function buildTieredWindowSlots(concurrency, screen, config) {
  const margin = Number(config.windowMargin || 8);
  const gap = Number(config.windowGap || 12);
  const topInset = Number(config.windowTopInset || 8);
  const bottomInset = Number(config.windowBottomInset || 48);
  const usableWidth = Math.max(1, screen.width - margin * 2);
  const usableHeight = Math.max(1, screen.height - topInset - bottomInset);

  function makeGrid(cols, rows) {
    const cellWidth = Math.max(520, Math.floor((usableWidth - gap * (cols - 1)) / cols));
    const cellHeight = Math.max(520, Math.floor((usableHeight - gap * (rows - 1)) / rows));
    const slots = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        slots.push({
          row,
          col,
          cols,
          rows,
          x: margin + col * (cellWidth + gap),
          y: topInset + row * (cellHeight + gap),
          width: cellWidth,
          height: cellHeight,
          layout: `${cols}x${rows}`,
        });
      }
    }
    return slots;
  }

  if (concurrency <= 1) {
    return [{
      row: 0,
      col: 0,
      cols: 1,
      rows: 1,
      x: margin,
      y: topInset,
      width: Math.max(960, usableWidth),
      height: Math.max(720, usableHeight),
      layout: 'single',
    }];
  }

  if (concurrency === 2) {
    return makeGrid(2, 1).slice(0, 2).map(slot => ({ ...slot, layout: 'tier-2-horizontal' }));
  }

  if (concurrency === 3) {
    const topHeight = Math.max(420, Math.floor((usableHeight - gap) * 0.58));
    const bottomHeight = Math.max(320, usableHeight - topHeight - gap);
    const topWidth = Math.max(900, usableWidth);
    const bottomWidth = Math.max(520, Math.floor((usableWidth - gap) / 2));
    return [
      { row: 0, col: 0, cols: 1, rows: 2, x: margin, y: topInset, width: topWidth, height: topHeight, layout: 'tier-3-focus-top' },
      { row: 1, col: 0, cols: 2, rows: 2, x: margin, y: topInset + topHeight + gap, width: bottomWidth, height: bottomHeight, layout: 'tier-3-focus-bottom' },
      { row: 1, col: 1, cols: 2, rows: 2, x: margin + bottomWidth + gap, y: topInset + topHeight + gap, width: bottomWidth, height: bottomHeight, layout: 'tier-3-focus-bottom' },
    ];
  }

  if (concurrency === 4) {
    return makeGrid(2, 2).slice(0, 4).map(slot => ({ ...slot, layout: 'tier-4-balanced' }));
  }

  if (concurrency === 5) {
    const topHeight = Math.max(340, Math.floor((usableHeight - gap) * 0.52));
    const bottomHeight = Math.max(280, usableHeight - topHeight - gap);
    const topWidth = Math.max(520, Math.floor((usableWidth - gap * 2) / 3));
    const bottomWidth = Math.max(520, Math.floor((usableWidth - gap) / 2));
    return [
      { row: 0, col: 0, cols: 3, rows: 2, x: margin, y: topInset, width: topWidth, height: topHeight, layout: 'tier-5-top' },
      { row: 0, col: 1, cols: 3, rows: 2, x: margin + topWidth + gap, y: topInset, width: topWidth, height: topHeight, layout: 'tier-5-top' },
      { row: 0, col: 2, cols: 3, rows: 2, x: margin + (topWidth + gap) * 2, y: topInset, width: topWidth, height: topHeight, layout: 'tier-5-top' },
      { row: 1, col: 0, cols: 2, rows: 2, x: margin, y: topInset + topHeight + gap, width: bottomWidth, height: bottomHeight, layout: 'tier-5-bottom' },
      { row: 1, col: 1, cols: 2, rows: 2, x: margin + bottomWidth + gap, y: topInset + topHeight + gap, width: bottomWidth, height: bottomHeight, layout: 'tier-5-bottom' },
    ];
  }

  if (concurrency === 6) {
    return makeGrid(3, 2).slice(0, 6).map(slot => ({ ...slot, layout: 'tier-6-3x2' }));
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(concurrency)));
  const rows = Math.max(1, Math.ceil(concurrency / cols));
  return makeGrid(cols, rows).slice(0, concurrency).map(slot => ({ ...slot, layout: `fallback-${cols}x${rows}` }));
}

function computeGridWindowBounds(workerId, concurrency, config) {
  const screen = getScreenSize();
  const slotIndex = Math.max(0, workerId - 1);
  const slots = buildTieredWindowSlots(concurrency, screen, config);
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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
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
  if (parts.length < 4) {
    throw new Error(`无法解析代理格式: ${line}`);
  }

  const host = parts[0].trim();
  const port = parts[1].trim();
  const username = parts[2].trim();
  const password = parts.slice(3).join(':').trim();

  return {
    host,
    port,
    username,
    password,
    server: `http://${host}:${port}`,
    raw: cleanLine,
  };
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

function formatBooleanLabel(value) {
  return value ? '是' : '否';
}

function buildBasicAuthHeader(username, password) {
  const raw = `${username}:${password}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

function getProxyPrecheckConfig(config = {}) {
  const url = String(config.proxyPrecheckUrl || 'https://www.google.com/').trim();
  const method = String(config.proxyPrecheckMethod || 'GET').trim().toUpperCase();
  const okMinStatus = Number(config.proxyPrecheckOkMinStatus || 200);
  const okMaxStatus = Number(config.proxyPrecheckOkMaxStatus || 399);
  const timeoutMs = Number(config.proxyConnectivityTimeoutMs || 15000);
  const exitIpUrl = String(config.proxyExitIpUrl || 'https://api.ipify.org?format=json').trim();
  const exitIpMethod = String(config.proxyExitIpMethod || 'GET').trim().toUpperCase();
  return {
    url,
    method,
    okMinStatus,
    okMaxStatus,
    timeoutMs,
    exitIpUrl,
    exitIpMethod,
  };
}

function extractIpFromResponseBody(body) {
  const text = String(body || '').trim();
  if (!text) return '';

  const jsonMatch = text.match(/"ip"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) return jsonMatch[1].trim();

  const plainIpMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (plainIpMatch) return plainIpMatch[0].trim();

  return '';
}

function extractProxyCountryCode(proxy) {
  const raw = String(proxy?.raw || '');
  const match = raw.match(/-cc-([A-Za-z]{2})-sessid-/i);
  return match ? match[1].toUpperCase() : '';
}

function extractProxySessionSourceId(proxy) {
  const raw = String(proxy?.raw || '');
  const match = raw.match(/-sessid-([^:]+)/i);
  return match ? match[1] : '';
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
  const sourceSessionId = extractProxySessionSourceId(proxy);
  const cookieSessionValue = normalizeCookieSessionValue(sessionId);
  const sessionIdPlain = cookieSessionValue;
  const sessionIdWithCountry = countryCode && sessionIdPlain ? `${countryCode}-${sessionIdPlain}` : sessionIdPlain;
  return {
    countryCode,
    sourceSessionId,
    cookieSessionValue,
    sessionIdPlain,
    sessionIdWithCountry,
  };
}

function isHardProxyFailureReason(reason) {
  const text = String(reason || '').trim();
  return text === 'DREAMINA_WHITE_SCREEN' || text === 'DREAMINA_BIRTHDAY_STAGE_UNREACHABLE';
}

function requestViaHttpProxy(proxy, url, method, timeoutMs) {
  const targetUrl = new URL(url);
  const targetLabel = `${method} ${targetUrl.toString()}`;
  const proxyAuth = buildBasicAuthHeader(proxy.username, proxy.password);

  return new Promise((resolve) => {
    const connectReq = http.request({
      host: proxy.host,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        Host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        'Proxy-Authorization': proxyAuth,
      },
    });

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`));
    });

    connectReq.on('connect', (res, socket) => {
      if ((res.statusCode || 0) !== 200) {
        socket.destroy();
        finish({
          success: false,
          reason: `PROXY_CONNECT_HTTP_${res.statusCode || 'NA'}`,
          status: res.statusCode || null,
          finalUrl: targetUrl.toString(),
          target: targetLabel,
          body: '',
        });
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
        rejectUnauthorized: false,
      }, () => {
        const req = https.request({
          host: targetUrl.hostname,
          port: Number(targetUrl.port || 443),
          path: `${targetUrl.pathname || '/'}${targetUrl.search || ''}`,
          method,
          createConnection: () => tlsSocket,
          agent: false,
          headers: {
            Host: targetUrl.host,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            Accept: '*/*',
            Connection: 'close',
          },
        }, (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            raw += chunk;
          });
          response.on('end', () => {
            tlsSocket.end();
            finish({
              success: true,
              reason: 'OK',
              status: response.statusCode || 0,
              finalUrl: targetUrl.toString(),
              target: targetLabel,
              body: raw,
            });
          });
        });

        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`));
        });

        req.on('error', (error) => {
          tlsSocket.destroy();
          finish({
            success: false,
            reason: error.message || 'HTTPS_REQUEST_ERROR',
            status: null,
            finalUrl: targetUrl.toString(),
            target: targetLabel,
            body: '',
          });
        });

        req.end();
      });

      tlsSocket.setTimeout(timeoutMs, () => {
        tlsSocket.destroy(new Error(`PRECHECK_TIMEOUT_${timeoutMs}ms`));
      });

      tlsSocket.on('error', (error) => {
        finish({
          success: false,
          reason: error.message || 'TLS_CONNECT_ERROR',
          status: null,
          finalUrl: targetUrl.toString(),
          target: targetLabel,
          body: '',
        });
      });
    });

    connectReq.on('error', (error) => {
      finish({
        success: false,
        reason: error.message || 'PROXY_CONNECT_ERROR',
        status: null,
        finalUrl: targetUrl.toString(),
        target: targetLabel,
        body: '',
      });
    });

    connectReq.end();
  });
}

async function fetchProxyExitIp(proxy, config = {}) {
  const target = getProxyPrecheckConfig(config);
  const response = await requestViaHttpProxy(proxy, target.exitIpUrl, target.exitIpMethod, target.timeoutMs);
  const ip = response.success ? extractIpFromResponseBody(response.body) : '';
  return {
    success: Boolean(response.success && ip),
    ip,
    response,
    reason: response.success ? (ip ? 'OK' : 'EXIT_IP_PARSE_FAILED') : response.reason,
  };
}

async function precheckProxy(proxy, config = {}) {
  const target = getProxyPrecheckConfig(config);
  const primaryResponse = await requestViaHttpProxy(proxy, target.url, target.method, target.timeoutMs);
  const primarySuccess = Boolean(primaryResponse.success && primaryResponse.status >= target.okMinStatus && primaryResponse.status <= target.okMaxStatus);
  const exitIp = await fetchProxyExitIp(proxy, config);

  return {
    success: primarySuccess,
    level: primarySuccess ? 'OK' : (exitIp.success ? 'WEAK' : 'BAD'),
    reason: primarySuccess ? 'OK' : (primaryResponse.success ? `HTTP_${primaryResponse.status}` : primaryResponse.reason),
    status: primaryResponse.status,
    finalUrl: primaryResponse.finalUrl,
    title: '',
    target: primaryResponse.target,
    exitIp,
  };
}

function buildRunSummary({
  config,
  allAccounts,
  accounts,
  proxies,
  proxySourcePath,
  requestedConcurrency,
  concurrency,
  doneAccountRawSet,
  resultsDir,
}) {
  const estimatedMailWaitSeconds = Math.round((Number(config.waitMailAttempts || 0) * Number(config.waitMailIntervalMs || 0)) / 1000);
  const proxyPrecheck = getProxyPrecheckConfig(config);
  const lines = [
    '=== 本次运行摘要 ===',
    `账号文件：${accountsPath}`,
    `代理文件：${proxySourcePath}`,
    `结果目录：${resultsDir}`,
    `账号总数：${allAccounts.length}`,
    `待跑账号数：${accounts.length}`,
    `已跳过成功账号数：${doneAccountRawSet.size}`,
    `可用代理数：${proxies.length}`,
    `代理策略：${config.proxyPolicy}`,
    `请求并发数：${requestedConcurrency}`,
    `实际并发数：${concurrency}`,
    `浏览器可见：${formatBooleanLabel(!Boolean(config.headless))}`,
    `SlowMo：${Number(config.slowMo || 0)}ms`,
    `每账号最大代理重试：${Number(config.maxProxyRetriesPerAccount || 0)} 次`,
    `代理预检：${proxyPrecheck.method} ${proxyPrecheck.url} | 通过状态=${proxyPrecheck.okMinStatus}-${proxyPrecheck.okMaxStatus} | timeout=${proxyPrecheck.timeoutMs}ms`,
    `出口IP获取：${proxyPrecheck.exitIpMethod} ${proxyPrecheck.exitIpUrl}`,
    `验证码最大等待：约 ${estimatedMailWaitSeconds} 秒（${Number(config.waitMailAttempts || 0)} 次 × ${Number(config.waitMailIntervalMs || 0)}ms）`,
    `Dreamina 恢复上限：${Number(config.dreaminaMaxRecoveries || 0)} 次`,
    `恢复后顺延等待：${Number(config.dreaminaRecoveryBonusMs || 0)}ms`,
    `窗口布局：${config.windowLayout || 'grid'} | gap=${Number(config.windowGap || 0)} | margin=${Number(config.windowMargin || 0)}`,
    `断点续跑：${doneAccountRawSet.size ? '开启（将自动跳过已成功账号）' : '未检测到已成功账号记录'}`,
    '====================',
  ];
  return lines;
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
  const accounts = allAccounts.filter(account => !doneAccountRawSet.has(account.raw));

  const proxySourcePath = fs.existsSync(healthyProxyPath) ? healthyProxyPath : proxiesPath;
  const proxies = readLines(proxySourcePath).map(parseProxy);

  const successFile = path.join(resultsDir, 'success.txt');
  const failedFile = path.join(resultsDir, 'failed.txt');
  const runLogFile = path.join(resultsDir, 'run-log.txt');
  const precheckFile = path.join(resultsDir, 'runner-precheck.txt');
  const sessionFile = path.join(resultsDir, 'sessions.txt');
  const sessionWithCountryFile = path.join(resultsDir, 'sessions-with-country.txt');
  const storageFile = path.join(resultsDir, 'storage-paths.txt');

  const state = {
    roundRobinIndex: 0,
    accountCursor: 0,
  };

  const proxyFailureMap = new Map();
  const proxyInUseSet = new Set();
  const withStateLock = createMutex();
  const withFileLock = createMutex();
  const requestedConcurrency = Number(config.concurrency || 1);
  const limitedByAccounts = Math.max(1, Math.min(requestedConcurrency, accounts.length || 1));
  const concurrency = Math.max(1, Math.min(limitedByAccounts, proxies.length || 1));

  const runSummaryLines = buildRunSummary({
    config,
    allAccounts,
    accounts,
    proxies,
    proxySourcePath,
    requestedConcurrency,
    concurrency,
    doneAccountRawSet,
    resultsDir,
  });

  appendLine(runLogFile, `=== RUN START ${new Date().toISOString()} ===`);
  appendLine(runLogFile, `accounts_total=${allAccounts.length}, accounts_pending=${accounts.length}, proxies=${proxies.length}, policy=${config.proxyPolicy}, source=${proxySourcePath}, concurrency=${concurrency}, requestedConcurrency=${requestedConcurrency}`);
  for (const line of runSummaryLines) {
    appendLine(runLogFile, line);
  }

  for (const line of runSummaryLines) {
    logSystem(line);
  }
  if (concurrency < requestedConcurrency) {
    logWarn(`并发数已自动收缩到 ${concurrency}，避免超过待跑账号数或可用代理数`);
  }

  for (const account of allAccounts) {
    if (doneAccountRawSet.has(account.raw)) {
      appendLine(runLogFile, `[SKIP_ACCOUNT] ${account.email} already_done=true`);
      logInfo(`跳过已成功账号：${account.email}`);
    }
  }

  async function appendLineSafe(filePath, line) {
    await withFileLock(async () => {
      appendLine(filePath, line);
    });
  }

  async function removeProxyFromListSafe(filePath, targetRaw) {
    await withFileLock(async () => {
      removeProxyFromList(filePath, targetRaw);
    });
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
      if (!proxies.length) {
        throw new Error('代理列表为空');
      }

      const availableIndexes = [];
      for (let i = 0; i < proxies.length; i++) {
        if (!proxyInUseSet.has(proxies[i].raw)) {
          availableIndexes.push(i);
        }
      }

      if (!availableIndexes.length) {
        return null;
      }

      let index;
      if (config.proxyPolicy === 'random') {
        const randomPos = Math.floor(Math.random() * availableIndexes.length);
        index = availableIndexes[randomPos];
      } else {
        const sortedIndexes = availableIndexes.sort((a, b) => a - b);
        const nextPos = state.roundRobinIndex % sortedIndexes.length;
        index = sortedIndexes[nextPos];
        state.roundRobinIndex += 1;
      }

      const proxy = proxies[index];
      proxyInUseSet.add(proxy.raw);
      return { proxy, index, workerId };
    });
  }

  async function releaseProxy(proxyRaw) {
    await withStateLock(async () => {
      proxyInUseSet.delete(proxyRaw);
    });
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

    const windowBounds = computeGridWindowBounds(workerId, concurrency, config);

    await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} START worker=${workerId} window=${windowBounds.width}x${windowBounds.height}@${windowBounds.x},${windowBounds.y}`);
    logAccount(`[线程${workerId}] 开始处理账号：${account.email}`);
    logInfo(`[线程${workerId}] 窗口布局：${windowBounds.width}x${windowBounds.height} @ (${windowBounds.x}, ${windowBounds.y}) | 网格=${windowBounds.cols}x${windowBounds.rows} | 分档=${windowBounds.layout || 'default'}`);

    for (let attempt = 1; attempt <= config.maxProxyRetriesPerAccount; attempt++) {
      const acquired = await acquireProxy(workerId);
      if (!acquired) {
        lastReason = 'NO_IDLE_PROXY_AVAILABLE';
        logWarn(`[线程${workerId}] 当前没有空闲代理，等待其他线程释放后重试`);
        await appendLineSafe(runLogFile, `[WAIT_PROXY] account=${account.email} worker=${workerId} reason=${lastReason}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
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
        logProxy(`正在预检代理（${precheckTarget.method} ${precheckTarget.url}）：${proxy.server}`);
        await appendLineSafe(precheckFile, `[PRECHECK] proxy=${proxy.server} -> ${precheck.level} | ${precheck.reason} | status=${precheck.status || 'NA'} | finalUrl=${precheck.finalUrl || ''} | target=${precheck.target} | account=${account.email} | worker=${workerId}`);

        if (precheck.level === 'OK') {
          logSuccess(`代理预检通过：${proxy.server} | 出口IP：${exitIpText} | 目标=${precheck.target}`);
        } else if (precheck.level === 'WEAK') {
          logWarn(`代理预检为 WEAK：${proxy.server} | 出口IP：${exitIpText} | 原因：${precheck.reason}`);
          logInfo(`预检落点：status=${precheck.status || 'NA'} | finalUrl=${precheck.finalUrl || 'NA'} | target=${precheck.target}`);
        } else {
          logFail(`代理预检失败：${proxy.server} | 出口IP：${exitIpText} | 原因：${precheck.reason}`);
          logInfo(`预检落点：status=${precheck.status || 'NA'} | finalUrl=${precheck.finalUrl || 'NA'} | target=${precheck.target}`);
        }

        if (precheck.level === 'BAD') {
          lastReason = `PROXY_PRECHECK_FAILED:${precheck.reason}`;
          await appendLineSafe(runLogFile, `[SKIP] account=${account.email} proxy=${proxy.server} worker=${workerId} level=${precheck.level} reason=${lastReason}`);

          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= 2) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，打入坏代理池：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
          continue;
        }

        try {
          logStage(`真实注册流程开始 | 账号=${account.email} | 代理=${proxy.server} | 出口IP=${exitIpText} | 浏览器模式=有头 | 工作线程=${workerId} | 验证码来源=Firstmail API | 预检等级=${precheck.level}`);
          logAccount(`[线程${workerId}] 已进入真实注册流程：${account.email}`);
          const result = await runRegisterTask({
            account,
            proxy,
            config,
            attempt,
            workerId,
            windowBounds,
            resolvedExitIp: exitIpText,
          });

          if (result.success) {
            const sessionFormats = buildSessionFormats(proxy, result.sessionId || '');
            const sessionName = extractSessionName(result.sessionId || '');
            const accountSessionId = sessionFormats.cookieSessionValue || normalizeCookieSessionValue(result.sessionId || '');
            const accountSessionIdWithCountry = sessionFormats.countryCode && accountSessionId
              ? `${sessionFormats.countryCode}-${accountSessionId}`
              : accountSessionId;

            await appendLineSafe(successFile, `${account.email}:${account.password} | proxy=${proxy.raw} | status=success | worker=${workerId} | precheck=${precheck.level}`);
            await appendLineSafe(doneAccountsFile, account.raw);
            await appendLineSafe(storageFile, `${account.email} | storage=${result.storagePath || ''}`);
            if (accountSessionId) {
              await appendLineSafe(sessionFile, accountSessionId);
            }
            if (accountSessionIdWithCountry) {
              await appendLineSafe(sessionWithCountryFile, accountSessionIdWithCountry);
            }
            await appendLineSafe(runLogFile, `[SUCCESS] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} storage=${result.storagePath || ''} session_name=${sessionName || ''} sessionid=${accountSessionId || ''} sessionid_with_country=${accountSessionIdWithCountry || ''}`);
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
          await appendLineSafe(runLogFile, `[FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} stageSummary=打开Dreamina/填写邮箱密码并提交/FirstmailAPI拉验证码/回填验证码和生日/保存登录态 reason=${lastReason}`);
          logFail(`真实注册流程失败：${account.email} | 原因：${lastReason}`);

          if (isHardProxyFailureReason(lastReason)) {
            await appendLineSafe(runLogFile, `[HARD_PROXY_FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} reason=${lastReason}`);
            logWarn(`命中代理强失败，立即剔除当前代理：${proxy.server} | 原因=${lastReason}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | hard-failed by runner | reason=${lastReason}`);
            await updateProxyFailure(proxy.raw, () => Number(config.maxProxyRetriesPerAccount || 3));
            continue;
          }

          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= 2) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to weak/bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，降级处理：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            const targetFile = precheck.level === 'WEAK' ? weakProxyPath : badProxyPath;
            await appendLineSafe(targetFile, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
        } catch (error) {
          lastReason = error.message || 'EXCEPTION';
          await appendLineSafe(runLogFile, `[ERROR] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} stageSummary=打开Dreamina/填写邮箱密码并提交/FirstmailAPI拉验证码/回填验证码和生日/保存登录态 reason=${lastReason}`);
          logFail(`真实注册流程异常：账号=${account.email} | 原因=${lastReason}`);

          if (isHardProxyFailureReason(lastReason)) {
            await appendLineSafe(runLogFile, `[HARD_PROXY_FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} precheck=${precheck.level} reason=${lastReason}`);
            logWarn(`命中代理强失败，立即剔除当前代理：${proxy.server} | 原因=${lastReason}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | hard-failed by runner | reason=${lastReason}`);
            await updateProxyFailure(proxy.raw, () => Number(config.maxProxyRetriesPerAccount || 3));
            continue;
          }

          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= 2) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to weak/bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，降级处理：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            const targetFile = precheck.level === 'WEAK' ? weakProxyPath : badProxyPath;
            await appendLineSafe(targetFile, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
        }
      } finally {
        await releaseProxy(proxy.raw);
      }
    }

    if (!success) {
      await appendLineSafe(failedFile, `${account.email}:${account.password} | status=failed | reason=${lastReason} | worker=${workerId}`);
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
