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
const { loadLocalProxies, summarizeProxy } = require('./S0-proxy-precheck/local-proxy-loader');
const {
  loadProxyHealthStore,
  saveProxyHealthStore,
  resetProxyPrecheckState,
  upsertProxyHealthFromPrecheck,
  upsertProxyHealthFromRuntime,
  sortProxiesByHealth,
  buildProxyHealthPolicy,
  computeDecayedHealthScore,
  isProxyHardBlocked,
} = require('./S0-proxy-precheck/proxy-health-store');

const {
  updateWorkerStatus,
  markWorkerIdle,
  syncWorkerSnapshot,
  buildWorkerOverviewPanel,
} = require('../../shared-utils/worker-status-tracker');
const { runBatchOrchestration, createProxyLockSet } = require('../../shared-batch-orchestration');
const { isProxyHardFailure, isBusinessFailure, classifyFailure } = require('./failure-classifier');

// ─── Config 加载 ───────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

/**
 * 读取 config.json，合并 CLI 覆盖项。
 * 优先级：CLI 参数 > config.json > 代码默认值
 * @param {object} [cliOverrides={}]
 * @returns {object}
 */
function loadBatchConfig(cliOverrides = {}) {
  try {
    const base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // 移除 _comment 字段，避免影响类型
    const clean = JSON.parse(JSON.stringify(base, (k, v) => k.startsWith('_') ? undefined : v));
    // CLI 覆盖（CLI 参数优先）
    if (typeof cliOverrides.headed === 'boolean') clean.browser.headless = !cliOverrides.headed;
    if (cliOverrides.slowMo != null) clean.browser.slowMo = Number(cliOverrides.slowMo);
    if (cliOverrides.concurrency != null) clean.batch.concurrency = Number(cliOverrides.concurrency);
    if (cliOverrides.ignoreKnownExists != null) clean.batch.ignoreKnownExists = Boolean(cliOverrides.ignoreKnownExists);
    return clean;
  } catch (e) {
    console.warn(`[Config] config.json 读取失败，使用内置默认值: ${e.message}`);
    return {};
  }
}

// ─── 生产代理池加载器 ──────────────────────────────────────────────────────
const PROXIES_TXT_PATH = path.join(__dirname, 'proxies.txt');
const LOCAL_PROXIES_TXT_PATH = path.join(__dirname, 'S0-proxy-precheck', 'local-proxies.txt');

/**
 * 加载代理列表。优先读取 proxies.txt，fallback 到 S0-proxy-precheck/local-proxies.txt。
 * @returns {Array<object>}
 */
function loadProxies() {
  const filePath = fs.existsSync(PROXIES_TXT_PATH) && fs.statSync(PROXIES_TXT_PATH).size > 200
    ? PROXIES_TXT_PATH
    : LOCAL_PROXIES_TXT_PATH;
  console.log(`[Proxy] 代理池来源: ${filePath.replace(__dirname, '.')}`);
  return loadLocalProxies({ filePath });
}
const { createWindowLayoutPlanner, resolveVerificationBudget, resolveProxyPolicy } = require('../../shared-window-layout');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function resetFile(filePath) {
  ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, '', 'utf8');
}

const KNOWN_EXISTS_FILE = path.join(__dirname, 'batch-results', 'latest', 'dreamina-known-exists.json');
const KNOWN_REGISTERED_FILE = path.join(__dirname, 'batch-results', 'latest', 'dreamina-known-registered.json');
const LOCAL_ACCOUNTS_FILE = path.join(__dirname, 'local-accounts.json');
const REGISTERED_ACCOUNTS_FILE = path.join(__dirname, 'registered-accounts.json');
const SESSION_RECORDS_DIR = path.join(__dirname, 'session-records');
const SESSION_RECORDS_LATEST_TXT = path.join(SESSION_RECORDS_DIR, 'latest.txt');
const SESSION_RECORDS_LATEST_JSONL = path.join(SESSION_RECORDS_DIR, 'latest.jsonl');

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
function getProxySelectionTier(proxy = {}) {
  const summary = proxy?.lastProxyPrecheckSummary || null;
  const proxyGrade = String(summary?.proxyGrade || '').trim().toUpperCase();
  const capabilityGrade = String(summary?.capabilityGrade || '').trim().toUpperCase();
  const businessGrade = String(summary?.businessGrade || '').trim().toUpperCase();

  if (proxyGrade === 'OK' && capabilityGrade === 'ENTRY_READY_CAPABLE') return 3;
  if ((proxyGrade === 'OK' || proxyGrade === 'WEAK') && capabilityGrade === 'HOMEPAGE_USABLE') return 2;
  if (proxyGrade === 'WEAK') return 1;
  return 0;
}

