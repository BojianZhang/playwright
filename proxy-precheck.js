const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');

function createMutex() {
  let current = Promise.resolve();
  return async (task) => {
    const run = current.then(() => task());
    current = run.catch(() => {});
    return run;
  };
}

const baseDir = __dirname;
const proxiesPath = path.join(baseDir, 'proxies.txt');
const configPath = path.join(baseDir, 'config.json');
const resultsDir = path.join(baseDir, 'results');
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

const okFile = path.join(resultsDir, 'proxy-ok.txt');
const weakFile = path.join(resultsDir, 'proxy-weak.txt');
const badFile = path.join(resultsDir, 'proxy-bad.txt');
const logFile = path.join(resultsDir, 'proxy-precheck-log.txt');

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function parseProxy(line) {
  const cleanLine = line.split(' | ')[0].trim();
  const parts = cleanLine.split(':');
  if (parts.length < 4) throw new Error(`无法解析代理格式: ${line}`);

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

function extractIpFromResponseBody(body) {
  const text = String(body || '').trim();
  if (!text) return '';

  const jsonMatch = text.match(/"ip"\s*:\s*"([^"]+)"/i);
  if (jsonMatch) return jsonMatch[1].trim();

  const plainIpMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (plainIpMatch) return plainIpMatch[0].trim();

  return '';
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

async function checkPrimaryConnectivity(proxy, config = {}) {
  const target = getProxyPrecheckConfig(config);
  const response = await requestViaHttpProxy(proxy, target.url, target.method, target.timeoutMs);
  const ok = Boolean(response.success && response.status >= target.okMinStatus && response.status <= target.okMaxStatus);
  return {
    success: ok,
    response,
    reason: ok ? 'OK' : (response.success ? `HTTP_${response.status}` : response.reason),
  };
}

async function classifyProxy(proxy, config) {
  const exitIp = await fetchProxyExitIp(proxy, config);
  const primary = await checkPrimaryConnectivity(proxy, config);

  if (primary.success) {
    return {
      level: 'OK',
      exitIp,
      primary,
    };
  }

  if (exitIp.success) {
    return {
      level: 'WEAK',
      exitIp,
      primary,
    };
  }

  return {
    level: 'BAD',
    exitIp,
    primary,
  };
}

(async () => {
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  const proxies = readLines(proxiesPath).map(parseProxy);
  const requestedConcurrency = Number(config.proxyPrecheckConcurrency || 4);
  const concurrency = Math.max(1, Math.min(requestedConcurrency, proxies.length || 1));
  const withFileLock = createMutex();
  let proxyCursor = 0;
  const cursorLock = createMutex();
  const precheckTarget = getProxyPrecheckConfig(config);

  fs.writeFileSync(okFile, '', 'utf8');
  fs.writeFileSync(weakFile, '', 'utf8');
  fs.writeFileSync(badFile, '', 'utf8');
  appendLine(logFile, `=== PRECHECK START ${new Date().toISOString()} ===`);
  appendLine(logFile, `[SYSTEM] proxies=${proxies.length} requestedConcurrency=${requestedConcurrency} actualConcurrency=${concurrency} primary=${precheckTarget.method} ${precheckTarget.url} okStatus=${precheckTarget.okMinStatus}-${precheckTarget.okMaxStatus} exitIp=${precheckTarget.exitIpMethod} ${precheckTarget.exitIpUrl} timeout=${precheckTarget.timeoutMs}`);
  console.log(`【系统】代理总数：${proxies.length}`);
  console.log(`【系统】预检请求并发数：${requestedConcurrency}`);
  console.log(`【系统】预检实际并发数：${concurrency}`);
  console.log(`【系统】主预检目标：${precheckTarget.method} ${precheckTarget.url} | 通过状态=${precheckTarget.okMinStatus}-${precheckTarget.okMaxStatus} | timeout=${precheckTarget.timeoutMs}ms`);
  console.log(`【系统】出口IP获取：${precheckTarget.exitIpMethod} ${precheckTarget.exitIpUrl}`);
  if (concurrency < requestedConcurrency) {
    console.log(`【警告】预检并发已自动收缩到 ${concurrency}`);
  }

  async function appendLineSafe(filePath, line) {
    await withFileLock(async () => {
      appendLine(filePath, line);
    });
  }

  async function acquireNextProxy() {
    return cursorLock(async () => {
      if (proxyCursor >= proxies.length) return null;
      const proxy = proxies[proxyCursor];
      proxyCursor += 1;
      return { proxy, index: proxyCursor - 1 };
    });
  }

  async function workerLoop(workerId) {
    while (true) {
      const next = await acquireNextProxy();
      if (!next) return;

      const { proxy, index } = next;
      console.log(`【代理预检】[线程${workerId}] 开始检查：${proxy.server}（索引 ${index}）`);
      const result = await classifyProxy(proxy, config);
      console.log(`【代理预检】[线程${workerId}] 出口IP：${result.exitIp.ip || result.exitIp.reason}`);
      await appendLineSafe(
        logFile,
        `[CHECK] worker=${workerId} ${proxy.server} -> ${result.level} | exitIp=${result.exitIp.ip || 'NA'} | exitIpReason=${result.exitIp.reason} | exitIpTarget=${result.exitIp.response.target} | primary=${result.primary.response.target} | primaryReason=${result.primary.reason} | primaryStatus=${result.primary.response.status || 'NA'} | primaryFinalUrl=${result.primary.response.finalUrl || ''}`
      );

      if (result.level === 'OK') {
        await appendLineSafe(okFile, proxy.raw);
        console.log(`【OK】[线程${workerId}] ${proxy.server} | 出口IP=${result.exitIp.ip || 'NA'} | primary=${result.primary.response.target} | reason=${result.primary.reason}`);
      } else if (result.level === 'WEAK') {
        await appendLineSafe(weakFile, `${proxy.raw} | exitIp=${result.exitIp.ip} | primary=${result.primary.response.target} | primaryReason=${result.primary.reason}`);
        console.log(`【WEAK】[线程${workerId}] ${proxy.server} | 出口IP=${result.exitIp.ip} | primary=${result.primary.response.target} | primaryReason=${result.primary.reason}`);
      } else {
        await appendLineSafe(badFile, `${proxy.raw} | exitIpReason=${result.exitIp.reason} | primary=${result.primary.response.target} | primaryReason=${result.primary.reason}`);
        console.log(`【BAD】[线程${workerId}] ${proxy.server} | 出口IP=${result.exitIp.reason} | primary=${result.primary.response.target} | primaryReason=${result.primary.reason}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1)));

  appendLine(logFile, `=== PRECHECK END ${new Date().toISOString()} ===`);
  console.log(`\n代理健康分层完成：\n- OK: ${okFile}\n- WEAK: ${weakFile}\n- BAD: ${badFile}`);
})();
