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
const PUSHED_DIR = path.join(RESULTS_DIR, '_pushed'); // 子机推送过来的结果(每个节点一个文件)
// 节点标识：分布式多机部署时用于区分来源、保证文件名/jobId 跨机不重复。
const NODE_ID = (process.env.OPENROUTER_NODE_ID || os.hostname() || 'node').replace(/[^\w-]/g, '-').slice(0, 40);

// 集群配置：中心机在 config.json 配 cluster.hosts = ["http://机器1:4317", ...],
// 聚合接口会自动带上,这样 results 页无需每次手填即可汇总全集群。
function loadClusterHosts() {
  let hosts = [];
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); if (Array.isArray(c.cluster?.hosts)) hosts = c.cluster.hosts; } catch (_e) { /* none */ }
  try { const l = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.local.json'), 'utf8')); if (Array.isArray(l.cluster?.hosts)) hosts = l.cluster.hosts; } catch (_e) { /* none */ }
  if (process.env.OPENROUTER_CLUSTER_HOSTS) hosts = process.env.OPENROUTER_CLUSTER_HOSTS.split(',').map((s) => s.trim()).filter(Boolean);
  return hosts;
}
function readCluster(key) {
  for (const f of ['config.local.json', 'config.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')); if (c.cluster && c.cluster[key] !== undefined) return c.cluster[key]; } catch (_e) { /* none */ }
  }
  return undefined;
}

// ── 动态节点注册表(子机心跳上报 → 主机自动聚合,无需手填机器清单)──────────
const PEERS = new Map(); // nodeId -> { nodeId, url, lastSeen }
const PEER_TTL_MS = 90000; // 超过 90s 没心跳视为离线
function getActivePeers() {
  const now = Date.now();
  return [...PEERS.values()].filter((p) => now - p.lastSeen < PEER_TTL_MS && p.nodeId !== NODE_ID);
}

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

// ── 鉴权：访问令牌(推荐,分布式友好) + 可选 Basic Auth ──────────────────────
// 令牌来源:环境变量 OPENROUTER_AUTH_TOKEN > config.local.json/config.json 的 security.token。
function loadAuthToken() {
  if (process.env.OPENROUTER_AUTH_TOKEN) return process.env.OPENROUTER_AUTH_TOKEN;
  for (const f of ['config.local.json', 'config.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')); if (c.security?.token) return c.security.token; } catch (_e) { /* none */ }
  }
  return '';
}
const AUTH_TOKEN = loadAuthToken();
const AUTH_USER = process.env.OPENROUTER_WEB_USER || '';
const AUTH_PASS = process.env.OPENROUTER_WEB_PASS || '';