function acquireNextProxy(batchContext) {
  const list = batchContext?.proxies?.list || [];
  if (!list.length) return null;

  const records = batchContext?.proxies?.healthStore?.records || {};
  const activeList = list.filter(proxy => {
    const proxyKey = proxy?.proxyKey || '';
    const record = proxyKey ? records[proxyKey] : null;
    return !isProxyHardBlocked(record || {});
  });
  if (!activeList.length) return null;

  const preferred = [];
  const fallback = [];
  for (const proxy of activeList) {
    const tier = getProxySelectionTier(proxy);
    if (tier >= 2) preferred.push(proxy);
    else fallback.push(proxy);
  }

  const sourceList = preferred.length ? preferred : activeList;
  const cursor = batchContext.proxies.cursor % sourceList.length;
  const proxy = sourceList[cursor] || null;
  batchContext.proxies.cursor = (cursor + 1) % sourceList.length;
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

function buildSessionArchiveLine(record = {}) {
  return [
    String(record?.email || '').trim().toLowerCase(),
    String(record?.countryCode || '').trim(),
    String(record?.countryName || '').trim(),
    String(record?.sessionId || '').trim(),
  ].join('----');
}

async function appendUniqueFileLine(filePath, line) {
  const normalizedLine = String(line || '').trim();
  if (!normalizedLine) return false;
  try {
    if (fs.existsSync(filePath)) {
      const existing = await fs.promises.readFile(filePath, 'utf8');
      const lines = new Set(String(existing || '').split(/\r?\n/).map(item => String(item || '').trim()).filter(Boolean));
      if (lines.has(normalizedLine)) {
        return false;
      }
    }
  } catch (_) {}
  await fs.promises.appendFile(filePath, `${normalizedLine}\n`, 'utf8');
  return true;
}

async function appendFirstSessionRecord(record = {}) {
  const sessionId = String(record?.sessionId || '').trim();
  const email = String(record?.email || '').trim();
  if (!email || !sessionId) {
    return { recorded: false, reason: 'SESSION_ID_MISSING' };
  }

  ensureDir(SESSION_RECORDS_DIR);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const batchTxt = path.join(SESSION_RECORDS_DIR, `dreamina-session-batch-${stamp}.txt`);
  const batchJsonl = path.join(SESSION_RECORDS_DIR, `dreamina-session-batch-${stamp}.jsonl`);
  const normalizedRecord = {
    ...record,
    email: String(record?.email || '').trim().toLowerCase(),
    countryCode: String(record?.countryCode || '').trim(),
    countryName: String(record?.countryName || '').trim(),
    sessionId: String(record?.sessionId || '').trim(),
    sessionSource: String(record?.sessionSource || '').trim(),
    recordedAt: String(record?.recordedAt || '').trim(),
  };
  const line = buildSessionArchiveLine(normalizedRecord);
  const jsonl = JSON.stringify(normalizedRecord);

  await fs.promises.appendFile(batchTxt, `${line}\n`, 'utf8');
  await fs.promises.appendFile(batchJsonl, `${jsonl}\n`, 'utf8');
  await appendUniqueFileLine(SESSION_RECORDS_LATEST_TXT, line);
  await appendUniqueFileLine(SESSION_RECORDS_LATEST_JSONL, jsonl);

  return {
    recorded: true,
    reason: 'FIRST_SESSION_RECORDED',
    txtFile: batchTxt,
    jsonlFile: batchJsonl,
  };
}

async function migrateAccountOutOfLocalPool(account = {}, result = {}) {
  const normalizedEmail = String(account?.email || result?.account?.email || '').trim().toLowerCase();
  if (!normalizedEmail) return { removed: false, appended: false, reason: 'EMPTY_EMAIL' };

  const localAccounts = readJsonArrayFile(LOCAL_ACCOUNTS_FILE);
  const registeredAccounts = readJsonArrayFile(REGISTERED_ACCOUNTS_FILE);
  const deliveryPayload = result?.deliveryPayload && typeof result.deliveryPayload === 'object' ? result.deliveryPayload : null;
  const sessionSummary = deliveryPayload?.sessionSummary && typeof deliveryPayload.sessionSummary === 'object' ? deliveryPayload.sessionSummary : null;
  const accountSummary = deliveryPayload?.accountSummary && typeof deliveryPayload.accountSummary === 'object' ? deliveryPayload.accountSummary : null;
  const sessionId = String(sessionSummary?.sessionId || sessionSummary?.cookieSummary?.matchedValue || '').trim();
  const sessionExtracted = Boolean(sessionId);
  const currentUrl = String(deliveryPayload?.currentUrl || '').trim();
  const countryCode = String(
    accountSummary?.countryCode
    || account?.countryCode
    || account?.proxyCountryCode
    || account?.country
    || ''
  ).trim();
  const countryName = String(
    accountSummary?.countryName
    || account?.countryName
    || account?.proxyCountryName
    || account?.countryLabel
    || ''
  ).trim();
  const nowIso = new Date().toISOString();

  const matchedLocal = localAccounts.find(item => String(item?.email || '').trim().toLowerCase() === normalizedEmail) || null;
  const nextLocalAccounts = localAccounts.filter(item => String(item?.email || '').trim().toLowerCase() !== normalizedEmail);
  const registeredIndex = registeredAccounts.findIndex(item => String(item?.email || '').trim().toLowerCase() === normalizedEmail);

  let appended = false;
  let updated = false;
  let firstSessionRecord = { recorded: false, reason: 'NOT_ATTEMPTED' };

  if (registeredIndex < 0) {
    registeredAccounts.push({
      email: matchedLocal?.email || account?.email || result?.account?.email || '',
      password: matchedLocal?.password || account?.password || '',
      source: result?.success ? 'register-success' : 'account-exists',
      status: result?.success ? 'registered' : 'exists',
      finalReason: String(result?.finalReason || result?.finalState || ''),
      finalState: String(result?.finalState || ''),
      sessionExtracted,
      firstSessionRecorded: false,
      firstSessionRecordedAt: '',
      countryCode,
      countryName,
      sessionId,
      currentUrl,
      sessionSource: String(sessionSummary?.source || '').trim(),
      lastSessionExtractedAt: sessionExtracted ? nowIso : '',
      movedAt: nowIso,
    });
    appended = true;
  } else {
    const existing = registeredAccounts[registeredIndex] || {};
    const next = {
      ...existing,
      email: existing.email || matchedLocal?.email || account?.email || result?.account?.email || '',
      password: existing.password || matchedLocal?.password || account?.password || '',
      finalReason: String(result?.finalReason || existing.finalReason || result?.finalState || ''),
      finalState: String(result?.finalState || existing.finalState || ''),
      status: result?.success ? 'registered' : (existing.status || 'exists'),
      source: existing.source || (result?.success ? 'register-success' : 'account-exists'),
      countryCode: String(existing.countryCode || countryCode || '').trim(),
      countryName: String(existing.countryName || countryName || '').trim(),
      currentUrl: currentUrl || String(existing.currentUrl || '').trim(),
      sessionSource: String(sessionSummary?.source || existing.sessionSource || '').trim(),
    };

    if (sessionExtracted) {
      next.sessionExtracted = true;
      next.sessionId = sessionId;
      next.lastSessionExtractedAt = nowIso;
    }

    registeredAccounts[registeredIndex] = next;
    updated = true;
  }

  const targetRecord = registeredAccounts[registeredIndex < 0 ? registeredAccounts.length - 1 : registeredIndex] || null;
  if (targetRecord && sessionExtracted && !targetRecord.firstSessionRecorded) {
    firstSessionRecord = await appendFirstSessionRecord({
      email: targetRecord.email,
      countryCode: targetRecord.countryCode || '',
      countryName: targetRecord.countryName || '',
      sessionId: targetRecord.sessionId || sessionId,
      sessionSource: targetRecord.sessionSource || '',
      recordedAt: nowIso,
    });
    if (firstSessionRecord.recorded) {
      targetRecord.firstSessionRecorded = true;
      targetRecord.firstSessionRecordedAt = nowIso;
    }
  }

  const removed = nextLocalAccounts.length !== localAccounts.length;
  if (removed) {
    await fs.promises.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(nextLocalAccounts, null, 2)}\n`, 'utf8');
  }
  if (appended || updated || firstSessionRecord.recorded) {
    await fs.promises.writeFile(REGISTERED_ACCOUNTS_FILE, `${JSON.stringify(registeredAccounts, null, 2)}\n`, 'utf8');
  }

  return {
    removed,
    appended,
    updated,
    sessionExtracted,
    sessionId,
    firstSessionRecorded: Boolean(firstSessionRecord.recorded),
    firstSessionRecord,
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
      layoutProfilePath: String(options.layoutProfilePath || ''),
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

    orchestration: {
      queueSummary: {
        total: pendingQueue.length,
        pending: pendingQueue.length,
        running: 0,
        done: 0,
        failed: 0,
      },
      workerSummary: {
        total: Math.max(1, Number(options.concurrency || 1)),
        idle: Math.max(1, Number(options.concurrency || 1)),
        running: 0,
        done: 0,
        failed: 0,
      },
      workers: [],
    },

    proxies: {
      total: Array.isArray(options.proxies) ? options.proxies.length : 0,
      list: Array.isArray(options.proxies) ? options.proxies : [],
      cursor: Math.max(0, Number(options.proxyStart || 0)),
      selectionPolicy: String(options.proxySelectionPolicy || 'fresh-batch-no-history'),
      healthStore: options.proxyHealthStore || { updatedAt: '', records: {} },
      healthPolicy: options.proxyHealthPolicy || { blockedCountries: [], blockedProviders: [], countryStats: {}, providerStats: {} },
    },

    knownExistsAccounts,

    summary: {
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      existsCount: 0,
      knownExistsSkippedCount: 0,
      retiredProxyCount: 0,
      retiredProxyKeys: [],
      retiredProxyReasonBuckets: {},
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

function buildStageSummaryText(stageResults = {}) {
  const ordered = [
    ['proxyPrecheck', 'proxyPrecheck'],
    ['entry', 'entry'],
    ['credential', 'credential'],
    ['verification', 'verification'],
    ['profileCompletion', 'profileCompletion'],
    ['postAuthReady', 'postAuthReady'],
    ['accountDelivery', 'accountDelivery'],
  ];
  return ordered.map(([key, label]) => {
    const item = stageResults?.[key];
    if (!item) return `${label}=SKIP`;
    return `${label}=${String(item.state || (item.success ? 'OK' : 'UNKNOWN') || 'UNKNOWN')}`;
  }).join(', ');
}

function buildSlowestStageText(stageResults = {}) {
  const ordered = [
    ['proxyPrecheck', 'proxyPrecheck'],
    ['entry', 'entry'],
    ['credential', 'credential'],
    ['verification', 'verification'],
    ['profileCompletion', 'profileCompletion'],
    ['postAuthReady', 'postAuthReady'],
    ['accountDelivery', 'accountDelivery'],
  ];

  let winner = null;
  for (const [key, label] of ordered) {
    const item = stageResults?.[key];
    const duration = Number(item?.detail?.durationMs ?? item?.durationMs ?? NaN);
    if (!Number.isFinite(duration)) continue;
    if (!winner || duration > winner.durationMs) {
      winner = { label, durationMs: duration, state: String(item?.state || '') };
    }
  }

  return winner ? `${winner.label}=${winner.durationMs}ms${winner.state ? `(${winner.state})` : ''}` : '';
}

function buildNumericStats(values = []) {
  const list = (Array.isArray(values) ? values : []).map(item => Number(item)).filter(Number.isFinite);
  if (!list.length) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      sampleCount: 0,
    };
  }
  const total = list.reduce((sum, item) => sum + item, 0);
  return {
    min: Math.min(...list),
    max: Math.max(...list),
    avg: Math.round(total / list.length),
    sampleCount: list.length,
  };
}

function buildEntrySlowSample(record = {}) {
  const entry = record?.stageResults?.entry || {};
  const detail = entry?.detail || record?.detail?.entry || {};
  const timing = detail?.timingBreakdown || {};
  const confirmTimingBreakdown = timing?.confirmTimingBreakdown || {};
  const waitTrace = detail?.healthTrace?.detail?.waitTrace || {};
  const signalTimeline = detail?.signalTimeline || {};
  const readyTraceEnvelope = detail?.readyTrace || {};
  const readyTrace = readyTraceEnvelope?.readyTrace && typeof readyTraceEnvelope.readyTrace === 'object'
    ? readyTraceEnvelope.readyTrace
    : readyTraceEnvelope;
  const confirmTrace = readyTrace?.confirmTrace || detail?.confirmTrace || {};
  const recoveryPhaseTrace = detail?.recoveryPhaseTrace || readyTraceEnvelope?.recoveryPhaseTrace || {};
  const gateTrace = readyTrace?.gateTrace || detail?.gateTrace || {};
  const waitForEntryReadyPhaseTrace = confirmTimingBreakdown?.waitForEntryReadyPhaseTrace && typeof confirmTimingBreakdown.waitForEntryReadyPhaseTrace === 'object'
    ? confirmTimingBreakdown.waitForEntryReadyPhaseTrace
    : readyTrace?.waitForEntryReadyPhaseTrace && typeof readyTrace.waitForEntryReadyPhaseTrace === 'object'
      ? readyTrace.waitForEntryReadyPhaseTrace
      : detail?.waitForEntryReadyPhaseTrace && typeof detail.waitForEntryReadyPhaseTrace === 'object'
        ? detail.waitForEntryReadyPhaseTrace
        : {};

  return {
    account: String(record?.account || ''),
    workerId: Number(record?.workerId || 0),
    durationMs: Number(entry?.durationMs ?? record?.durationMs ?? 0),
    openEntryPageMs: Number(timing?.openEntryPageMs || 0),
    checkEntryHealthMs: Number(timing?.checkEntryHealthMs || 0),
    confirmEntryReadyMs: Number(timing?.confirmEntryReadyMs || 0),
    totalBeforeSettleMs: Number(timing?.totalBeforeSettleMs || 0),
    outerConfirmMs: Number(confirmTimingBreakdown?.outerConfirmMs || 0),
    gateConfirmMs: Number(confirmTimingBreakdown?.gateConfirmMs || 0),
    confirmWrapperOverheadMs: Number(confirmTimingBreakdown?.wrapperOverheadMs || 0),
    waitWrapperMs: Number(confirmTimingBreakdown?.waitWrapperMs || 0),
    wrapperResidualMs: Number(confirmTimingBreakdown?.wrapperResidualMs || 0),
    waitTimelineMs: Number(waitForEntryReadyPhaseTrace?.timelineWaitMs || 0),
    waitEnsureGateMs: Number(waitForEntryReadyPhaseTrace?.ensureGateMs || 0),
    waitRecoverSignalsMs: Number(waitForEntryReadyPhaseTrace?.recoverSignalsMs || 0),
    waitReensureGateMs: Number(waitForEntryReadyPhaseTrace?.reensureGateMs || 0),
    waitDebugSnapshotMs: Number(waitForEntryReadyPhaseTrace?.debugSnapshotMs || 0),
    waitResolvedPath: String(waitForEntryReadyPhaseTrace?.resolvedPath || ''),
    waitRecoveredSignals: Boolean(waitForEntryReadyPhaseTrace?.recoveredSignals),
    recoveryInitialWaitMs: Number(recoveryPhaseTrace?.initialWaitMs || 0),
    recoveryClassifyMs: Number(recoveryPhaseTrace?.classifyMs || 0),
    recoveryRecoverMs: Number(recoveryPhaseTrace?.recoverMs || 0),
    recoveryPreprocessAfterRecoverMs: Number(recoveryPhaseTrace?.preprocessAfterRecoverMs || 0),
    recoveryRewaitMs: Number(recoveryPhaseTrace?.rewaitMs || 0),
    recoveryResolvedPath: String(recoveryPhaseTrace?.resolvedPath || ''),
    matchedKind: String(waitTrace?.matchedKind || ''),
    matchedValue: String(waitTrace?.matchedValue || ''),
    source: String(entry?.source || detail?.source || ''),
    ctaSource: String(signalTimeline?.ctaSource || ''),
    ctaOpenedGateMs: Number(signalTimeline?.ctaOpenedGateMs || 0),
    postClickGateReadyMs: Number(signalTimeline?.postClickGateReadyMs || 0),
    continueWithEmailVisibleMs: Number(signalTimeline?.continueWithEmailVisible?.firstSeenMs || 0),
    emailInputVisibleMs: Number(signalTimeline?.emailInputVisible?.firstSeenMs || 0),
    signInVisibleMs: Number(signalTimeline?.['text:Sign in']?.firstSeenMs || 0),
    outerConfirmResolvedAtMs: Number(confirmTrace?.resolvedAtMs || 0),
    outerConfirmResolvedBy: String(confirmTrace?.resolvedBy || ''),
    outerConfirmResolvedState: String(confirmTrace?.resolvedState || ''),
    outerConfirmResolvedReason: String(confirmTrace?.resolvedReason || ''),
    gateResolvedAtMs: Number(gateTrace?.resolvedAtMs || 0),
    gateResolvedState: String(gateTrace?.resolvedState || ''),
    gateResolvedReason: String(gateTrace?.resolvedReason || ''),
    finalState: String(record?.finalState || ''),
    stageSummary: String(record?.stageSummary || ''),
  };
}

function buildBatchFingerprintSummary(input = null) {
  const summary = input && typeof input === 'object' ? input : {};
  return {
    userAgent: String(summary?.userAgent || ''),
    viewport: String(summary?.viewport || ''),
    locale: String(summary?.locale || ''),
    timezoneId: String(summary?.timezoneId || ''),
    colorScheme: String(summary?.colorScheme || ''),
    deviceScaleFactor: Number(summary?.deviceScaleFactor || 0),
    randomEnabled: Boolean(summary?.randomEnabled),
  };
}

function buildBatchAccountRecord(result = {}, extra = {}) {
  const stageResults = result?.stageResults && typeof result.stageResults === 'object'
    ? { ...result.stageResults }
    : {};

  const topLevelDetail = result?.detail && typeof result.detail === 'object'
    ? result.detail
    : null;

  const stageDetailSummary = Object.entries(stageResults).reduce((acc, [stageKey, stageResult]) => {
    if (stageResult && typeof stageResult === 'object' && stageResult.detail && typeof stageResult.detail === 'object') {
      acc[stageKey] = stageResult.detail;
    }
    return acc;
  }, {});

  const derivedDetail = Object.keys(stageDetailSummary).length > 0
    ? {
        ...(topLevelDetail ? { finalStageDetail: topLevelDetail } : {}),
        ...stageDetailSummary,
      }
    : (topLevelDetail
      || stageResults[result?.finalStage]?.detail
      || stageResults.accountDelivery?.detail
      || stageResults.postAuthReady?.detail
      || null);

  const stageSummary = buildStageSummaryText(stageResults);
  const slowestStage = buildSlowestStageText(stageResults);

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
    fingerprintSummary: buildBatchFingerprintSummary(result?.fingerprintSummary || result?.meta?.fingerprintSummary || null),
    resultFile: String(result?.meta?.resultFile || result?.meta?.filePath || ''),
    latestResultFile: String(result?.meta?.latestResultFile || result?.meta?.latestByAccount || ''),
    batchBucketPath: String(
      extra?.bucket === 'exists'
        ? (extra?.batchContext?.paths?.existsDir || '')
        : extra?.bucket === 'success'
          ? (extra?.batchContext?.paths?.successDir || '')
          : (extra?.batchContext?.paths?.failedDir || '')
    ),
    stageSummary,
    slowestStage,
    detail: derivedDetail,
    deliveryPayload: result?.deliveryPayload || null,
    stageResults,
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

function isTerminalBusinessFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim();
  return [
    'DREAMINA_ACCOUNT_ALREADY_EXISTS',
    'ACCOUNT_ALREADY_EXISTS',
    'DREAMINA_ACCOUNT_ALREADY_EXISTS_PRECHECK',
    'ACCOUNT_ALREADY_EXISTS_PRECHECK',
    'SIGNUP_REJECTED',
    'DREAMINA_SIGNUP_REJECTED',
    'SIGNUP_REJECTED_IP_BANNED',
    'DREAMINA_SIGNUP_REJECTED_IP_BANNED',
    'VERIFICATION_CODE_RATE_LIMITED',
    'DREAMINA_VERIFICATION_CODE_RATE_LIMITED',
    'KNOWN_EXISTS_ACCOUNT_SKIPPED',
  ].includes(reason);
}

function isRetryableProxyOrEnvironmentFailure(result = {}) {
  const reason = String(result?.finalReason || result?.finalState || '').trim();
  if (!reason) return false;
  if (isTerminalBusinessFailure(result)) return false;
  return [
    'DREAMINA_PROXY_CONNECTIVITY_FAILED',
    'PROXY_CONNECTIVITY_FAILED',
    'DREAMINA_PROXY_PRECHECK_BAD',
    'PROXY_PRECHECK_BAD',
    'DREAMINA_BROWSER_SMOKE_BLANK_PAGE',
    'DREAMINA_BROWSER_SMOKE_FAILED',
    'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT',
    'ENTRY_PAGE_OPEN_FAILED',
    'DREAMINA_ENTRY_PAGE_OPEN_FAILED',
    'DREAMINA_WHITE_SCREEN',
    'DREAMINA_FIRST_LOAD_DEAD_PAGE',
    'DREAMINA_READY_SIGNAL_MISSING',
    'DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY',
    'DREAMINA_LOGIN_ENTRY_NOT_FOUND',
    'LOGIN_ENTRY_FAILED',
    'LOGIN_ENTRY_CLICK_NO_STATE_CHANGE',
  ].includes(reason);
}

function shouldRetryAccountWithNextProxy(result = {}, attempt = 1, batchContext = {}) {
  const maxAttempts = Math.max(1, Number(batchContext?.config?.maxProxyRetriesPerAccount || 2));
  if (attempt >= maxAttempts) return false;
  return isRetryableProxyOrEnvironmentFailure(result);
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

  const recordFiles = await writeBatchAccountRecordFile(batchContext, record);
  record.resultFile = String(recordFiles?.filePath || record.resultFile || '');
  record.latestResultFile = String(recordFiles?.latestByAccount || record.latestResultFile || '');

  if ((result?.success || existsFailure) && normalizedEmail) {
    const migration = await migrateAccountOutOfLocalPool(extra?.account || result?.account || {}, result);
    record.accountPoolMigration = migration;
  }
}

function buildBatchOverviewLines(batchContext) {
  const queueSummary = batchContext?.orchestration?.queueSummary || {};
  const pending = Number(queueSummary.pending || 0);
  const running = Number(queueSummary.running || 0);
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
    windowLayout: options.windowLayout || null,
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
    verificationBudget = null,
    proxyPolicy = null,
  } = options;

  const runtimeBundle = await createWorkerRuntime({
    proxy,
    headed,
    slowMo,
    windowLayout: options.windowLayout || null,
  });

  try {
    const result = await runDreaminaRegisterFlow({
      browser: runtimeBundle.browser,
      context: runtimeBundle.context,
      page: runtimeBundle.page,
      proxy,
      account: {
        ...account,
        proxyCountryCode: String(proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
        proxyCountryName: String(proxy?.countryName || proxy?.proxyCountryName || '').trim(),
        countryCode: String(account?.countryCode || proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
        countryName: String(account?.countryName || proxy?.countryName || proxy?.proxyCountryName || '').trim(),
      },
      runtime: {
        batch: true,
        cli: false,
        headed,
        slowMo,
        workerId,
        attempt,
        proxyCountryCode: String(proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
        proxyCountryName: String(proxy?.countryName || proxy?.proxyCountryName || '').trim(),
        dreaminaHomeUrl: 'https://dreamina.capcut.com/ai-tool/home',
        proxyConnectivityTimeoutMs: Number(proxyPolicy?.connectivityTimeoutMs || 8000),
        proxyPrimaryTargetTimeoutMs: Number(proxyPolicy?.primaryTargetTimeoutMs || 10000),
        proxySecondaryTargetTimeoutMs: Number(proxyPolicy?.secondaryTargetTimeoutMs || 8000),
        proxyEnableSecondaryTarget: Boolean(proxyPolicy?.enableSecondaryTarget ?? true),
        entryGotoTimeoutMs: 120000,
        dreaminaNavigationTimeoutMs: 120000,
        firstLoadGraceWaitMs: 12000,
        dreaminaAuthMode: 'signup',
        credentialSignupSwitchWaitMs: 1200,
        verificationRetryMaxAttempts: Number(verificationBudget?.verificationRetryMaxAttempts || 3),
        verificationResendWaitMs: Number(verificationBudget?.verificationResendWaitMs || 1800),
        skipCredentialExistsPrecheckAfterEmail: true,
        firstmailApiMaxPollAttempts: Number(verificationBudget?.firstmailApiMaxPollAttempts || 6),
        waitMailIntervalMs: Number(verificationBudget?.waitMailIntervalMs || 2500),
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
          'Explore Create Assets',
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
  const latestByAccount = path.join(batchContext.paths.latestDir, `dreamina-batch-${account}-latest.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
  await fs.promises.writeFile(latestByAccount, JSON.stringify(record, null, 2), 'utf8');
  record.batchRecordFile = filePath;
  record.resultFile = filePath;
  record.latestResultFile = latestByAccount;
  return {
    filePath,
    latestByAccount,
  };
}

async function writeBatchSummaryFile(batchContext) {
  batchContext.finishedAt = Date.now();
  batchContext.durationMs = Math.max(0, batchContext.finishedAt - batchContext.startedAt);

  const allAccountRecords = [
    ...(Array.isArray(batchContext.accounts.success) ? batchContext.accounts.success : []),
    ...(Array.isArray(batchContext.accounts.failed) ? batchContext.accounts.failed : []),
    ...(Array.isArray(batchContext.accounts.exists) ? batchContext.accounts.exists : []),
    ...(Array.isArray(batchContext.accounts.skipped) ? batchContext.accounts.skipped : []),
  ];

  const allEntrySamples = allAccountRecords
    .filter(item => item?.stageResults?.entry)
    .map(buildEntrySlowSample);

  const entrySlowSamples = [...allEntrySamples]
    .sort((a, b) => Number(b?.durationMs || 0) - Number(a?.durationMs || 0))
    .slice(0, 5);

  const matchedSignalBuckets = allEntrySamples.reduce((acc, item) => {
    const key = `${String(item?.matchedKind || '')}:${String(item?.matchedValue || '')}` || 'UNKNOWN';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  const entryConcurrencyStats = {
    sampleCount: allEntrySamples.length,
    durationMs: buildNumericStats(allEntrySamples.map(item => item.durationMs)),
    openEntryPageMs: buildNumericStats(allEntrySamples.map(item => item.openEntryPageMs)),
    checkEntryHealthMs: buildNumericStats(allEntrySamples.map(item => item.checkEntryHealthMs)),
    confirmEntryReadyMs: buildNumericStats(allEntrySamples.map(item => item.confirmEntryReadyMs)),
    totalBeforeSettleMs: buildNumericStats(allEntrySamples.map(item => item.totalBeforeSettleMs)),
    matchedSignalBuckets,
    topMatchedSignals: Object.entries(matchedSignalBuckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => ({ key, count })),
  };

  const concurrencyProfileSnapshot = {
    concurrency: Number(batchContext?.config?.concurrency || 0),
    verificationBudget: batchContext?.concurrencyPolicy?.verificationBudget || null,
    proxyPolicy: batchContext?.concurrencyPolicy?.proxyPolicy || null,
    layoutPreset: batchContext?.windowLayout?.resolvedPreset
      ? {
          mode: String(batchContext.windowLayout.resolvedPreset.mode || ''),
          cols: Number(batchContext.windowLayout.resolvedPreset.cols || 0),
          rows: Number(batchContext.windowLayout.resolvedPreset.rows || 0),
          scale: Number(batchContext.windowLayout.resolvedPreset.scale || 0),
          usageRatio: Number(batchContext.windowLayout.resolvedPreset.usageRatio || 0),
          gap: Number(batchContext.windowLayout.resolvedPreset.gap || 0),
          outerMargin: Number(batchContext.windowLayout.resolvedPreset.outerMargin || 0),
          width: Number(batchContext.windowLayout.resolvedPreset.width || 0),
          height: Number(batchContext.windowLayout.resolvedPreset.height || 0),
          cellWidth: Number(batchContext.windowLayout.resolvedPreset.cellWidth || 0),
          cellHeight: Number(batchContext.windowLayout.resolvedPreset.cellHeight || 0),
        }
      : null,
    layoutProfilePath: String(batchContext?.windowLayout?.profilePath || ''),
  };

  const fingerprintSummaries = allAccountRecords
    .map(item => buildBatchFingerprintSummary(item?.fingerprintSummary || null))
    .filter(item => item.userAgent || item.viewport || item.locale || item.timezoneId);

  const proxyPrecheckSummaries = batchContext.accounts.success
    .concat(batchContext.accounts.failed)
    .concat(batchContext.accounts.exists)
    .concat(batchContext.accounts.skipped)
    .map(item => item?.proxyPrecheckSummary)
    .filter(item => item && typeof item === 'object');

  const proxyHealthRecords = Object.values(batchContext?.proxies?.healthStore?.records || {}).map((item) => ({
    ...item,
    healthScore: computeDecayedHealthScore(item),
  }));
  const proxyHealthTopGood = [...proxyHealthRecords]
    .sort((a, b) => Number(b.healthScore || 0) - Number(a.healthScore || 0))
    .slice(0, 5);
  const proxyHealthTopBad = [...proxyHealthRecords]
    .sort((a, b) => Number(a.healthScore || 0) - Number(b.healthScore || 0))
    .slice(0, 5);

  const proxyPrecheckGradeBuckets = proxyPrecheckSummaries.reduce((acc, item) => {
    const key = `${String(item?.proxyGrade || 'NA')}/${String(item?.capabilityGrade || 'NA')}/${String(item?.businessGrade || 'NA')}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

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
    concurrencyPolicy: batchContext.concurrencyPolicy || null,
    proxySelectionPolicy: String(batchContext?.proxies?.selectionPolicy || ''),
    proxyHealthPolicy: batchContext?.proxies?.healthPolicy || null,
    concurrencyProfileSnapshot,
    entryConcurrencyStats,
    layoutProfile: {
      path: String(batchContext?.windowLayout?.profilePath || ''),
      preset: batchContext?.windowLayout?.resolvedPreset
        ? {
            mode: String(batchContext.windowLayout.resolvedPreset.mode || ''),
            cols: Number(batchContext.windowLayout.resolvedPreset.cols || 0),
            rows: Number(batchContext.windowLayout.resolvedPreset.rows || 0),
            scale: Number(batchContext.windowLayout.resolvedPreset.scale || 0),
            usageRatio: Number(batchContext.windowLayout.resolvedPreset.usageRatio || 0),
            gap: Number(batchContext.windowLayout.resolvedPreset.gap || 0),
            outerMargin: Number(batchContext.windowLayout.resolvedPreset.outerMargin || 0),
            width: Number(batchContext.windowLayout.resolvedPreset.width || 0),
            height: Number(batchContext.windowLayout.resolvedPreset.height || 0),
            cellWidth: Number(batchContext.windowLayout.resolvedPreset.cellWidth || 0),
            cellHeight: Number(batchContext.windowLayout.resolvedPreset.cellHeight || 0),
          }
        : null,
    },
    fingerprintSummary: fingerprintSummaries[0] || null,
    fingerprintSamples: fingerprintSummaries.slice(0, 10),
    proxyPrecheckOverview: {
      totalSamples: proxyPrecheckSummaries.length,
      gradeBuckets: proxyPrecheckGradeBuckets,
      samples: proxyPrecheckSummaries.slice(0, 10),
    },
    proxyHealthTopGood,
    proxyHealthTopBad,
    retiredProxyCount: Number(batchContext.summary.retiredProxyCount || 0),
    retiredProxyKeys: Array.isArray(batchContext.summary.retiredProxyKeys) ? batchContext.summary.retiredProxyKeys : [],
    retiredProxyReasonBuckets: batchContext.summary.retiredProxyReasonBuckets || {},
    entrySlowSamples,
    successAccounts: batchContext.accounts.success,
    failedAccounts: batchContext.accounts.failed,
    confirmedExistsAccounts: batchContext.accounts.exists,
    knownExistsSkippedAccounts: batchContext.accounts.skipped.filter(item => String(item?.finalReason || item?.finalState || '') === 'KNOWN_EXISTS_ACCOUNT_SKIPPED'),
    skippedAccounts: batchContext.accounts.skipped,
    existsAccounts: batchContext.accounts.exists,
  };

  await fs.promises.writeFile(batchContext.paths.summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  await fs.promises.writeFile(batchContext.paths.latestSummaryFile, JSON.stringify(summary, null, 2), 'utf8');
  saveProxyHealthStore(batchContext?.proxies?.healthStore || { updatedAt: '', records: {} });
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
  const concurrencyPolicy = summary.concurrencyPolicy || null;
  const persistedConcurrencyProfileSnapshot = summary?.concurrencyProfileSnapshot || null;
  const persistedEntryConcurrencyStats = summary?.entryConcurrencyStats || null;
  const layoutPreset = summary?.layoutProfile?.preset || null;
  const topEntrySlowSample = Array.isArray(summary.entrySlowSamples) && summary.entrySlowSamples.length > 0
    ? {
        account: String(summary.entrySlowSamples[0]?.account || ''),
        durationMs: Number(summary.entrySlowSamples[0]?.durationMs || 0),
        openEntryPageMs: Number(summary.entrySlowSamples[0]?.openEntryPageMs || 0),
        checkEntryHealthMs: Number(summary.entrySlowSamples[0]?.checkEntryHealthMs || 0),
        confirmEntryReadyMs: Number(summary.entrySlowSamples[0]?.confirmEntryReadyMs || 0),
        matchedKind: String(summary.entrySlowSamples[0]?.matchedKind || ''),
        matchedValue: String(summary.entrySlowSamples[0]?.matchedValue || ''),
        source: String(summary.entrySlowSamples[0]?.source || ''),
        ctaSource: String(summary.entrySlowSamples[0]?.ctaSource || ''),
        ctaOpenedGateMs: Number(summary.entrySlowSamples[0]?.ctaOpenedGateMs || 0),
        postClickGateReadyMs: Number(summary.entrySlowSamples[0]?.postClickGateReadyMs || 0),
        continueWithEmailVisibleMs: Number(summary.entrySlowSamples[0]?.continueWithEmailVisibleMs || 0),
        emailInputVisibleMs: Number(summary.entrySlowSamples[0]?.emailInputVisibleMs || 0),
        signInVisibleMs: Number(summary.entrySlowSamples[0]?.signInVisibleMs || 0),
        outerConfirmMs: Number(summary.entrySlowSamples[0]?.outerConfirmMs || 0),
        gateConfirmMs: Number(summary.entrySlowSamples[0]?.gateConfirmMs || 0),
        confirmWrapperOverheadMs: Number(summary.entrySlowSamples[0]?.confirmWrapperOverheadMs || 0),
        waitWrapperMs: Number(summary.entrySlowSamples[0]?.waitWrapperMs || 0),
        wrapperResidualMs: Number(summary.entrySlowSamples[0]?.wrapperResidualMs || 0),
        waitTimelineMs: Number(summary.entrySlowSamples[0]?.waitTimelineMs || 0),
        waitEnsureGateMs: Number(summary.entrySlowSamples[0]?.waitEnsureGateMs || 0),
        waitRecoverSignalsMs: Number(summary.entrySlowSamples[0]?.waitRecoverSignalsMs || 0),
        waitReensureGateMs: Number(summary.entrySlowSamples[0]?.waitReensureGateMs || 0),
        waitDebugSnapshotMs: Number(summary.entrySlowSamples[0]?.waitDebugSnapshotMs || 0),
        waitResolvedPath: String(summary.entrySlowSamples[0]?.waitResolvedPath || ''),
        waitRecoveredSignals: Boolean(summary.entrySlowSamples[0]?.waitRecoveredSignals),
        recoveryInitialWaitMs: Number(summary.entrySlowSamples[0]?.recoveryInitialWaitMs || 0),
        recoveryClassifyMs: Number(summary.entrySlowSamples[0]?.recoveryClassifyMs || 0),
        recoveryRecoverMs: Number(summary.entrySlowSamples[0]?.recoveryRecoverMs || 0),
        recoveryPreprocessAfterRecoverMs: Number(summary.entrySlowSamples[0]?.recoveryPreprocessAfterRecoverMs || 0),
        recoveryRewaitMs: Number(summary.entrySlowSamples[0]?.recoveryRewaitMs || 0),
        recoveryResolvedPath: String(summary.entrySlowSamples[0]?.recoveryResolvedPath || ''),
        outerConfirmResolvedAtMs: Number(summary.entrySlowSamples[0]?.outerConfirmResolvedAtMs || 0),
        outerConfirmResolvedBy: String(summary.entrySlowSamples[0]?.outerConfirmResolvedBy || ''),
        outerConfirmResolvedState: String(summary.entrySlowSamples[0]?.outerConfirmResolvedState || ''),
        outerConfirmResolvedReason: String(summary.entrySlowSamples[0]?.outerConfirmResolvedReason || ''),
        gateResolvedAtMs: Number(summary.entrySlowSamples[0]?.gateResolvedAtMs || 0),
        gateResolvedState: String(summary.entrySlowSamples[0]?.gateResolvedState || ''),
        gateResolvedReason: String(summary.entrySlowSamples[0]?.gateResolvedReason || ''),
        layoutPreset: layoutPreset
          ? {
              mode: String(layoutPreset.mode || ''),
              cols: Number(layoutPreset.cols || 0),
              rows: Number(layoutPreset.rows || 0),
              scale: Number(layoutPreset.scale || 0),
              usageRatio: Number(layoutPreset.usageRatio || 0),
              gap: Number(layoutPreset.gap || 0),
              outerMargin: Number(layoutPreset.outerMargin || 0),
              width: Number(layoutPreset.width || 0),
              height: Number(layoutPreset.height || 0),
            }
          : null,
        verificationBudget: concurrencyPolicy?.verificationBudget || null,
        proxyPolicy: concurrencyPolicy?.proxyPolicy || null,
      }
    : null;

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
    topEntrySlowSample,
    verificationBudget: concurrencyPolicy?.verificationBudget || null,
    concurrencyProfileSnapshot: persistedConcurrencyProfileSnapshot,
    entryConcurrencyStats: persistedEntryConcurrencyStats,
    layoutProfilePath: String(summary?.layoutProfile?.path || ''),
    layoutPreset: layoutPreset
      ? {
          mode: String(layoutPreset.mode || ''),
          cols: Number(layoutPreset.cols || 0),
          rows: Number(layoutPreset.rows || 0),
          scale: Number(layoutPreset.scale || 0),
          usageRatio: Number(layoutPreset.usageRatio || 0),
          gap: Number(layoutPreset.gap || 0),
          outerMargin: Number(layoutPreset.outerMargin || 0),
          width: Number(layoutPreset.width || 0),
          height: Number(layoutPreset.height || 0),
        }
      : null,
    summaryFile: batchContext.paths.summaryFile,
  });
  indexData = indexData.slice(0, 30);
  await fs.promises.writeFile(batchContext.paths.indexFile, JSON.stringify(indexData, null, 2), 'utf8');

  return summary;
}

async function processBatchTask({ workerId, task, payload, batchContext }) {
  const account = payload?.account || null;
  const initialAttempt = Number(task?.attempts || 1);
  if (!account) {
    return {
      success: false,
      finalStage: 'batch-runner',
      finalState: 'BATCH_TASK_ACCOUNT_MISSING',
      finalReason: 'BATCH_TASK_ACCOUNT_MISSING',
      meta: { durationMs: 0 },
    };
  }

  batchContext.accounts.running.push(account.email);

  try {
    const normalizedEmail = String(account?.email || '').trim().toLowerCase();
    if (!batchContext.config.ignoreKnownExists && normalizedEmail && batchContext.knownExistsAccounts.has(normalizedEmail)) {
      updateWorkerStatus(workerId, {
        status: 'skip-known-exists',
        account: account.email,
        stage: 'precheck-skip',
        step: 'known-exists-skip-before-proxy-precheck',
        attempt: initialAttempt,
        proxy: '',
        lastReason: 'KNOWN_EXISTS_ACCOUNT_SKIPPED',
        lastState: 'KNOWN_EXISTS_ACCOUNT_SKIPPED',
      });
      console.log(`[Dreamina Batch] 跳过已知已注册账号（代理预检前，账号已在 registered-accounts.json 保留） | account=${account?.email || ''} | worker=${workerId} | attempt=${initialAttempt} | reason=KNOWN_EXISTS_ACCOUNT_SKIPPED`);
      const skippedResult = buildKnownExistsSkipResult(account, null);
      await updateBatchSummary(batchContext, skippedResult, {
        workerId,
        account,
        proxy: null,
      });
      return skippedResult;
    }

    const maxAttempts = Math.max(initialAttempt, Number(batchContext?.config?.maxProxyRetriesPerAccount || 2));
    let attempt = initialAttempt;
    let lastResult = null;
    let lastProxy = null;

    while (attempt <= maxAttempts) {
      const proxy = acquireNextProxy(batchContext);
      lastProxy = proxy;
      if (!proxy) {
        const noProxyResult = {
          success: false,
          skipped: true,
          finalStage: 'batch-runner',
          finalState: 'NO_PROXY_AVAILABLE',
          finalReason: 'NO_PROXY_AVAILABLE',
          meta: { durationMs: 0, attempt },
        };
        if (!lastResult) {
          await updateBatchSummary(batchContext, noProxyResult, {
            workerId,
            account,
            proxy: null,
          });
        }
        return lastResult || noProxyResult;
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

      const windowLayout = batchContext?.windowLayout?.planner
        ? batchContext.windowLayout.planner.resolve(workerId, batchContext.config.concurrency)
        : null;
      const verificationBudget = batchContext?.concurrencyPolicy?.verificationBudget || null;
      const proxyPolicy = batchContext?.concurrencyPolicy?.proxyPolicy || null;
      const staggerMs = Math.max(0, Number(proxyPolicy?.workerStartStaggerMs || 0)) * Math.max(0, workerId - 1);
      if (staggerMs > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }

      const result = await runSingleAccountWithNewArchitecture({
        account,
        proxy,
        workerId,
        attempt,
        headed: batchContext.config.headed,
        slowMo: batchContext.config.slowMo,
        windowLayout,
        verificationBudget,
        proxyPolicy,
      });
      lastResult = result;

      if (proxy && result?.proxyPrecheckSummary && typeof result.proxyPrecheckSummary === 'object') {
        proxy.lastProxyPrecheckSummary = result.proxyPrecheckSummary;
        const precheckUpdated = upsertProxyHealthFromPrecheck(batchContext?.proxies?.healthStore || {}, proxy, result.proxyPrecheckSummary);
        batchContext.proxies.healthStore = precheckUpdated.store;
      }
      if (proxy) {
        const runtimeUpdated = upsertProxyHealthFromRuntime(batchContext?.proxies?.healthStore || {}, proxy, result);
        batchContext.proxies.healthStore = runtimeUpdated.store;
        if (isProxyHardBlocked(runtimeUpdated?.record || {})) {
          const blockedKey = String(runtimeUpdated?.record?.proxyKey || proxy?.proxyKey || '').trim();
          const beforeCount = (batchContext.proxies.list || []).length;
          batchContext.proxies.list = (batchContext.proxies.list || []).filter(item => String(item?.proxyKey || '').trim() !== blockedKey);
          const removed = beforeCount !== (batchContext.proxies.list || []).length;
          if (removed && blockedKey && !batchContext.summary.retiredProxyKeys.includes(blockedKey)) {
            const blockedReason = String(runtimeUpdated?.record?.blockedReason || result?.finalReason || result?.finalState || 'UNKNOWN').trim() || 'UNKNOWN';
            batchContext.summary.retiredProxyKeys.push(blockedKey);
            batchContext.summary.retiredProxyCount = batchContext.summary.retiredProxyKeys.length;
            incrementBucket(batchContext.summary.retiredProxyReasonBuckets, blockedReason);
          }
        }
      }

      if (result?.success || isTerminalBusinessFailure(result) || !shouldRetryAccountWithNextProxy(result, attempt, batchContext)) {
        await updateBatchSummary(batchContext, result, {
          workerId,
          account,
          proxy,
          attempt,
          retryCount: Math.max(0, attempt - initialAttempt),
        });
        return result;
      }

      console.log(`[Dreamina Batch] 账号准备换代理重试 | account=${account?.email || ''} | worker=${workerId} | attempt=${attempt}/${maxAttempts} | reason=${String(result?.finalReason || result?.finalState || 'UNKNOWN')} | proxy=${proxy?.raw || summarizeProxy(proxy).id || ''}`);
      attempt += 1;
    }

    await updateBatchSummary(batchContext, lastResult || {
      success: false,
      finalStage: 'batch-runner',
      finalState: 'ACCOUNT_RETRY_EXHAUSTED',
      finalReason: 'ACCOUNT_RETRY_EXHAUSTED',
      meta: { durationMs: 0, attempt: maxAttempts },
    }, {
      workerId,
      account,
      proxy: lastProxy,
      attempt: maxAttempts,
      retryCount: Math.max(0, maxAttempts - initialAttempt),
    });
    return lastResult || {
      success: false,
      finalStage: 'batch-runner',
      finalState: 'ACCOUNT_RETRY_EXHAUSTED',
      finalReason: 'ACCOUNT_RETRY_EXHAUSTED',
      meta: { durationMs: 0, attempt: maxAttempts },
    };
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
      proxy: null,
    });
    return failedResult;
  } finally {
    batchContext.accounts.running = batchContext.accounts.running.filter(item => item !== account.email);
    markWorkerIdle(workerId);
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
  const entrySlowSamples = Array.isArray(summary?.entrySlowSamples) ? summary.entrySlowSamples : [];

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
  const verificationBudget = summary?.concurrencyPolicy?.verificationBudget || null;
  if (verificationBudget) {
    lines.push(`[Dreamina Batch] VerificationBudget: matched=${verificationBudget.matchedConcurrency} | attempts=${verificationBudget.firstmailApiMaxPollAttempts} | intervalMs=${verificationBudget.waitMailIntervalMs} | retryMax=${verificationBudget.verificationRetryMaxAttempts} | resendWaitMs=${verificationBudget.verificationResendWaitMs}`);
  }
  const proxyPolicy = summary?.concurrencyPolicy?.proxyPolicy || null;
  if (proxyPolicy) {
    lines.push(`[Dreamina Batch] ProxyPolicy: matched=${proxyPolicy.matchedConcurrency} | staggerMs=${proxyPolicy.workerStartStaggerMs} | connectivityTimeoutMs=${proxyPolicy.connectivityTimeoutMs} | primaryTimeoutMs=${proxyPolicy.primaryTargetTimeoutMs} | secondaryTimeoutMs=${proxyPolicy.secondaryTargetTimeoutMs} | enableSecondaryTarget=${proxyPolicy.enableSecondaryTarget ? 'Y' : 'N'}`);
  }
  if (summary?.proxySelectionPolicy) {
    lines.push(`[Dreamina Batch] ProxySelectionPolicy: ${summary.proxySelectionPolicy}`);
  }
  if (summary?.proxyHealthPolicy) {
    const blockedCountries = Array.isArray(summary.proxyHealthPolicy.blockedCountries) ? summary.proxyHealthPolicy.blockedCountries.join(',') : '';
    const blockedProviders = Array.isArray(summary.proxyHealthPolicy.blockedProviders) ? summary.proxyHealthPolicy.blockedProviders.join(',') : '';
    lines.push(`[Dreamina Batch] ProxyHealthPolicy: blockedCountries=${blockedCountries || '-'} | blockedProviders=${blockedProviders || '-'}`);
  }
  if (typeof summary?.retiredProxyCount === 'number') {
    const retiredReasonBuckets = Object.entries(summary?.retiredProxyReasonBuckets || {})
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key}=${value}`)
      .join(' | ');
    lines.push(`[Dreamina Batch] RetiredProxies: count=${summary.retiredProxyCount} | keys=${Array.isArray(summary?.retiredProxyKeys) && summary.retiredProxyKeys.length ? summary.retiredProxyKeys.join(',') : '-'}${retiredReasonBuckets ? ` | reasons=${retiredReasonBuckets}` : ''}`);
  }
  if (Array.isArray(summary?.proxyHealthTopGood) && summary.proxyHealthTopGood.length) {
    const topGood = summary.proxyHealthTopGood.map(item => `${item.proxyId || item.host}:${item.healthScore}`).join(' | ');
    lines.push(`[Dreamina Batch] ProxyHealthTopGood: ${topGood}`);
  }
  if (Array.isArray(summary?.proxyHealthTopBad) && summary.proxyHealthTopBad.length) {
    const topBad = summary.proxyHealthTopBad.map(item => `${item.proxyId || item.host}:${item.healthScore}`).join(' | ');
    lines.push(`[Dreamina Batch] ProxyHealthTopBad: ${topBad}`);
  }
  const proxyPrecheckOverview = summary?.proxyPrecheckOverview || null;
  if (proxyPrecheckOverview && proxyPrecheckOverview.totalSamples > 0) {
    const gradeBuckets = Object.entries(proxyPrecheckOverview.gradeBuckets || {})
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key}=${value}`)
      .join(' | ');
    lines.push(`[Dreamina Batch] ProxyPrecheckOverview: samples=${proxyPrecheckOverview.totalSamples}${gradeBuckets ? ` | ${gradeBuckets}` : ''}`);
  }
  const layoutPreset = summary?.layoutProfile?.preset || null;
  if (layoutPreset) {
    lines.push(`[Dreamina Batch] LayoutPreset: mode=${layoutPreset.mode} | cols=${layoutPreset.cols} | rows=${layoutPreset.rows} | scale=${layoutPreset.scale} | usageRatio=${layoutPreset.usageRatio} | gap=${layoutPreset.gap} | outerMargin=${layoutPreset.outerMargin} | width=${layoutPreset.width} | height=${layoutPreset.height}`);
  }
  const entryConcurrencyStats = summary?.entryConcurrencyStats || null;
  if (entryConcurrencyStats && Number(entryConcurrencyStats.sampleCount || 0) > 0) {
    lines.push(`[Dreamina Batch] EntryConcurrencyStats: samples=${entryConcurrencyStats.sampleCount} | durationAvg=${entryConcurrencyStats.durationMs?.avg || 0} | durationMax=${entryConcurrencyStats.durationMs?.max || 0} | healthAvg=${entryConcurrencyStats.checkEntryHealthMs?.avg || 0} | healthMax=${entryConcurrencyStats.checkEntryHealthMs?.max || 0} | confirmAvg=${entryConcurrencyStats.confirmEntryReadyMs?.avg || 0} | confirmMax=${entryConcurrencyStats.confirmEntryReadyMs?.max || 0}`);
  }
  if (entrySlowSamples.length > 0) {
    const compact = entrySlowSamples
      .map(item => `${item.account}:${item.durationMs}ms(open=${item.openEntryPageMs},health=${item.checkEntryHealthMs},confirm=${item.confirmEntryReadyMs},outerMs=${item.outerConfirmMs || 0},gateMs=${item.gateConfirmMs || 0},wrapMs=${item.confirmWrapperOverheadMs || 0},wait=${item.waitTimelineMs || 0}/${item.waitEnsureGateMs || 0}/${item.waitRecoverSignalsMs || 0}/${item.waitReensureGateMs || 0}/${item.waitDebugSnapshotMs || 0},waitPath=${item.waitResolvedPath || '-'},residual=${item.wrapperResidualMs || 0},recovery=${item.recoveryResolvedPath || '-'}:${item.recoveryInitialWaitMs || 0}/${item.recoveryRecoverMs || 0}/${item.recoveryRewaitMs || 0},match=${item.matchedKind || '-'}:${item.matchedValue || '-'},src=${item.source || '-'},cta=${item.ctaOpenedGateMs || 0}/${item.postClickGateReadyMs || 0},outer=${item.outerConfirmResolvedAtMs || 0}:${item.outerConfirmResolvedBy || '-'},gate=${item.gateResolvedAtMs || 0}:${item.gateResolvedState || '-'})`)
      .join(' | ');
    lines.push(`[Dreamina Batch] EntrySlowSamples: ${compact}`);
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
  const loadedProxyHealthStore = loadProxyHealthStore();
  const proxyHealthStore = resetProxyPrecheckState(loadedProxyHealthStore);
  const proxyHealthPolicy = {
    blockedCountries: [],
    blockedProviders: [],
    countryStats: {},
    providerStats: {},
    mode: 'fresh-batch-no-history',
  };
  const proxies = loadLocalProxies().map((proxy, index) => ({
    ...proxy,
    proxyKey: String(proxy?.proxyKey || `${proxy?.host || 'proxy'}:${proxy?.port || ''}:${proxy?.username || proxy?.id || index}`),
  }));

  if (!accounts.length) {
    throw new Error('Dreamina batch runner: no accounts available from Dreamina/local-accounts.json');
  }
  if (!proxies.length) {
    throw new Error('Dreamina batch runner: no proxies available from local proxy source');
  }

  const layoutProfilePath = path.join(__dirname, '..', '..', 'shared-window-layout', 'window-layout-profile.json');
  const layoutPlanner = createWindowLayoutPlanner({ profilePath: layoutProfilePath });

  const batchContext = createBatchRunContext({
    ...cli,
    layoutProfilePath,
    accounts,
    proxies,
    proxyHealthStore,
    proxyHealthPolicy,
    proxySelectionPolicy: 'fresh-batch-no-history',
  });

  batchContext.summary.proxySelectionPolicy = 'fresh-batch-no-history';

  const resolvedLayoutPreset = layoutPlanner.resolve(1, batchContext.config.concurrency);

  batchContext.windowLayout = {
    planner: layoutPlanner,
    profilePath: layoutProfilePath,
    profile: layoutPlanner.profile || {},
    resolvedPreset: resolvedLayoutPreset,
  };

  batchContext.concurrencyPolicy = {
    verificationBudget: resolveVerificationBudget(layoutPlanner.profile || {}, batchContext.config.concurrency),
    proxyPolicy: resolveProxyPolicy(layoutPlanner.profile || {}, batchContext.config.concurrency),
  };

  await resetFile(SESSION_RECORDS_LATEST_TXT);
  await resetFile(SESSION_RECORDS_LATEST_JSONL);

  console.log(`[Dreamina Batch] runId=${batchContext.runId} | concurrency=${batchContext.config.concurrency} | accounts=${accounts.length} | proxies=${proxies.length} | ignoreKnownExists=${batchContext.config.ignoreKnownExists ? 'Y' : 'N'}`);
  console.log('[Dreamina Batch] Proxy precheck cache reset: Y | history-ordering: N | strategy=fresh-batch-no-history');
  if (!cli.ignoreKnownExists && pruneResult.removedCount > 0) {
    console.log(`[Dreamina Batch] 启动前已将已知已注册账号迁出待注册池，并保留到 registered-accounts.json | moved=${pruneResult.removedCount}`);
  }

  const panelInterval = setInterval(() => {
    for (const line of buildBatchOverviewLines(batchContext)) {
      console.log(line);
    }
  }, 10000);

  try {
    await runBatchOrchestration({
      tasks: accounts.map((account, index) => ({
        id: `account-${index + 1}-${sanitizeFileName(account?.email || '')}`,
        account,
      })),
      concurrency: batchContext.config.concurrency,
      runTask: async ({ workerId, task, payload }) => {
        return await processBatchTask({
          workerId,
          task,
          payload,
          batchContext,
        });
      },
      onWorkerUpdate: async (workerState, snapshot = {}) => {
        batchContext.orchestration = batchContext.orchestration || {
          queueSummary: { total: 0, pending: 0, running: 0, done: 0, failed: 0 },
          workerSummary: { total: 0, idle: 0, running: 0, done: 0, failed: 0 },
          workers: [],
        };
        batchContext.orchestration.queueSummary = snapshot?.queueSummary || batchContext.orchestration.queueSummary;
        batchContext.orchestration.workerSummary = snapshot?.workerSummary || batchContext.orchestration.workerSummary;
        batchContext.orchestration.workers = Array.isArray(snapshot?.workers) ? snapshot.workers : batchContext.orchestration.workers;

        syncWorkerSnapshot(batchContext.orchestration.workers);

        updateWorkerStatus(workerState?.workerId || 0, {
          status: workerState?.status || 'idle',
          account: workerState?.account?.email || workerState?.account || '',
          stage: workerState?.stage || '',
          step: workerState?.step || 'waiting-account',
          attempt: workerState?.attempt || 0,
          proxy: workerState?.proxy?.raw || workerState?.proxy || '',
        });
        if (String(workerState?.status || '') === 'idle') {
          markWorkerIdle(workerState?.workerId || 0);
        }
      },
    });
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
