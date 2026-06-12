'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — selenium（支持但冗余 · Python）
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/engines/selenium.js
//
// 经 runtime.adspower.debugPort 用 debuggerAddress 让 Python Selenium 接管【同一个】AdsPower 浏览器，
//   switch_to.frame 进 Stripe 跨域 iframe 填卡。能力与 playwright 相同(同浏览器同 CDP)，仅语言不同——
//   纯为"Python 团队想自管填卡"而存在，对填卡能力【无增益】。
// 依赖：python + selenium + 匹配 AdsPower Chromium 的 chromedriver(Selenium Manager 可自动取)。
//   缺 debugPort(非接管模式)/缺 python/版本错配 → 优雅落链(返回未填，链上 playwright 接管)。
// ═══════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');

// 跑 Python 脚本：卡数据经 stdin 传(不进 argv，避免出现在进程列表)；结果从 stdout 的 OR_RESULT: 行取。
function runPython(scriptPath, payload, log) {
  return new Promise((resolve) => {
    let out = ''; let err = '';
    const py = process.env.OPENROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    let p;
    try { p = spawn(py, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (_e) { resolve({ error: 'PY_SPAWN_FAILED' }); return; }
    p.on('error', () => resolve({ error: 'PY_NOT_FOUND' }));
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', () => {
      // 取最后一行 OR_RESULT:(贪婪匹配会被后续 brace/traceback 破坏成非法 JSON)。
      const lines = out.split(/\r?\n/).filter((l) => l.startsWith('OR_RESULT:'));
      if (lines.length) { try { resolve(JSON.parse(lines[lines.length - 1].slice('OR_RESULT:'.length))); return; } catch (_e) { /* */ } }
      if (log && err) log(`selenium py stderr: ${err.replace(/\s+/g, ' ').slice(0, 200)}`);
      resolve({ error: 'PY_NO_RESULT' });
    });
    try { p.stdin.write(JSON.stringify(payload)); p.stdin.end(); } catch (_e) { /* */ }
  });
}

async function fillCard({ card, address, log, runtime }) {
  const debugPort = runtime && runtime.adspower && runtime.adspower.debugPort;
  if (!debugPort) {
    log && log('selenium 引擎：无 AdsPower debugPort(非接管模式?) → 落链');
    return { num: false, exp: false, cvc: false, engine: 'selenium', error: 'NO_DEBUG_PORT' };
  }
  const exp = `${card.expMonth}${card.expYear}`;
  const zip = card.zip || (address && address.zip) || '';
  const scriptPath = path.join(__dirname, '..', 'py', 'selenium_fill.py');
  log && log(`selenium 引擎：Python 经 debuggerAddress 127.0.0.1:${debugPort} 接管填卡`);
  const r = await runPython(scriptPath, { debugPort, number: card.number, expiry: exp, cvc: card.cvc, postal: zip }, log) || {};
  if (r.error) log && log(`selenium 引擎结果: ${r.error}`);
  return { num: !!r.num, exp: !!r.exp, cvc: !!r.cvc, zip: zip ? !!r.zip : undefined, engine: 'selenium', error: r.error };
}

module.exports = { name: 'selenium', fillCard };
