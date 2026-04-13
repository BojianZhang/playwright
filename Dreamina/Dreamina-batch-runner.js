'use strict';

/**
 * Dreamina-batch-runner.js
 *
 * 新架构批量运行入口（最小 runnable 版本）。
 *
 * 目标：
 * - 只围绕新架构 `Dreamina-register.js` 组织批量运行
 * - 不再把老 `runner.js` / `task-register.js` 当作正式主入口
 * - 先跑通“账号队列 + worker 池 + 代理分配 + 新主链调用 + 批次摘要落盘”最小闭环
 *
 * 当前边界：
 * - 本文件只负责“批量调度层”
 * - 单账号业务主链全部交给 `runDreaminaRegisterFlow(...)`
 * - 代理来源当前仍先复用 `loadLocalProxies()`，这是过渡期设计，不代表语义回退到老架构
 * - worker 状态展示当前先复用已有 `worker-status-tracker.js`
 *
 * 后续可扩展但当前不做：
 * - 复杂 retry policy
 * - 智能代理淘汰/回收
 * - GUI 看板
 * - 独立新 config 体系
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const {
  runDreaminaRegisterFlow,
  loadLocalAccounts,
  loadLocalProxies,
  summarizeProxy,
} = require('./Dreamina-register');

const {
  updateWorkerStatus,
  markWorkerIdle,
  buildWorkerOverviewPanel,
} = require('../worker-status-tracker');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeFileName(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 解析 batch runner CLI 参数。
 *
 * 当前只保留最小必要参数，避免第一版 batch runner 过重。
 *
 * 支持示例：
 * node .\Dreamina\Dreamina-batch-runner.js --concurrency 2 --account-start 0 --account-limit 10 --proxy-start 0 --headed --slow-mo 100
 */
function parseBatchCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = {
    concurrency: 2,
    accountStart: 0,
    accountLimit: 10,
    proxyStart: 0,
    headed: false,
    slowMo: 0,
  };

  for (let index = 0; index < args.length; index++) {
    const token = String(args[index] || '').trim();
    if (!token) continue;

    if (token === '--concurrency') {
      parsed.concurrency = Number(args[index + 1] || parsed.concurrency);
      index += 1;
      continue;
    }
    if (token === '--account-start') {
      parsed.accountStart = Number(args[index + 1] || parsed.accountStart);
      index += 1;
      continue;
    }
    if (token === '--account-limit') {
      parsed.accountLimit = Number(args[index + 1] || parsed.accountLimit);
      index += 1;
      continue;
    }
    if (token === '--proxy-start') {
      parsed.proxyStart = Number(args[index + 1] || parsed.proxyStart);
      index += 1;
      continue;
    }
    if (token === '--headed') {
      parsed.headed = true;
      continue;
    }
    if (token === '--headless') {
      parsed.headed = false;
      continue;
    }
    if (token === '--slow-mo') {
      parsed.slowMo = Number(args[index + 1] || parsed.slowMo);
      index += 1;
      continue;
    }
  }

  parsed.concurrency = Math.max(1, Number.isFinite(parsed.concurrency) ? parsed.concurrency : 1);
  parsed.accountStart = Math.max(0, Number.isFinite(parsed.accountStart) ? parsed.accountStart : 0);
  parsed.accountLimit = Math.max(1, Number.isFinite(parsed.accountLimit) ? parsed.accountLimit : 1);
  parsed.proxyStart = Math.max(0, Number.isFinite(parsed.proxyStart) ? parsed.proxyStart : 0);
  parsed.slowMo = Math.max(0, Number.isFinite(parsed.slowMo) ? parsed.slowMo : 0);

  return parsed;
}

/**
 * 按起始索引与数量截取账号列表。
 */
function selectBatchAccounts(accounts = [], options = {}) {
  const list = Array.isArray(accounts) ? accounts.filter(item => item?.email && item?.password) : [];
  const start = Math.max(0, Number(options.accountStart || 0));
  const limit = Math.max(1, Number(options.accountLimit || list.length || 1));
  return list.slice(start, start + limit);
}

/**
 * 当前先按简单环形轮询分配代理。
 *
 * 说明：
 * - 第一版先保证可跑，不在这里引入复杂健康池策略
 * - 后续可以独立抽出新架构 proxy allocator
 */
function acquireNextProxy(batchContext) {
  const list = batchContext?.proxies?.list || [];
  if (!list.length) return null;
  const cursor = batchContext.proxies.cursor % list.length;
  const proxy = list[cursor] || null;
  batchContext.proxies.cursor = (cursor + 1) % list.length;
  return proxy;
}

