'use strict';
/**
 * result-doctor.js — 批量结果文件健康诊断
 *
 * 检查内容：
 *   1. batch-results/ 目录是否存在、accounts-done.txt 行格式
 *   2. batch-results/latest/ 中 latest JSON 文件格式抽样
 *   3. results/ (CLI 单跑) success/failed 文件数统计
 *   4. session-records/ 文件数量现状（超限警告）
 *   5. 批量最近一次 batch-summary 成功率统计
 *   6. registered-accounts.json 与 local-accounts.json 数量关系异常检测
 *
 * 运行：
 *   node Dreamina/0.0.3/account-state/result-doctor.js
 *   node Dreamina/0.0.3/account-state/result-doctor.js --verbose
 *   node Dreamina/0.0.3/account-state/result-doctor.js --last-batch  （分析最近一批结果）
 */

const fs = require('fs');
const path = require('path');

const RUNNER_DIR = path.join(__dirname, '..');
const ACCOUNT_STATE_DIR = __dirname;

const PATHS = {
  batchResults: path.join(RUNNER_DIR, 'data', 'batch-results'),
  accountsDone: path.join(RUNNER_DIR, 'data', 'batch-results', 'accounts-done.txt'),
  batchLatest: path.join(RUNNER_DIR, 'data', 'batch-results', 'latest'),
  batchSummaryLatest: path.join(RUNNER_DIR, 'data', 'batch-results', 'latest', 'dreamina-batch-summary-latest.json'),
  cliResults: path.join(RUNNER_DIR, 'data', 'results'),
  sessionRecords: path.join(RUNNER_DIR, 'data', 'session-records'),
  registered: path.join(ACCOUNT_STATE_DIR, 'registered-accounts.json'),
  local: path.join(ACCOUNT_STATE_DIR, 'local-accounts.json'),
  failureEvents: path.join(RUNNER_DIR, 'data', 'batch-results', 'failure-events.jsonl'),
};

const verbose = process.argv.includes('--verbose');
const lastBatch = process.argv.includes('--last-batch');
const issues = [];
const report = {};

function issue(level, check, msg, detail) {
  issues.push({ level, check, msg, detail });
}

