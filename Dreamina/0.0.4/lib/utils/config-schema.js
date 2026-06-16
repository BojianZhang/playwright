'use strict';
// ═══════════════════════════════════════════════════════════════════════
// shared-utils/config-schema.js
//
// 职责：描述 v0.0.3 config.json 的字段 schema——类型、范围、枚举。
//       不做业务验证，只做结构与类型约束检查。
//       与 config-doctor.js 配合使用（doctor 做诊断，schema 提供规则）。
//
// 不涉及：业务规则语义、策略含义、运行时校验
// ═══════════════════════════════════════════════════════════════════════

/**
 * 字段类型：
 *   'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
 *
 * 字段属性：
 *   type       - 类型
 *   required   - 是否必须存在
 *   enum       - 枚举合法值列表（type='enum' 时使用）
 *   min / max  - number 类型的范围约束
 *   default    - 建议默认值（文档用途，实际默认值在 config-defaults.js）
 *   desc       - 字段说明
 */
const SCHEMA = {

  runMode: {
    type: 'enum',
    required: false,
    enum: ['run', 'test'],
    default: 'run',
    desc: '运行模式，影响 navigation 参数选择',
  },

  batch: {
    type: 'object',
    required: true,
    fields: {
      concurrency: { type: 'number', min: 1, max: 100, default: 1, desc: '并发 Worker 数量' },
      workerStatusIntervalMs: { type: 'number', min: 1000, max: 60000, default: 10000, desc: 'Worker 状态刷新间隔' },
      ignoreKnownExists: { type: 'boolean', default: false, desc: '是否跳过已知已注册账号' },
      ignoreDone: { type: 'boolean', default: false, desc: '是否跳过 globalDoneFile 过滤（EVO-13）' },
      proxySelectionPolicy: { type: 'enum', enum: ['fresh-batch-no-history', 'health-ordered'], default: 'fresh-batch-no-history', desc: '代理选择策略' },
    },
  },

  browser: {
    type: 'object',
    required: false,
    fields: {
      headless: { type: 'boolean', default: true },
      slowMo: { type: 'number', min: 0, max: 5000, default: 0 },
      blockedResourceTypes: { type: 'array', default: ['image', 'media', 'font'] },
    },
  },

  proxy: {
    type: 'object',
    required: true,
    fields: {
      maxRetriesPerAccount: { type: 'number', min: 0, max: 10, default: 2, desc: '账号最大换代理重试次数' },
      evictOnHardFailure: { type: 'boolean', default: true },
      connectivityTimeoutMs: { type: 'number', min: 1000, max: 30000, default: 8000 },
      primaryTargetTimeoutMs: { type: 'number', min: 1000, max: 60000, default: 10000 },
      secondaryTargetTimeoutMs: { type: 'number', min: 1000, max: 60000, default: 8000 },
      enableSecondaryTarget: { type: 'boolean', default: true },
    },
  },

  noProxyPolicy: {
    type: 'object',
    required: false,
    fields: {
      strategy: {
        type: 'enum',
        enum: ['skip_account', 'retry', 'retry_then_defer', 'stop_batch'],
        default: 'skip_account',
        desc: '无代理时的账号处理策略',
      },
      retryMaxAttempts: { type: 'number', min: 1, max: 20, default: 3 },
      retryIntervalMs: { type: 'number', min: 500, max: 60000, default: 5000 },
      deferQueueFile: { type: 'string', default: '' },
    },
  },

  failureClassifier: {
    type: 'object',
    required: false,
    fields: {
      proxyHardReasons: { type: 'array', default: [] },
      businessReasons: { type: 'array', default: [] },
      reasonOverrides: { type: 'object', default: {} },
    },
  },

  proxyHealthPool: {
    type: 'object',
    required: false,
    fields: {
      softPenaltyThreshold: { type: 'number', min: 1, max: 20, default: 2 },
      evictOnSoftPenalty: { type: 'boolean', default: true },
      fallbackToWeakPool: { type: 'boolean', default: true },
      speedTierFilter: {
        type: 'array',
        default: ['FAST', 'NORMAL', 'SLOW', 'UNKNOWN'],
        desc: '允许调度的代理速度档，枚举值：FAST(≥75) / NORMAL(≥40) / SLOW(<40) / UNKNOWN(未预检)',
      },
      fastThreshold: { type: 'number', min: 1, max: 100, default: 75 },
      normalThreshold: { type: 'number', min: 1, max: 100, default: 40 },
    },
  },

  resumePolicy: {
    type: 'object',
    required: false,
    fields: {
      enabled: { type: 'boolean', default: true },
      globalDoneFile: { type: 'string', default: 'batch-results/accounts-done.txt' },
      doneScope: { type: 'enum', enum: ['success', 'success+exists'], default: 'success+exists' },
      ignoreDone: { type: 'boolean', default: false },
    },
  },

  site: {
    type: 'object',
    required: true,
    fields: {
      homeUrl: { type: 'string', required: true, desc: '目标站点首页 URL（EVO-6）' },
    },
  },

  resultRouting: {
    type: 'object',
    required: false,
    fields: {
      writeSuccessRecords: { type: 'boolean', default: true },
      writeExistsRecords: { type: 'boolean', default: true },
      writeFailedRecords: { type: 'boolean', default: true },
      perKindEnabled: { type: 'boolean', default: true },
    },
  },

  log: {
    type: 'object',
    required: false,
    fields: {
      writeRunLog: { type: 'boolean', default: true },
      writeFailureEvents: { type: 'boolean', default: true },
      writeRunEndMarker: { type: 'boolean', default: true },
      runLogAppend: { type: 'boolean', default: true },
    },
  },

  output: {
    type: 'object',
    required: false,
    fields: {
      baseDir: { type: 'string', default: 'batch-results' },
      latestDir: { type: 'string', default: 'batch-results/latest' },
      createDateSubdir: { type: 'boolean', default: false },
    },
  },

  storageSafety: {
    type: 'object',
    required: false,
    fields: {
      enablePoolFileLock: { type: 'boolean', default: true },
      writeRetryTimes: { type: 'number', min: 0, max: 5, default: 2 },
      writeRetryDelayMs: { type: 'number', min: 0, max: 5000, default: 100 },
    },
  },

  runtime: {
    type: 'object',
    required: false,
    fields: {
      workerAcquireTimeoutMs: { type: 'number', min: 1000, max: 300000, default: 30000 },
      stageFallbackTimeoutMs: { type: 'number', min: 5000, max: 600000, default: 60000 },
      gcIntervalMs: { type: 'number', min: 0, default: 0 },
    },
  },

  verification: {
    type: 'object',
    required: false,
    fields: {
      retryMaxAttempts: { type: 'number', min: 1, max: 10, default: 3 },
      resendWaitMs: { type: 'number', min: 0, max: 30000, default: 1800 },
      countdownWaitMs: { type: 'number', min: 0, max: 60000, default: 12000 },
      intervalMs: { type: 'number', min: 500, max: 30000, default: 3000 },
    },
  },

  navigation: {
    type: 'object',
    required: false,
    fields: {
      run: { type: 'object', fields: {
        entryGotoTimeoutMs: { type: 'number', min: 5000 },
        dreaminaNavigationTimeoutMs: { type: 'number', min: 5000 },
        firstLoadGraceWaitMs: { type: 'number', min: 0 },
        postContinueWaitMs: { type: 'number', min: 0 },
      }},
      test: { type: 'object', fields: {} },
    },
  },
};

/**
 * 返回指定 section 的 schema 定义。
 */
function getFieldSchema(section) {
  return SCHEMA[section] || null;
}

/**
 * 返回所有 required=true 的顶层 section 名称。
 */
function getRequiredSections() {
  return Object.keys(SCHEMA).filter(k => SCHEMA[k] && SCHEMA[k].required === true);
}

/**
 * 返回所有 required=true 的字段路径（包含嵌套，格式如 'batch.concurrency'）。
 */
function getRequiredFields() {
  const result = [];
  for (const [section, def] of Object.entries(SCHEMA)) {
    if (!def || def.type !== 'object') continue;
    for (const [field, fdDef] of Object.entries(def.fields || {})) {
      if (fdDef && fdDef.required) result.push(`${section}.${field}`);
    }
  }
  return result;
}

module.exports = {
  SCHEMA,
  getFieldSchema,
  getRequiredSections,
  getRequiredFields,
};
