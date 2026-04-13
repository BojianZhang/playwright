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

const {
  runDreaminaRegisterFlow,
  loadLocalAccounts,
  createDreaminaCliRuntime,
} = require('./Dreamina-register');
const { loadLocalProxies, summarizeProxy } = require('../shared-proxy-precheck/local-proxy-loader');

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

const KNOWN_EXISTS_FILE = path.join(__dirname, 'batch-results', 'latest', 'dreamina-known-exists.json');
const KNOWN_REGISTERED_FILE = path.join(__dirname, 'batch-results', 'latest', 'dreamina-known-registered.json');
const LOCAL_ACCOUNTS_FILE = path.join(__dirname, 'local-accounts.json');
const REGISTERED_ACCOUNTS_FILE = path.join(__dirname, 'registered-accounts.json');

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
    ignoreKnownExists: false,
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
    if (token === '--ignore-known-exists') {
      parsed.ignoreKnownExists = true;
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

async function pruneKnownRegisteredFromLocalPool(knownExistsAccounts = new Set()) {
  if (!(knownExistsAccounts instanceof Set) || !knownExistsAccounts.size) {
    return {
      removedCount: 0,
      removedEmails: [],
      remainingAccounts: readJsonArrayFile(LOCAL_ACCOUNTS_FILE),
    };
  }

  const localAccounts = readJsonArrayFile(LOCAL_ACCOUNTS_FILE);
  const removedEmails = [];
  const remainingAccounts = localAccounts.filter(item => {
    const normalizedEmail = String(item?.email || '').trim().toLowerCase();
    const shouldRemove = normalizedEmail && knownExistsAccounts.has(normalizedEmail);
    if (shouldRemove) removedEmails.push(normalizedEmail);
    return !shouldRemove;
  });

  if (removedEmails.length > 0) {
    await fs.promises.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(remainingAccounts, null, 2)}\n`, 'utf8');
  }

  return {
    removedCount: removedEmails.length,
    removedEmails,
    remainingAccounts,
  };
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

function readKnownExistsAccounts() {
  try {
    if (!fs.existsSync(KNOWN_EXISTS_FILE)) {
      return new Set();
    }
    const raw = JSON.parse(fs.readFileSync(KNOWN_EXISTS_FILE, 'utf8'));
    const items = Array.isArray(raw?.accounts) ? raw.accounts : [];
    return new Set(items.map(item => String(item || '').trim().toLowerCase()).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

async function writeKnownExistsAccounts(batchContext) {
  const accounts = Array.from(batchContext.knownExistsAccounts || []).sort();
  const payload = {
    updatedAt: new Date().toISOString(),
    count: accounts.length,
    semantic: 'known-registered-or-non-repeatable-accounts',
    compatibilityFile: path.basename(KNOWN_EXISTS_FILE),
    canonicalFile: path.basename(KNOWN_REGISTERED_FILE),
    accounts,
  };
  const content = JSON.stringify(payload, null, 2);
  await fs.promises.writeFile(KNOWN_EXISTS_FILE, content, 'utf8');
  await fs.promises.writeFile(KNOWN_REGISTERED_FILE, content, 'utf8');
}

function buildKnownExistsSkipResult(account = {}, proxy = {}, reason = 'KNOWN_EXISTS_ACCOUNT_SKIPPED') {
  return {
    success: false,
    skipped: true,
    finalStage: 'precheck-skip',
    finalState: reason,
    finalReason: reason,
    account: {
      email: account?.email || '',
    },
    proxy: summarizeProxy(proxy || {}),
    meta: {
      durationMs: 0,
      skippedBeforeRun: true,
    },
    stageSummary: 'precheck-skip=KNOWN_EXISTS_ACCOUNT_SKIPPED',
    slowestStage: '',
  };
}

function readJsonArrayFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

async function migrateAccountOutOfLocalPool(account = {}, result = {}) {
  const normalizedEmail = String(account?.email || result?.account?.email || '').trim().toLowerCase();
  if (!normalizedEmail) return { removed: false, appended: false, reason: 'EMPTY_EMAIL' };

  const localAccounts = readJsonArrayFile(LOCAL_ACCOUNTS_FILE);
  const registeredAccounts = readJsonArrayFile(REGISTERED_ACCOUNTS_FILE);

  const matchedLocal = localAccounts.find(item => String(item?.email || '').trim().toLowerCase() === normalizedEmail) || null;
  const nextLocalAccounts = localAccounts.filter(item => String(item?.email || '').trim().toLowerCase() !== normalizedEmail);
  const alreadyRegistered = registeredAccounts.some(item => String(item?.email || '').trim().toLowerCase() === normalizedEmail);

  let appended = false;
  if (!alreadyRegistered) {
    registeredAccounts.push({
      email: matchedLocal?.email || account?.email || result?.account?.email || '',
      password: matchedLocal?.password || account?.password || '',
      source: result?.success ? 'register-success' : 'account-exists',
      finalReason: String(result?.finalReason || result?.finalState || ''),
      finalState: String(result?.finalState || ''),
      movedAt: new Date().toISOString(),
    });
    appended = true;
  }

  const removed = nextLocalAccounts.length !== localAccounts.length;
  if (removed) {
    await fs.promises.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(nextLocalAccounts, null, 2)}\n`, 'utf8');
  }
  if (appended) {
    await fs.promises.writeFile(REGISTERED_ACCOUNTS_FILE, `${JSON.stringify(registeredAccounts, null, 2)}\n`, 'utf8');
  }

  return {
    removed,
    appended,
    reason: removed ? 'MOVED_TO_REGISTERED_POOL' : 'NOT_FOUND_IN_LOCAL_POOL',
  };
}

