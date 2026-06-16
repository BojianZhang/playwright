'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 临时输入文件 — Openrouter / web / temp-inputs
//
// 把 web 表单里的账号/代理文本落成 run.py / hybrid_run.py 需要的 --accounts / --proxies 文件。
// 落在 data/_runs_tmp/<jobId>/,job 结束后清理。零依赖、CommonJS。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const TMP_BASE = path.join(__dirname, '..', 'data', '_runs_tmp');

// accounts: [{email,password}] → "email:password" 每行(password 即邮箱密码)
// proxies:  [{host,port,username,password}] → "host:port:user:pass" 每行(无账密则 host:port)
function write(jobId, accounts, proxies) {
  const dir = path.join(TMP_BASE, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const accLines = (accounts || []).map((a) => `${a.email}:${a.password || ''}`);
  const accFile = path.join(dir, 'accounts.txt');
  fs.writeFileSync(accFile, accLines.join('\n') + '\n', 'utf8');

  const pxLines = (proxies || []).map((p) => (p.username
    ? `${p.host}:${p.port}:${p.username}:${p.password || ''}`
    : `${p.host}:${p.port}`));
  const pxFile = path.join(dir, 'proxies.txt');
  fs.writeFileSync(pxFile, pxLines.join('\n') + '\n', 'utf8');

  return { dir, accFile, pxFile, accCount: accLines.length, pxCount: pxLines.length };
}

// split：把账号随机切两组,各写一份(代理共用一份)。ratioA = A 组占比(0-1)。
// 返回 { dir, pxFile, groupA:{accFile,count}, groupB:{accFile,count} }。
function writeSplit(jobId, accounts, proxies, ratioA) {
  const dir = path.join(TMP_BASE, jobId);
  fs.mkdirSync(dir, { recursive: true });
  // 洗牌(Fisher-Yates),再按比例切
  const arr = (accounts || []).slice();
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const r = (typeof ratioA === 'number' && ratioA > 0 && ratioA < 1) ? ratioA : 0.5;
  const na = Math.max(0, Math.min(arr.length, Math.round(arr.length * r)));
  const groupA = arr.slice(0, na);
  const groupB = arr.slice(na);
  const toLines = (xs) => xs.map((a) => `${a.email}:${a.password || ''}`).join('\n') + '\n';
  const aFile = path.join(dir, 'accounts.A.txt');
  const bFile = path.join(dir, 'accounts.B.txt');
  fs.writeFileSync(aFile, toLines(groupA), 'utf8');
  fs.writeFileSync(bFile, toLines(groupB), 'utf8');
  const pxLines = (proxies || []).map((p) => (p.username ? `${p.host}:${p.port}:${p.username}:${p.password || ''}` : `${p.host}:${p.port}`));
  const pxFile = path.join(dir, 'proxies.txt');
  fs.writeFileSync(pxFile, pxLines.join('\n') + '\n', 'utf8');
  return { dir, pxFile, groupA: { accFile: aFile, count: groupA.length }, groupB: { accFile: bFile, count: groupB.length } };
}

// 跨引擎衔接(split 第二轮)用:从 payload.accounts 里挑「邮箱 ∈ emailSet」的子集,写到 <jobId>/<name>。
// 代理沿用 writeSplit 已写的 proxies.txt(不重写代理)。返回 { accFile, count }。
// 文件名(如 accounts.handoff-hybrid.txt)不与 accounts.A/B.txt 冲突,readResumeInputs 也不读它们 → 续跑不受影响;cleanup(jobId) 已能清。
function writeSubset(jobId, accounts, emailSet, name) {
  const dir = path.join(TMP_BASE, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const subset = (accounts || []).filter((a) => emailSet.has(a.email));
  const accFile = path.join(dir, name);
  fs.writeFileSync(accFile, subset.map((a) => `${a.email}:${a.password || ''}`).join('\n') + '\n', 'utf8');
  return { accFile, count: subset.length };
}

function cleanup(jobId) {
  try { fs.rmSync(path.join(TMP_BASE, jobId), { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

// ★批量恢复保留了【有失败的批次】的输入(供运行详情复用原始账号·密码·代理)→ 配套 TTL 回收防无限堆积。
// 按目录 mtime 判龄,超 maxAgeMs(默认 3 天)的整目录删除。返回回收个数。server 启动时调一次。
function reapStaleTempInputs(maxAgeMs) {
  const ttl = (maxAgeMs == null || maxAgeMs === '') ? 3 * 24 * 3600 * 1000 : Math.max(0, Number(maxAgeMs) || 0);
  let reaped = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(TMP_BASE)) {
      const d = path.join(TMP_BASE, name);
      try {
        const st = fs.statSync(d);
        if (st.isDirectory() && (now - st.mtimeMs) >= ttl) { fs.rmSync(d, { recursive: true, force: true }); reaped += 1; }
      } catch (_e) { /* 单目录异常不影响其它 */ }
    }
  } catch (e) {
    // ENOENT = TMP_BASE 还没建(没东西可清,正常);其它错(权限/挂载丢失)= 清理静默失败→输入会无限堆积,必须告警让运维可见。
    if (e && e.code !== 'ENOENT') { try { console.warn(`[temp-inputs] reapStaleTempInputs 访问 ${TMP_BASE} 失败 → 续跑临时输入可能堆积: ${e.message}`); } catch (_e2) { /* */ } }
  }
  return reaped;
}

// 提交时把"非账号/代理"的完整任务参数落一份 job.json，供日后「续跑这批」忠实重建
// (accountsRaw/proxiesRaw 不写进来——它们就在 accounts.txt/proxies.txt，避免重复存凭证)。
function writeManifest(jobId, manifest) {
  try {
    const dir = path.join(TMP_BASE, jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(manifest), 'utf8');
    return true;
  } catch (_e) { return false; }
}

// 「续跑这批」读取源 job 的输入:accounts.txt(split 用 A/B 合并)+ proxies.txt + job.json。
// 返回 { accountsRaw, proxiesRaw, manifest } ;accounts 文件都不在(正常跑完已清理)→ null。
function readResumeInputs(jobId) {
  const dir = path.join(TMP_BASE, jobId);
  const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_e) { return ''; } };
  let accountsRaw = rd('accounts.txt');
  let splitHint = false;
  if (!accountsRaw.trim()) {
    // split 引擎写的是 accounts.A.txt / accounts.B.txt → 合并(且据此推断引擎=split)
    const ab = [rd('accounts.A.txt'), rd('accounts.B.txt')].filter((s) => s.trim()).join('\n');
    if (ab.trim()) { accountsRaw = ab; splitHint = true; }
  }
  if (!accountsRaw.trim()) return null;   // 输入已被清理,无法续跑
  let manifest = null;
  try { manifest = JSON.parse(rd('job.json') || 'null'); } catch (_e) { manifest = null; }
  return { accountsRaw, proxiesRaw: rd('proxies.txt'), manifest, splitHint };
}

module.exports = { write, writeSplit, writeSubset, cleanup, reapStaleTempInputs, writeManifest, readResumeInputs, TMP_BASE };
