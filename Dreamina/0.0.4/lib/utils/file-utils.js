'use strict';
// ═══════════════════════════════════════════════════════════════════════
// shared-utils/file-utils.js
//
// 职责：跨模块复用的文件/路径操作工具，无业务语义。
//
// 已验证的复用点（从 Dreamina-batch-runner.js 提炼）：
//   - ensureDir            → batch-runner L129
//   - sanitizeFileName     → batch-runner L148
//   - readJsonArrayFile    → batch-runner L487
//   - appendUniqueFileLine → batch-runner L506
//   - incrementBucket      → batch-runner L1013
//   - buildNumericStats    → batch-runner L852
//   - buildRunId           → batch-runner L414（通用 ID 生成）
//
// 不包含：
//   - 代理管理、账号迁移、注册流程相关逻辑
//   - 与 batchContext 耦合的写入操作
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ─── 目录操作 ──────────────────────────────────────────────────────────

/**
 * 确保目录存在，不存在时递归创建。
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (dirPath && !fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 确保文件的父目录存在。
 * @param {string} filePath
 */
function ensureFileDir(filePath) {
  if (filePath) ensureDir(path.dirname(filePath));
}

// ─── 文件名与路径 ──────────────────────────────────────────────────────

/**
 * 将任意字符串转为安全文件名（仅保留字母/数字/.-_）。
 * @param {string} value
 * @returns {string}
 */
function sanitizeFileName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * 生成带时间戳的 runId，格式：{prefix}-{ISO日期，特殊字符替换为-}
 * @param {string} [prefix='run']
 * @returns {string}
 */
function buildRunId(prefix) {
  const p = String(prefix || 'run').trim();
  return `${p}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

// ─── JSON 文件安全读写 ─────────────────────────────────────────────────

/**
 * 安全读取 JSON 文件，返回解析结果或默认值（不抛出异常）。
 * @param {string} filePath
 * @param {*} [defaultValue=null]
 * @returns {*}
 */
function readJsonFileSafe(filePath, defaultValue) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return defaultValue !== undefined ? defaultValue : null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return defaultValue !== undefined ? defaultValue : null;
  }
}

/**
 * 安全读取 JSON 文件，若内容为数组则返回数组，否则返回 []。
 * @param {string} filePath
 * @returns {Array}
 */
function readJsonArrayFile(filePath) {
  const result = readJsonFileSafe(filePath, []);
  return Array.isArray(result) ? result : [];
}

/**
 * 安全写入 JSON 文件（同步，可选 pretty-print）。
 * @param {string} filePath
 * @param {*} data
 * @param {{ indent?: number }} [options]
 * @returns {boolean} 是否写入成功
 */
function writeJsonFileSafe(filePath, data, options) {
  try {
    ensureFileDir(filePath);
    const indent = (options && options.indent) !== undefined ? options.indent : 2;
    fs.writeFileSync(filePath, JSON.stringify(data, null, indent), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// ─── 文本追加 ─────────────────────────────────────────────────────────

/**
 * 异步追加一行文本到文件，若行已存在则跳过（去重写入）。
 * @param {string} filePath
 * @param {string} line
 * @returns {Promise<boolean>} true=新增写入，false=已存在跳过
 */
async function appendUniqueFileLine(filePath, line) {
  const normalizedLine = String(line || '').trim();
  if (!normalizedLine) return false;
  try {
    if (fs.existsSync(filePath)) {
      const existing = await fs.promises.readFile(filePath, 'utf8');
      const existingLines = new Set(
        String(existing || '').split(/\r?\n/).map(l => String(l || '').trim()).filter(Boolean)
      );
      if (existingLines.has(normalizedLine)) return false;
    }
  } catch (_) {}
  await fs.promises.appendFile(filePath, `${normalizedLine}\n`, 'utf8');
  return true;
}

/**
 * 重置文件内容为空（异步）。文件不存在时先创建。
 * @param {string} filePath
 */
async function resetFile(filePath) {
  ensureFileDir(filePath);
  await fs.promises.writeFile(filePath, '', 'utf8');
}

/**
 * 读取文本文件中所有非空行，返回 Set<string>（trim + lowercase）。
 * 文件不存在时返回空 Set。
 * @param {string} filePath
 * @returns {Set<string>}
 */
function readLineSetFromFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return new Set();
    const content = fs.readFileSync(filePath, 'utf8');
    return new Set(
      content.split(/\r?\n/)
        .map(l => l.trim().toLowerCase())
        .filter(Boolean)
    );
  } catch (_) {
    return new Set();
  }
}

// ─── 统计工具 ─────────────────────────────────────────────────────────

/**
 * 对一组数值计算 min/max/avg/sampleCount。
 * @param {number[]} values
 * @returns {{ min: number, max: number, avg: number, sampleCount: number }}
 */
function buildNumericStats(values) {
  const list = (Array.isArray(values) ? values : [])
    .map(item => Number(item))
    .filter(Number.isFinite);
  if (!list.length) return { min: 0, max: 0, avg: 0, sampleCount: 0 };
  const total = list.reduce((sum, item) => sum + item, 0);
  return {
    min: Math.min(...list),
    max: Math.max(...list),
    avg: Math.round(total / list.length),
    sampleCount: list.length,
  };
}

/**
 * 对对象的 key 计数（桶计数）。
 * @param {object} target - 目标计数器对象（会被修改）
 * @param {string} key
 */
function incrementBucket(target, key) {
  const normalized = String(key || '').trim() || 'UNKNOWN';
  target[normalized] = Number(target[normalized] || 0) + 1;
}

/**
 * 将 Map/Object 的 buckets 转为 "key=value | key=value" 格式字符串。
 * @param {object} buckets
 * @returns {string}
 */
function formatBuckets(buckets) {
  return Object.entries(buckets || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' | ');
}

// ─── 导出 ─────────────────────────────────────────────────────────────

module.exports = {
  // 目录
  ensureDir,
  ensureFileDir,
  // 文件名
  sanitizeFileName,
  buildRunId,
  // JSON
  readJsonFileSafe,
  readJsonArrayFile,
  writeJsonFileSafe,
  // 文本追加
  appendUniqueFileLine,
  resetFile,
  readLineSetFromFile,
  // 统计
  buildNumericStats,
  incrementBucket,
  formatBuckets,
};