function createBatchRunContext(options = {}) {
  const runId = buildBatchRunId();
  const resultsDir = path.join(__dirname, 'batch-results');
  const successDir = path.join(resultsDir, 'success');
  const failedDir = path.join(resultsDir, 'failed');
  const existsDir = path.join(resultsDir, 'exists');
  const latestDir = path.join(resultsDir, 'latest');

  ensureDir(resultsDir);
  ensureDir(successDir);
  ensureDir(failedDir);
  ensureDir(existsDir);
  ensureDir(latestDir);

  const pendingQueue = [...(options.accounts || [])];
  const knownExistsAccounts = readKnownExistsAccounts();

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
      ignoreKnownExists: Boolean(options.ignoreKnownExists),
    },

    accounts: {
      total: pendingQueue.length,
      pendingQueue,
      running: [],
      success: [],
      failed: [],
      exists: [],
      skipped: [],
    },

    proxies: {
      total: Array.isArray(options.proxies) ? options.proxies.length : 0,
      list: Array.isArray(options.proxies) ? options.proxies : [],
      cursor: Math.max(0, Number(options.proxyStart || 0)),
    },

    knownExistsAccounts,

    summary: {
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      existsCount: 0,
      knownExistsSkippedCount: 0,
      failureReasonBuckets: {},
      existsReasonBuckets: {},
      finalStageBuckets: {},
      slowestStageBuckets: {},
    },

    paths: {
      resultsDir,
      successDir,
      failedDir,
      existsDir,
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
    bucket: String(extra?.bucket || (result?.success ? 'success' : 'failed')),
    success: Boolean(result?.success),
    finalStage: String(result?.finalStage || ''),
    finalState: String(result?.finalState || ''),
    finalReason: String(result?.finalReason || ''),
    durationMs: Number(result?.meta?.durationMs || 0),
    resultFile: String(result?.meta?.resultFile || ''),
    latestResultFile: String(result?.meta?.latestResultFile || ''),
    batchBucketPath: String(
      extra?.bucket === 'exists'
        ? (extra?.batchContext?.paths?.existsDir || '')
        : extra?.bucket === 'success'
          ? (extra?.batchContext?.paths?.successDir || '')
          : (extra?.batchContext?.paths?.failedDir || '')
    ),
    stageSummary: String(result?.stageSummary || ''),
    slowestStage: String(result?.slowestStage || ''),
    detail: result?.detail || null,
    deliveryPayload: result?.deliveryPayload || null,
    stageResults: {
      postAuthReady: result?.stageResults?.postAuthReady || null,
      accountDelivery: result?.stageResults?.accountDelivery || null,
    },
  };
}

function incrementBucket(target = {}, key = '') {
  const normalized = String(key || '').trim() || 'UNKNOWN';
  target[normalized] = Number(target[normalized] || 0) + 1;
}

/**
 * 从单账号结果中抽批次级汇总字段。
 */

function isExistsBusinessFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim();
  return [
    'DREAMINA_ACCOUNT_ALREADY_EXISTS',
    'ACCOUNT_ALREADY_EXISTS',
    'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
    'ACCOUNT_ALREADY_EXISTS_PRECHECK',
  ].includes(reason);
}