// 取请求里的 token：X-Auth-Token 头 / Authorization: Bearer / ?token=
function reqToken(req, url) {
  return req.headers['x-auth-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (url && url.searchParams.get('token'))
    || '';
}
function checkAuth(req, res, url) {
  if (!AUTH_TOKEN && !AUTH_USER) return true; // 都没配 = 不鉴权(仅建议内网/本机)
  if (AUTH_TOKEN && reqToken(req, url) === AUTH_TOKEN) return true;
  if (AUTH_USER) {
    const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (m) { const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':'); if (u === AUTH_USER && p === AUTH_PASS) return true; }
  }
  // 只有在"纯 Basic Auth(没配 token)"时才发 WWW-Authenticate,触发浏览器登录框;
  // 用 token 时不发,避免浏览器弹自带登录框干扰(改由前端 token 弹窗处理)。
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (AUTH_USER && !AUTH_TOKEN) headers['WWW-Authenticate'] = 'Basic realm="Openrouter Console"';
  res.writeHead(401, headers);
  res.end('Unauthorized: 需要访问令牌(token)');
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

// POST /api/register —— 子机心跳上报;主机记录其地址(默认用请求来源 IP + 上报端口)。
async function handleRegister(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const nodeId = String(body.nodeId || '').slice(0, 60);
  if (!nodeId) { sendJson(res, 400, { error: 'MISSING_NODE_ID' }); return; }
  let url = String(body.url || '').trim();
  if (!url) { url = `http://${clientIp(req)}:${Number(body.port) || PORT}`; }
  PEERS.set(nodeId, { nodeId, url, lastSeen: Date.now() });
  sendJson(res, 200, { ok: true, registered: { nodeId, url } });
}

// POST /api/push —— 子机把自己的成功账号推给中心机(出站,穿 NAT;适合 NAT 后的子机)。
async function handlePush(req, res) {
  let body;
  try { body = await readJsonBody(req, 64 * 1024 * 1024); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const nodeId = String(body.nodeId || '').replace(/[^\w-]/g, '-').slice(0, 60);
  if (!nodeId) { sendJson(res, 400, { error: 'MISSING_NODE_ID' }); return; }
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  try {
    fs.mkdirSync(PUSHED_DIR, { recursive: true });
    fs.writeFileSync(path.join(PUSHED_DIR, `${nodeId}.json`), JSON.stringify({ nodeId, updatedAt: Date.now(), accounts }));
  } catch (_e) { /* ignore */ }
  // 同时标记为在线节点(即使没有可回连的 url)
  const prev = PEERS.get(nodeId) || {};
  PEERS.set(nodeId, { nodeId, url: prev.url || '', lastSeen: Date.now() });
  sendJson(res, 200, { ok: true, stored: accounts.length });
}
function readPushed() {
  const out = [];
  try {
    for (const f of fs.readdirSync(PUSHED_DIR).filter((x) => x.endsWith('.json'))) {
      try { const o = JSON.parse(fs.readFileSync(path.join(PUSHED_DIR, f), 'utf8')); out.push({ nodeId: o.nodeId, count: (o.accounts || []).length, accounts: o.accounts || [] }); } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* none */ }
  return out;
}

// POST /api/aggregate —— 服务端聚合:本节点 + 指定远程节点,合并去重(绕开浏览器跨域)。
async function handleApiAggregate(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  // 请求里的 hosts 与服务端配置的 cluster.hosts 合并去重 → 中心机配好后无需手填。
  const bodyHosts = Array.isArray(body.hosts) ? body.hosts : [];
  // 合并:请求传入 + 配置 cluster.hosts + 动态注册的在线子机
  const hosts = [...new Set([...bodyHosts, ...loadClusterHosts(), ...getActivePeers().map((p) => p.url)].map((h) => String(h).trim()).filter(Boolean))];
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
      // 节点间聚合带上令牌(假设全集群同一 token);也支持 URL 内嵌 user:pass。
      const headers = AUTH_TOKEN ? { 'X-Auth-Token': AUTH_TOKEN } : {};
      const resp = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      const arr = j.accounts || [];
      arr.forEach((a) => all.push(a));
      sources.push({ source: h, count: arr.length, ok: true });
    } catch (e) {
      sources.push({ source: h, count: 0, ok: false, error: String(e.message || e) });
    }
  }
  // 子机推送过来的数据(NAT 后子机)——去重会自动处理与 pull 的重叠。
  for (const p of readPushed()) { p.accounts.forEach((a) => all.push(a)); sources.push({ source: `push(${p.nodeId})`, count: p.count, ok: true }); }
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

// 仅"数据/动作"接口需要鉴权;静态页面(无敏感数据,只是 UI 外壳)放行,
// 这样开了 token 也能先打开页面、再由前端弹窗输入 token。
// 全锁定模式:开启后连静态页面也要 token(陌生人有域名也打不开)。
// 用 ?token= 访问一次即可(auth.js 会带入并记住)。开关:security.gateStatic / OPENROUTER_GATE_STATIC=1
function loadGateStatic() {
  if (process.env.OPENROUTER_GATE_STATIC) return process.env.OPENROUTER_GATE_STATIC === '1' || process.env.OPENROUTER_GATE_STATIC === 'true';
  for (const f of ['config.local.json', 'config.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')); if (c.security && typeof c.security.gateStatic === 'boolean') return c.security.gateStatic; } catch (_e) { /* none */ }
  }
  return false;
}
const GATE_STATIC = loadGateStatic();
function isProtectedRoute(pathname) {
  if (GATE_STATIC) return true; // 全锁定:所有路由都要鉴权
  return pathname === '/jobs' || pathname === '/events' || pathname === '/download' || pathname.startsWith('/api/');
}

// ── IP / 域名白名单(可选,代码级兜底)────────────────────────────────────
// 配置来源:环境变量 > config.local.json/config.json 的 security.{allowIps,allowHosts,trustForwardedFor}。
function readSec(key) {
  for (const f of ['config.local.json', 'config.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')); if (c.security && c.security[key] !== undefined) return c.security[key]; } catch (_e) { /* none */ }
  }
  return undefined;
}
function toList(v) { if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean); if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean); return []; }
const ALLOW_IPS = process.env.OPENROUTER_ALLOW_IPS ? toList(process.env.OPENROUTER_ALLOW_IPS) : toList(readSec('allowIps'));
const ALLOW_HOSTS = (process.env.OPENROUTER_ALLOW_HOSTS ? toList(process.env.OPENROUTER_ALLOW_HOSTS) : toList(readSec('allowHosts'))).map((h) => h.toLowerCase());
const TRUST_PROXY = process.env.OPENROUTER_TRUST_PROXY === '1' || readSec('trustForwardedFor') === true;

function ipToLong(ip) { return ip.split('.').reduce((a, o) => (((a << 8) + (parseInt(o, 10) & 255)) >>> 0), 0) >>> 0; }
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim().replace(/^::ffff:/, '');
  return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}
