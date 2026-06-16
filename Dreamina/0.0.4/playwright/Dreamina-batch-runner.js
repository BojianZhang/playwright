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
const { loadLocalProxies, summarizeProxy } = require('./stages/S0-proxy-precheck/local-proxy-loader');
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
} = require('./stages/S0-proxy-precheck/proxy-health-store');

const {
  updateWorkerStatus,
  markWorkerIdle,
  syncWorkerSnapshot,
  buildWorkerOverviewPanel,
} = require('../lib/utils/worker-status-tracker');
const { runBatchOrchestration, createProxyLockSet, createMutex } = require('../lib/batch-orchestration');
// 失败分类/决策谓词统一收口至 ./failure-policy.js（含原 failure-classifier.js + 原内联 6 谓词）。
const {
  isProxyHardFailure, isBusinessFailure, classifyFailure, createFailureClassifier,
  isExistsBusinessFailure, isTerminalBusinessFailure, isRetryableProxyOrEnvironmentFailure,
  shouldRetryAccountWithNextProxy, isBlacklistFailure, isAccountRetryFailure,
} = require('./failure-policy');
const { diagnoseConfigFile } = require('../lib/utils/config-doctor');  // Step2: config preflight
const _fileUtils = require('../lib/utils/file-utils');  // Step3: shared file utilities (ensureDir/sanitizeFileName/readJsonArrayFile etc.)

// ─── GAP-1 修复：账号池文件写入互斥锁 ───────────────────────────────────────
// 保护 local-accounts.json / registered-accounts.json / registered-accounts.json 并发覆写安全。
// 源样本： v0.0.2/runner.js:L614-615 的 withFileLock mutex。
// 所有对以上三个文件的 writeFile 覆写操作必须通过此锁序列化。
const withPoolFileLock = createMutex();


// ─── Config 加载 ───────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

