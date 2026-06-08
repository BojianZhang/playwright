'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Web 层 — Openrouter / web / server
//
// 文件定位：Openrouter/0.0.1/web/server.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— Node 原生 http 服务：静态表单页、POST /jobs 起任务、GET /events SSE 推流。
// ❌ 不负责 —— 自动化业务（交给 Openrouter-job-runner.runJob）。
//
// 无第三方依赖（仓库仅有 playwright）。启动：node Openrouter/0.0.1/web/server.js
// ═══════════════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const jobRunner = require('../Openrouter-job-runner');
const eventBus = require('./event-bus');

const PORT = Number(process.env.OPENROUTER_WEB_PORT) || 4317;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESULTS_DIR = path.join(__dirname, '..', 'batch-results');
// 节点标识：分布式多机部署时用于区分来源、保证文件名/jobId 跨机不重复。
const NODE_ID = (process.env.OPENROUTER_NODE_ID || os.hostname() || 'node').replace(/[^\w-]/g, '-').slice(0, 40);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// ── 输入解析 ────────────────────────────────────────────────────────────

/** "email:password" 多行 → [{email,password}]（忽略空行/#注释；密码可含 :） */
function parseAccounts(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return { email: line, password: '' };
      return { email: line.slice(0, idx).trim(), password: line.slice(idx + 1).trim() };
    })
    .filter(acct => acct.email);
}

/** "host:port:user:pass" 多行 → [{host,port,username,password,raw}]（密码可含 :） */
function parseProxies(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const parts = line.split(':');
      const [host, port, username] = parts;
      const password = parts.slice(3).join(':');
      return {
        host: (host || '').trim(),
        port: Number(port) || 0,
        username: (username || '').trim(),
        password: (password || '').trim(),
        server: host && port ? `http://${host}:${port}` : '',
        raw: line,
      };
    })
    .filter(p => p.host && p.port);
}

// ── 请求体读取 ──────────────────────────────────────────────────────────

function readJsonBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ── 路由处理 ────────────────────────────────────────────────────────────

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate', // 避免浏览器缓存旧 JS/CSS
    });
    res.end(data);
  });
}

async function handleStartJob(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const accounts = parseAccounts(payload.accountsRaw);
  const proxies = parseProxies(payload.proxiesRaw);
  if (!accounts.length) {
    sendJson(res, 400, { error: 'NO_ACCOUNTS', message: '账号凭证为空' });
    return;
  }

  const runParams = {
    headed: !!payload.headed,
    concurrency: Math.max(1, Number(payload.concurrency) || 1),
    count: Number(payload.count) || accounts.length,
    timeoutMs: Number(payload.timeoutMs) || 0,
  };
  const slicedAccounts = accounts.slice(0, runParams.count);

  const taskParams = {
    apiKeyName: payload.apiKeyName || '',
    apiKeyExpiration: payload.apiKeyExpiration || 'No expiration',
    topUpAmount: Number(payload.topUpAmount) || 0,
    card: {
      cardNumber: payload.cardNumber || '',
      expMonth: payload.expMonth || '',
      expYear: payload.expYear || '',
      cvc: payload.cvc || '',
      name: payload.cardName || '',
    },
  };

  // jobId 含节点标识 → 文件名 <jobId>-success.txt 跨机器不会重复。
  const jobId = `job-${NODE_ID}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // fire-and-forget：进度通过 SSE 汇报。
  Promise.resolve()
    .then(() => jobRunner.runJob({
      jobId,
      accounts: slicedAccounts,
      proxies,
      runParams,
      taskParams,
      successTemplate: payload.successTemplate || '',
      publish: eventBus.publish,
    }))
    .catch((err) => {
      eventBus.publish(jobId, 'log', `job 异常终止: ${err && err.message}`);
      eventBus.publish(jobId, 'job-done', { jobId, error: err && err.message });
    });

  sendJson(res, 200, { jobId, accepted: slicedAccounts.length });
}

function handleEvents(req, res, query) {
  const jobId = query.get('jobId');
  if (!jobId) { sendJson(res, 400, { error: 'MISSING_JOB_ID' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ jobId })}\n\n`);

  const unsubscribe = eventBus.subscribe(jobId, (evt) => {
    res.write(`event: ${evt.type}\n`);
    res.write(`data: ${JSON.stringify(evt.data === undefined ? null : evt.data)}\n\n`);
  });

  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

// ── 可选 Basic Auth（设置环境变量 OPENROUTER_WEB_USER/PASS 即启用）──────────
const AUTH_USER = process.env.OPENROUTER_WEB_USER || '';
const AUTH_PASS = process.env.OPENROUTER_WEB_PASS || '';
function checkAuth(req, res) {
  if (!AUTH_USER) return true; // 未配置则不鉴权
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Basic\s+(.+)$/i);
  if (m) {
    const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (u === AUTH_USER && p === AUTH_PASS) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Openrouter Console"' });
  res.end('Authentication required');
  return false;
}

// 下载某个 job 的成功结果文件（batch-results/<jobId>-success.txt）。
function handleDownload(req, res, query) {
  const jobId = query.get('jobId') || '';
  if (!/^job-[\w-]+$/.test(jobId)) { sendJson(res, 400, { error: 'BAD_JOB_ID' }); return; }
  const file = path.join(__dirname, '..', 'batch-results', `${jobId}-success.txt`);
  if (!file.startsWith(path.join(__dirname, '..', 'batch-results'))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('结果文件不存在(可能尚无成功账号)'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${jobId}-success.txt"`,
    });
    res.end(data);
  });
}