function ipAllowed(req) {
  if (!ALLOW_IPS.length) return true;
  const ip = clientIp(req);
  if (ip === '127.0.0.1' || ip === '::1') return true; // 本机始终放行
  for (const rule of ALLOW_IPS) {
    if (rule === ip) return true;
    if (rule.includes('/') && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      const [base, bitsStr] = rule.split('/'); const bits = Number(bitsStr);
      if (/^\d+\.\d+\.\d+\.\d+$/.test(base) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
        if ((ipToLong(ip) & mask) === (ipToLong(base) & mask)) return true;
      }
    }
  }
  return false;
}
function hostAllowed(req) {
  if (!ALLOW_HOSTS.length) return true;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return true; // 本机始终放行
  return ALLOW_HOSTS.some((rule) => (rule.startsWith('*.') ? (host === rule.slice(2) || host.endsWith(rule.slice(1))) : host === rule));
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403); res.end('Forbidden (host not allowed)'); return; }
  if (!ipAllowed(req)) { res.writeHead(403); res.end('Forbidden (ip not allowed)'); return; }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  if (isProtectedRoute(pathname) && !checkAuth(req, res, url)) return;

  if (req.method === 'POST' && pathname === '/jobs') return void handleStartJob(req, res);
  if (req.method === 'GET' && pathname === '/events') return void handleEvents(req, res, url.searchParams);
  if (req.method === 'GET' && pathname === '/download') return void handleDownload(req, res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/node') return void sendJson(res, 200, { nodeId: NODE_ID, hostname: os.hostname() });
  if (req.method === 'GET' && pathname === '/api/cluster') return void sendJson(res, 200, { nodeId: NODE_ID, hosts: loadClusterHosts(), peers: getActivePeers().map((p) => ({ nodeId: p.nodeId, url: p.url, ageSec: Math.round((Date.now() - p.lastSeen) / 1000) })) });
  if (req.method === 'GET' && pathname === '/api/results') return void handleApiResults(res);
  if (req.method === 'GET' && pathname === '/api/results/all') return void handleApiResultsAll(res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/results/job') return void handleApiResultsJob(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/register') return void handleRegister(req, res);
  if (req.method === 'POST' && pathname === '/api/push') return void handlePush(req, res);
  if (req.method === 'POST' && pathname === '/api/aggregate') return void handleApiAggregate(req, res);
  if (req.method === 'GET') return void serveStatic(req, res, pathname);

  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[Openrouter Web] 控制台已启动: http://${HOST}:${PORT}  (本机: http://localhost:${PORT})`);
  if (ALLOW_IPS.length) console.log(`🔒 IP 白名单(+本机): ${ALLOW_IPS.join(', ')}${TRUST_PROXY ? ' [信任 X-Forwarded-For]' : ''}`);
  if (ALLOW_HOSTS.length) console.log(`🔒 域名白名单(+localhost): ${ALLOW_HOSTS.join(', ')}`);

  // 子机自动注册:配了中心机地址就启动时 + 每 30s 心跳上报,中心机自动聚合本机。
  const CENTRAL_URL = process.env.OPENROUTER_CENTRAL_URL || readCluster('centralUrl') || '';
  const SELF_URL = process.env.OPENROUTER_SELF_URL || readCluster('selfUrl') || '';
  if (CENTRAL_URL) {
    const base = CENTRAL_URL.replace(/\/+$/, '');
    const authHdr = Object.assign({ 'Content-Type': 'application/json' }, AUTH_TOKEN ? { 'X-Auth-Token': AUTH_TOKEN } : {});
    const register = async () => {
      try {
        await fetch(base + '/api/register', { method: 'POST', headers: authHdr, body: JSON.stringify({ nodeId: NODE_ID, port: PORT, url: SELF_URL || undefined }), signal: AbortSignal.timeout(10000) });
      } catch (_e) { /* 中心机暂不可达,下次重试 */ }
    };
    // 推送本机成功账号给中心机(出站,穿 NAT;中心机够不着子机时也能拿到数据)。
    const pushResults = async () => {
      try {
        const records = [];
        for (const f of listResultJsonl()) { const jobId = f.replace('-success.jsonl', ''); for (const r of readJobRecords(jobId)) records.push({ nodeId: NODE_ID, jobId, ...r }); }
        if (!records.length) return;
        await fetch(base + '/api/push', { method: 'POST', headers: authHdr, body: JSON.stringify({ nodeId: NODE_ID, accounts: records }), signal: AbortSignal.timeout(20000) });
      } catch (_e) { /* 忽略,下次重试 */ }
    };
    const beat = () => { register(); pushResults(); };
    beat();
    setInterval(beat, 30000);
    // eslint-disable-next-line no-console
    console.log(`📡 自动注册并推送结果到中心机: ${CENTRAL_URL}(每 30s)`);
  }
  if (AUTH_TOKEN) {
    // eslint-disable-next-line no-console
    console.log('🔒 访问令牌已启用:所有请求需带 token。');
  } else if (HOST === '0.0.0.0' && !AUTH_USER) {
    // eslint-disable-next-line no-console
    console.log('⚠ 安全提醒: 监听所有网卡且无鉴权!任何能访问本端口的人都能拉取你的成功账号/API Key。');
    console.log('   请任选其一加固: 设 OPENROUTER_AUTH_TOKEN=一个随机串(推荐) / 绑定内网+防火墙 / OPENROUTER_WEB_HOST=127.0.0.1 + SSH 隧道。');
  }
});

module.exports = { server, parseAccounts, parseProxies };