/**
 * 读取 config.json，合并 CLI 覆盖项。
 * 优先级：CLI 参数 > config.json > 代码默认值
 *
 * 返回节说明：
 *   navigation.run / .test  → 按运行模式选取的页面超时/等待参数
 *   firstmail               → Firstmail API 鉴权与行为参数
 *   verification            → 验证码阶段参数（可被 window-layout-profile 并发档覆盖）
 *   credential              → 凭据提交阶段参数
 *   proxy / browser / batch → 同原有语义
 *
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

    // 保证各节在返回值中始终存在，避免下游 ?. 链条过长
    if (!clean.navigation) clean.navigation = {};
    if (!clean.navigation.run) clean.navigation.run = {};
    if (!clean.navigation.test) clean.navigation.test = {};
    if (!clean.firstmail) clean.firstmail = {};
    if (!clean.verification) clean.verification = {};
    if (!clean.credential) clean.credential = {};
    if (!clean.proxy) clean.proxy = {};
    if (!clean.failureClassifier) clean.failureClassifier = {};
    if (!clean.noProxyPolicy) clean.noProxyPolicy = {};

    return clean;
  } catch (e) {
    console.warn(`[Config] config.json 读取失败，使用内置默认值: ${e.message}`);
    return {
      browser: {}, batch: {}, proxy: {}, firstmail: {},
      navigation: { run: {}, test: {} }, verification: {}, credential: {},
    };
  }
}

// ─── 生产代理池加载器 ──────────────────────────────────────────────────────
const PROXIES_TXT_PATH = path.join(__dirname, '..', 'proxies.txt');
const LOCAL_PROXIES_TXT_PATH = path.join(__dirname, 'stages', 'S0-proxy-precheck', 'local-proxies.txt');

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
const { createWindowLayoutPlanner, resolveVerificationBudget, resolveProxyPolicy } = require('../lib/window-layout');

// @shared-utils: _fileUtils.ensureDir — 待 Step3 调用点替换后清理
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function resetFile(filePath) {
  ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, '', 'utf8');
}

// known-exists 缓存：记录已注册或已存在账号邮箱列表，供批量启动时快速跳过
// 语义属于账号状态管理（跨批次持久化），迁入 account-state/ 统一管理
const KNOWN_EXISTS_FILE = path.join(__dirname, '..', 'account-state', 'known-accounts.json');
const KNOWN_REGISTERED_FILE = path.join(__dirname, '..', 'account-state', 'known-accounts.json'); // 与 KNOWN_EXISTS_FILE 合并为同一文件
// ── 账号状态文件（account-state/ 目录，长期跨批次持久化）────────────────────
const ACCOUNT_STATE_DIR = path.join(__dirname, '..', 'account-state');
const LOCAL_ACCOUNTS_FILE = path.join(ACCOUNT_STATE_DIR, 'local-accounts.json');
const REGISTERED_ACCOUNTS_FILE = path.join(ACCOUNT_STATE_DIR, 'registered-accounts.json');
// 黑名单：硬失败，不再重试（SIGNUP_REJECTED / IP_BANNED / VERIFICATION_RATE_LIMITED 等）
const BLACKLISTED_ACCOUNTS_FILE = path.join(ACCOUNT_STATE_DIR, 'blacklisted-accounts.json');
// 软失败：偶发网络/代理/页面环境失败，可重新加入 local-accounts.json 重试
const RETRY_ACCOUNTS_FILE = path.join(ACCOUNT_STATE_DIR, 'retry-accounts.json');
const SESSION_RECORDS_DIR = path.join(__dirname, '..', 'data', 'session-records');
const SESSION_RECORDS_LATEST_TXT = path.join(SESSION_RECORDS_DIR, 'latest.txt');
const SESSION_RECORDS_LATEST_JSONL = path.join(SESSION_RECORDS_DIR, 'latest.jsonl');

// @shared-utils: _fileUtils.sanitizeFileName — 待 Step3 调用点替换后清理
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
    ignoreDone: false,
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

    if (token === '--ignore-done') {
      parsed.ignoreDone = true;
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
 * 启动前将已知已注册账号从本地账号池移除（防止重复注册）。
 *
 * 边界说明（待演进项 D2）：
 *   本函数属于“账号状态管理”领域逻辑，不属于批量调度层。
 *   计划当 account-pool-manager.js 建立后将该函数迁入其中。
 * @todo 迁入 account-pool-manager.js
 */
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
    await withPoolFileLock(async () => fs.promises.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(remainingAccounts, null, 2)}\n`, 'utf8'));
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

/**
 * EVO-8（v0.0.2 继承）：将代理 healthScore 映射为速度档枚举。
 *
 * 枚举值：FAST / NORMAL / SLOW / UNKNOWN
 * 阈值（来自设计收敛决策，2026-04-17）：
 *   FAST   → healthScore >= 75
 *   NORMAL → healthScore >= 40 && < 75
 *   SLOW   → healthScore < 40
 *   UNKNOWN→ 无 healthRecord 或 healthScore 为 0 且从未预检
 *
 * @param {object} proxy       - 代理对象（含 lastProxyPrecheckSummary）
 * @param {object} healthRecord - proxy-health-store 的记录（可为 null/undefined）
 * @returns {"FAST"|"NORMAL"|"SLOW"|"UNKNOWN"}
 */
function getProxySpeedTier(proxy, healthRecord) {
  const score = Number(healthRecord && healthRecord.healthScore || 0);
  const hasPrecheckRecord = Boolean(
    (proxy && proxy.lastProxyPrecheckSummary && proxy.lastProxyPrecheckSummary.proxyGrade) ||
    (healthRecord && (healthRecord.recentSuccessCount || healthRecord.recentFailureCount || healthRecord.proxyGrade))
  );
  if (!hasPrecheckRecord) return 'UNKNOWN';
  if (score >= 75) return 'FAST';
  if (score >= 40) return 'NORMAL';
  return 'SLOW';
}
function acquireNextProxy(batchContext) {
  const list = batchContext?.proxies?.list || [];
  if (!list.length) return null;

  const records = batchContext?.proxies?.healthStore?.records || {};
  const lockSet = batchContext?.proxies?.lockSet || null;

  // EVO-8: speedTierFilter 配置（默认全放行 FAST+NORMAL+SLOW+UNKNOWN）
  const _allowedTiers = (batchContext && batchContext.rawConfig &&
    batchContext.rawConfig.proxyHealthPool &&
    Array.isArray(batchContext.rawConfig.proxyHealthPool.speedTierFilter) &&
    batchContext.rawConfig.proxyHealthPool.speedTierFilter.length > 0
    ? batchContext.rawConfig.proxyHealthPool.speedTierFilter
    : ['FAST', 'NORMAL', 'SLOW', 'UNKNOWN'] // EVO-8 默认：全放行，防止初次运行代理被清空
  ).map(function(t) { return String(t).toUpperCase(); });

  // EVO-8: 基础过滤（硬封禁 + 独占锁 + speedTier）
  function _buildActiveList(tiers) {
    return list.filter(function(proxy) {
      const proxyKey = proxy && proxy.proxyKey || '';
      const record = proxyKey ? records[proxyKey] : null;
      if (isProxyHardBlocked(record || {})) return false;
      if (lockSet && lockSet.isLocked(proxyKey)) return false;  // 已被其他 Worker 独占
      const speedTier = getProxySpeedTier(proxy, record);
      return tiers.includes(speedTier);  // EVO-8: 速度档过滤
    });
  }

  let activeList = _buildActiveList(_allowedTiers);

  // EVO-5: DEGRADED_RUN weak pool fallback
  // 当 ok pool 在当前 speedTierFilter 下耗尽时，若 fallbackToWeakPool=true 则放宽到全放行
  if (!activeList.length) {
    const _fallbackEnabled = Boolean(
      batchContext && batchContext.rawConfig &&
      batchContext.rawConfig.proxyHealthPool &&
      batchContext.rawConfig.proxyHealthPool.fallbackToWeakPool
    );
    if (_fallbackEnabled && JSON.stringify(_allowedTiers) !== JSON.stringify(['FAST','NORMAL','SLOW','UNKNOWN'])) {
      // 放宽过滤：只保留 blocked 和 lock 限制，忽略 speedTierFilter
      activeList = _buildActiveList(['FAST', 'NORMAL', 'SLOW', 'UNKNOWN']);
      if (activeList.length > 0) {
        // EVO-5: 激活或保持 DEGRADED_RUN 模式
        if (batchContext._runMode !== 'DEGRADED') {
          batchContext._runMode = 'DEGRADED';
          const _degradedMsg = '[Dreamina Batch] === DEGRADED_RUN ACTIVATED | reason=speed-filter-exhausted' +
            ' | weakPoolSize=' + activeList.length + ' | allowedTiers=' + JSON.stringify(_allowedTiers) + ' ===';
          console.warn(_degradedMsg);
          // EVO-5: 写 run-log.txt（fire-and-forget）
          if (batchContext.paths && batchContext.paths.runLogFile) {
            fs.promises.appendFile(batchContext.paths.runLogFile,
              _degradedMsg + ' ' + new Date().toISOString() + '\n', 'utf8'
            ).catch(function() {});
          }
        }
      }
    }
    if (!activeList.length) return null;  // ok pool + weak pool 均耗尽
  } else {
    // EVO-5: ok pool 有代理，若之前处于 DEGRADED 则退出
    if (batchContext._runMode === 'DEGRADED') {
      batchContext._runMode = 'NORMAL';
      console.log('[Dreamina Batch] DEGRADED_RUN RECOVERED | ok pool restored, size=' + activeList.length);
    }
  }

  // 选优先级（沿用 getProxySelectionTier 排序逻辑）
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
  if (proxy && lockSet) {
    const acquired = lockSet.tryAcquire(proxy.proxyKey || '');
    if (!acquired) return null;  // 冗余防御：独占锁竞态
  }
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

/**
 * 将 knownExistsAccounts 集合持久化到磁盘（registered-accounts.json）。
 *
 * 边界说明（待演进项 D2）：
 *   本函数属于“账号状态管理”领域逻辑，不属于批量调度层。
 *   计划当 account-pool-manager.js 建立后将该函数迁入其中。
 * @todo 迁入 account-pool-manager.js
 */
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
  await withPoolFileLock(async () => {
      await fs.promises.writeFile(KNOWN_EXISTS_FILE, content, 'utf8');
      await fs.promises.writeFile(KNOWN_REGISTERED_FILE, content, 'utf8');
  });
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

// @shared-utils: _fileUtils.readJsonArrayFile — 待 Step3 调用点替换后清理
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

/**
 * 账号首次 session 记录写入履历档案（registered-accounts.json）。
 *
 * 边界说明（待演进项 D2）：
 *   本函数属于“账号状态管理”领域逻辑，不属于批量调度层。
 *   计划当 account-pool-manager.js 建立后将该函数迁入其中。
 * @todo 迁入 account-pool-manager.js
 */
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

/**
 * 账号迁移逻辑：将已注册账号从本地池（local-accounts.json）迁出并写入履历档案（registered-accounts.json）。
 *
 * 边界说明（待演进项 D2）：
 *   本函数属于“账号状态管理”领域逻辑，不属于批量调度层。
 *   计划当 account-pool-manager.js 建立后将该函数迁入其中（低风险，当前仅注释标注）。
 * @todo 迁入 account-pool-manager.js
 */
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
    await withPoolFileLock(async () => fs.promises.writeFile(LOCAL_ACCOUNTS_FILE, `${JSON.stringify(nextLocalAccounts, null, 2)}\n`, 'utf8'));
  }
  if (appended || updated || firstSessionRecord.recorded) {
    await withPoolFileLock(async () => fs.promises.writeFile(REGISTERED_ACCOUNTS_FILE, `${JSON.stringify(registeredAccounts, null, 2)}\n`, 'utf8'));
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
  const resultsDir = path.join(__dirname, '..', 'data', 'batch-results');
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
      lockSet: createProxyLockSet(),  // 代理独占锁：防止并发 Worker 同时持有同一条代理
    },

    knownExistsAccounts,
    deferredAccounts: [],   // GAP-2: retry_then_defer 策略超限时的账号追踪列表

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
      failureClassBuckets: {},    // GAP-3: proxy-hard/business/proxy-soft/unknown 分类桶（由 config-aware classifier 驱动）
      failurePhaseBuckets: {},    // EXP-3: precheck/entry/credential/verification/general 阶段桶
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
      deferredFile: path.join(latestDir, 'dreamina-batch-deferred.jsonl'),  // GAP-2: deferred accounts log
      failureEventsFile: path.join(resultsDir, 'failure-events.jsonl'), // EXP-1: 结构化失败事件（v0.0.2 继承）
      runLogFile: path.join(resultsDir, 'run-log.txt'), // EXP-2: 纯文本运行日志
      // EXP-12（v0.0.2 继承）：按失败种类的独立结果文件，支持后续分组分析
      globalDoneFile: path.join(__dirname, '..', 'data', 'batch-results', 'accounts-done.txt'), // EVO-13: 跨批次断点续跑 done 文件（不含 runId）
      accountsDoneFile: path.join(resultsDir, 'accounts-done.txt'), // EXP-13（v0.0.2继承）：已成功账号列表，支持断点续跑
      perKindResultFiles: {
        wrongCode: path.join(resultsDir, 'wrong-code.jsonl'),
        signupRejected: path.join(resultsDir, 'signup-rejected.jsonl'),
        verificationRateLimited: path.join(resultsDir, 'verification-rate-limited.jsonl'),
        ipBanned: path.join(resultsDir, 'ip-banned.jsonl'),
        proxyHardFailed: path.join(resultsDir, 'proxy-hard-failed.jsonl'),
        successSessions: path.join(resultsDir, 'sessions-with-country.txt'), // EVO-23: countryCode-sessionId 格式，v0.0.2 继承
      },
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

// @shared-utils: _fileUtils.buildNumericStats — 待 Step3 调用点替换后清理
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
    acceptLanguage: String(summary?.acceptLanguage || ''),
    colorScheme: String(summary?.colorScheme || ''),
    deviceScaleFactor: Number(summary?.deviceScaleFactor || 0),
    randomEnabled: Boolean(summary?.randomEnabled),
    identityStable: Boolean(summary?.identityStable),
    identityKey: String(summary?.identityKey || ''),
    identityHash: String(summary?.identityHash || ''),
    identitySeed: String(summary?.identitySeed || ''),
    identityTtlBucket: summary?.identityTtlBucket === null || summary?.identityTtlBucket === undefined
      ? null
      : Number(summary.identityTtlBucket),
    countryCode: String(summary?.countryCode || ''),
    geoSource: String(summary?.geoSource || ''),
    storagePolicy: String(summary?.storagePolicy || ''),
  };
}

function resolveBrowserIdentityConfig(batchConfig = {}) {
  const browserIdentity = batchConfig?.browserIdentity && typeof batchConfig.browserIdentity === 'object'
    ? batchConfig.browserIdentity
    : {};
  const browserIdentityFromBrowser = batchConfig?.browser?.identity && typeof batchConfig.browser.identity === 'object'
    ? batchConfig.browser.identity
    : {};

  return {
    enabled: true,
    stableByProxy: true,
    stableFingerprintTtlMs: 6 * 60 * 60 * 1000,
    alignGeoWithProxy: true,
    includeAcceptLanguageHeader: true,
    clearStorageOnStart: true,
    ...browserIdentityFromBrowser,
    ...browserIdentity,
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
    proxyExitIp: String(extra?.proxy?.exitIp || extra?.proxy?.resolvedExitIp || result?.meta?.exitIp || ''), // EXP-11: 代理出口IP（v0.0.2继承）
    // 双 IP 显示字段：
    // proxyCheckExitIp — Node 层代理预检出口 IP（来自 checkProxyExitIp，已写入 proxy.exitIp）
    // browserRuntimeIp — Playwright 浏览器实际使用 IP（来自 getBrowserRuntimeIp，走 chromium proxy 通道）
    // ipMatched        — 两者是否一致（null 表示任意一方未能获取）
    proxyCheckExitIp: String(result?.ipCheck?.proxyCheckExitIp || extra?.proxy?.exitIp || ''),
    browserRuntimeIp: String(result?.ipCheck?.browserRuntimeIp || ''),
    ipMatched: result?.ipCheck?.ipMatched !== undefined ? result.ipCheck.ipMatched : null,
    ipMismatchWarning: result?.ipCheck?.ipMatched === false
      ? '代理预检 IP 与浏览器实际 IP 不一致，请检查 launchOptions.proxy 是否正确注入'
      : null,
    precheckLevel: String(result?.meta?.precheckLevel || extra?.precheckLevel || ''), // EXP-17: 预检等级（OK/WEAK/BAD），v0.0.2 继承
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

// @shared-utils: _fileUtils.incrementBucket — 待 Step3 调用点替换后清理
function incrementBucket(target = {}, key = '') {
  const normalized = String(key || '').trim() || 'UNKNOWN';
  target[normalized] = Number(target[normalized] || 0) + 1;
}


/**
 * 追加账号到账号状态 JSON 数组文件（blacklisted / retry）。
 * 自动去重，防止同一账号重复写入。
 */
async function appendToAccountStateFile(filePath, entry = {}) {
  try {
    ensureDir(ACCOUNT_STATE_DIR);
    let arr = [];
    if (fs.existsSync(filePath)) {
      try { arr = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { arr = []; }
    }
    if (!Array.isArray(arr)) arr = [];
    const email = String(entry.email || '').trim().toLowerCase();
    if (email && arr.some(function(a) { return String(a.email || '').trim().toLowerCase() === email; })) {
      return; // 已存在，跳过
    }
    arr.push(entry);
    await withPoolFileLock(async function() {
      await fs.promises.writeFile(filePath, JSON.stringify(arr, null, 2) + '\n', 'utf8');
    });
  } catch (_err) {
    // 静默，不影响主流程
  }
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
      // EVO-13: 断点续跑 — 写 globalDoneFile（success）
      if (batchContext.paths && batchContext.paths.globalDoneFile) {
        fs.promises.appendFile(batchContext.paths.globalDoneFile, normalizedEmail + '\n', 'utf8').catch(function() {});
      }
    }
  } else if (result?.skipped && finalReason === 'KNOWN_EXISTS_ACCOUNT_SKIPPED') {
    batchContext.summary.skippedCount += 1;
    batchContext.summary.knownExistsSkippedCount += 1;
  } else if (existsFailure) {
    batchContext.summary.existsCount += 1;
    incrementBucket(batchContext.summary.existsReasonBuckets, finalReason);
    if (normalizedEmail) {
      batchContext.knownExistsAccounts.add(normalizedEmail);
      // EVO-13: 断点续跑 — 写 globalDoneFile（exists）
      if (batchContext.paths && batchContext.paths.globalDoneFile) {
        fs.promises.appendFile(batchContext.paths.globalDoneFile, normalizedEmail + '\n', 'utf8').catch(function() {});
      }
    }
  } else {
    batchContext.summary.failedCount += 1;
    incrementBucket(batchContext.summary.failureReasonBuckets, finalReason);
    // GAP-3: config-aware 分类桶（proxy-hard / business / proxy-soft / unknown）
    const _classLabel = (batchContext.classifier || { classifyFailure }).classifyFailure(finalReason);
    incrementBucket(batchContext.summary.failureClassBuckets, _classLabel);
    // EXP-3（v0.0.2 继承）：推断失败阶段，用于按阶段分析失败分布
    const _failPhase = (() => {
      const code = String(finalReason || '').split('|')[0].trim();
      if (/PROXY_PRECHECK|PROXY_CONNECT|PROXY_DNS|PROXY_TLS|PROXY_TIMEOUT/.test(code)) return 'precheck';
      if (/ENTRY|SITE_ENTRY|DREAMINA_ENTRY|WHITE_SCREEN|DEAD_PAGE/.test(code)) return 'entry';
      if (/CREDENTIAL|S2_|LOGIN_ENTRY/.test(code)) return 'credential';
      if (/VERIFICATION|FIRSTMAIL|WRONG_CODE|RATE_LIMITED/.test(code)) return 'verification';
      if (/ACCOUNT_ALREADY|ACCOUNT_EXISTS/.test(code)) return 'exists';
      if (/SIGNUP_REJECTED/.test(code)) return 'signup';
      if (/SESSION|DELIVERY|S6_/.test(code)) return 'delivery';
      return 'general';
    })();
    incrementBucket(batchContext.summary.failurePhaseBuckets, _failPhase);
  }

  incrementBucket(batchContext.summary.finalStageBuckets, finalStage);
  if (slowestStage && slowestStage !== 'UNKNOWN') {
    const stageLabel = slowestStage.split('=')[0] || slowestStage;
    incrementBucket(batchContext.summary.slowestStageBuckets, stageLabel);
  }

  // EVO-2（v0.0.2 继承）：写 run-log.txt，关键节点 [SUCCESS]/[FAIL]/[EXISTS]/[SKIP]
  if (batchContext.paths && batchContext.paths.runLogFile) {
    const _outcome2 = result && result.success ? 'SUCCESS' : (result && result.skipped ? 'SKIP' : (existsFailure ? 'EXISTS' : 'FAIL'));
    const _email2 = String(result && result.account && result.account.email || extra && extra.account && extra.account.email || '');
    const _logLine2 = `[${_outcome2}] ${new Date().toISOString()} | runId=${batchContext.runId} | account=${_email2} | reason=${finalReason} | stage=${finalStage}\n`;
    fs.promises.appendFile(batchContext.paths.runLogFile, _logLine2, 'utf8').catch(function() {});
  }
  const record = buildBatchAccountRecord(result, {
    ...extra,
    batchContext,
    bucket: result?.success ? 'success' : (existsFailure ? 'exists' : (result?.skipped ? 'skipped' : 'failed')),
  });
  if (result?.success) {
    batchContext.accounts.success.push(record);
    // EVO-23（v0.0.2 继承）：写 sessions-with-country.txt（格式：countryCode-sessionId）
    if (result && result.success && batchContext.paths && batchContext.paths.perKindResultFiles && batchContext.paths.perKindResultFiles.successSessions) {
      const _sessionId23 = String(result.deliveryPayload && result.deliveryPayload.sessionSummary && result.deliveryPayload.sessionSummary.sessionId || record && record.deliveryPayload && record.deliveryPayload.sessionSummary && record.deliveryPayload.sessionSummary.sessionId || '').trim();
      const _cc23 = String(result.account && result.account.countryCode || result.account && result.account.proxyCountryCode || extra && extra.proxy && extra.proxy.countryCode || '').trim().toUpperCase();
      if (_sessionId23) {
        const _sessLine23 = (_cc23 ? _cc23 + '-' : '') + _sessionId23 + '\n';
        fs.promises.appendFile(batchContext.paths.perKindResultFiles.successSessions, _sessLine23, 'utf8').catch(function() {});
      }
    }
  } else if (existsFailure) {
    batchContext.accounts.exists.push(record);
  } else if (result?.skipped) {
    batchContext.accounts.skipped.push(record);
  } else {
    batchContext.accounts.failed.push(record);
    // ── 账号状态分流：写 blacklisted-accounts.json 或 retry-accounts.json ────
    const _stateEntry = {
      email: normalizedEmail,
      password: String(result?.account?.password || extra?.account?.password || ''),
      finalReason,
      finalStage,
      failedAt: new Date().toISOString(),
    };
    if (isBlacklistFailure(result)) {
      appendToAccountStateFile(BLACKLISTED_ACCOUNTS_FILE, _stateEntry).catch(function() {});
    } else if (isAccountRetryFailure(result)) {
      appendToAccountStateFile(RETRY_ACCOUNTS_FILE, _stateEntry).catch(function() {});
    }
  }

  const recordFiles = await writeBatchAccountRecordFile(batchContext, record);
// EVO-1（v0.0.2 继承）：结构化失败事件追加到 failure-events.jsonl，供后分析
  if (batchContext.paths && batchContext.paths.failureEventsFile) {
  const _fev = {
  time: new Date().toISOString(),
  runId: batchContext.runId,
  account: String(result && result.account && result.account.email || extra && extra.account && extra.account.email || ''),
  proxy: String(extra && extra.proxy && (extra.proxy.raw || extra.proxy.server) || ''),
  proxyExitIp: String(extra && extra.proxyExitIp || record.proxyExitIp || ''),
  outcome: result && result.success ? 'success' : (result && result.skipped ? 'skipped' : (existsFailure ? 'exists' : 'failed')),
  phase: String(result && result.finalStage || 'UNKNOWN'),
  reason: finalReason,
  failureKind: String((batchContext.classifier || { classifyFailure }).classifyFailure(finalReason) || ''),
  };
  fs.promises.appendFile(batchContext.paths.failureEventsFile, JSON.stringify(_fev) + '\n', 'utf8').catch(function() {});
  }
  record.resultFile = String(recordFiles?.filePath || record.resultFile || '');
  record.latestResultFile = String(recordFiles?.latestByAccount || record.latestResultFile || '');


  // EVO-7（v0.0.2 继承）：verificationRateLimited 写独立文件（供下次启动自动跳过）
  // EVO-12（v0.0.2 继承）：按失败种类路由到独立文件（wrongCode / signupRejected / ipBanned / verification-rate-limited）
  if (batchContext && batchContext.paths && batchContext.paths.perKindResultFiles && record) {
    const _pkf = batchContext.paths.perKindResultFiles;
    const _rc = String(result && result.finalReason || result && result.finalState || '').toUpperCase();
    const _email = String(record.account || '');
    const _line = JSON.stringify({ email: _email, reason: _rc, time: new Date().toISOString() }) + '\n';
    // EVO-12: wrong verification code → 可人工处理后再跑
    if (_pkf.wrongCode && /WRONG_CODE|WRONG_VERIFICATION/.test(_rc)) {
      fs.promises.appendFile(_pkf.wrongCode, _line, 'utf8').catch(function() {});
    }
    // EVO-7 + EVO-12: 验证码限速 → 独立追踪，下次启动前可过滤
    if (_pkf.verificationRateLimited && /RATE_LIMITED|VERIFICATION_CODE_RATE_LIMITED/.test(_rc)) {
      fs.promises.appendFile(_pkf.verificationRateLimited, _line, 'utf8').catch(function() {});
    }
    // EVO-12: 注册被拒（SIGNUP_REJECTED）→ 说明邮箱/IP 被平台封禁
    if (_pkf.signupRejected && /SIGNUP_REJECTED/.test(_rc)) {
      fs.promises.appendFile(_pkf.signupRejected, _line, 'utf8').catch(function() {});
    }
    // EVO-12: IP 封禁（SIGNUP_REJECTED_IP_BANNED）→ 供代理剔除参考
    if (_pkf.ipBanned && /IP_BANNED/.test(_rc)) {
      fs.promises.appendFile(_pkf.ipBanned, _line, 'utf8').catch(function() {});
    }
    // EVO-12: 代理硬失败 → 供代理池清洗参考
    if (_pkf.proxyHard && /proxy-hard/.test(String(record.failureKind || batchContext && batchContext.classifier && batchContext.classifier.classifyFailure && batchContext.classifier.classifyFailure(_rc) || ''))) {
      fs.promises.appendFile(_pkf.proxyHard, _line, 'utf8').catch(function() {});
    }
  }
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
  // GAP-3: config-aware 分类汇总（proxy-hard/business/proxy-soft/unknown）
  const failureClassBuckets = Object.entries(batchContext.summary.failureClassBuckets || {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' | ');

  const lines = [header];
  if (failureBuckets) {
    lines.push(`BATCH_FAILURE_BUCKETS | ${failureBuckets}`);
  }
  if (failureClassBuckets) {
    lines.push(`BATCH_FAILURE_CLASS | ${failureClassBuckets}`);
  }
  // EVO-5: DEGRADED_RUN 模式显示
  if (batchContext && batchContext._runMode === 'DEGRADED') {
    lines.push('BATCH_MODE | DEGRADED_RUN | weakPool=active | speedFilterExhausted=true');
  }
  return [...lines, ...buildWorkerOverviewPanel()];
}

async function createWorkerRuntime(options = {}) {
  const batchConfig = options.batchConfig && typeof options.batchConfig === 'object' ? options.batchConfig : {};
  const browserConfig = batchConfig.browser && typeof batchConfig.browser === 'object' ? batchConfig.browser : {};
  const browserIdentity = resolveBrowserIdentityConfig(batchConfig);
  return await createDreaminaCliRuntime({
    proxy: options.proxy,
    account: options.account || null,
    headed: options.headed,
    slowMo: options.slowMo,
    windowLayout: options.windowLayout || null,
    blockedResourceTypes: Array.isArray(browserConfig.blockedResourceTypes)
      ? browserConfig.blockedResourceTypes
      : ['image', 'media', 'font'],
    browserIdentity,
    runtime: {
      ...(browserConfig.runtime && typeof browserConfig.runtime === 'object' ? browserConfig.runtime : {}),
      browserIdentity,
      proxyCountryCode: String(options?.proxy?.countryCode || options?.proxy?.proxyCountryCode || '').trim(),
      proxyCountryName: String(options?.proxy?.countryName || options?.proxy?.proxyCountryName || '').trim(),
      countryCode: String(options?.account?.countryCode || options?.proxy?.countryCode || options?.proxy?.proxyCountryCode || '').trim(),
      countryName: String(options?.account?.countryName || options?.proxy?.countryName || options?.proxy?.proxyCountryName || '').trim(),
    },
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
    batchConfig = {},
  } = options;

  // 从 config.json 读取对应运行模式的 navigation 参数 (D4/C7 fix)
  const runMode = String(batchConfig && batchConfig.runMode || 'run').trim().toLowerCase();
  const navConfig = (runMode === 'test' ? (batchConfig && batchConfig.navigation && batchConfig.navigation.test) : (batchConfig && batchConfig.navigation && batchConfig.navigation.run)) || {};
  const firstmailConfig = (batchConfig && batchConfig.firstmail) || {};
  const verificationConfig = (batchConfig && batchConfig.verification) || {};
  const credentialConfig = (batchConfig && batchConfig.credential) || {};

  const runtimeBundle = await createWorkerRuntime({
    account,
    proxy,
    headed,
    slowMo,
    windowLayout: options.windowLayout || null,
    batchConfig,
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
        dreaminaHomeUrl: String(batchConfig && batchConfig.site && batchConfig.site.homeUrl || 'https://dreamina.capcut.com/ai-tool/home'), // EVO-6: 读 config.site.homeUrl，旧硬编码为 fallback
        proxyConnectivityTimeoutMs: Number(proxyPolicy?.connectivityTimeoutMs || 8000),
        proxyPrimaryTargetTimeoutMs: Number(proxyPolicy?.primaryTargetTimeoutMs || 10000),
        proxySecondaryTargetTimeoutMs: Number(proxyPolicy?.secondaryTargetTimeoutMs || 8000),
        proxyEnableSecondaryTarget: Boolean(proxyPolicy?.enableSecondaryTarget ?? true),
        // navigation 参数：优先读 config.json，硬编码値作 fallback（D4/C7 修复）
        entryGotoTimeoutMs: Number(navConfig.entryGotoTimeoutMs || 120000),
        dreaminaNavigationTimeoutMs: Number(navConfig.dreaminaNavigationTimeoutMs || 120000),
        firstLoadGraceWaitMs: Number(navConfig.firstLoadGraceWaitMs || 4000),
        postContinueWaitMs: Number(navConfig.postContinueWaitMs || 0),
        postOverlayWaitMs: Number(navConfig.postOverlayWaitMs || 0),
        postSignEntryWaitMs: Number(navConfig.postSignEntryWaitMs || 0),
        postErrorRecoveryWaitMs: Number(navConfig.postErrorRecoveryWaitMs || 0),
        humanPauseMinMs: Number(navConfig.humanPauseMinMs || 0),
        humanPauseMaxMs: Number(navConfig.humanPauseMaxMs || 0),
        dreaminaAuthMode: 'signup',
        // 凭据参数：来自 config.json credential 节
        credentialSignupSwitchWaitMs: Number(credentialConfig.signupSwitchWaitMs || 1200),
        skipCredentialExistsPrecheckAfterEmail: Boolean(credentialConfig.skipExistsPrecheckAfterEmail !== undefined ? credentialConfig.skipExistsPrecheckAfterEmail : true),
        // 验证码参数：verificationBudget（layout profile 按并发量决定）优先，其次读 config.json
        verificationRetryMaxAttempts: Number((verificationBudget && verificationBudget.verificationRetryMaxAttempts) || (verificationConfig && verificationConfig.retryMaxAttempts) || 3),
        verificationResendWaitMs: Number((verificationBudget && verificationBudget.verificationResendWaitMs) || (verificationConfig && verificationConfig.resendWaitMs) || 1800),
        // Firstmail API 参数：来自 config.json firstmail 节
        firstmailApiMaxPollAttempts: Number((verificationBudget && verificationBudget.firstmailApiMaxPollAttempts) || 6),
        waitMailIntervalMs: Number((verificationBudget && verificationBudget.waitMailIntervalMs) || 2500),
        firstmailRecentMessageScanLimit: Number((firstmailConfig && firstmailConfig.recentMessageScanLimit) || 8),
        firstmailPollJitterMinMs: Number((firstmailConfig && firstmailConfig.pollJitterMinMs) || 0),
        firstmailPollJitterMaxMs: Number((firstmailConfig && firstmailConfig.pollJitterMaxMs) || 0),
        firstmailApiKey: String((firstmailConfig && firstmailConfig.apiKey) || process.env.FIRSTMAIL_API_KEY || '').trim(),
        firstmailApiBaseUrl: String((firstmailConfig && firstmailConfig.apiBaseUrl) || process.env.FIRSTMAIL_API_BASE_URL || '').trim(),
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

    // ── 双 IP 对比日志 ──────────────────────────────────────────────────────────────
    // proxyCheckExitIp：来自代理预检阶段（Node 层），已写入 result.proxyPrecheckSummary.resolvedIp。
    // browserRuntimeIp：来自 createBrowserRuntime 新增的 getBrowserRuntimeIp()，走浏览器 proxy 通道。
    // 两者均不包含用户名/密码，只输出 IP 地址。
    const _ipCheckBundle = runtimeBundle.ipCheck && typeof runtimeBundle.ipCheck === 'object' ? runtimeBundle.ipCheck : null;
    const _precheckIp = String(result?.proxyPrecheckSummary?.resolvedIp || '').trim();
    const _browserIp  = String(_ipCheckBundle?.browserRuntimeIp || '').trim();
    const _ipMatched  = _precheckIp && _browserIp ? _precheckIp === _browserIp : null;
    const _ipSrcLabel = String(_ipCheckBundle?.browserRuntimeIpSourceLabel || _ipCheckBundle?.browserRuntimeIpSource || 'unknown').trim();
    console.log(`[proxy-ip] precheck exit IP   : ${_precheckIp || 'N/A'}`);
    console.log(`[proxy-ip] browser runtime IP : ${_browserIp  || 'N/A'}  (source: ${_ipSrcLabel})`);
    if (_ipMatched === true) {
      console.log('[proxy-ip] matched            : true  ✅');
    } else if (_ipMatched === false) {
      console.log('[proxy-ip] matched            : false  ⚠ 代理预检 IP 与浏览器实际 IP 不一致，请检查 launchOptions.proxy 是否正确注入');
    } else {
      console.log(`[proxy-ip] matched            : null  (一方或两方 IP 未能获取 | precheckErr=${_ipCheckBundle?.ipCheckError || 'N/A'})`);
    }
    // 把 ipCheck 写回 result（result 是 normalizeDreaminaRegisterResult 的返回对象，可扩展字段）。
    if (result && typeof result === 'object' && _ipCheckBundle) {
      result.ipCheck = {
        proxyCheckExitIp: _precheckIp || null,
        browserRuntimeIp: _browserIp  || null,
        ipMatched: _ipMatched,
        proxyCheckIpSource: 'proxy-precheck-adapter/checkProxyExitIp',
        browserRuntimeIpSource: _ipCheckBundle.browserRuntimeIpSource || null,
        browserRuntimeIpSourceLabel: _ipCheckBundle.browserRuntimeIpSourceLabel || null,
        ipCheckError: _ipCheckBundle.ipCheckError || null,
        checkedAt: _ipCheckBundle.checkedAt || null,
      };
    }
    // ────────────────────────────────────────────────────────────────────────────────
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
            // GAP-2: 可配置策略 —— 无代理可用时的账号处理逻辑
            // 策略来源：config.json noProxyPolicy.strategy
            // 可选值：skip_account | retry | retry_then_defer | stop_batch
            const noProxyPolicy = batchContext?.rawConfig?.noProxyPolicy || {};
            const noProxyStrategy = String(noProxyPolicy.strategy || 'skip_account').trim().toLowerCase();
            const noProxyRetryWaitMs = Math.max(500, Number(noProxyPolicy.retryWaitMs || 2000));
            const noProxyRetryMax = Math.max(1, Number(noProxyPolicy.retryMaxAttempts || 3));
            
            console.log(`[Dreamina Batch] 无可用代理 | account=${account?.email || ''} | worker=${workerId} | attempt=${attempt} | strategy=${noProxyStrategy}`);
            
            if (noProxyStrategy === 'stop_batch') {
              throw new Error('NO_PROXY_AVAILABLE_STOP_BATCH');
            }
            
            if (noProxyStrategy === 'retry' || noProxyStrategy === 'retry_then_defer') {
              const retryAttempt = attempt - initialAttempt; // 当前无代理等待次数
              if (retryAttempt < noProxyRetryMax) {
                await new Promise(resolve => setTimeout(resolve, noProxyRetryWaitMs));
                // 不消耗 attempt 计数，仅等待后重试代理分配
                continue;
              }
              // 超过等待次数上限 → 仍无代理，退出循环
              if (noProxyStrategy === 'retry_then_defer') {
                // GAP-2: 最小可追踪实现 —— 记录 deferred account 并写入持久化 JSONL
                const deferredRecord = {
                  email: account?.email || '',
                  deferredAt: new Date().toISOString(),
                  reason: 'NO_PROXY_AVAILABLE_RETRY_EXHAUSTED',
                  noProxyWaitMs: noProxyRetryWaitMs,
                  noProxyRetryMax,
                  workerId,
                  attempt,
                };
                if (Array.isArray(batchContext.deferredAccounts)) {
                  batchContext.deferredAccounts.push(deferredRecord);
                }
                // 异步写 deferred JSONL（fire-and-forget，不阻塞主流程）
                const _deferredFilePath = batchContext?.paths?.deferredFile;
                if (_deferredFilePath) {
                  fs.promises.appendFile(_deferredFilePath, JSON.stringify(deferredRecord) + '\n', 'utf8').catch(() => {});
                }
                console.log(`[Dreamina Batch] 代理等待超时，账号已记录为 deferred | account=${account?.email || ''} | count=${(batchContext.deferredAccounts || []).length}`);
              }
            }
            
            // 默认 skip_account 或等待重试上限耗尽：返回 NO_PROXY_AVAILABLE
            const noProxyResult = {
              success: false,
              skipped: true,
              finalStage: 'batch-runner',
              finalState: 'NO_PROXY_AVAILABLE',
              finalReason: 'NO_PROXY_AVAILABLE',
              meta: { durationMs: 0, attempt, noProxyStrategy },
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
        batchConfig: batchContext.rawConfig || {},
      });
      lastResult = result;
      // 释放代理独占锁（无论成功还是失败，必须释放，防止永久死锁）
      if (proxy && batchContext && batchContext.proxies && batchContext.proxies.lockSet) batchContext.proxies.lockSet.release(proxy.proxyKey || '');

      // EVO-ExitIp: 把 proxyPrecheckSummary.resolvedIp 写回 proxy.exitIp，供 buildBatchAccountRecord 读取
      if (proxy && result && result.proxyPrecheckSummary && result.proxyPrecheckSummary.resolvedIp) {
        proxy.exitIp = String(result.proxyPrecheckSummary.resolvedIp);
      }
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

      // EVO-4（v0.0.2 繼承）：代理软惩罚计数器
      // 来源：config.proxyHealthPool.softPenaltyThreshold（默认2次）
      // 逻辑：软失败累积达阈值后，从当前批次 proxies.list 中软降级（移到尾部），不硬剔除
      if (proxy && result && !result.success && !isTerminalBusinessFailure(result)) {
        const _softThreshold = Math.max(1, Number(
          batchContext && batchContext.rawConfig && batchContext.rawConfig.proxyHealthPool && batchContext.rawConfig.proxyHealthPool.softPenaltyThreshold || 2
        ));
        const _pkey = String(proxy && proxy.proxyKey || '');
        if (_pkey) {
          batchContext._proxySoftFailCount = batchContext._proxySoftFailCount || {};
          batchContext._proxySoftFailCount[_pkey] = (batchContext._proxySoftFailCount[_pkey] || 0) + 1;
          const _softCount = batchContext._proxySoftFailCount[_pkey];
          if (_softCount >= _softThreshold) {
            // 软降级：把该代理移到 list 末尾（下次被其他 Worker 选到的概率降低）
            const _listArr = batchContext.proxies && batchContext.proxies.list || [];
            const _pIdx = _listArr.findIndex(function(p) { return String(p && p.proxyKey || '') === _pkey; });
            if (_pIdx >= 0 && _pIdx < _listArr.length - 1) {
              const _moved = _listArr.splice(_pIdx, 1)[0];
              _listArr.push(_moved);
              console.log('[Dreamina Batch] 软惩罚代理降级 | proxyKey=' + _pkey + ' softFails=' + _softCount + '/' + _softThreshold + ' → 移至 list 末尾');
            }
            batchContext._proxySoftFailCount[_pkey] = 0; // 重置计数，防止持续触发
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

  // Step2: 运行前配置诊断（config-doctor）——只打印，不中断业务
  const _doctorResult = diagnoseConfigFile(CONFIG_PATH, { verbose: false });
  if (!_doctorResult.ok) {
    console.warn('[Dreamina Batch] ⚠ 配置诊断发现 ERROR，建议修复后再运行：');
    for (const issue of _doctorResult.issues.filter(i => i.level === 'ERROR')) {
      console.warn(`  ✖ [CONFIG-ERROR] ${issue.field}: ${issue.msg}`);
    }
  } else if (_doctorResult.issues.length > 0) {
    console.log(`[Dreamina Batch] 配置诊断通过 | warnings=${_doctorResult.issues.length}`);
  }

  const knownExistsAccounts = readKnownExistsAccounts();
  const pruneResult = cli.ignoreKnownExists
    ? { removedCount: 0, removedEmails: [], remainingAccounts: loadLocalAccounts() }
    : await pruneKnownRegisteredFromLocalPool(knownExistsAccounts);
  let accounts = selectBatchAccounts(pruneResult.remainingAccounts, cli);
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

  // EVO-13: 断点续跑 — 读 globalDoneFile 过滤已完成账号
    if (!cli.ignoreDone) {
      const _gdf = require('path').join(__dirname, '..', 'data', 'batch-results', 'accounts-done.txt');
      try {
        if (require('fs').existsSync(_gdf)) {
          const _doneEmails = new Set(require('fs').readFileSync(_gdf, 'utf8').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean));
          if (_doneEmails.size > 0) {
            const _beforeDone = accounts.length;
            accounts = accounts.filter(function(a) { return !_doneEmails.has(String(a && a.email || '').trim().toLowerCase()); });
            console.log('[Dreamina Batch] EVO-13 断点续跑过滤 | globalDoneFile=' + _gdf + ' | done=' + _doneEmails.size + ' | before=' + _beforeDone + ' | after=' + accounts.length);
          }
        }
      } catch(_doneErr) {
        console.warn('[Dreamina Batch] EVO-13 读 globalDoneFile 失败（静默）:', String(_doneErr && _doneErr.message || _doneErr));
      }
    }

  // ── 域名黑洞过滤（batchFilter.skipEmailDomains）────────────────────────────
  // 读 config.json 中 batchFilter.skipEmailDomains，匹配账号直接跳过，不开浏览器不消耗代理。
  try {
    const _batchCfg = require('path').join(__dirname, '..', 'config', 'config.json');
    const _batchConfigRaw = JSON.parse(require('fs').readFileSync(_batchCfg, 'utf8'));
    const _skipDomains = Array.isArray(_batchConfigRaw && _batchConfigRaw.batchFilter && _batchConfigRaw.batchFilter.skipEmailDomains)
      ? _batchConfigRaw.batchFilter.skipEmailDomains.map(function(d) { return String(d || '').trim().toLowerCase(); }).filter(Boolean)
      : [];
    if (_skipDomains.length > 0) {
      const _beforeDomainFilter = accounts.length;
      const _skippedByDomain = [];
      accounts = accounts.filter(function(a) {
        const _emailDomain = String(a && a.email || '').trim().toLowerCase().split('@')[1] || '';
        if (_skipDomains.includes(_emailDomain)) {
          _skippedByDomain.push(String(a.email));
          return false;
        }
        return true;
      });
      if (_skippedByDomain.length > 0) {
        console.log('[Dreamina Batch] 域名黑洞过滤 | skipDomains=' + _skipDomains.join(',') + ' | before=' + _beforeDomainFilter + ' | skipped=' + _skippedByDomain.length + ' | after=' + accounts.length);
        console.log('[Dreamina Batch] 已跳过黑洞域名账号: ' + _skippedByDomain.join(', '));
      }
    }
  } catch (_domainFilterErr) {
    console.warn('[Dreamina Batch] 域名黑洞过滤读 config 失败（静默）:', String(_domainFilterErr && _domainFilterErr.message || _domainFilterErr));
  }

  // ── 账号加载诊断（最小化修复 2026-04-17）：数据/过滤/切片三段计数 ────────────
  const _rawAccountCount = Array.isArray(pruneResult.remainingAccounts) ? pruneResult.remainingAccounts.length : 0;
  const _validAccountCount = Array.isArray(pruneResult.remainingAccounts) ? pruneResult.remainingAccounts.filter(function(a) { return a && a.email && a.password; }).length : 0;
  const _prunedCount = pruneResult.removedCount || 0;
  console.log('[Dreamina Batch] 账号诊断 | 原始=' + _rawAccountCount + ' 有效(email+password)=' + _validAccountCount + ' 已剔除已注册=' + _prunedCount + ' start=' + cli.accountStart + ' limit=' + cli.accountLimit + ' 切片后可用=' + accounts.length);
  if (!accounts.length) {
    var _acctFilePath = require('path').join(__dirname, '..', 'account-state', 'local-accounts.json');
    console.error('[Dreamina Batch] ❌ 账号文件无可用账号，批量任务无法启动。');
    console.error('  原始账号数=' + _rawAccountCount + ' | 含email+password有效=' + _validAccountCount + ' | 已剔除已注册=' + _prunedCount + ' | start=' + cli.accountStart + ' | limit=' + cli.accountLimit);
    console.error('  A. local-accounts.json 为空 [] → 填入待注册账号（格式见 Dreamina-register.README.md）');
    console.error('  B. 所有账号已注册 → 检查 registered-accounts.json，或加 --ignore-known-exists');
    console.error('  C. --account-start ' + cli.accountStart + ' 超出有效账号范围（有效=' + _validAccountCount + '）→ 减小 --account-start');
    throw new Error('Dreamina batch runner: no accounts available | raw=' + _rawAccountCount + ' valid=' + _validAccountCount + ' pruned=' + _prunedCount + ' start=' + cli.accountStart + ' limit=' + cli.accountLimit + ' | file=' + _acctFilePath);
  }
  if (!proxies.length) {
    throw new Error('Dreamina batch runner: no proxies available from local proxy source');
  }

  const layoutProfilePath = path.join(__dirname, '..', 'lib', 'window-layout', 'window-layout-profile.json');
  const layoutPlanner = createWindowLayoutPlanner({ profilePath: layoutProfilePath });

  const batchConfig = loadBatchConfig(cli);

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
  batchContext.rawConfig = batchConfig;
  // EXP-19（v0.0.2 继承）：workerStatusInterval 面板日志应同步写入 runLogFile，当前仅打 console
  // TODO: 在 orchestration 调用后追加 setInterval 写 runLogFile，待确认 runBatchOrchestration 是否支持 onWorkerStatus 回调
  // GAP-3: config-aware 失败分类器实例，消费 config.json failureClassifier 节（内置枚举为基线，可追加/覆盖）
  batchContext.classifier = createFailureClassifier(batchConfig);

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

  // EXP-9（v0.0.2 继承）：RUN START 标记，方便 grep 分段和持续时间计算
  const _runLogFile = batchContext?.paths?.runLogFile;
  const _tsStart = new Date().toISOString();
  if (_runLogFile) {
    fs.promises.appendFile(_runLogFile,
      `=== RUN START ${_tsStart} | runId=${batchContext.runId} | concurrency=${batchContext.config.concurrency} | accounts=${batchContext.accounts.total} | proxies=${batchContext.proxies.total} ===\n`,
      'utf8'
    ).catch(() => {});
  }
  console.log(`[Dreamina Batch] RUN START | runId=${batchContext.runId} | accounts=${batchContext.accounts.total} | proxies=${batchContext.proxies.total} | concurrency=${batchContext.config.concurrency}`);
  batchContext._runStartTs = Date.now(); // EVO-9: 记录启动时间戳用于计算总耗时

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

    // EVO-9（v0.0.2 继承）：RUN END 标记，配合 RUN START 计算本次运行总耗时
    if (batchContext && batchContext.paths && batchContext.paths.runLogFile) {
      const _tsEnd9 = new Date().toISOString();
      const _dur9 = batchContext._runStartTs ? Math.round((Date.now() - batchContext._runStartTs) / 1000) + 's' : 'N/A';
      fs.promises.appendFile(batchContext.paths.runLogFile,
        `=== RUN END ${_tsEnd9} | runId=${batchContext.runId} | elapsed=${_dur9} | success=${summary && summary.counts && summary.counts.success || 0} | failed=${summary && summary.counts && summary.counts.failed || 0} ===\n`,
        'utf8'
      ).catch(function() {});
    }
  
  return summary;
}

if (require.main === module) {
  // 支付相关旗标(--dry-run/--plan/--tab/--no-upgrade/--no-billing/--amount)→ env 覆盖。
  require('./cli-billing-flags').applyBillingFlags(process.argv.slice(2));
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
