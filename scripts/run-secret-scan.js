#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 跨平台 secret-scan 启动器 —— 解析一个【真能执行】的 python 再跑 scripts/secret_scan.py。
//
// 文件定位:仓库根 / scripts/run-secret-scan.js
//
// 背景:npm 脚本若直接写 `python`,只装了 python3 的 macOS 上会 command-not-found;若写 `python3`,
//   又会撞 Windows 的 Store 占位 stub(where 找得到却跑不了)。故对齐 .githooks/pre-commit 的做法:
//   按 python → python3 → py 顺序【实测】`-c "import sys"`,谁真能跑用谁。passthru 透传参数(如 --all)。
// ═══════════════════════════════════════════════════════════════════════

const { spawnSync } = require('child_process');
const path = require('path');

const SCAN = path.join(__dirname, 'secret_scan.py');
const passthru = process.argv.slice(2);

function resolvePython() {
  for (const cand of ['python', 'python3', 'py']) {
    try {
      const t = spawnSync(cand, ['-c', 'import sys'], { stdio: 'ignore' });
      if (t.status === 0) return cand;
    } catch (_e) { /* try next candidate */ }
  }
  return null;
}

const py = resolvePython();
if (!py) {
  console.log('⚠ 未找到可用的 python,跳过 secret-scan(装 Python 后即生效)');
  process.exit(0);
}
const r = spawnSync(py, [SCAN, ...passthru], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
