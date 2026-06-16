'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Dreamina 0.0.4 Web 控制台（后端） —— Node-only
//
// 文件定位：Dreamina/0.0.4/web/server.js
//
// 提供：
//   GET  /                      控制台页面（public/index.html，原生 JS，无需构建）
//   POST /api/run               {plan,tab,concurrency,accountLimit,dryRun,headed,...} → 拉起批量跑，返回 {jobId}
//   GET  /api/events?jobId=...  SSE：重放缓冲 + 实时推送 9 阶段进度/日志/成功失败/job-done
//   GET  /api/cards             卡池快照 + 统计
//   POST /api/cards/import      {text,maxUses} 文本导入卡
//   POST /api/cards/disable     {id} / /api/cards/enable {id}
//   GET  /api/config            读 config.json 的 upgrade/billing 节
//   POST /api/config            写回 upgrade/billing（套餐/真实扣款开关等）
//   GET  /api/health            健康检查
//
// 端口：DREAMINA_WEB_PORT（默认 4417）。引擎驱动见 engine-runner.js（纯 Node 子进程）。
// 注：完整 React SPA（移植 OpenRouter web/src）列为后续增强；当前为功能完备的原生控制台。
// ═══════════════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const eventBus = require('./event-bus');
const engineRunner = require('./engine-runner');
const cardStore = require('./card-store');

const PORT = Number(process.env.DREAMINA_WEB_PORT || 4417);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_e) { return {}; } }
function writeConfigAtomic(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

// 把控制台表单 → batch-runner CLI args + billing env 旗标。
function buildRunArgs(body) {
  const args = [];
  if (Number(body.concurrency) > 0) args.push('--concurrency', String(Number(body.concurrency)));
  if (Number(body.accountLimit) > 0) args.push('--account-limit', String(Number(body.accountLimit)));
  if (body.headed) args.push('--headed');
  if (body.ignoreKnownExists) args.push('--ignore-known-exists');
  if (body.dryRun) args.push('--dry-run');
  if (body.noUpgrade) args.push('--no-upgrade');
  if (body.noBilling) args.push('--no-billing');
  if (body.plan) args.push('--plan', String(body.plan));
  if (body.tab) args.push('--tab', String(body.tab));
  if (Number(body.amount) > 0) args.push('--amount', String(Number(body.amount)));
  return args;
}

const ROUTES = {
  'POST /api/run': async (req, res) => {
    const body = await readBody(req);
    const jobId = 'job-' + crypto.randomUUID().slice(0, 8);
    const args = buildRunArgs(body);
    engineRunner.runJob(jobId, args);
    sendJson(res, 200, { ok: true, jobId, args });
  },

  'GET /api/events': (req, res, q) => {
    const jobId = String(q.jobId || '').trim();
    if (!jobId) return sendJson(res, 400, { ok: false, error: 'jobId required' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const lastSeq = Number(req.headers['last-event-id'] || q.lastSeq || 0);
    for (const evt of eventBus.getBuffered(jobId, lastSeq)) {
      res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    }
    const unsub = eventBus.subscribe(jobId, (evt) => {
      res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    });
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_e) { /* */ } }, 25000);
    if (hb.unref) hb.unref();
    req.on('close', () => { clearInterval(hb); unsub(); });
  },

  'GET /api/cards': async (_req, res) => {
    const [snapshot, stats, available] = await Promise.all([cardStore.snapshot(), cardStore.stats(), cardStore.availableCount()]);
    sendJson(res, 200, { ok: true, snapshot, stats, available });
  },
  'POST /api/cards/import': async (req, res) => {
    const body = await readBody(req);
    const result = await cardStore.importFromText(String(body.text || ''), Number(body.maxUses) || undefined);
    sendJson(res, 200, { ok: true, ...result });
  },
  'POST /api/cards/disable': async (req, res) => { const b = await readBody(req); await cardStore.disable(String(b.id)); sendJson(res, 200, { ok: true }); },
  'POST /api/cards/enable': async (req, res) => { const b = await readBody(req); await cardStore.enable(String(b.id)); sendJson(res, 200, { ok: true }); },

  'GET /api/config': (_req, res) => {
    const cfg = readConfig();
    sendJson(res, 200, { ok: true, upgrade: cfg.upgrade || {}, billing: cfg.billing || {} });
  },
  'POST /api/config': async (req, res) => {
    const body = await readBody(req);
    const cfg = readConfig();
    if (body.upgrade && typeof body.upgrade === 'object') cfg.upgrade = { ...(cfg.upgrade || {}), ...body.upgrade };
    if (body.billing && typeof body.billing === 'object') {
      const nextBilling = { ...(cfg.billing || {}), ...body.billing };
      if (body.billing.cashier && typeof body.billing.cashier === 'object') nextBilling.cashier = { ...((cfg.billing || {}).cashier || {}), ...body.billing.cashier };
      cfg.billing = nextBilling;
    }
    try { writeConfigAtomic(cfg); sendJson(res, 200, { ok: true, upgrade: cfg.upgrade, billing: cfg.billing }); }
    catch (e) { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); }
  },

  'GET /api/health': (_req, res) => sendJson(res, 200, { ok: true, service: 'dreamina-web', port: PORT, at: new Date().toISOString() }),
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '/';
    const key = `${req.method} ${pathname}`;
    if (ROUTES[key]) return await ROUTES[key](req, res, parsed.query);
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
    sendJson(res, 404, { ok: false, error: 'not found', path: pathname });
  } catch (e) {
    try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (_e) { /* */ }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[Dreamina Web] 控制台已启动: http://127.0.0.1:${PORT}  (DREAMINA_WEB_PORT 可改端口)`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

module.exports = { server, PORT, buildRunArgs };
