'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— Dreamina/0.0.3/S0-proxy-precheck
//
// 文件定位：Dreamina/0.0.3/S0-proxy-precheck/proxy-health-store.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 读取 / 写入 data/proxy-health-store.json（代理健康状态持久化）。
// ✅ 负责 —— 维护每条代理的健康评分字段（healthScore / 连续失败计数 / 冷却惩罚）。
// ✅ 负责 —— 根据预检结果更新代理健康记录（upsertProxyHealthFromPrecheck）。
// ✅ 负责 —— 根据运行时结果更新代理健康记录（upsertProxyHealthFromRuntime）。
// ✅ 负责 —— 判定代理是否被硬封禁（isProxyHardBlocked）。
// ✅ 负责 —— 按健康评分排序代理列表（sortProxiesByHealth）。
// ✅ 负责 —— 统计国家 / 供应商维度的失败分布（buildProxyHealthPolicy）。
// ❌ 不负责 —— 任何网络请求或 Playwright 操作。
// ❌ 不负责 —— 代理分配调度（在 Dreamina-batch-runner.js）。
// ❌ 不负责 —— 代理热剔除（热剔除逻辑在 batch-runner.js / failure-classifier.js）。
//
// 数据文件：data/proxy-health-store.json
// 调用方：Dreamina-batch-runner.js / Dreamina-register.js
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// 代理健康状态存储文件路径（单一来源）
const PROXY_HEALTH_STORE_PATH = path.join(__dirname, 'data', 'proxy-health-store.json');

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 确保输入是一个普通对象（非数组、非 null）。
 * 用于防御性读取 JSON 字段，避免类型错误导致崩溃。
 * @param {any} input
 * @returns {object}
 */
