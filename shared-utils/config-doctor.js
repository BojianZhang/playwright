'use strict';
// ═══════════════════════════════════════════════════════════════════════
// shared-utils/config-doctor.js
//
// 职责：运行前置条件检查与配置诊断。
//
//   - checkRequiredSections()  检查必要 section 是否存在
//   - checkFieldTypes()        检查字段类型与枚举合法性
//   - checkRanges()            检查数值范围
//   - checkPreflightConditions() 检查运行前置条件（文件/目录存在性）
//   - diagnose(config, options) 一次性诊断并输出报告
//
// 不涉及：业务规则、代理可用性、账号有效性
// 依赖：config-schema.js，config-defaults.js
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { SCHEMA, getRequiredSections, getRequiredFields } = require('./config-schema');
const { DEFAULTS, mergeWithDefaults } = require('./config-defaults');

// ─── 单项校验工具 ──────────────────────────────────────────────────────

function checkValue(value, fieldDef, fieldPath) {
  const issues = [];
  if (value === undefined || value === null) {
    if (fieldDef.required) issues.push({ level: 'ERROR', field: fieldPath, msg: '必填字段缺失' });
    return issues;
  }
  const t = fieldDef.type;
  if (t === 'string' && typeof value !== 'string') {
    issues.push({ level: 'WARN', field: fieldPath, msg: `期望 string，实际 ${typeof value}` });
  } else if (t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ level: 'WARN', field: fieldPath, msg: `期望 number，实际 ${typeof value}` });
    } else {
      if (fieldDef.min !== undefined && value < fieldDef.min)
        issues.push({ level: 'WARN', field: fieldPath, msg: `值 ${value} 低于最小值 ${fieldDef.min}` });
      if (fieldDef.max !== undefined && value > fieldDef.max)
        issues.push({ level: 'WARN', field: fieldPath, msg: `值 ${value} 高于最大值 ${fieldDef.max}` });
    }
  } else if (t === 'boolean' && typeof value !== 'boolean') {
    issues.push({ level: 'WARN', field: fieldPath, msg: `期望 boolean，实际 ${typeof value}` });
  } else if (t === 'array' && !Array.isArray(value)) {
    issues.push({ level: 'WARN', field: fieldPath, msg: `期望 array，实际 ${typeof value}` });
  } else if (t === 'enum') {
    if (!Array.isArray(fieldDef.enum) || !fieldDef.enum.includes(value)) {
      issues.push({ level: 'WARN', field: fieldPath, msg: `值 "${value}" 不在合法枚举内 [${(fieldDef.enum || []).join(',')}]` });
    }
  }
  return issues;
}

function checkObjectFields(obj, schemaDef, prefix) {
  const issues = [];
  const fields = schemaDef.fields || {};
  for (const [key, fdDef] of Object.entries(fields)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const val = obj && obj[key];
    if (fdDef.type === 'object') {
      if (val !== undefined && val !== null && typeof val !== 'object') {
        issues.push({ level: 'WARN', field: fieldPath, msg: `期望 object，实际 ${typeof val}` });
      } else {
        issues.push(...checkObjectFields(val || {}, fdDef, fieldPath));
      }
    } else {
      issues.push(...checkValue(val, fdDef, fieldPath));
    }
  }
  return issues;
}

// ─── 主诊断函数 ────────────────────────────────────────────────────────

/**
 * 对配置对象执行全量诊断。
 *
 * @param {object} rawConfig    - 原始 config.json 解析结果（未合并默认值）
 * @param {object} [options]
 * @param {string} [options.runnerDir] - runner 所在目录（用于路径检查）
 * @param {boolean} [options.checkFiles=false] - 是否检查文件/目录存在性
 * @param {boolean} [options.verbose=false] - 是否打印 INFO 级别信息
 * @returns {{ issues: Array<{level, field, msg}>, ok: boolean, merged: object }}
 */
