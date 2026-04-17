'use strict';
/**
 * state-doctor.js — 账号状态文件健康诊断
 *
 * 检查内容：
 *   1. 四个状态文件格式正确性（必须是 JSON 数组）
 *   2. local vs registered 去重：同一邮箱不应同时出现在两个文件
 *   3. local vs blacklisted 去重：黑名单邮箱不应还在待跑池
 *   4. registered vs blacklisted 去重（账号已注册不应出现在黑名单）
 *   5. accounts-done.txt 与 registered-accounts.json 一致性校验
 *   6. retry 文件格式 + 每条必须含 email + password
 *
 * 运行：
 *   node Dreamina/0.0.3/account-state/state-doctor.js
 *   node Dreamina/0.0.3/account-state/state-doctor.js --verbose
 */

const fs = require('fs');
const path = require('path');

const ACCOUNT_STATE_DIR = path.join(__dirname);
const RUNNER_DIR = path.join(__dirname, '..');
const FILES = {
  local: path.join(ACCOUNT_STATE_DIR, 'local-accounts.json'),
  registered: path.join(ACCOUNT_STATE_DIR, 'registered-accounts.json'),
  blacklisted: path.join(ACCOUNT_STATE_DIR, 'blacklisted-accounts.json'),
  retry: path.join(ACCOUNT_STATE_DIR, 'retry-accounts.json'),
  done: path.join(RUNNER_DIR, 'batch-results', 'accounts-done.txt'),
};

const verbose = process.argv.includes('--verbose');
const issues = [];
const stats = {};

// ─── 工具函数 ─────────────────────────────────────────────────────────

function issue(level, check, msg, detail) {
  issues.push({ level, check, msg, detail });
}

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function readJsonArray(filePath, label) {
  if (!fs.existsSync(filePath)) {
    issue('ERROR', label, '文件不存在: ' + filePath);
    return null;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    issue('ERROR', label, 'JSON 解析失败: ' + e.message);
    return null;
  }
  if (!Array.isArray(data)) {
    issue('ERROR', label, '文件内容不是 JSON 数组，实际类型: ' + typeof data);
    return null;
  }
  return data;
}

function readDoneTxt(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  return new Set(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(function(l) { return l.trim().toLowerCase(); })
      .filter(Boolean)
  );
}

function emailSet(arr, label) {
  const s = new Set();
  const dupes = [];
  (arr || []).forEach(function(item) {
    const e = normalizeEmail(item && item.email);
    if (!e) {
      if (verbose) issue('WARN', label, '条目缺少 email 字段', JSON.stringify(item).substring(0, 80));
      return;
    }
    if (s.has(e)) dupes.push(e);
    s.add(e);
  });
  if (dupes.length) issue('WARN', label, '文件内部重复 email: ' + dupes.join(', '));
  return s;
}

// ─── 主检查逻辑 ────────────────────────────────────────────────────────

// 1. 读取所有文件
const local = readJsonArray(FILES.local, 'local-accounts');
const registered = readJsonArray(FILES.registered, 'registered-accounts');
const blacklisted = readJsonArray(FILES.blacklisted, 'blacklisted-accounts');
const retry = readJsonArray(FILES.retry, 'retry-accounts');
const doneSet = readDoneTxt(FILES.done);

stats.local = local ? local.length : 'ERROR';
stats.registered = registered ? registered.length : 'ERROR';
stats.blacklisted = blacklisted ? blacklisted.length : 'ERROR';
stats.retry = retry ? retry.length : 'ERROR';
stats.done = doneSet.size;

// 2. 构建 email 集合
const localSet = emailSet(local, 'local-accounts');
const registeredSet = emailSet(registered, 'registered-accounts');
const blacklistedSet = emailSet(blacklisted, 'blacklisted-accounts');
const retrySet = emailSet(retry, 'retry-accounts');

// 3. 跨文件去重检查
function findOverlap(setA, setB, labelA, labelB) {
  const overlap = [];
  setA.forEach(function(e) { if (setB.has(e)) overlap.push(e); });
  return overlap;
}

const localVsRegistered = findOverlap(localSet, registeredSet, 'local', 'registered');
if (localVsRegistered.length) {
  issue('ERROR', 'cross-dedup:local-vs-registered',
    localVsRegistered.length + ' 个邮箱同时出现在 local 和 registered（已注册账号未从 local 移除）',
    localVsRegistered.slice(0, 5).join(', ') + (localVsRegistered.length > 5 ? '...' : ''));
}