async function updateBatchSummary(batchContext, result = {}, extra = {}) {
  const finalReason = String(result?.finalReason || result?.finalState || 'UNKNOWN');
  const finalStage = String(result?.finalStage || 'UNKNOWN');
  const slowestStage = String(result?.slowestStage || 'UNKNOWN');
  const existsFailure = isExistsBusinessFailure(result);
  const normalizedEmail = String(result?.account?.email || extra?.account?.email || '').trim().toLowerCase();

  if (result?.success) {
    batchContext.summary.successCount += 1;
    if (normalizedEmail) {
      batchContext.knownExistsAccounts.add(normalizedEmail);
    }
  } else if (result?.skipped && finalReason === 'KNOWN_EXISTS_ACCOUNT_SKIPPED') {
    batchContext.summary.skippedCount += 1;
    batchContext.summary.knownExistsSkippedCount += 1;
  } else if (existsFailure) {
    batchContext.summary.existsCount += 1;
    incrementBucket(batchContext.summary.existsReasonBuckets, finalReason);
    if (normalizedEmail) {
      batchContext.knownExistsAccounts.add(normalizedEmail);
    }
  } else {
    batchContext.summary.failedCount += 1;
    incrementBucket(batchContext.summary.failureReasonBuckets, finalReason);
  }

  incrementBucket(batchContext.summary.finalStageBuckets, finalStage);
  if (slowestStage && slowestStage !== 'UNKNOWN') {
    const stageLabel = slowestStage.split('=')[0] || slowestStage;
    incrementBucket(batchContext.summary.slowestStageBuckets, stageLabel);
  }

  const record = buildBatchAccountRecord(result, {
    ...extra,
    batchContext,
    bucket: result?.success ? 'success' : (existsFailure ? 'exists' : (result?.skipped ? 'skipped' : 'failed')),
  });
  if (result?.success) {
    batchContext.accounts.success.push(record);
  } else if (existsFailure) {
    batchContext.accounts.exists.push(record);
  } else if (result?.skipped) {
    batchContext.accounts.skipped.push(record);
  } else {
    batchContext.accounts.failed.push(record);
  }

  await writeBatchAccountRecordFile(batchContext, record);

  if ((result?.success || existsFailure) && normalizedEmail) {
    const migration = await migrateAccountOutOfLocalPool(extra?.account || result?.account || {}, result);
    record.accountPoolMigration = migration;
  }
}

