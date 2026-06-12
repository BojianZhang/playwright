'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Python 驱动共用 —— 子进程跑 Python 脚本，输入经 stdin(JSON)，结果从 stdout 的 OR_RESULT: 行取
//
// 文件定位：Openrouter/0.0.1/automation-driver/py-run.js
// 解释器：OPENROUTER_PYTHON 环境变量 > python(win) / python3。缺 python/脚本异常 → 优雅返回 {error}。
// ═══════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');

function runPython(scriptPath, payload, log) {
  return new Promise((resolve) => {
    let out = ''; let err = '';
    const py = process.env.OPENROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    let p;
    try { p = spawn(py, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (_e) { resolve({ error: 'PY_SPAWN_FAILED' }); return; }
    p.on('error', (e) => resolve({ error: (e && e.code === 'ENOENT') ? 'PY_NOT_FOUND(装 python?)' : 'PY_SPAWN_ERROR', detail: (e && (e.code || e.message)) || '' }));
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code, signal) => {
      // 取最后一行 OR_RESULT:(贪婪匹配整 buffer 会被后续 brace/traceback 破坏成非法 JSON)。
      const lines = out.split(/\r?\n/).filter((l) => l.startsWith('OR_RESULT:'));
      if (lines.length) { try { resolve(JSON.parse(lines[lines.length - 1].slice('OR_RESULT:'.length))); return; } catch (_e) { /* */ } }
      if (log && err) log(`py stderr: ${err.replace(/\s+/g, ' ').slice(0, 200)}`);
      resolve({ error: 'PY_NO_RESULT', code, signal, stderr: err.replace(/\s+/g, ' ').slice(0, 200) });
    });
    try { p.stdin.write(JSON.stringify(payload || {})); p.stdin.end(); } catch (_e) { /* */ }
  });
}

module.exports = { runPython };