function ensureObject(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件读写
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 JSON 文件加载代理健康状态存储。
 * 文件不存在或解析失败时返回空 store，不抛异常。
 *
 * @param {{ filePath?: string }} [options={}]
 * @returns {{ updatedAt: string, records: object }}
 *   - updatedAt: 最近写入时间（ISO 字符串）
 *   - records:   代理 key → 健康记录对象 的映射
 */
function loadProxyHealthStore(options = {}) {
  const filePath = String(options.filePath || PROXY_HEALTH_STORE_PATH);
  try {
    if (!fs.existsSync(filePath)) {
      return { updatedAt: '', records: {} };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      updatedAt: String(raw?.updatedAt || '').trim(),
      records: ensureObject(raw?.records),
    };
  } catch (_) {
    return { updatedAt: '', records: {} };
  }
}

/**
 * 将代理健康状态存储序列化写入 JSON 文件。
 * 写入时自动刷新 updatedAt 为当前时间。
 *
 * @param {{ records: object }} [store={}]
 * @param {{ filePath?: string }} [options={}]
 * @returns {{ updatedAt: string, records: object }} 写入的 payload
 */
function saveProxyHealthStore(store = {}, options = {}) {
  const filePath = String(options.filePath || PROXY_HEALTH_STORE_PATH);
  const payload = {
    updatedAt: new Date().toISOString(),
    records: ensureObject(store?.records),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// 批次间状态重置
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在新一轮批次开始前，重置所有代理的预检评级字段。
 * 保留历史计数（recentSuccessCount / recentFailureCount），
 * 清空 capabilityGrade / businessGrade / proxyGrade / lastProxyPrecheckSummary。
 * 目的：避免上一轮的旧评级影响本轮代理选择。
 *
 * @param {{ records: object }} [store={}]
 * @returns {{ updatedAt: string, records: object }}
 */
function resetProxyPrecheckState(store = {}) {
  const records = ensureObject(store?.records);
  const nextRecords = {};
  for (const [proxyKey, record] of Object.entries(records)) {
    const normalized = normalizeProxyHealthRecord(record, {});
    nextRecords[proxyKey] = normalizeProxyHealthRecord({
      ...normalized,
      capabilityGrade: '',
      businessGrade: '',
      proxyGrade: '',
      lastProxyPrecheckSummary: null,
      updatedAt: new Date().toISOString(),
    }, {});
  }
  return {
    updatedAt: new Date().toISOString(),
    records: nextRecords,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 代理 Key 构造
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造代理的唯一健康记录 key。
 * 格式：`host:port:username`（不含密码，确保稳定唯一）。
 * 若 host / port / username 三者不全，降级使用 proxy.id 或 proxy.raw。
 *
 * @param {object} [proxy={}]
 * @returns {string}
 */
function buildProxyHealthKey(proxy = {}) {
  const host = String(proxy?.host || '').trim().toLowerCase();
  const port = String(proxy?.port || '').trim();
  const username = String(proxy?.username || '').trim();
  if (!host || !port || !username) {
    return String(proxy?.id || proxy?.raw || '').trim();
  }
  return `${host}:${port}:${username}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 健康记录归一化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将任意来源的代理健康记录归一化为标准字段结构。
 * 所有可选字段都有 fallback，不会出现 undefined。
 *
 * 字段说明：
 * @param {object} [record={}]   — 已有的健康记录（来自 JSON 存储）
 * @param {object} [proxy={}]    — 原始代理对象（用于填充基础标识字段）
 * @returns {{
 *   proxyKey:                    string,   // 代理唯一 key（host:port:username）
 *   proxyId:                     string,   // 代理 ID（来自 local-proxy-loader 赋值）
 *   host:                        string,   // 代理主机地址
 *   port:                        number,   // 代理端口
 *   username:                    string,   // 代理用户名
 *   provider:                    string,   // 代理服务提供商（来自 proxies.txt 或标注）
 *   countryCode:                 string,   // 出口国家码（如 DE / JP / KR）
 *   countryName:                 string,   // 出口国家中文名
 *   capabilityGrade:             string,   // 最近预检的能力等级（ENTRY_READY_CAPABLE / HOMEPAGE_USABLE / NONE）
 *   businessGrade:               string,   // 最近预检的业务等级（留白=未评）
 *   proxyGrade:                  string,   // 最近预检的代理质量等级（OK / WEAK / BAD）
 *   healthScore:                 number,   // 综合健康评分（0~100，越高越优先被选中）
 *   recentSuccessCount:          number,   // 近期成功次数（注册成功计）
 *   recentFailureCount:          number,   // 近期失败次数（技术/业务失败均计）
 *   consecutiveConnectivityFails: number,  // 连续 TCP 连通失败次数
 *   consecutiveEntryFails:       number,   // 连续入口页失败次数（超时 / 信号缺失）
 *   consecutiveBusinessFails:    number,   // 连续业务失败次数（注册被拒等）
 *   cooldownPenaltyUntil:        number,   // 冷却惩罚解除时间戳（ms，0=无惩罚）
 *   blocked:                     boolean,  // 是否被硬封禁（blocked=true 则永不分配）
 *   blockedReason:               string,   // 封禁原因码
 *   blockedAt:                   string,   // 封禁时间（ISO 字符串）
 *   lastProxyPrecheckSummary:    object|null, // 最近一次预检完整摘要对象
 *   lastRuntimeOutcome:          object|null, // 最近一次运行结果摘要（success / finalReason 等）
 *   updatedAt:                   string,   // 本记录最近更新时间（ISO 字符串）
 * }}
 */
function normalizeProxyHealthRecord(record = {}, proxy = {}) {
  const normalized = ensureObject(record);
  return {
    proxyKey: String(normalized.proxyKey || buildProxyHealthKey(proxy) || '').trim(),
    proxyId: String(normalized.proxyId || proxy?.id || '').trim(),
    host: String(normalized.host || proxy?.host || '').trim(),
    port: Number(normalized.port || proxy?.port || 0),
    username: String(normalized.username || proxy?.username || '').trim(),
    provider: String(normalized.provider || proxy?.provider || '').trim(),
    countryCode: String(normalized.countryCode || proxy?.countryCode || proxy?.proxyCountryCode || '').trim(),
    countryName: String(normalized.countryName || proxy?.countryName || proxy?.proxyCountryName || '').trim(),
    capabilityGrade: String(normalized.capabilityGrade || '').trim(),
    businessGrade: String(normalized.businessGrade || '').trim(),
    proxyGrade: String(normalized.proxyGrade || '').trim(),
    healthScore: Number(normalized.healthScore || 0),
    recentSuccessCount: Number(normalized.recentSuccessCount || 0),
    recentFailureCount: Number(normalized.recentFailureCount || 0),
    consecutiveConnectivityFails: Number(normalized.consecutiveConnectivityFails || 0),
    consecutiveEntryFails: Number(normalized.consecutiveEntryFails || 0),
    consecutiveBusinessFails: Number(normalized.consecutiveBusinessFails || 0),
    cooldownPenaltyUntil: Number(normalized.cooldownPenaltyUntil || 0),
    blocked: Boolean(normalized.blocked),
    blockedReason: String(normalized.blockedReason || '').trim(),
    blockedAt: String(normalized.blockedAt || '').trim(),
    lastProxyPrecheckSummary: normalized.lastProxyPrecheckSummary && typeof normalized.lastProxyPrecheckSummary === 'object'
      ? normalized.lastProxyPrecheckSummary
      : null,
    lastRuntimeOutcome: normalized.lastRuntimeOutcome && typeof normalized.lastRuntimeOutcome === 'object'
      ? normalized.lastRuntimeOutcome
      : null,
    updatedAt: String(normalized.updatedAt || '').trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 代理封禁判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断某条代理是否被硬封禁，不应再被分配给任何 Worker。
 *
 * 触发条件（满足任意一个即为硬封禁）：
 * - record.blocked === true（永久封禁）
 * - record.cooldownPenaltyUntil > Date.now()（冷却惩罚期未到）
 *
 * @param {object} [record={}]
 * @returns {boolean}
 */
function isProxyHardBlocked(record = {}) {
  const normalized = normalizeProxyHealthRecord(record, {});
  if (normalized.blocked) return true;
  if (normalized.cooldownPenaltyUntil && Date.now() < normalized.cooldownPenaltyUntil) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 健康评分计算
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算代理当前的衰减后健康评分（0~100）。
 * 冷却惩罚期内额外扣 15 分；blocked 直接返回 0。
 *
 * @param {object} [record={}]
 * @returns {number}
 */
function computeDecayedHealthScore(record = {}) {
  const normalized = normalizeProxyHealthRecord(record, {});
  if (normalized.blocked) return 0;
  let score = Number(normalized.healthScore || 0);
  if (normalized.cooldownPenaltyUntil && Date.now() < normalized.cooldownPenaltyUntil) {
    score = Math.max(0, score - 15);
  }
  return Math.max(0, Math.min(100, score));
}

// ─────────────────────────────────────────────────────────────────────────────
// 预检结果写入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 根据 S0 预检结果（proxyPrecheckSummary）更新代理健康记录。
 * 仅更新预检相关字段（proxyGrade / capabilityGrade / lastProxyPrecheckSummary）。
 * 不影响 healthScore / blocked / cooldown 等运行时字段。
 *
 * @param {{ records: object }} [store={}]
 * @param {object} [proxy={}]                   — 代理对象
 * @param {object|null} [proxyPrecheckSummary]  — S0 预检产出摘要（confirmProxyPrecheckResult 的返回值）
 * @returns {{ updated: boolean, record?: object, store: object }}
 */
function upsertProxyHealthFromPrecheck(store = {}, proxy = {}, proxyPrecheckSummary = null) {
  const records = ensureObject(store?.records);
  const proxyKey = buildProxyHealthKey(proxy);
  if (!proxyKey) return { updated: false, store: { ...store, records } };

  const previous = normalizeProxyHealthRecord(records[proxyKey], proxy);
  const summary = proxyPrecheckSummary && typeof proxyPrecheckSummary === 'object' ? proxyPrecheckSummary : null;
  const next = normalizeProxyHealthRecord({
    ...previous,
    proxyKey,
    proxyId: proxy?.id || previous.proxyId,
    host: proxy?.host || previous.host,
    port: proxy?.port || previous.port,
    username: proxy?.username || previous.username,
    provider: proxy?.provider || previous.provider,
    countryCode: proxy?.countryCode || proxy?.proxyCountryCode || previous.countryCode,
    countryName: proxy?.countryName || proxy?.proxyCountryName || previous.countryName,
    proxyGrade: summary?.proxyGrade || previous.proxyGrade,
    capabilityGrade: summary?.capabilityGrade || previous.capabilityGrade,
    businessGrade: summary?.businessGrade || previous.businessGrade,
    healthScore: Number(summary?.healthScore || previous.healthScore || 0),
    lastProxyPrecheckSummary: summary || previous.lastProxyPrecheckSummary,
    updatedAt: new Date().toISOString(),
  }, proxy);

  records[proxyKey] = next;
  return {
    updated: true,
    record: next,
    store: { updatedAt: new Date().toISOString(), records },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行时结果写入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 根据单次注册运行结果更新代理健康评分。
 *
 * 评分规则：
 * - 成功：healthScore += 6（上限 100），重置连续失败计数 / 冷却 / block
 * - 连通/入口超时失败：healthScore = 0，冷却惩罚 12 小时，blocked = true
 * - 入口页登录入口丢失（HOME_SHELL_WITHOUT_LOGIN_ENTRY）：扣分 + 冷却 20 分钟
 * - 入口信号缺失（READY_SIGNAL_MISSING）：扣分 + 冷却 15 分钟
 * - 注册被拒（SIGNUP_REJECTED）：轻微扣分，不冷却
 *
 * @param {{ records: object }} [store={}]
 * @param {object} [proxy={}]            — 代理对象
 * @param {object|null} [runtimeOutcome] — 单次注册结果（{ success, finalReason, finalStage, meta }）
 * @returns {{ updated: boolean, record?: object, store: object }}
 */
function upsertProxyHealthFromRuntime(store = {}, proxy = {}, runtimeOutcome = null) {
  const records = ensureObject(store?.records);
  const proxyKey = buildProxyHealthKey(proxy);
  if (!proxyKey) return { updated: false, store: { ...store, records } };

  const previous = normalizeProxyHealthRecord(records[proxyKey], proxy);
  const outcome = runtimeOutcome && typeof runtimeOutcome === 'object' ? runtimeOutcome : {};
  const finalReason = String(outcome?.finalReason || outcome?.finalState || '').trim().toUpperCase();
  const success = Boolean(outcome?.success);

  const isConnectivityFailure = /DREAMINA_PROXY_CONNECTIVITY_FAILED|PROXY_CONNECTIVITY_FAILED/.test(finalReason);
  const isEntryTimeoutFailure = /DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT|ENTRY_PAGE_OPEN_FAILED/.test(finalReason);
  const isEntrySignalFailure = /DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY|DREAMINA_READY_SIGNAL_MISSING/.test(finalReason);
  const isBusinessFailure = /DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY|DREAMINA_READY_SIGNAL_MISSING|DREAMINA_SIGNUP_REJECTED/.test(finalReason);

  const next = normalizeProxyHealthRecord({
    ...previous,
    recentSuccessCount: success ? previous.recentSuccessCount + 1 : previous.recentSuccessCount,
    recentFailureCount: success ? previous.recentFailureCount : previous.recentFailureCount + 1,
    consecutiveConnectivityFails: isConnectivityFailure ? previous.consecutiveConnectivityFails + 1 : 0,
    consecutiveEntryFails: (isEntryTimeoutFailure || isEntrySignalFailure) ? previous.consecutiveEntryFails + 1 : 0,
    consecutiveBusinessFails: (isEntryTimeoutFailure || isBusinessFailure) ? previous.consecutiveBusinessFails + 1 : 0,
    lastRuntimeOutcome: {
      success,
      finalStage: String(outcome?.finalStage || '').trim(),
      finalState: String(outcome?.finalState || '').trim(),
      finalReason: String(outcome?.finalReason || outcome?.finalState || '').trim(),
      durationMs: Number(outcome?.meta?.durationMs || 0),
    },
    updatedAt: new Date().toISOString(),
  }, proxy);

  if (success) {
    // 成功：恢复健康，解除封禁和冷却
    next.consecutiveConnectivityFails = 0;
    next.consecutiveEntryFails = 0;
    next.consecutiveBusinessFails = 0;
    next.cooldownPenaltyUntil = 0;
    next.blocked = false;
    next.blockedReason = '';
    next.blockedAt = '';
    next.healthScore = Math.min(100, Math.max(Number(next.healthScore || 0) + 6, 75));
  } else if (isConnectivityFailure || isEntryTimeoutFailure) {
    // 硬失败：清零评分，冷却 12 小时，永久封禁
    next.healthScore = 0;
    next.cooldownPenaltyUntil = Date.now() + 12 * 60 * 60 * 1000;
    next.blocked = true;
    next.blockedReason = finalReason || (isEntryTimeoutFailure ? 'DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT' : 'PROXY_CONNECTIVITY_FAILED');
    next.blockedAt = new Date().toISOString();
  } else if (/DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY/.test(finalReason)) {
    // 入口登录入口丢失：扣分 + 冷却 20 分钟
    next.healthScore = Math.max(0, Number(next.healthScore || 0) - (16 + next.consecutiveEntryFails * 4));
    next.cooldownPenaltyUntil = Date.now() + 20 * 60 * 1000;
  } else if (/DREAMINA_READY_SIGNAL_MISSING/.test(finalReason)) {
    // 入口信号缺失：扣分 + 冷却 15 分钟
    next.healthScore = Math.max(0, Number(next.healthScore || 0) - (12 + next.consecutiveEntryFails * 3));
    next.cooldownPenaltyUntil = Date.now() + 15 * 60 * 1000;
  } else if (/DREAMINA_SIGNUP_REJECTED/.test(finalReason)) {
    // 注册被拒：轻微扣分，不冷却
    next.healthScore = Math.max(0, Number(next.healthScore || 0) - 4);
  }

  records[proxyKey] = next;
  return {
    updated: true,
    record: next,
    store: { updatedAt: new Date().toISOString(), records },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 代理排序
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 按健康评分降序排序代理列表。
 * 被封禁国家的代理额外扣 30 分，被封禁供应商额外扣 20 分。
 *
 * @param {Array} [proxies=[]]   — 代理对象数组
 * @param {{ records: object }} [store={}]
 * @param {{ blockedCountries?: string[], blockedProviders?: string[] }} [policy={}]
 * @returns {Array} 排序后的代理列表（原列表不变）
 */
function sortProxiesByHealth(proxies = [], store = {}, policy = {}) {
  const records = ensureObject(store?.records);
  const blockedCountries = new Set(Array.isArray(policy?.blockedCountries) ? policy.blockedCountries : []);
  const blockedProviders = new Set(Array.isArray(policy?.blockedProviders) ? policy.blockedProviders : []);
  return [...(Array.isArray(proxies) ? proxies : [])].sort((a, b) => {
    const aRecord = normalizeProxyHealthRecord(records[buildProxyHealthKey(a)], a);
    const bRecord = normalizeProxyHealthRecord(records[buildProxyHealthKey(b)], b);
    const aPenalty = (blockedCountries.has(aRecord.countryCode) ? 30 : 0) + (blockedProviders.has(aRecord.provider) ? 20 : 0);
    const bPenalty = (blockedCountries.has(bRecord.countryCode) ? 30 : 0) + (blockedProviders.has(bRecord.provider) ? 20 : 0);
    return (computeDecayedHealthScore(bRecord) - bPenalty) - (computeDecayedHealthScore(aRecord) - aPenalty);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 健康策略统计
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 统计各国家 / 供应商的失败分布，生成封禁策略快照。
 *
 * 封禁阈值：
 * - 国家：connectivityFails >= 3 或 entryFails >= 4 → 加入 blockedCountries
 * - 供应商：connectivityFails >= 4 或 entryFails >= 5 → 加入 blockedProviders
 *
 * @param {{ records: object }} [store={}]
 * @returns {{
 *   blockedCountries: string[],  // 当前应封禁的国家码列表
 *   blockedProviders: string[],  // 当前应封禁的供应商列表
 *   countryStats: object,        // 国家维度失败统计（key=国家码）
 *   providerStats: object,       // 供应商维度失败统计（key=供应商名）
 * }}
 */
function buildProxyHealthPolicy(store = {}) {
  const records = Object.values(ensureObject(store?.records)).map(item => normalizeProxyHealthRecord(item, {}));
  const countryStats = {};
  const providerStats = {};

  for (const record of records) {
    const countryKey = String(record.countryCode || '').trim();
    const providerKey = String(record.provider || '').trim();
    if (countryKey) {
      const bucket = countryStats[countryKey] || { connectivityFails: 0, entryFails: 0, samples: 0 };
      bucket.samples += 1;
      bucket.connectivityFails += Number(record.consecutiveConnectivityFails || 0);
      bucket.entryFails += Number(record.consecutiveEntryFails || 0);
      countryStats[countryKey] = bucket;
    }
    if (providerKey) {
      const bucket = providerStats[providerKey] || { connectivityFails: 0, entryFails: 0, samples: 0 };
      bucket.samples += 1;
      bucket.connectivityFails += Number(record.consecutiveConnectivityFails || 0);
      bucket.entryFails += Number(record.consecutiveEntryFails || 0);
      providerStats[providerKey] = bucket;
    }
  }

  const blockedCountries = Object.entries(countryStats)
    .filter(([, value]) => value.connectivityFails >= 3 || value.entryFails >= 4)
    .map(([key]) => key);
  const blockedProviders = Object.entries(providerStats)
    .filter(([, value]) => value.connectivityFails >= 4 || value.entryFails >= 5)
    .map(([key]) => key);

  return { blockedCountries, blockedProviders, countryStats, providerStats };
}

module.exports = {
  PROXY_HEALTH_STORE_PATH,
  buildProxyHealthKey,
  loadProxyHealthStore,
  saveProxyHealthStore,
  resetProxyPrecheckState,
  normalizeProxyHealthRecord,
  upsertProxyHealthFromPrecheck,
  upsertProxyHealthFromRuntime,
  computeDecayedHealthScore,
  sortProxiesByHealth,
  buildProxyHealthPolicy,
  isProxyHardBlocked,
};