function diagnose(rawConfig, options = {}) {
  const { runnerDir = process.cwd(), checkFiles = false, verbose = false } = options;
  const issues = [];
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

  // ① 检查必要 section
  for (const section of getRequiredSections()) {
    if (config[section] === undefined || config[section] === null) {
      issues.push({ level: 'ERROR', field: section, msg: `必要配置节 "${section}" 缺失` });
    }
  }

  // ② 检查字段类型与枚举
  for (const [section, schemaDef] of Object.entries(SCHEMA)) {
    const val = config[section];
    if (val === undefined) continue;  // 缺失的非必须节在①中已处理
    if (schemaDef.type === 'object') {
      issues.push(...checkObjectFields(val, schemaDef, section));
    } else {
      issues.push(...checkValue(val, schemaDef, section));
    }
  }

  // ③ 特殊前置条件检查
  const merged = mergeWithDefaults(config);

  // site.homeUrl 必须是有效 URL
  const homeUrl = String(merged.site && merged.site.homeUrl || '');
  if (!homeUrl.startsWith('http')) {
    issues.push({ level: 'ERROR', field: 'site.homeUrl', msg: `homeUrl "${homeUrl}" 不是有效 URL（必须以 http 开头）` });
  }

  // speedTierFilter 的合法性
  const validTiers = ['FAST', 'NORMAL', 'SLOW', 'UNKNOWN'];
  const tierFilter = merged.proxyHealthPool && merged.proxyHealthPool.speedTierFilter;
  if (Array.isArray(tierFilter)) {
    for (const t of tierFilter) {
      if (!validTiers.includes(t)) {
        issues.push({ level: 'WARN', field: 'proxyHealthPool.speedTierFilter', msg: `未知速度档 "${t}"，合法值：${validTiers.join('/')}` });
      }
    }
    if (tierFilter.length === 0) {
      issues.push({ level: 'WARN', field: 'proxyHealthPool.speedTierFilter', msg: 'speedTierFilter 为空数组，将导致所有代理被过滤（使用时自动 fallback 为全放行）' });
    }
  }

  // noProxyPolicy.strategy 合法性
  const strategy = merged.noProxyPolicy && merged.noProxyPolicy.strategy;
  if (!['skip_account', 'retry', 'retry_then_defer', 'stop_batch'].includes(strategy)) {
    issues.push({ level: 'WARN', field: 'noProxyPolicy.strategy', msg: `未知策略 "${strategy}"` });
  }

  // ④ 文件路径存在性检查（可选）
  if (checkFiles) {
    // accounts 文件
    const accountsFile = path.join(runnerDir, '..', 'local-accounts.json');
    if (!fs.existsSync(accountsFile)) {
      issues.push({ level: 'ERROR', field: 'preflight.accounts', msg: `账号文件不存在: ${accountsFile}` });
    }
    // batch-results 目录
    const baseDir = path.join(runnerDir, merged.output && merged.output.baseDir || 'batch-results');
    if (!fs.existsSync(baseDir)) {
      issues.push({ level: 'INFO', field: 'preflight.output', msg: `输出目录不存在，将自动创建: ${baseDir}` });
    }
  }

  // ⑤ 过滤 INFO（verbose=false 时不输出）
  const filteredIssues = verbose ? issues : issues.filter(i => i.level !== 'INFO');

  return {
    ok: !filteredIssues.some(i => i.level === 'ERROR'),
    issues: filteredIssues,
    merged,
  };
}

/**
 * 打印诊断报告到 console。
 *
 * @param {{ ok, issues, merged }} result - diagnose() 的返回值
 * @param {string} [label='ConfigDoctor'] - 日志前缀
 */
function printDiagnosticReport(result, label = 'ConfigDoctor') {
  const { ok, issues } = result;
  if (issues.length === 0) {
    console.log(`[${label}] ✔ 配置诊断通过，无问题`);
    return;
  }
  const errors = issues.filter(i => i.level === 'ERROR');
  const warns = issues.filter(i => i.level === 'WARN');
  const infos = issues.filter(i => i.level === 'INFO');
  console.log(`[${label}] 诊断结果 | ok=${ok} | ERROR=${errors.length} WARN=${warns.length} INFO=${infos.length}`);
  for (const issue of issues) {
    const icon = issue.level === 'ERROR' ? '✖' : issue.level === 'WARN' ? '⚠' : '…';
    console.log(`  ${icon} [${issue.level}] ${issue.field}: ${issue.msg}`);
  }
}

/**
 * 便捷函数：读取 config 文件并诊断，出错时打印报告。
 * 可在 runDreaminaBatch 启动前直接调用。
 *
 * @param {string} configPath - config.json 的绝对路径
 * @param {object} [options]
 * @returns {{ ok, issues, merged }}
 */
function diagnoseConfigFile(configPath, options = {}) {
  let rawConfig = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    rawConfig = JSON.parse(raw);
  } catch (e) {
    const issue = { level: 'ERROR', field: 'config.file', msg: `无法读取 config.json: ${e.message}` };
    console.error('[ConfigDoctor] ✖ ' + issue.msg);
    return { ok: false, issues: [issue], merged: mergeWithDefaults({}) };
  }
  const result = diagnose(rawConfig, Object.assign({ runnerDir: path.dirname(configPath) }, options));
  if (!result.ok || (options.verbose && result.issues.length)) {
    printDiagnosticReport(result);
  }
  return result;
}

module.exports = {
  diagnose,
  diagnoseConfigFile,
  printDiagnosticReport,
  checkValue,
  checkObjectFields,
};
