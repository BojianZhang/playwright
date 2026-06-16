'use strict';
// ═══════════════════════════════════════════════════════════════════════
// lib/utils/config-defaults.js
//
// 职责：提供 v0.0.3 batch runner 所有配置节的规范默认值。
//
// 设计原则：
//   - 每个 section 的 default 对象必须包含所有已知字段及其安全默认值
//   - 不包含业务规则，只包含数值/布尔/枚举默认值
//   - 通过 mergeWithDefaults(userConfig, defaults) 合并，用户值优先
//   - 新增配置字段时，必须同步在此添加默认值
//
// 使用方式：
//   const { DEFAULTS, mergeWithDefaults, getSection } = require('../../lib/utils/config-defaults');
//   const cfg = mergeWithDefaults(rawConfig, DEFAULTS);
// ═══════════════════════════════════════════════════════════════════════

/**
 * 全配置默认值骨架。
 * 每个 section 对应 config.json 中的同名键。
 */
const DEFAULTS = {

  // ── runMode ────────────────────────────────────────────────────────
  // 'run' = 生产模式；'test' = 调试模式（使用 navigation.test 参数）
  runMode: 'run',

  // ── batch ──────────────────────────────────────────────────────────
  batch: {
    concurrency: 1,
    workerStatusIntervalMs: 10000,
    ignoreKnownExists: false,
    ignoreDone: false,                       // EVO-13: 断点续跑跳过开关
    proxySelectionPolicy: 'fresh-batch-no-history',
    maxAccountsPerRun: 0,                    // 0 = 不限制
  },

  // ── browser ────────────────────────────────────────────────────────
  browser: {
    headless: true,
    slowMo: 0,
    blockedResourceTypes: ['image', 'media', 'font'],
  },

  // ── proxy ──────────────────────────────────────────────────────────
  proxy: {
    maxRetriesPerAccount: 2,
    evictOnHardFailure: true,
    connectivityTimeoutMs: 8000,
    primaryTargetTimeoutMs: 10000,
    secondaryTargetTimeoutMs: 8000,
    enableSecondaryTarget: true,
  },

  // ── noProxyPolicy ──────────────────────────────────────────────────
  // 'skip_account' | 'retry' | 'retry_then_defer' | 'stop_batch'
  noProxyPolicy: {
    strategy: 'skip_account',               // 最保守策略（GAP-2）
    retryMaxAttempts: 3,
    retryIntervalMs: 5000,
    deferQueueFile: '',                      // 空 = 不持久化 defer 队列
  },

  // ── failureClassifier ──────────────────────────────────────────────
  failureClassifier: {
    proxyHardReasons: [],                   // 追加自定义代理硬失败原因码
    businessReasons: [],                    // 追加自定义业务失败原因码
    reasonOverrides: {},                    // 精确覆盖单个原因码的分类
  },

  // ── proxyHealthPool ────────────────────────────────────────────────
  proxyHealthPool: {
    softPenaltyThreshold: 2,               // EVO-4: 软惩罚触发次数
    evictOnSoftPenalty: true,
    fallbackToWeakPool: true,              // EVO-5: DEGRADED_RUN 是否允许 weak pool
    speedTierFilter: ['FAST', 'NORMAL', 'SLOW', 'UNKNOWN'],  // EVO-8: 允许调度档位
    fastThreshold: 75,                     // EVO-8: FAST 阈值（healthScore >= 75）
    normalThreshold: 40,                   // EVO-8: NORMAL 阈值（healthScore >= 40）
  },

  // ── resumePolicy (EVO-13) ──────────────────────────────────────────
  resumePolicy: {
    enabled: true,                         // 是否启用断点续跑
    globalDoneFile: 'batch-results/accounts-done.txt',  // 相对于 runner 目录
    doneScope: 'success+exists',           // 'success' | 'success+exists'
    ignoreDone: false,                     // --ignore-done 开关
  },

  // ── navigation ────────────────────────────────────────────────────
  navigation: {
    run: {
      entryGotoTimeoutMs: 120000,
      dreaminaNavigationTimeoutMs: 120000,
      firstLoadGraceWaitMs: 4000,
      postContinueWaitMs: 300,
    },
    test: {
      entryGotoTimeoutMs: 60000,
      dreaminaNavigationTimeoutMs: 60000,
      firstLoadGraceWaitMs: 2000,
      postContinueWaitMs: 200,
    },
  },

  // ── verification ──────────────────────────────────────────────────
  verification: {
    retryMaxAttempts: 3,
    resendWaitMs: 1800,
    countdownWaitMs: 12000,
    intervalMs: 3000,
  },

  // ── credential ────────────────────────────────────────────────────
  credential: {
    submitTimeoutMs: 15000,
    confirmTimeoutMs: 10000,
  },

  // ── site ──────────────────────────────────────────────────────────
  site: {
    homeUrl: 'https://dreamina.capcut.com',   // EVO-6: 统一入口 URL
    loginPath: '/login',
    afterLoginPath: '/',
  },

  // ── resultRouting ─────────────────────────────────────────────────
  resultRouting: {
    writeSuccessRecords: true,
    writeExistsRecords: true,
    writeFailedRecords: true,
    perKindEnabled: true,                  // EVO-7/12: 按种类分流
  },

  // ── log ───────────────────────────────────────────────────────────
  log: {
    writeRunLog: true,                     // EVO-2: run-log.txt
    writeFailureEvents: true,             // EVO-1: failure-events.jsonl
    writeRunEndMarker: true,              // EVO-9: RUN END 标记
    runLogAppend: true,                   // true=追加 false=每次覆写
  },

  // ── output ────────────────────────────────────────────────────────
  // 第一版占位，用于未来统一输出目录配置
  output: {
    baseDir: 'batch-results',
    latestDir: 'batch-results/latest',
    createDateSubdir: false,              // false = 按 runId 平铺
  },

  // ── storageSafety ─────────────────────────────────────────────────
  // 并发写文件互斥保护（GAP-1）
  storageSafety: {
    enablePoolFileLock: true,            // 是否启用账号池文件互斥锁
    writeRetryTimes: 2,                 // 写失败时重试次数
    writeRetryDelayMs: 100,
  },

  // ── runtime ───────────────────────────────────────────────────────
  // 运行时行为调优，不影响业务逻辑
  runtime: {
    workerAcquireTimeoutMs: 30000,       // Worker 等待代理最大时间
    stageFallbackTimeoutMs: 60000,       // 单阶段最长执行时间
    gcIntervalMs: 0,                     // 0 = 不强制 GC
  },
};