function countFiles(dir, ext) {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter(function(f) { return !ext || f.endsWith(ext); }).length;
  } catch (_) { return 0; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

function readJsonArraySafe(p) {
  const d = readJsonSafe(p);
  return Array.isArray(d) ? d : [];
}

// ─── 1. batch-results/ 基础检查 ──────────────────────────────────────

report.batchResultsExists = fs.existsSync(PATHS.batchResults);
if (!report.batchResultsExists) {
  issue('WARN', 'batch-results', 'batch-results/ 目录不存在（尚未运行过批量任务）');
} else {
  // accounts-done.txt
  if (fs.existsSync(PATHS.accountsDone)) {
    const doneLines = fs.readFileSync(PATHS.accountsDone, 'utf8').split(/\r?\n/).filter(Boolean);
    report.doneCount = doneLines.length;
    const malformed = doneLines.filter(function(l) { return !l.includes('@'); });
    if (malformed.length) {
      issue('WARN', 'accounts-done', malformed.length + ' 行格式异常（不含 @）', malformed.slice(0, 3).join(', '));
    }
  } else {
    report.doneCount = 0;
    issue('WARN', 'accounts-done', 'accounts-done.txt 不存在（断点续跑功能初始化）');
  }

  // failure-events.jsonl
  if (fs.existsSync(PATHS.failureEvents)) {
    const fevLines = fs.readFileSync(PATHS.failureEvents, 'utf8').split(/\r?\n/).filter(Boolean);
    report.failureEventsCount = fevLines.length;
    // 分析最近 20 条失败原因分布
    if (lastBatch || verbose) {
      const reasonCounts = {};
      fevLines.slice(-50).forEach(function(l) {
        try {
          const obj = JSON.parse(l);
          const r = obj.finalReason || obj.reason || 'UNKNOWN';
          reasonCounts[r] = (reasonCounts[r] || 0) + 1;
        } catch (_) {}
      });
      report.recentFailureReasons = reasonCounts;
    }
  }

  // batch-results/latest/ 最新批次 summary
  if (fs.existsSync(PATHS.batchSummaryLatest)) {
    const summary = readJsonSafe(PATHS.batchSummaryLatest);
    if (summary) {
      report.lastBatchSummary = {
        total: summary.total || summary.accountsTotal,
        success: summary.success || summary.successCount,
        failed: summary.failed || summary.failedCount,
        successRate: summary.successRate,
        durationMs: summary.durationMs || summary.totalDurationMs,
      };
      const rate = report.lastBatchSummary.successRate || 0;
      if (rate < 0.8) {
        issue('WARN', 'last-batch-success-rate',
          '最近一批成功率 ' + (rate * 100).toFixed(1) + '% 低于 80%，建议检查失败原因',
          '查看 failure-events.jsonl 和 batch-results/latest/');
      }
    }
  } else {
    issue('WARN', 'batch-summary', 'batch-results/latest/ 中无 summary 文件（首次运行 or 路径变化）');
  }
}

// ─── 2. results/ (CLI 单跑) 检查 ─────────────────────────────────────

report.cliResultsExists = fs.existsSync(PATHS.cliResults);
if (report.cliResultsExists) {
  const successDir = path.join(PATHS.cliResults, 'success');
  const failedDir = path.join(PATHS.cliResults, 'failed');
  report.cliSuccess = countFiles(successDir, '.json');
  report.cliFailed = countFiles(failedDir, '.json');
} else {
  report.cliSuccess = 0;
  report.cliFailed = 0;
}

// ─── 3. session-records/ 文件数量警告 ────────────────────────────────

if (fs.existsSync(PATHS.sessionRecords)) {
  const count = countFiles(PATHS.sessionRecords);
  report.sessionRecordsCount = count;
  if (count > 500) {
    issue('WARN', 'session-records',
      'session-records/ 含 ' + count + ' 个文件（超过 500），建议手动归档或清理',
      '可移动 7 天前的文件到 session-records/archive/');
  }
} else {
  report.sessionRecordsCount = 0;
}

// ─── 4. registered vs local 数量健康度 ───────────────────────────────

const registeredData = readJsonArraySafe(PATHS.registered);
const localData = readJsonArraySafe(PATHS.local);
report.registeredCount = registeredData.length;
report.localCount = localData.length;

if (localData.length === 0 && registeredData.length === 0) {
  issue('WARN', 'account-pool', 'local 和 registered 均为空，账号池可能未初始化');
} else if (localData.length === 0) {
  issue('WARN', 'account-pool', 'local-accounts.json 为空——待跑账号已耗尽，执行前需补充或 recycle-retry');
}

// ─── 5. 最近批次失败原因明细（--last-batch 模式）─────────────────────

if (lastBatch && report.recentFailureReasons) {
  console.log('\n[ResultDr] ══ 最近批次失败原因（最近 50 条）══');
  Object.entries(report.recentFailureReasons)
    .sort(function(a, b) { return b[1] - a[1]; })
    .forEach(function(e) { console.log('  ' + e[0] + ': ' + e[1]); });
}

// ─── 输出报告 ──────────────────────────────────────────────────────────

const errors = issues.filter(function(i) { return i.level === 'ERROR'; });
const warns = issues.filter(function(i) { return i.level === 'WARN'; });
const ok = errors.length === 0;

console.log('[ResultDr] ══ 批量结果文件诊断 ══');
console.log('[ResultDr] registered=' + report.registeredCount +
  ' | local=' + report.localCount +
  ' | done.txt=' + (report.doneCount || 0) +
  ' | session-records=' + report.sessionRecordsCount);
console.log('[ResultDr] CLI results: success=' + report.cliSuccess + ' failed=' + report.cliFailed);

if (report.lastBatchSummary) {
  const s = report.lastBatchSummary;
  console.log('[ResultDr] 最近批次: total=' + s.total + ' success=' + s.success +
    ' failed=' + s.failed + ' rate=' + (s.successRate ? (s.successRate * 100).toFixed(1) + '%' : 'N/A'));
}

if (issues.length === 0) {
  console.log('[ResultDr] ✔ 全部通过，无问题');
} else {
  console.log('[ResultDr] 结果 | ok=' + ok + ' | ERROR=' + errors.length + ' WARN=' + warns.length);
  issues.forEach(function(i) {
    const icon = i.level === 'ERROR' ? '✖' : '⚠';
    console.log('  ' + icon + ' [' + i.level + '] ' + i.check + ': ' + i.msg);
    if (i.detail && verbose) console.log('    → ' + i.detail);
  });
}

process.exit(ok ? 0 : 1);

module.exports = { issues, report, ok };