// ── 结果聚合 API（分布式部署:中心机可逐台拉取整合）────────────────────────
function listResultJsonl() {
  try { return fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('-success.jsonl')); } catch (_e) { return []; }
}
function readJobRecords(jobId) {
  const out = [];
  try {
    fs.readFileSync(path.join(RESULTS_DIR, `${jobId}-success.jsonl`), 'utf8')
      .split('\n').filter(Boolean)
      .forEach((line) => { try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ } });
  } catch (_e) { /* none */ }
  return out;
}
// GET /api/results —— 本节点的 job 列表 + 各自成功数
function handleApiResults(res) {
  const jobs = listResultJsonl().map((f) => {
    const jobId = f.replace('-success.jsonl', '');
    let count = 0; let mtime = null;
    try { count = readJobRecords(jobId).length; } catch (_e) { /* 0 */ }
    try { mtime = fs.statSync(path.join(RESULTS_DIR, f)).mtime.toISOString(); } catch (_e) { /* null */ }
    return { jobId, count, mtime };
  });
  sendJson(res, 200, { nodeId: NODE_ID, hostname: os.hostname(), jobCount: jobs.length, jobs });
}
// GET /api/results/all?format=json|txt —— 本节点所有成功账号(供中心机整合)
function handleApiResultsAll(res, query) {
  const records = [];
  for (const f of listResultJsonl()) {
    const jobId = f.replace('-success.jsonl', '');
    for (const r of readJobRecords(jobId)) records.push({ nodeId: NODE_ID, jobId, ...r });
  }
  if ((query.get('format') || 'json') === 'txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(records.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'));
    return;
  }
  sendJson(res, 200, { nodeId: NODE_ID, count: records.length, accounts: records });
}
// GET /api/results/job?jobId= —— 单个 job 的成功账号
function handleApiResultsJob(res, query) {
  const jobId = query.get('jobId') || '';
  if (!/^job-[\w-]+$/.test(jobId)) { sendJson(res, 400, { error: 'BAD_JOB_ID' }); return; }
  const accounts = readJobRecords(jobId).map((r) => ({ nodeId: NODE_ID, jobId, ...r }));
  sendJson(res, 200, { nodeId: NODE_ID, jobId, count: accounts.length, accounts });
}

// POST /api/aggregate —— 服务端聚合:本节点 + 指定远程节点,合并去重(绕开浏览器跨域)。
async function handleApiAggregate(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const hosts = Array.isArray(body.hosts) ? body.hosts : [];
  const includeLocal = body.includeLocal !== false;
  const dedupeMode = body.dedupe || 'email';
  const all = [];
  const sources = [];
  if (includeLocal) {
    let n = 0;
    for (const f of listResultJsonl()) { const jobId = f.replace('-success.jsonl', ''); for (const r of readJobRecords(jobId)) { all.push({ nodeId: NODE_ID, jobId, ...r }); n += 1; } }
    sources.push({ source: `local(${NODE_ID})`, count: n, ok: true });
  }
  for (const h of hosts) {
    try {
      const u = String(h).replace(/\/+$/, '') + '/api/results/all';
      const resp = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      const arr = j.accounts || [];
      arr.forEach((a) => all.push(a));
      sources.push({ source: h, count: arr.length, ok: true });
    } catch (e) {
      sources.push({ source: h, count: 0, ok: false, error: String(e.message || e) });
    }
  }
  let merged = all;
  if (dedupeMode !== 'none') {
    const seen = new Map();
    for (const r of all) {
      const key = dedupeMode === 'email+apiKey' ? `${r.email}|${r.apiKey}` : (r.email || JSON.stringify(r));
      if (!seen.has(key) || (!seen.get(key).apiKey && r.apiKey)) seen.set(key, r);
    }
    merged = [...seen.values()];
  }
  sendJson(res, 200, { total: all.length, count: merged.length, sources, accounts: merged });
}

// ── 服务器 ──────────────────────────────────────────────────────────────
const HOST = process.env.OPENROUTER_WEB_HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'POST' && pathname === '/jobs') return void handleStartJob(req, res);
  if (req.method === 'GET' && pathname === '/events') return void handleEvents(req, res, url.searchParams);
  if (req.method === 'GET' && pathname === '/download') return void handleDownload(req, res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/node') return void sendJson(res, 200, { nodeId: NODE_ID, hostname: os.hostname() });
  if (req.method === 'GET' && pathname === '/api/results') return void handleApiResults(res);
  if (req.method === 'GET' && pathname === '/api/results/all') return void handleApiResultsAll(res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/results/job') return void handleApiResultsJob(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/aggregate') return void handleApiAggregate(req, res);
  if (req.method === 'GET') return void serveStatic(req, res, pathname);

  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[Openrouter Web] 控制台已启动: http://${HOST}:${PORT}  (本机: http://localhost:${PORT})`);
  if (HOST === '0.0.0.0' && !AUTH_USER) {
    // eslint-disable-next-line no-console
    console.log('⚠ 安全提醒: 已监听所有网卡且无鉴权。公网部署请设置 OPENROUTER_WEB_USER/PASS 或绑定 localhost(OPENROUTER_WEB_HOST=127.0.0.1)+SSH 隧道。');
  }
});

module.exports = { server, parseAccounts, parseProxies };