/**
 * 从 pending queue 取下一个账号。
 */
function acquireNextAccount(batchContext) {
  if (!Array.isArray(batchContext?.accounts?.pendingQueue)) return null;
  return batchContext.accounts.pendingQueue.shift() || null;
}

function buildBatchRunId() {
  return `dreamina-batch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * 构造本次 batch run 的统一上下文。
 *
 * 这是批量调度层的“真相容器”：
 * - 配置
 * - 账号队列
 * - 代理队列
 * - 统计汇总
 * - 结果目录
 */
function createBatchRunContext(options = {}) {
  const runId = buildBatchRunId();
  const resultsDir = path.join(__dirname, 'batch-results');
  const successDir = path.join(resultsDir, 'success');
  const failedDir = path.join(resultsDir, 'failed');
  const latestDir = path.join(resultsDir, 'latest');

  ensureDir(resultsDir);
  ensureDir(successDir);
  ensureDir(failedDir);
  ensureDir(latestDir);

  const pendingQueue = [...(options.accounts || [])];

  return {
    runId,
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: 0,

    config: {
      concurrency: options.concurrency,
      headed: Boolean(options.headed),
      slowMo: Number(options.slowMo || 0),
      accountStart: Number(options.accountStart || 0),
      accountLimit: Number(options.accountLimit || 0),
      proxyStart: Number(options.proxyStart || 0),
    },

    accounts: {
      total: pendingQueue.length,
      pendingQueue,
      running: [],
      success: [],
      failed: [],
      skipped: [],
    },

    proxies: {
      total: Array.isArray(options.proxies) ? options.proxies.length : 0,
      list: Array.isArray(options.proxies) ? options.proxies : [],
      cursor: Math.max(0, Number(options.proxyStart || 0)),
    },

    summary: {
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      failureReasonBuckets: {},
      finalStageBuckets: {},
      slowestStageBuckets: {},
    },

    paths: {
      resultsDir,
      successDir,
      failedDir,
      latestDir,
      summaryFile: path.join(resultsDir, `${runId}.json`),
      latestSummaryFile: path.join(latestDir, 'dreamina-batch-latest.json'),
      indexFile: path.join(latestDir, 'dreamina-batch-index.json'),
    },
  };
}

function buildBatchAccountRecord(result = {}, extra = {}) {
  return {
    account: result?.account?.email || extra?.account?.email || '',
    workerId: extra?.workerId || 0,
    proxyId: extra?.proxy?.id || summarizeProxy(extra?.proxy || {}).id || '',
    success: Boolean(result?.success),
    finalStage: String(result?.finalStage || ''),
    finalState: String(result?.finalState || ''),
    finalReason: String(result?.finalReason || ''),
    durationMs: Number(result?.meta?.durationMs || 0),
    resultFile: String(result?.meta?.resultFile || ''),
    latestResultFile: String(result?.meta?.latestResultFile || ''),
    stageSummary: String(result?.stageSummary || ''),
    slowestStage: String(result?.slowestStage || ''),
  };
}

function incrementBucket(target = {}, key = '') {
  const normalized = String(key || '').trim() || 'UNKNOWN';
  target[normalized] = Number(target[normalized] || 0) + 1;
}

/**
 * 从单账号结果中抽批次级汇总字段。
 */
function updateBatchSummary(batchContext, result = {}, extra = {}) {
  const finalReason = String(result?.finalReason || result?.finalState || 'UNKNOWN');
  const finalStage = String(result?.finalStage || 'UNKNOWN');
  const slowestStage = String(result?.slowestStage || 'UNKNOWN');

  if (result?.success) {
    batchContext.summary.successCount += 1;
  } else {
    batchContext.summary.failedCount += 1;
    incrementBucket(batchContext.summary.failureReasonBuckets, finalReason);
  }

  incrementBucket(batchContext.summary.finalStageBuckets, finalStage);
  if (slowestStage && slowestStage !== 'UNKNOWN') {
    const stageLabel = slowestStage.split('=')[0] || slowestStage;
    incrementBucket(batchContext.summary.slowestStageBuckets, stageLabel);
  }

  const record = buildBatchAccountRecord(result, extra);
  if (result?.success) {
    batchContext.accounts.success.push(record);
  } else {
    batchContext.accounts.failed.push(record);
  }
}

function buildBatchOverviewLines(batchContext) {
  const pending = batchContext.accounts.pendingQueue.length;
  const running = batchContext.accounts.running.length;
  const success = batchContext.summary.successCount;
  const failed = batchContext.summary.failedCount;
  const skipped = batchContext.summary.skippedCount;
  const header = `BATCH_OVERVIEW | total=${batchContext.accounts.total} | pending=${pending} | running=${running} | success=${success} | failed=${failed} | skipped=${skipped}`;

  const failureBuckets = Object.entries(batchContext.summary.failureReasonBuckets || {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' | ');

  const lines = [header];
  if (failureBuckets) {
    lines.push(`BATCH_FAILURE_BUCKETS | ${failureBuckets}`);
  }
  return [...lines, ...buildWorkerOverviewPanel()];
}

async function createWorkerRuntime(options = {}) {
  const browser = await chromium.launch({
    headless: !options.headed,
    slowMo: Number(options.slowMo || 0),
  });

  const proxy = options.proxy || null;
  const context = await browser.newContext({
    proxy: proxy
      ? {
          server: `${proxy.protocol || 'http'}://${proxy.host}:${proxy.port}`,
          username: proxy.username,
          password: proxy.password,
        }
      : undefined,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * 运行单账号新架构主链。
 *
 * 注意：
 * - 这里只是批量调度层调用单账号主链
 * - 不应该在这里复制 `Dreamina-register.js` 内部业务逻辑
 */