// ─── 工具函数 ───────────────────────────────────────────────────────────

/**
 * 深合并两个对象。用户值（source）优先于默认值（defaults）。
 * 只合并到 schema 中存在的 key，防止无效字段注入。
 *
 * @param {object} source   - 用户配置（config.json 读取值）
 * @param {object} defaults - 默认值骨架（DEFAULTS 中的某个 section）
 * @returns {object}
 */
function mergeSection(source, defaults) {
  if (!source || typeof source !== 'object') return Object.assign({}, defaults);
  const result = Object.assign({}, defaults);
  for (const key of Object.keys(defaults)) {
    const defVal = defaults[key];
    const srcVal = source[key];
    if (srcVal === undefined || srcVal === null) continue;
    if (defVal !== null && typeof defVal === 'object' && !Array.isArray(defVal)) {
      result[key] = mergeSection(srcVal, defVal);
    } else {
      result[key] = srcVal;
    }
  }
  // 保留用户配置中 schema 外的 key（不丢弃扩展字段）
  for (const key of Object.keys(source || {})) {
    if (result[key] === undefined) result[key] = source[key];
  }
  return result;
}

/**
 * 将整个用户配置与 DEFAULTS 合并，返回填充了所有缺省值的完整配置。
 *
 * @param {object} userConfig - 用户 config.json 解析结果
 * @returns {object} 合并后的完整配置
 */
function mergeWithDefaults(userConfig) {
  const cfg = userConfig && typeof userConfig === 'object' ? userConfig : {};
  const result = {};
  for (const section of Object.keys(DEFAULTS)) {
    const defVal = DEFAULTS[section];
    if (defVal !== null && typeof defVal === 'object' && !Array.isArray(defVal)) {
      result[section] = mergeSection(cfg[section], defVal);
    } else {
      result[section] = cfg[section] !== undefined ? cfg[section] : defVal;
    }
  }
  // 保留用户配置中 schema 外的顶层 key
  for (const key of Object.keys(cfg)) {
    if (result[key] === undefined) result[key] = cfg[key];
  }
  return result;
}

/**
 * 获取单个 section 的合并结果（含默认值）。
 *
 * @param {object} userConfig
 * @param {string} section
 */
function getSection(userConfig, section) {
  const defVal = DEFAULTS[section];
  if (defVal === undefined) return (userConfig || {})[section];
  const src = (userConfig || {})[section];
  if (defVal !== null && typeof defVal === 'object' && !Array.isArray(defVal)) {
    return mergeSection(src, defVal);
  }
  return src !== undefined ? src : defVal;
}

module.exports = {
  DEFAULTS,
  mergeWithDefaults,
  mergeSection,
  getSection,
};
