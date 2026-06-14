#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 跨平台清理(替代 reset-results.ps1)—— 清空结果/批次/会话目录【内容】(保留目录本身)。
//
// 文件定位:仓库根 / reset-results.js
//
// 背景:原 reset-results.ps1 仅 Windows(PowerShell)。npm scripts 现指向本脚本,Windows / macOS / Linux
//   一律 `node reset-results.js` 跑通(Node 本就是项目依赖)。.ps1 保留供 Windows 用户直接调用。
//
// 用法:  node reset-results.js          清 results / batch-results / session-records / output
//        node reset-results.js --all    额外清 test-results / playwright-report
// 与 .ps1 一致:逐项【工作区边界护栏】(绝不删仓库外路径);目录不存在则跳过;清的是内容、保留目录壳。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const includeReports = process.argv
  .slice(2)
  .some((a) => a === '--all' || a === '-IncludeReports' || a === '--IncludeReports');

function clearDirectoryContents(targetPath, label) {
  const resolvedRoot = path.resolve(ROOT);
  const resolvedTarget = path.resolve(targetPath);
  // 工作区边界护栏:目标必须在仓库根内(等于根本身或以 根+分隔符 开头),否则拒绝。
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to clear path outside workspace: ${resolvedTarget}`);
  }
  if (!fs.existsSync(resolvedTarget)) {
    console.log(`[skip] ${label} not found: ${resolvedTarget}`);
    return;
  }
  for (const entry of fs.readdirSync(resolvedTarget)) {
    fs.rmSync(path.join(resolvedTarget, entry), { recursive: true, force: true });
  }
  console.log(`[ok] cleared ${label}: ${resolvedTarget}`);
}

clearDirectoryContents(path.join(ROOT, 'Dreamina/0.0.3/results'), 'Dreamina results');
clearDirectoryContents(path.join(ROOT, 'Dreamina/0.0.3/batch-results'), 'Dreamina batch-results');
clearDirectoryContents(path.join(ROOT, 'Dreamina/0.0.3/session-records'), 'Dreamina session-records');
clearDirectoryContents(path.join(ROOT, 'output'), 'root output');

if (includeReports) {
  clearDirectoryContents(path.join(ROOT, 'test-results'), 'test-results');
  clearDirectoryContents(path.join(ROOT, 'playwright-report'), 'playwright-report');
} else {
  console.log('[skip] test-results/playwright-report; pass --all to clear them');
}

console.log('[done] reset complete');