const localVsBlacklisted = findOverlap(localSet, blacklistedSet, 'local', 'blacklisted');
if (localVsBlacklisted.length) {
  issue('ERROR', 'cross-dedup:local-vs-blacklisted',
    localVsBlacklisted.length + ' 个黑名单邮箱仍在 local 待跑池（应从 local 移除）',
    localVsBlacklisted.slice(0, 5).join(', '));
}

const registeredVsBlacklisted = findOverlap(registeredSet, blacklistedSet, 'registered', 'blacklisted');
if (registeredVsBlacklisted.length) {
  issue('WARN', 'cross-dedup:registered-vs-blacklisted',
    registeredVsBlacklisted.length + ' 个已注册账号也出现在黑名单（语义矛盾，可忽略或手动清理）',
    registeredVsBlacklisted.slice(0, 5).join(', '));
}

const localVsRetry = findOverlap(localSet, retrySet, 'local', 'retry');
if (localVsRetry.length) {
  issue('WARN', 'cross-dedup:local-vs-retry',
    localVsRetry.length + ' 个 retry 邮箱已回注到 local（retry 文件应已清空这些条目）',
    localVsRetry.slice(0, 5).join(', '));
}

// 4. done.txt 与 registered 一致性
const registeredNotInDone = [];
const doneNotInRegistered = [];

registeredSet.forEach(function(e) {
  if (!doneSet.has(e)) registeredNotInDone.push(e);
});
doneSet.forEach(function(e) {
  if (!registeredSet.has(e)) doneNotInRegistered.push(e);
});

if (registeredNotInDone.length > 10) {
  issue('WARN', 'done-vs-registered',
    registeredNotInDone.length + ' 个 registered 账号未出现在 accounts-done.txt（可能来自老版本，非错误）',
    '示例: ' + registeredNotInDone.slice(0, 3).join(', '));
}
if (doneNotInRegistered.length) {
  issue('WARN', 'done-vs-registered',
    doneNotInRegistered.length + ' 个 accounts-done.txt 条目未出现在 registered-accounts.json（双写漂移）',
    '示例: ' + doneNotInRegistered.slice(0, 3).join(', '));
}

// 5. retry 条目字段完整性
if (retry) {
  const retryMissingPassword = retry.filter(function(a) { return !a.password; });
  if (retryMissingPassword.length) {
    issue('WARN', 'retry-integrity',
      retryMissingPassword.length + ' 个 retry 条目缺少 password，无法回注后重跑',
      retryMissingPassword.map(function(a) { return a.email; }).slice(0, 5).join(', '));
  }
}

// 6. local 条目完整性
if (local) {
  const missingPwd = local.filter(function(a) { return !a.password; });
  if (missingPwd.length) {
    issue('ERROR', 'local-integrity',
      missingPwd.length + ' 个 local 账号缺少 password',
      missingPwd.map(function(a) { return a.email; }).slice(0, 5).join(', '));
  }
}

// ─── 输出报告 ──────────────────────────────────────────────────────────
const errors = issues.filter(function(i) { return i.level === 'ERROR'; });
const warns = issues.filter(function(i) { return i.level === 'WARN'; });
const ok = errors.length === 0;

console.log('[StateDr] ══ 账号状态文件诊断 ══');
console.log('[StateDr] local=' + stats.local + ' | registered=' + stats.registered +
  ' | blacklisted=' + stats.blacklisted + ' | retry=' + stats.retry + ' | done.txt=' + stats.done);

if (issues.length === 0) {
  console.log('[StateDr] ✔ 全部通过，无问题');
} else {
  console.log('[StateDr] 结果 | ok=' + ok + ' | ERROR=' + errors.length + ' WARN=' + warns.length);
  issues.forEach(function(i) {
    const icon = i.level === 'ERROR' ? '✖' : '⚠';
    console.log('  ' + icon + ' [' + i.level + '] ' + i.check + ': ' + i.msg);
    if (i.detail && verbose) console.log('    → ' + i.detail);
  });
}

process.exit(ok ? 0 : 1);

module.exports = { issues, stats, ok };