async function runSingleAccountWithNewArchitecture(options = {}) {
  const {
    account,
    proxy,
    workerId,
    attempt = 1,
    headed = false,
    slowMo = 0,
  } = options;

  const runtimeBundle = await createWorkerRuntime({
    proxy,
    headed,
    slowMo,
  });

  try {
    const result = await runDreaminaRegisterFlow({
      browser: runtimeBundle.browser,
      context: runtimeBundle.context,
      page: runtimeBundle.page,
      proxy,
      account,
      runtime: {
        batch: true,
        headed,
        slowMo,
        workerId,
        attempt,
        dreaminaHomeUrl: 'https://dreamina.capcut.com/ai-tool/home',
        entryGotoTimeoutMs: 120000,
        dreaminaNavigationTimeoutMs: 120000,
        firstLoadGraceWaitMs: 12000,
        dreaminaAuthMode: 'signup',
        verificationRetryMaxAttempts: 3,
        verificationResendWaitMs: 1800,
        firstmailApiMaxPollAttempts: 2,
        waitMailIntervalMs: 2500,
      },
      workerId,
      attempt,
      logInfo: null,
    });

    return result;
  } finally {
    await runtimeBundle.context.close().catch(() => {});
    await runtimeBundle.browser.close().catch(() => {});
  }
}

