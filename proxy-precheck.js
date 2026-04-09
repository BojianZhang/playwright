const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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
  const parts = line.split(':');
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
    raw: line,
  };
}

async function fetchProxyExitIp(proxy) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      },
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    await page.goto('https://api.ipify.org?format=json', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const raw = await page.locator('body').innerText().catch(() => '');
    const match = raw.match(/"ip"\s*:\s*"([^"]+)"/i);
    return match ? match[1] : raw.trim();
  } catch (error) {
    return `获取失败: ${error.message || 'EXIT_IP_UNKNOWN'}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function checkPage(proxy, url, okPattern, timeout = 30000) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      },
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    let finalUrl = '';
    let status = null;

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    finalUrl = page.url();
    status = response ? response.status() : null;

    await page.waitForTimeout(2500).catch(() => {});

    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const text = await page.locator('body').innerText().catch(() => '');
    const sample = `${title}\n${text}`.slice(0, 800);
    const ok = okPattern.test(html) || okPattern.test(text) || okPattern.test(title);

    if (ok) {
      return { success: true, reason: 'OK', status, finalUrl, title, sample };
    }

    return {
      success: false,
      reason: `PAGE_UNEXPECTED status=${status || 'NA'} finalUrl=${finalUrl || 'NA'} title=${JSON.stringify(title).slice(0, 120)}`,
      status,
      finalUrl,
      title,
      sample,
    };
  } catch (error) {
    return { success: false, reason: error.message || 'CHECK_EXCEPTION', status: null, finalUrl: '', title: '', sample: '' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function classifyProxy(proxy) {
  const exitIp = await fetchProxyExitIp(proxy);

  const firstmail = await checkPage(
    proxy,
    'https://firstmail.ltd/webmail/login/',
    /Email address|Log in webmail|Password|Webmail/i,
    30000
  );

  const dreamina = await checkPage(
    proxy,
    'https://dreamina.capcut.com/ai-tool/home',
    /Sign in|Sign up|Continue with email|Enter email|CapCut|Dreamina|ByteDance/i,
    45000
  );

  if (firstmail.success && dreamina.success) {
    return { level: 'OK', exitIp, firstmail, dreamina };
  }

  if (firstmail.success && !dreamina.success) {
    return { level: 'WEAK', exitIp, firstmail, dreamina };
  }

  return { level: 'BAD', exitIp, firstmail, dreamina };
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

  fs.writeFileSync(okFile, '', 'utf8');
  fs.writeFileSync(weakFile, '', 'utf8');
  fs.writeFileSync(badFile, '', 'utf8');
  appendLine(logFile, `=== PRECHECK START ${new Date().toISOString()} ===`);
  appendLine(logFile, `[SYSTEM] proxies=${proxies.length} requestedConcurrency=${requestedConcurrency} actualConcurrency=${concurrency}`);
  console.log(`【系统】代理总数：${proxies.length}`);
  console.log(`【系统】预检请求并发数：${requestedConcurrency}`);
  console.log(`【系统】预检实际并发数：${concurrency}`);
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
      const result = await classifyProxy(proxy);
      console.log(`【代理预检】[线程${workerId}] 出口IP：${result.exitIp}`);
      await appendLineSafe(
        logFile,
        `[CHECK] worker=${workerId} ${proxy.server} -> ${result.level} | exitIp=${result.exitIp} | firstmail=${result.firstmail.reason} | dreamina=${result.dreamina.reason}`
      );
      await appendLineSafe(logFile, `[DETAIL] worker=${workerId} ${proxy.server} | exitIp=${result.exitIp} | firstmail_final=${result.firstmail.finalUrl || ''} | dreamina_final=${result.dreamina.finalUrl || ''}`);
      await appendLineSafe(logFile, `[DETAIL] worker=${workerId} ${proxy.server} | firstmail_title=${JSON.stringify(result.firstmail.title || '')} | dreamina_title=${JSON.stringify(result.dreamina.title || '')}`);
      await appendLineSafe(logFile, `[DETAIL] worker=${workerId} ${proxy.server} | firstmail_sample=${JSON.stringify(result.firstmail.sample || '').slice(0, 500)} | dreamina_sample=${JSON.stringify(result.dreamina.sample || '').slice(0, 500)}`);

      if (result.level === 'OK') {
        await appendLineSafe(okFile, proxy.raw);
        console.log(`【OK】[线程${workerId}] ${proxy.server} | 出口IP=${result.exitIp} | firstmail=${result.firstmail.reason} | dreamina=${result.dreamina.reason}`);
      } else if (result.level === 'WEAK') {
        await appendLineSafe(weakFile, `${proxy.raw} | firstmail=${result.firstmail.reason} | dreamina=${result.dreamina.reason}`);
        console.log(`【WEAK】[线程${workerId}] ${proxy.server} | 出口IP=${result.exitIp} | firstmail=${result.firstmail.reason} | dreamina=${result.dreamina.reason}`);
      } else {
        await appendLineSafe(badFile, `${proxy.raw} | firstmail=${result.firstmail.reason} | dreamina=${result.dreamina.reason}`);
        console.log(`【BAD】[线程${workerId}] ${proxy.server} | 出口IP=${result.exitIp} | firstmail=${result.firstmail.reason} | dreamina=${result.dreamina.reason}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => workerLoop(index + 1)));

  appendLine(logFile, `=== PRECHECK END ${new Date().toISOString()} ===`);
  console.log(`\n代理健康分层完成：\n- OK: ${okFile}\n- WEAK: ${weakFile}\n- BAD: ${badFile}`);
})();
