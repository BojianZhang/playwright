const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
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

function computeGridWindowBounds(workerId, concurrency, config) {
  const screen = getScreenSize();
  const margin = Number(config.windowMargin || 8);
  const gap = Number(config.windowGap || 12);
  const cols = Math.max(1, Math.ceil(Math.sqrt(concurrency)));
  const rows = Math.max(1, Math.ceil(concurrency / cols));
  const slotIndex = Math.max(0, workerId - 1);
  const row = Math.floor(slotIndex / cols);
  const col = slotIndex % cols;

  const usableWidth = screen.width - margin * 2 - gap * (cols - 1);
  const usableHeight = screen.height - margin * 2 - gap * (rows - 1) - 40;
  const width = Math.max(520, Math.floor(usableWidth / cols));
  const height = Math.max(720, Math.floor(usableHeight / rows));
  const x = margin + col * (width + gap);
  const y = margin + row * (height + gap);

  return {
    screen,
    row,
    col,
    cols,
    rows,
    x,
    y,
    width,
    height,
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

function pickProxy(proxies, policy, state) {
  if (!proxies.length) {
    throw new Error('代理列表为空');
  }

  if (policy === 'random') {
    const index = Math.floor(Math.random() * proxies.length);
    return { proxy: proxies[index], index };
  }

  const index = state.roundRobinIndex % proxies.length;
  state.roundRobinIndex += 1;
  return { proxy: proxies[index], index };
}

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

function formatBooleanLabel(value) {
  return value ? '是' : '否';
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

async function precheckProxy(proxy) {
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
    const response = await page.goto('https://firstmail.ltd/webmail/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(2500).catch(() => {});
    const html = await page.content().catch(() => '');
    const text = await page.locator('body').innerText().catch(() => '');
    const title = await page.title().catch(() => '');
    const ok = /Email address|Log in webmail|Password|Webmail/i.test(html)
      || /Email address|Log in webmail|Password|Webmail/i.test(text)
      || /Webmail/i.test(title);

    if (!ok) {
      return {
        success: false,
        reason: 'FIRSTMAIL_PAGE_UNEXPECTED',
        status: response ? response.status() : null,
        finalUrl: page.url(),
        title,
      };
    }

    return {
      success: true,
      reason: 'OK',
      status: response ? response.status() : null,
      finalUrl: page.url(),
      title,
    };
  } catch (error) {
    return { success: false, reason: error.message || 'PRECHECK_EXCEPTION', status: null, finalUrl: '', title: '' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
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
    logInfo(`[线程${workerId}] 窗口布局：${windowBounds.width}x${windowBounds.height} @ (${windowBounds.x}, ${windowBounds.y}) | 网格=${windowBounds.cols}x${windowBounds.rows}`);

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

        const exitIp = await fetchProxyExitIp(proxy);
        logProxy(`代理出口 IP：${exitIp}`);
        await appendLineSafe(precheckFile, `[EXIT_IP] proxy=${proxy.server} | exitIp=${exitIp} | account=${account.email} | worker=${workerId}`);

        logProxy(`正在预检代理：${proxy.server}`);
        const precheck = await precheckProxy(proxy);
        await appendLineSafe(precheckFile, `[PRECHECK] proxy=${proxy.server} -> ${precheck.success ? 'OK' : 'FAIL'} | ${precheck.reason} | status=${precheck.status || 'NA'} | finalUrl=${precheck.finalUrl || ''} | title=${JSON.stringify(precheck.title || '')} | account=${account.email} | worker=${workerId}`);

        if (precheck.success) {
          logSuccess(`代理预检通过：${proxy.server} | 出口IP：${exitIp}`);
        } else {
          logFail(`代理预检失败：${proxy.server} | 出口IP：${exitIp} | 原因：${precheck.reason}`);
          logInfo(`预检落点：status=${precheck.status || 'NA'} | finalUrl=${precheck.finalUrl || 'NA'} | title=${precheck.title || 'NA'}`);
        }

        if (!precheck.success) {
          lastReason = `PROXY_PRECHECK_FAILED:${precheck.reason}`;
          await appendLineSafe(runLogFile, `[SKIP] account=${account.email} proxy=${proxy.server} worker=${workerId} reason=${lastReason}`);

          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= 2) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to weak/bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，降级处理：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(weakProxyPath, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
          continue;
        }

        try {
          logStage(`真实注册开始 | 账号=${account.email} | 代理=${proxy.server} | 出口IP=${exitIp} | 浏览器模式=有头 | 工作线程=${workerId}`);
          logAccount(`[线程${workerId}] 已进入真实注册阶段，浏览器即将弹出：${account.email}`);
          const result = await runRegisterTask({
            account,
            proxy,
            config,
            attempt,
            workerId,
            windowBounds,
          });

          if (result.success) {
            await appendLineSafe(successFile, `${account.email}:${account.password} | proxy=${proxy.raw} | status=success | worker=${workerId}`);
            await appendLineSafe(doneAccountsFile, account.raw);
            await appendLineSafe(storageFile, `${account.email} | storage=${result.storagePath || ''}`);
            await appendLineSafe(sessionFile, `${account.email} | sessionid=${result.sessionId || ''}`);
            await appendLineSafe(runLogFile, `[SUCCESS] account=${account.email} worker=${workerId} proxy=${proxy.server} storage=${result.storagePath || ''} sessionid=${result.sessionId || ''}`);
            logSuccess(`账号注册成功：${account.email}`);
            logInfo(`登录态文件：${result.storagePath || ''}`);
            logInfo(`SessionID：${result.sessionId || ''}`);
            await updateProxyFailure(proxy.raw, () => 0);
            success = true;
            break;
          }

          lastReason = result.reason || 'UNKNOWN_FAIL';
          await appendLineSafe(runLogFile, `[FAIL] account=${account.email} worker=${workerId} proxy=${proxy.server} reason=${lastReason}`);
          logFail(`账号注册失败：${account.email} | 原因：${lastReason}`);

          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= 2) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to weak/bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，降级处理：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(weakProxyPath, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
        } catch (error) {
          lastReason = error.message || 'EXCEPTION';
          await appendLineSafe(runLogFile, `[ERROR] account=${account.email} worker=${workerId} proxy=${proxy.server} reason=${lastReason}`);
          logFail(`任务异常：账号=${account.email} | 原因=${lastReason}`);

          const currentFail = await updateProxyFailure(proxy.raw, count => count + 1);
          if (currentFail >= 2) {
            await appendLineSafe(runLogFile, `[DOWNGRADE] proxy=${proxy.server} failCount=${currentFail} worker=${workerId} -> move to bad pool`);
            logWarn(`代理连续失败 ${currentFail} 次，打入坏代理池：${proxy.server}`);
            await removeProxyFromListSafe(healthyProxyPath, proxy.raw);
            await appendLineSafe(badProxyPath, `${proxy.raw} | auto-downgraded by runner | reason=${lastReason}`);
          }
        }
      } finally {
        await releaseProxy(proxy.raw);
      }
    }

    if (!success) {
      await appendLineSafe(failedFile, `${account.email}:${account.password} | status=failed | reason=${lastReason} | worker=${workerId}`);
      await appendLineSafe(runLogFile, `[ACCOUNT] ${account.email} worker=${workerId} FINAL_FAIL reason=${lastReason}`);
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