async function writeBatchSummaryFile(batchContext) {
  batchContext.finishedAt = Date.now();
  batchContext.durationMs = Math.max(0, batchContext.finishedAt - batchContext.startedAt);

  const summary = {
    runId: batchContext.runId,
    startedAt: new Date(batchContext.startedAt).toISOString(),
    finishedAt: new Date(batchContext.finishedAt).toISOString(),
    durationMs: batchContext.durationMs,
    success: batchContext.summary.failedCount === 0,
    config: batchContext.config,
    counts: {
      total: batchContext.accounts.total,
      success: batchContext.summary.successCount,
      failed: batchContext.summary.failedCount,
      skipped: batchContext.summary.skippedCount,
    },
    failureReasonBuckets: batchContext.summary.failureReasonBuckets,
    finalStageBuckets: batchContext.summary.finalStageBuckets,
    slowestStageBuckets: batchContext.summary.slowestStageBuckets,
    successAccounts: batchContext.accounts.success,
    failedAccounts: batchContext.accounts.failed,
    skippedAccounts: batchContext.accounts.skipped,
  };

  await fs.promises.writeFile(batchContext.paths.summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  await fs.promises.writeFile(batchContext.paths.latestSummaryFile, JSON.stringify(summary, null, 2), 'utf8');

  let indexData = [];
  try {
    const existing = await fs.promises.readFile(batchContext.paths.indexFile, 'utf8');
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed)) indexData = parsed;
  } catch (_) {}

  const topFailureReason = Object.entries(batchContext.summary.failureReasonBuckets || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topSlowestStage = Object.entries(batchContext.summary.slowestStageBuckets || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  indexData.unshift({
    timestamp: new Date().toISOString(),
    runId: batchContext.runId,
    success: summary.success,
    durationMs: summary.durationMs,
    counts: summary.counts,
    topFailureReason,
    topSlowestStage,
    summaryFile: batchContext.paths.summaryFile,
  });
  indexData = indexData.slice(0, 30);
  await fs.promises.writeFile(batchContext.paths.indexFile, JSON.stringify(indexData, null, 2), 'utf8');

  return summary;
}

async function workerLoop(workerId, batchContext) {
  updateWorkerStatus(workerId, {
    status: 'idle',
    account: '',
    stage: '',
    step: 'waiting-account',
    attempt: 0,
    proxy: '',
    lastReason: '',
    lastState: '',
  });

  let attempt = 0;

  while (true) {
    const account = acquireNextAccount(batchContext);
    if (!account) {
      markWorkerIdle(workerId);
      return;
    }

    attempt += 1;
    batchContext.accounts.running.push(account.email);

    const proxy = acquireNextProxy(batchContext);
    if (!proxy) {
      batchContext.accounts.skipped.push({
        account: account.email,
        reason: 'NO_PROXY_AVAILABLE',
      });
      batchContext.summary.skippedCount += 1;
      batchContext.accounts.running = batchContext.accounts.running.filter(item => item !== account.email);
      continue;
    }

    updateWorkerStatus(workerId, {
      status: 'running-register-stage',
      account: account.email,
      stage: 'proxy-precheck',
      step: 'worker-start-account',
      attempt,
      proxy: proxy.raw || summarizeProxy(proxy).id || '',
      lastReason: '',
      lastState: '',
    });

    try {
      const result = await runSingleAccountWithNewArchitecture({
        account,
        proxy,
        workerId,
        attempt,
        headed: batchContext.config.headed,
        slowMo: batchContext.config.slowMo,
      });

      updateBatchSummary(batchContext, result, {
        workerId,
        account,
        proxy,
      });
    } catch (error) {
      const failedResult = {
        success: false,
        finalStage: 'batch-runner',
        finalState: 'BATCH_RUNNER_EXCEPTION',
        finalReason: String(error?.message || 'BATCH_RUNNER_EXCEPTION'),
        meta: {
          durationMs: 0,
        },
      };

      updateBatchSummary(batchContext, failedResult, {
        workerId,
        account,
        proxy,
      });
    } finally {
      batchContext.accounts.running = batchContext.accounts.running.filter(item => item !== account.email);
      markWorkerIdle(workerId);
    }
  }
}

async function runDreaminaBatch(argv = []) {
  const cli = parseBatchCliArgs(argv);
  const accounts = selectBatchAccounts(loadLocalAccounts(), cli);
  const proxies = loadLocalProxies();

  if (!accounts.length) {
    throw new Error('Dreamina batch runner: no accounts available from Dreamina/local-accounts.json');
  }
  if (!proxies.length) {
    throw new Error('Dreamina batch runner: no proxies available from local proxy source');
  }

  const batchContext = createBatchRunContext({
    ...cli,
    accounts,
    proxies,
  });

  console.log(`[Dreamina Batch] runId=${batchContext.runId} | concurrency=${batchContext.config.concurrency} | accounts=${accounts.length} | proxies=${proxies.length}`);

  const panelInterval = setInterval(() => {
    for (const line of buildBatchOverviewLines(batchContext)) {
      console.log(line);
    }
  }, 10000);

  try {
    await Promise.all(
      Array.from({ length: batchContext.config.concurrency }, (_, index) => workerLoop(index + 1, batchContext))
    );
  } finally {
    clearInterval(panelInterval);
  }

  const summary = await writeBatchSummaryFile(batchContext);

  console.log(`[Dreamina Batch] success=${summary.success ? 'Y' : 'N'} | total=${summary.counts.total} | successCount=${summary.counts.success} | failedCount=${summary.counts.failed} | skippedCount=${summary.counts.skipped}`);
  console.log(`[Dreamina Batch] summaryFile=${batchContext.paths.summaryFile}`);
  console.log(`[Dreamina Batch] latestSummaryFile=${batchContext.paths.latestSummaryFile}`);
  console.log(`[Dreamina Batch] indexFile=${batchContext.paths.indexFile}`);

  return summary;
}

if (require.main === module) {
  runDreaminaBatch(process.argv.slice(2))
    .then(result => {
      process.exit(result?.success ? 0 : 1);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  parseBatchCliArgs,
  selectBatchAccounts,
  createBatchRunContext,
  runSingleAccountWithNewArchitecture,
  writeBatchSummaryFile,
  runDreaminaBatch,
};