function buildBatchOverviewLines(batchContext) {
  const pending = batchContext.accounts.pendingQueue.length;
  const running = batchContext.accounts.running.length;
  const success = batchContext.summary.successCount;
  const failed = batchContext.summary.failedCount;
  const exists = batchContext.summary.existsCount;
  const skipped = batchContext.summary.skippedCount;
  const header = `BATCH_OVERVIEW | total=${batchContext.accounts.total} | pending=${pending} | running=${running} | success=${success} | exists=${exists} | failed=${failed} | skipped=${skipped}`;

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
  return await createDreaminaCliRuntime({
    proxy: options.proxy,
    headed: options.headed,
    slowMo: options.slowMo,
    blockedResourceTypes: ['image', 'media', 'font'],
  });
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
        cli: false,
        headed,
        slowMo,
        workerId,
        attempt,
        dreaminaHomeUrl: 'https://dreamina.capcut.com/ai-tool/home',
        entryGotoTimeoutMs: 120000,
        dreaminaNavigationTimeoutMs: 120000,
        firstLoadGraceWaitMs: 12000,
        dreaminaAuthMode: 'signup',
        credentialSignupSwitchWaitMs: 1200,
        verificationRetryMaxAttempts: 3,
        verificationResendWaitMs: 1800,
        skipCredentialExistsPrecheckAfterEmail: true,
        firstmailApiMaxPollAttempts: 6,
        waitMailIntervalMs: 2500,
        firstmailRecentMessageScanLimit: 8,
        firstmailPollJitterMinMs: 0,
        firstmailPollJitterMaxMs: 0,
        readyTextSignals: [
          'Continue with email',
          'Sign in',
          'Log in',
          'Login',
          'Sign up',
          'Create realistic talk',
          'Start Creating With AI Agent',
          'AI Image',
          'Canvas',
        ],
        readySelectors: [
          'input[role="textbox"]',
          'input[type="email"]',
          '[class*="credit-display-container"]',
          '[class*="login"] button',
          '[class*="signin"] button',
          '[class*="sign-in"] button',
          '[class*="signup"] button',
          '[class*="sign-up"] button',
        ],
        readyBodyPatterns: [
          'dreamina',
          'capcut',
          'continue with email',
          'sign in',
          'sign up',
          'create realistic talk',
          'ai image',
          'canvas',
        ],
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


async function writeBatchAccountRecordFile(batchContext, record = {}) {
  const account = sanitizeFileName(record?.account || 'unknown-account');
  const stage = sanitizeFileName(record?.finalStage || 'unknown-stage');
  const reason = sanitizeFileName(record?.finalReason || record?.finalState || 'unknown-reason');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bucket = String(record?.bucket || 'failed');
  const targetDir = bucket === 'exists' || bucket === 'skipped'
    ? batchContext.paths.existsDir
    : bucket === 'success'
      ? batchContext.paths.successDir
      : batchContext.paths.failedDir;
  const filePath = path.join(targetDir, `dreamina-batch-${account}-${stage}-${reason}-${stamp}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
  record.batchRecordFile = filePath;
  return filePath;
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
      exists: batchContext.summary.existsCount,
      skipped: batchContext.summary.skippedCount,
      knownExistsSkipped: batchContext.summary.knownExistsSkippedCount,
    },
    failureReasonBuckets: batchContext.summary.failureReasonBuckets,
    existsReasonBuckets: batchContext.summary.existsReasonBuckets,
    existsMeaning: 'exists=本次实际提交注册后，被平台明确判定为账号已存在；skipped/knownExistsSkipped=运行前已知该账号已注册或不可重复注册，因此本次直接跳过未提交注册',
    finalStageBuckets: batchContext.summary.finalStageBuckets,
    slowestStageBuckets: batchContext.summary.slowestStageBuckets,
    successAccounts: batchContext.accounts.success,
    failedAccounts: batchContext.accounts.failed,
    confirmedExistsAccounts: batchContext.accounts.exists,
    knownExistsSkippedAccounts: batchContext.accounts.skipped.filter(item => String(item?.finalReason || item?.finalState || '') === 'KNOWN_EXISTS_ACCOUNT_SKIPPED'),
    skippedAccounts: batchContext.accounts.skipped,
    existsAccounts: batchContext.accounts.exists,
  };

  await fs.promises.writeFile(batchContext.paths.summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  await fs.promises.writeFile(batchContext.paths.latestSummaryFile, JSON.stringify(summary, null, 2), 'utf8');
  await writeKnownExistsAccounts(batchContext);

  let indexData = [];
  try {
    const existing = await fs.promises.readFile(batchContext.paths.indexFile, 'utf8');
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed)) indexData = parsed;
  } catch (_) {}

  const topFailureReason = Object.entries(batchContext.summary.failureReasonBuckets || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topExistsReason = Object.entries(summary.existsReasonBuckets || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const topSlowestStage = Object.entries(batchContext.summary.slowestStageBuckets || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  indexData.unshift({
    timestamp: new Date().toISOString(),
    runId: batchContext.runId,
    success: summary.success,
    systemStatus: summary.counts.failed > 0 ? 'failed' : 'healthy',
    existsStatus: summary.counts.exists > 0 ? 'has-confirmed-existing-accounts' : (summary.counts.knownExistsSkipped > 0 ? 'skipped-known-existing-accounts' : 'none'),
    durationMs: summary.durationMs,
    totalAccounts: summary.counts.total,
    successCount: summary.counts.success,
    existsCount: summary.counts.exists,
    knownExistsSkippedCount: summary.counts.knownExistsSkipped,
    failedCount: summary.counts.failed,
    skippedCount: summary.counts.skipped,
    counts: summary.counts,
    topExistsReason,
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

    let proxy = null;

    try {
      const normalizedEmail = String(account?.email || '').trim().toLowerCase();
      if (!batchContext.config.ignoreKnownExists && normalizedEmail && batchContext.knownExistsAccounts.has(normalizedEmail)) {
        updateWorkerStatus(workerId, {
          status: 'skip-known-exists',
          account: account.email,
          stage: 'precheck-skip',
          step: 'known-exists-skip-before-proxy-precheck',
          attempt,
          proxy: '',
          lastReason: 'KNOWN_EXISTS_ACCOUNT_SKIPPED',
          lastState: 'KNOWN_EXISTS_ACCOUNT_SKIPPED',
        });
        console.log(`[Dreamina Batch] 跳过已知已注册账号（代理预检前，账号已在 registered-accounts.json 保留） | account=${account?.email || ''} | worker=${workerId} | attempt=${attempt} | reason=KNOWN_EXISTS_ACCOUNT_SKIPPED`);
        const skippedResult = buildKnownExistsSkipResult(account, null);
        await updateBatchSummary(batchContext, skippedResult, {
          workerId,
          account,
          proxy: null,
        });
        continue;
      }

      proxy = acquireNextProxy(batchContext);
      if (!proxy) {
        batchContext.accounts.skipped.push({
          account: account.email,
          reason: 'NO_PROXY_AVAILABLE',
        });
        batchContext.summary.skippedCount += 1;
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

      const result = await runSingleAccountWithNewArchitecture({
        account,
        proxy,
        workerId,
        attempt,
        headed: batchContext.config.headed,
        slowMo: batchContext.config.slowMo,
      });

      await updateBatchSummary(batchContext, result, {
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

      await updateBatchSummary(batchContext, failedResult, {
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


function buildBatchFinalSummaryLines(summary = {}) {
  const lines = [];
  const existsBuckets = Object.entries(summary?.existsReasonBuckets || {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value}`)
    .join(' | ');
  const failureBuckets = Object.entries(summary?.failureReasonBuckets || {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value}`)
    .join(' | ');
  const successAccounts = Array.isArray(summary?.successAccounts)
    ? summary.successAccounts.map(item => item.account).filter(Boolean).join(', ')
    : '';
  const failedAccounts = Array.isArray(summary?.failedAccounts)
    ? summary.failedAccounts.map(item => `${item.account}:${item.finalReason || item.finalState || 'UNKNOWN'}`).filter(Boolean).join(', ')
    : '';
  const confirmedExistsAccounts = Array.isArray(summary?.confirmedExistsAccounts)
    ? summary.confirmedExistsAccounts.map(item => `${item.account}:${item.finalReason || item.finalState || 'UNKNOWN'}`).filter(Boolean).join(', ')
    : '';
  const knownExistsSkippedAccounts = Array.isArray(summary?.knownExistsSkippedAccounts)
    ? summary.knownExistsSkippedAccounts.map(item => `${item.account}:${item.finalReason || item.finalState || 'UNKNOWN'}`).filter(Boolean).join(', ')
    : '';
  const topSlowestStage = Object.entries(summary?.slowestStageBuckets || {})
    .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  if (existsBuckets) {
    lines.push(`[Dreamina Batch] ExistsBuckets: ${existsBuckets}`);
  }
  if ((summary?.counts?.knownExistsSkipped || 0) > 0) {
    lines.push(`[Dreamina Batch] KnownExistsSkipped: ${summary.counts.knownExistsSkipped}`);
  }
  if (failureBuckets) {
    lines.push(`[Dreamina Batch] FailureBuckets: ${failureBuckets}`);
  }
  if (successAccounts) {
    lines.push(`[Dreamina Batch] SuccessAccounts: ${successAccounts}`);
  }
  if (failedAccounts) {
    lines.push(`[Dreamina Batch] FailedAccounts: ${failedAccounts}`);
  }
  if (confirmedExistsAccounts) {
    lines.push(`[Dreamina Batch] ConfirmedExistsAccounts: ${confirmedExistsAccounts}`);
  }
  if (knownExistsSkippedAccounts) {
    lines.push(`[Dreamina Batch] KnownExistsSkippedAccounts: ${knownExistsSkippedAccounts}`);
  }
  if (topSlowestStage) {
    lines.push(`[Dreamina Batch] TopSlowestStage: ${topSlowestStage}`);
  }
  return lines;
}

async function runDreaminaBatch(argv = []) {
  const cli = parseBatchCliArgs(argv);
  const knownExistsAccounts = readKnownExistsAccounts();
  const pruneResult = cli.ignoreKnownExists
    ? { removedCount: 0, removedEmails: [], remainingAccounts: loadLocalAccounts() }
    : await pruneKnownRegisteredFromLocalPool(knownExistsAccounts);
  const accounts = selectBatchAccounts(pruneResult.remainingAccounts, cli);
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

  console.log(`[Dreamina Batch] runId=${batchContext.runId} | concurrency=${batchContext.config.concurrency} | accounts=${accounts.length} | proxies=${proxies.length} | ignoreKnownExists=${batchContext.config.ignoreKnownExists ? 'Y' : 'N'}`);
  if (!cli.ignoreKnownExists && pruneResult.removedCount > 0) {
    console.log(`[Dreamina Batch] 启动前已将已知已注册账号迁出待注册池，并保留到 registered-accounts.json | moved=${pruneResult.removedCount}`);
  }

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

  console.log(`[Dreamina Batch] success=${summary.success ? 'Y' : 'N'} | total=${summary.counts.total} | successCount=${summary.counts.success} | existsCount=${summary.counts.exists} | failedCount=${summary.counts.failed} | skippedCount=${summary.counts.skipped}`);
  for (const line of buildBatchFinalSummaryLines(summary)) {
    console.log(line);
  }
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
