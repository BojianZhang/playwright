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
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const jobRunner = require('../playwright/Openrouter-job-runner');
const eventBus = require('./event-bus');
const cardPool = require('../billing/card-pool');
const billingLedger = require('../billing/billing-ledger');
const accountStore = require('../data/account-store');
const failurePolicy = require('../playwright/failure-policy');
const policyStore = require('../data/policy-store');
const errorLog = require('../playwright/error-log');
const runsStore = require('./runs-store');
const engineRunner = require('./engine-runner');
const tempInputs = require('./temp-inputs');
const procRegistry = require('./proc-registry');
const procCleanup = require('./proc-cleanup');
const { offsetPage } = require('./paginate');   // 列表接口可选 offset/limit 分页(不带 limit=全量,向后兼容)
const configRw = require('./config-rw');
const strategiesStore = require('./strategies-store');
const schemesStore = require('./schemes-store');
const engineConfigStore = require('./engine-config-store');
const recoveryStore = require('./recovery-store');
const advancedStore = require('./advanced-store');
const selectorsStore = require('./selectors-store');
const selectorsSchema = require('./selectors-schema');
const proxyStore = require('./proxy-store');
const addressStore = require('./address-store');
const adspowerStore = require('./adspower-store');
const adspowerEndpointStore = require('./adspower-endpoint-store');
const serviceKeys = require('./service-keys');   // 验证码/邮箱当前生效 key(跨节点下发用)
const usageStore = require('./usage-store');
const failureAnalytics = require('./failure-analytics');
const captchaStore = require('./captcha-store');
const mailboxStore = require('./mailbox-store');
const setupStore = require('./setup-store');

const PORT = Number(process.env.OPENROUTER_WEB_PORT) || 4317;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RESULTS_DIR = path.join(__dirname, '..', 'data', 'batch-results');
const PUSHED_DIR = path.join(RESULTS_DIR, '_pushed'); // 子机推送过来的结果(每个节点一个文件)
// 节点标识：分布式多机部署时用于区分来源、保证文件名/jobId 跨机不重复。
const NODE_ID = (process.env.OPENROUTER_NODE_ID || os.hostname() || 'node').replace(/[^\w-]/g, '-').slice(0, 40);

// 集群配置：中心机在 config.json 配 cluster.hosts = ["http://机器1:4317", ...],
// 聚合接口会自动带上,这样 results 页无需每次手填即可汇总全集群。
function loadClusterHosts() {
  let hosts = [];
  try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.json'), 'utf8')); if (Array.isArray(c.cluster?.hosts)) hosts = c.cluster.hosts; } catch (_e) { /* none */ }
  try { const l = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.local.json'), 'utf8')); if (Array.isArray(l.cluster?.hosts)) hosts = l.cluster.hosts; } catch (_e) { /* none */ }
  if (process.env.OPENROUTER_CLUSTER_HOSTS) hosts = process.env.OPENROUTER_CLUSTER_HOSTS.split(',').map((s) => s.trim()).filter(Boolean);
  return hosts.filter(validHttpUrl);   // 挡掉非法/非 http(s) 项,别让坏配置喂给 fetch(rte-11)
}
// 校验是合法 http/https 集群地址 —— 挡掉 'not-a-url'/'ftp://host' 等,避免 fetch 到非预期协议(rte-3/rte-11)。
function validHttpUrl(h) {
  try { const u = new URL(String(h)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (_e) { return false; }
}
function readCluster(key) {
  for (const f of ['config.local.json', 'config.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf8')); if (c.cluster && c.cluster[key] !== undefined) return c.cluster[key]; } catch (_e) { /* none */ }
  }
  return undefined;
}
// 节点角色：配了中心机地址(centralUrl)的是子机(启动后自动注册+推送);否则是主机/中心机。
function getCentralUrl() { return process.env.OPENROUTER_CENTRAL_URL || readCluster('centralUrl') || ''; }
function nodeRole() { return getCentralUrl() ? 'sub' : 'master'; }

// ── 动态节点注册表(子机心跳上报 → 主机自动聚合,无需手填机器清单)──────────
const PEERS = new Map(); // nodeId -> { nodeId, url, lastSeen }
const PEER_TTL_MS = 90000; // 超过 90s 没心跳视为离线
function getActivePeers() {
  const now = Date.now();
  return [...PEERS.values()].filter((p) => now - p.lastSeen < PEER_TTL_MS && p.nodeId !== NODE_ID);
}
// 【#2 修】周期驱逐过期 peer:原来 getActivePeers 只在【读】时过滤过期,PEERS 本体从无 delete →
//   长跑大集群里离线节点条目永久累积 → heap 持续增长。每 2 分钟清一次过期项(.unref 不阻塞进程退出)。
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of PEERS) { if (now - p.lastSeen >= PEER_TTL_MS) PEERS.delete(id); }
}, 120000).unref();

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

/** 代理多行 → [{host,port,username,password,type,server,raw}]。
 *  支持 host:port[:user:pass](裸,无协议→server 沿用 http,与历史一致)
 *  及 scheme://user:pass@host:port / scheme://host:port[:user:pass](http/https/socks5)。
 *  server 按真实协议拼(`${type}://host:port`),不再一律 http://。 */
function parseProxies(raw) {
  if (!raw) return [];
  const norm = (t) => { t = String(t || '').toLowerCase(); return (t === 'socks' || t === 'socks5h') ? 'socks5' : t; };
  return String(raw)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      let type = '', s = line, host = '', username = '', password = '';
      let port = 0;
      const sm = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/(.*)$/);
      if (sm) { type = norm(sm[1]); s = sm[2]; }
      if (sm && s.includes('@')) {
        const at = s.lastIndexOf('@'); const cred = s.slice(0, at); const hp = s.slice(at + 1);
        const ci = cred.indexOf(':'); username = ci >= 0 ? cred.slice(0, ci) : cred; password = ci >= 0 ? cred.slice(ci + 1) : '';
        const p = hp.split(':'); host = p[0] || ''; port = Number(p[1]) || 0;
      } else {
        const p = s.split(':'); host = p[0] || ''; port = Number(p[1]) || 0; username = p[2] || ''; password = p.slice(3).join(':');
      }
      const scheme = type || 'http';   // 裸格式无协议 → server 沿用 http(保持历史行为,无回归)
      return {
        host: host.trim(), port,
        username: username.trim(), password: password.trim(),
        type: scheme,
        server: host && port ? `${scheme}://${host.trim()}:${port}` : '',
        raw: line,
      };
    })
    .filter(p => p.host && p.port);
}

/**
 * 账单地址池：每行 "姓名|地址行1|城市|州|邮编[|地址行2]"（分隔符 | 或制表或逗号）。
 * 国家默认美国(United States)。
 * @param {string} raw
 * @returns {Array<{name,line1,city,state,zip,line2,country}>}
 */
function parseAddressLines(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const parts = line.split(/\s*[|\t]\s*|\s*,\s*/).map(s => s.trim());
      const [name, line1, city, state, zip, line2] = parts;
      return {
        name: name || '',
        line1: line1 || '',
        city: city || '',
        state: state || '',
        zip: zip || '',
        line2: line2 || '',
        country: 'United States',
      };
    })
    .filter(a => a.line1 && a.zip);
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
    if (err) {
      // SPA fallback(单页应用客户端路由):未命中且【无资源后缀】的路径(如 /console、/runs/job-xxx、/settings)
      //   → 回 public/index.html,交前端 React Router 渲染;带后缀(.js/.css/.png/.map…)的真缺失仍 404,
      //   不用 HTML 去污染资源请求。/jobs /events /download /api/* 在路由表前段已被各 handler return,到不了这里。
      const hasExt = /\.[a-z0-9]+$/i.test(rel);
      if (!hasExt) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) { res.writeHead(404); res.end('Not Found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          res.end(html);
        });
      }
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // Vite 给 /assets/* 产物名带内容哈希(index-xxxx.js):内容一变文件名就变,而 index.html(下方/上方 no-store,每次校验)
    // 引用的是新哈希,旧哈希永不再被请求 → /assets/* 可放心长缓存 immutable(免每次冷加载重下 ~600KB),其余保持 no-store。
    const longCache = rel.startsWith('assets/');
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': longCache ? 'public, max-age=31536000, immutable' : 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
}

// 「从池选用」:运行时用已保存的资源池覆盖粘贴文本(开关默认关,关时保持原粘贴行为)。
function resolvePools(payload) {
  try {
    if (payload.useProxyPool) payload.proxiesRaw = proxyStore.activeLines();
    if (payload.useAddressPool) payload.billingAddressesRaw = addressStore.activeLines();
    if (payload.useAdspowerPool) { const raw = adspowerStore.activeRaw(); payload.adspowerEnvIdsRaw = raw; payload.browserEnvIdsRaw = raw; }
  } catch (_e) { /* 池读失败 → 用 payload 原值 */ }
  return payload;
}

async function handleStartJob(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }
  resolvePools(payload);

  const accounts = parseAccounts(payload.accountsRaw);
  const proxies = parseProxies(payload.proxiesRaw);
  if (!accounts.length) {
    sendJson(res, 400, { error: 'NO_ACCOUNTS', message: '账号凭证为空' });
    return;
  }

  const runParams = {
    headed: !!payload.headed,
    concurrency: Math.max(1, Number(payload.concurrency) || 1),
    // 负数/NaN 一律视作"全部";避免 slice(0, 负数) 从尾部丢账号。
    count: Math.max(0, Math.floor(Number(payload.count) || 0)) || accounts.length,
  };
  const slicedAccounts = accounts.slice(0, runParams.count);

  // 卡池：若本次提交带了卡文本，先合并导入(已存在的保留历史计数)。
  if (payload.cardsRaw && String(payload.cardsRaw).trim()) {
    const parsed = cardPool.parseCardLines(payload.cardsRaw, Number(payload.cardMaxUses) || 10);
    await cardPool.upsertMany(parsed).catch(() => {});
  }

  const taskParams = {
    mode: payload.mode === 'login' ? 'login' : 'register',
    // 断点续跑：默认开启；跳过已完成阶段、复用已取 Key、不对已充值账号复扣。
    resume: payload.resume !== false,
    // 阶段开关（自由组合）：取Key 默认开；改密默认仅在设了统一密码时开。
    doApiKey: payload.doApiKey !== false,
    doPasswordChange: payload.doPasswordChange === true,
    apiKeyName: payload.apiKeyName || '',
    apiKeyExpiration: payload.apiKeyExpiration || 'No expiration',
    // 统一密码：OpenRouter 注册用此密码；最终状态把邮箱密码改成它。留空=用输入里的原密码、不改密。
    unifiedPassword: String(payload.unifiedPassword || '').trim(),
    topUpAmount: Number(payload.topUpAmount) || 0,
    // S5 账单/卡/充值动作：none|address|card|charge（兼容老的 allowCharges）。
    billingAction: ['none', 'address', 'card', 'charge'].includes(payload.billingAction)
      ? payload.billingAction
      : (payload.allowCharges ? 'charge' : 'none'),
    maxCardTries: Math.max(1, Number(payload.maxCardTries) || 3),
    // 账单地址：默认随机生成(免税州)；pool=用手动地址池。
    addressMode: payload.addressMode === 'pool' ? 'pool' : 'random',
    addressStates: String(payload.addressStates || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    billingAddresses: parseAddressLines(payload.billingAddressesRaw),
    billingAddressStrategy: payload.billingAddressStrategy === 'round-robin' ? 'round-robin' : 'random',
    // 验证码人工兜底：加卡 hCaptcha 自动解不动时，停下等人工在有头浏览器里手动过（需配合「有头」）。
    manualCaptchaFallback: payload.manualCaptchaFallback === true,
    // 加卡人工兜底：自动填卡/保存没成时，停下等人工在有头浏览器里手动完成加卡（需配合「有头」）。
    manualBillingFallback: payload.manualBillingFallback === true,
    // 拟人模式：填卡/Save 加真鼠标轨迹+阅读停顿+页面预热，压 Stripe Radar 行为 bot-score（更拟人但更慢）。
    humanLike: payload.humanLike === true,
    // 手动选卡填入：付款弹窗处注入卡池面板，人工点选一张卡，自动填入（需配合「有头」）。
    manualCardPick: payload.manualCardPick === true,
    // 脏IP跳过加卡：出口IP被标记 proxy/hosting 时跳过加卡（默认开，避免白烧卡触发 Stripe 风控）。
    skipCardOnDirtyIp: payload.skipCardOnDirtyIp !== false,
    // AdsPower 接管：用 AdsPower 指纹浏览器(自带代理+反检测)跑，过 Stripe 最稳。
    useAdsPower: payload.useAdsPower === true,
    // AdsPower 环境ID池（一行一个 user_id，如 k1db9yk8），每账号分一个。
    adspowerEnvIds: String(payload.adspowerEnvIdsRaw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    // 填卡引擎(可逗号链，如 "playwright,osinput")：服务端白名单每段，未知段丢弃，全空则默认 playwright。
    cardFillEngine: (String(payload.cardFillEngine || '').split(',').map((s) => s.trim())
      .filter((s) => ['playwright', 'osinput', 'extension', 'selenium', 'api'].includes(s)).join(',') || 'playwright'),
    // 指纹浏览器 provider：服务端白名单，未知→none(原生 Playwright)。
    browserProvider: ['none', 'adspower', 'bitbrowser', 'dolphin', 'gologin', 'hubstudio', 'morelogin', 'multilogin', 'vmlogin']
      .includes(payload.browserProvider) ? payload.browserProvider : 'none',
    // 通用环境ID池(所选 provider 的环境 id)：兼容旧 adspowerEnvIdsRaw。
    browserEnvIds: String(payload.browserEnvIdsRaw || payload.adspowerEnvIdsRaw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    // 跨节点下发:中心机随 payload 复制来的验证码/邮箱 key → 透传给 serviceKeys.applyToConfig(优先用它)。
    captchaApiKey: payload.captchaApiKey ? String(payload.captchaApiKey) : '',
    captchaProvider: payload.captchaProvider ? String(payload.captchaProvider) : '',
    mailboxApiKey: payload.mailboxApiKey ? String(payload.mailboxApiKey) : '',
    mailboxApiBaseUrl: payload.mailboxApiBaseUrl ? String(payload.mailboxApiBaseUrl) : '',
  };
  // 向后兼容：旧「AdsPower 接管」勾选 → 指纹浏览器选 adspower。
  if (taskParams.useAdsPower === true && taskParams.browserProvider === 'none') taskParams.browserProvider = 'adspower';

  // 防重复提交(与 Python /api/run 的 _batchInflight 同机制,防重复扣费):两个并发 /jobs(双标签页/重试/或 dispatch
  //   把同批 playwright 账号回环到本机 /jobs)会各起一个 job 同时跑同号 → 同账号被处理两次 → 重复加卡/充值(真扣款)。
  //   按 引擎+排序后account集 指纹挡掉,job 结束(成败均)在 finally 释放。
  const _pwBatchKey = _batchKey('playwright', slicedAccounts);
  const _pwConflict = _batchInflight.get(_pwBatchKey);
  if (_pwConflict) { sendJson(res, 409, { error: 'DUPLICATE_SUBMIT', message: `相同账号批次已在运行中(jobId …${String(_pwConflict).slice(-10)}),已挡掉重复提交防重复扣费;等它结束或用「续跑这批」。` }); return; }

  // jobId 含节点标识 → 文件名 <jobId>-success.txt 跨机器不会重复。
  const jobId = `job-${NODE_ID}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  _batchInflight.set(_pwBatchKey, jobId);

  // 运行历史:登记一条 running(参数摘要,不含密钥/明文凭证)。job 跑完(runJob 返回 summary)更新为 finished。
  try {
    runsStore.start({
      jobId, nodeId: NODE_ID, startedAt: Date.now(), total: slicedAccounts.length,
      params: {
        mode: taskParams.mode, concurrency: runParams.concurrency, count: runParams.count,
        billingAction: taskParams.billingAction, doApiKey: taskParams.doApiKey, doPasswordChange: taskParams.doPasswordChange,
        topUpAmount: taskParams.topUpAmount, headed: runParams.headed, browserProvider: taskParams.browserProvider,
      },
    });
  } catch (_e) { /* 历史落盘失败不阻断任务 */ }

  // fire-and-forget：进度通过 SSE 汇报;同时把 runJob 的返回 summary 收口进运行历史。
  Promise.resolve()
    .then(() => jobRunner.runJob({
      jobId,
      accounts: slicedAccounts,
      proxies,
      runParams,
      taskParams,
      successTemplate: payload.successTemplate || '',
      failureTemplate: payload.failureTemplate || '',
      publish: eventBus.publish,
    }))
    .then((summary) => { try { runsStore.finish(jobId, summary); } catch (_e) { /* ignore */ } })
    .catch((err) => {
      try { runsStore.fail(jobId, err); } catch (_e) { /* ignore */ }
      eventBus.publish(jobId, 'log', `job 异常终止: ${err && err.message}`);
      eventBus.publish(jobId, 'job-done', { jobId, error: err && err.message });
    })
    .finally(() => { _batchInflight.delete(_pwBatchKey); });   // job 结束(成败均)释放防重互斥,之后可正常再提交同批

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
  // 受保护写:连接已关/已销毁则跳过;写抛错(ERR_STREAM_WRITE_AFTER_END 等)就地清理,
  // 绝不让异常顺着 eventBus 的同步 emit 冒泡回发布方(job-runner / engine-runner 的回调里),
  // 否则会变成未捕获异常直接打挂整个 server 进程。
  let keepAlive = null;
  let unsubscribe = () => {};
  let closed = false;
  function cleanup() {
    if (closed) return; closed = true;
    if (keepAlive) clearInterval(keepAlive);
    try { unsubscribe(); } catch (_e) { /* ignore */ }
  }
  const safeWrite = (s) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try { res.write(s); } catch (_e) { cleanup(); }
  };

  safeWrite(`event: connected\ndata: ${JSON.stringify({ jobId })}\n\n`);
  // 重放:client 连上前(任务启动瞬间)或断线重连(Last-Event-ID)期间漏掉的事件补发,避免启动日志/进度丢。
  // 同步执行(getBuffered→subscribe 之间无 await,不会有 publish 插入),并对已重放的 seq 去重,既不漏也不重。
  const lastId = Number(req.headers['last-event-id'] || query.get('lastEventId') || 0) || 0;
  let lastReplayed = lastId;
  try {
    for (const evt of eventBus.getBuffered(jobId, lastId)) {
      safeWrite(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.data === undefined ? null : evt.data)}\n\n`);
      lastReplayed = evt.seq;
    }
  } catch (_e) { /* ignore */ }
  unsubscribe = eventBus.subscribe(jobId, (evt) => {
    if (evt.seq != null && evt.seq <= lastReplayed) return;   // 已在重放里发过的不重复
    safeWrite(`id: ${evt.seq}\n`);
    safeWrite(`event: ${evt.type}\n`);
    safeWrite(`data: ${JSON.stringify(evt.data === undefined ? null : evt.data)}\n\n`);
  });
  keepAlive = setInterval(() => safeWrite(': keepalive\n\n'), 15000);
  req.on('close', cleanup);
  res.on('error', cleanup);
}

// ── 鉴权：访问令牌(推荐,分布式友好) + 可选 Basic Auth ──────────────────────
// 令牌来源:环境变量 OPENROUTER_AUTH_TOKEN > config.local.json/config.json 的 security.token。
function loadAuthToken() {
  if (process.env.OPENROUTER_AUTH_TOKEN) return process.env.OPENROUTER_AUTH_TOKEN;
  for (const f of ['config.local.json', 'config.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf8')); if (c.security?.token) return c.security.token; } catch (_e) { /* none */ }
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
// 恒定时间比较(防 token/密码逐字符计时旁路):两边都 sha256 成定长再 timingSafeEqual,连长度都不泄露。
function _safeEq(a, b) {
  try { const h = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest(); return crypto.timingSafeEqual(h(a), h(b)); } catch (_e) { return false; }
}
function checkAuth(req, res, url) {
  if (!AUTH_TOKEN && !AUTH_USER) return true; // 都没配 = 不鉴权(仅建议内网/本机)
  if (AUTH_TOKEN && _safeEq(reqToken(req, url), AUTH_TOKEN)) return true;
  if (AUTH_USER) {
    const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (m) {
      // 只在【第一个】冒号切分:RFC 7617 里密码可含冒号(原 split(':') 会把含冒号的密码截断→登录失败/被弱化)。
      const dec = Buffer.from(m[1], 'base64').toString('utf8'); const ci = dec.indexOf(':');
      const u = ci >= 0 ? dec.slice(0, ci) : dec; const p = ci >= 0 ? dec.slice(ci + 1) : '';
      if (_safeEq(u, AUTH_USER) && _safeEq(p, AUTH_PASS)) return true;
    }
  }
  // 只有在"纯 Basic Auth(没配 token)"时才发 WWW-Authenticate,触发浏览器登录框;
  // 用 token 时不发,避免浏览器弹自带登录框干扰(改由前端 token 弹窗处理)。
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (AUTH_USER && !AUTH_TOKEN) headers['WWW-Authenticate'] = 'Basic realm="Openrouter Console"';
  res.writeHead(401, headers);
  res.end('Unauthorized: 需要访问令牌(token)');
  return false;
}

// 下载某个 job 的结果文件（type=success|failed）。
function handleDownload(req, res, query) {
  const jobId = query.get('jobId') || '';
  const type = query.get('type') === 'failed' ? 'failed' : 'success';
  if (!/^job-[\w-]+$/.test(jobId)) { sendJson(res, 400, { error: 'BAD_JOB_ID' }); return; }
  const file = path.join(__dirname, '..', 'data', 'batch-results', `${jobId}-${type}.txt`);
  if (!file.startsWith(path.join(__dirname, '..', 'data', 'batch-results'))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('结果文件不存在'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${jobId}-${type}.txt"`,
    });
    res.end(data);
  });
}

// ── 结果聚合 API（分布式部署:中心机可逐台拉取整合）────────────────────────
function listResultJsonl() {
  try { return fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('-success.jsonl')); } catch (_e) { return []; }
}
const _jobRecCache = new Map(); // file -> { mtimeMs, size, rows }:按 mtime+size memo,避免每次聚合/计数都重读+解析同一 success.jsonl
function readJobRecords(jobId) {
  const file = path.join(RESULTS_DIR, `${jobId}-success.jsonl`);
  try {
    const st = fs.statSync(file);
    const c = _jobRecCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.rows;  // 文件没变(追加/删改都会改 size)→ 复用;调用方只 spread/map 不就地改,可共享引用
    const out = [];
    fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .forEach((line) => { try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ } });
    _jobRecCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows: out });
    return out;
  } catch (_e) { return []; }  // 无文件/读失败 → 空(不缓存,下次重试)
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
    return;   // txt 导出始终全量(复制/导全用),不分页
  }
  // 默认全量(向后兼容:节点间互拉 /api/results/all 不带 limit → 收全量供合并去重);UI 可带 ?limit=&offset= 分页。
  const page = offsetPage(records, query);
  sendJson(res, 200, { nodeId: NODE_ID, count: records.length, returned: page.returned, offset: page.offset, limit: page.limit, nextOffset: page.nextOffset, accounts: page.rows });
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
  const nodeId = String(body.nodeId || '').replace(/[^\w-]/g, '-').slice(0, 60);   // 与 handlePush 一致 sanitize(rte-9:否则 PEERS key 与 push 落盘文件名不匹配)
  if (!nodeId) { sendJson(res, 400, { error: 'MISSING_NODE_ID' }); return; }
  let url = String(body.url || '').trim();
  if (!url) { url = `http://${clientIp(req)}:${Number(body.port) || PORT}`; }
  PEERS.set(nodeId, { nodeId, url, lastSeen: Date.now() });
  sendJson(res, 200, { ok: true, registered: { nodeId, url } });
}

// POST /api/push —— 子机把自己的成功账号推给中心机(出站,穿 NAT;适合 NAT 后的子机)。
async function handlePush(req, res) {
  let body;
  // 64MB 上限(高于默认 5MB):/api/push 由可信子机推送【整批成功账号】,大集群一次可达数万行(rte-8:此处放宽是刻意的)。
  try { body = await readJsonBody(req, 64 * 1024 * 1024); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const nodeId = String(body.nodeId || '').replace(/[^\w-]/g, '-').slice(0, 60);
  if (!nodeId) { sendJson(res, 400, { error: 'MISSING_NODE_ID' }); return; }
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  try {
    fs.mkdirSync(PUSHED_DIR, { recursive: true });
    // 【#3 修】原子写 tmp+rename:原来直接 writeFileSync,进程中途崩溃会留半截 JSON → readPushed 解析失败→该子机全部账号在聚合页无声消失。
    const _pf = path.join(PUSHED_DIR, `${nodeId}.json`);
    const _ptmp = _pf + '.tmp';
    fs.writeFileSync(_ptmp, JSON.stringify({ nodeId, updatedAt: Date.now(), accounts }));
    fs.renameSync(_ptmp, _pf);
  } catch (e) { try { console.error('[push] 落盘失败 nodeId=%s: %s', nodeId, e && e.message); } catch (_e) { /* ignore */ } }
  // 同时标记为在线节点(即使没有可回连的 url)
  const prev = PEERS.get(nodeId) || {};
  PEERS.set(nodeId, { nodeId, url: prev.url || '', lastSeen: Date.now() });
  sendJson(res, 200, { ok: true, stored: accounts.length });
}
function readPushed() {
  const out = [];
  try {
    for (const f of fs.readdirSync(PUSHED_DIR).filter((x) => x.endsWith('.json'))) {
      try { const o = JSON.parse(fs.readFileSync(path.join(PUSHED_DIR, f), 'utf8')); out.push({ nodeId: o.nodeId, count: (o.accounts || []).length, accounts: o.accounts || [] }); }
      catch (e) { try { console.warn('[readPushed] 解析 %s 失败,该子机本次聚合账号丢失: %s', f, e && e.message); } catch (_e) { /* ignore */ } }   // 【#3 修】不再静默丢号
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
  // 合并:请求传入 + 配置 cluster.hosts + 动态注册的在线子机。只保留合法 http(s) 地址(rte-3:防把任意串喂给 fetch)。
  const hosts = [...new Set([...bodyHosts, ...loadClusterHosts(), ...getActivePeers().map((p) => p.url)].map((h) => String(h).trim()).filter(Boolean))].filter(validHttpUrl);
  const includeLocal = body.includeLocal !== false;
  const dedupeMode = body.dedupe || 'email+apiKey'; // 默认每个 邮箱+Key 一行(同邮箱多 key 不丢)
  const all = [];
  const sources = [];
  if (includeLocal) {
    let n = 0;
    for (const f of listResultJsonl()) { const jobId = f.replace('-success.jsonl', ''); for (const r of readJobRecords(jobId)) { all.push({ nodeId: NODE_ID, jobId, ...r }); n += 1; } }
    sources.push({ source: `local(${NODE_ID})`, count: n, ok: true });
  }
  // 跨节点【并行】拉取(原串行:N 个慢节点累加 N×15s;改 Promise.allSettled 后总墙钟≈最慢单个 15s)。
  // 仍按 hosts 原顺序合并 all/sources,保证去重「先到先留」结果与串行版逐条一致。
  const peerResults = await Promise.allSettled(hosts.map(async (h) => {
    const u = String(h).replace(/\/+$/, '') + '/api/results/all';
    // 节点间聚合带上令牌(假设全集群同一 token);也支持 URL 内嵌 user:pass。
    const headers = AUTH_TOKEN ? { 'X-Auth-Token': AUTH_TOKEN } : {};
    const resp = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    return { nodeId: j.nodeId, arr: j.accounts || [] };
  }));
  hosts.forEach((h, i) => {
    const r = peerResults[i];
    if (r.status === 'fulfilled') {
      r.value.arr.forEach((a) => all.push(a));
      sources.push({ source: r.value.nodeId || h, count: r.value.arr.length, ok: true }); // 用对方 nodeId 显示更直观
    } else {
      // 远端错误文本不原样回吐(sec-2):截短 + 抹掉疑似凭据(key=…/token=…),避免对方报错里夹带密钥被反射给客户端。
      const e = r.reason;
      const safeErr = String((e && e.message) || e).replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, '$1***').slice(0, 120);
      sources.push({ source: h, count: 0, ok: false, error: safeErr });
    }
  });
  // 子机推送过来的数据(NAT 后子机)——去重会自动处理与 pull 的重叠。
  for (const p of readPushed()) { p.accounts.forEach((a) => all.push(a)); sources.push({ source: `push(${p.nodeId})`, count: p.count, ok: true }); }
  let merged = all;
  if (dedupeMode !== 'none') {
    const seen = new Map();
    for (const r of all) {
      if (dedupeMode === 'email+apiKey') {
        // 每个 邮箱+Key 一行：仅去掉完全相同的 (email,key) 重复(如 pull 与 push 的同一条重叠)。
        // email 与 apiKey 都缺时不可塌缩成 'undefined|undefined'(会把彼此不同的记录误删)→ 用唯一键保留。
        const key = (r.email || r.apiKey) ? `${r.email || ''}|${r.apiKey || ''}` : `__row${seen.size}`;
        if (!seen.has(key)) seen.set(key, r);
      } else {
        // 按邮箱合并：同邮箱只留"最新"的一个 key(按 createdAt)，消除"留哪个 key"的不确定
        const key = r.email || JSON.stringify(r);
        const prev = seen.get(key);
        if (!prev || String(r.createdAt || '') > String(prev.createdAt || '')) seen.set(key, r);
      }
    }
    merged = [...seen.values()];
  }
  // 默认全量(向后兼容);前端可在 body 传 limit/offset 分页。total/count 仍是全量数,masthead「共 N」不变。
  const page = offsetPage(merged, body);
  sendJson(res, 200, { total: all.length, count: merged.length, returned: page.returned, offset: page.offset, limit: page.limit, nextOffset: page.nextOffset, sources, accounts: page.rows });
}

// ── 结果删除/清空(聚合页一键操作)──────────────────────────────────────────
// 结果含 API Key / 已绑卡,删除不可恢复 → 前端二次确认。每条结果按 (email,apiKey) 定位
// (jsonl 无唯一 id),本机改 jobId 文件、改 _pushed 缓存;非本机的记录(pull/push)按
// nodeId 转发到源节点的同名接口在源头删(用户已选「尝试远程删除」)。
const _matchRec = (rec, it) => String(rec.email || '') === String(it.email || '') && String(rec.apiKey || '') === String(it.apiKey || '');
function _rewriteJsonl(file, keptLines) {
  try {
    const tmp = file + '.tmp';
    if (keptLines.length) { fs.writeFileSync(tmp, keptLines.join('\n') + '\n'); fs.renameSync(tmp, file); }
    else { fs.unlinkSync(file); }       // 全删 → 移除空文件(job 计数归零)
  } catch (_e) { /* 落盘失败不致命 */ }
}
// 删本机 success.jsonl:按 jobId 分组,逐文件重写去掉命中的行。
function deleteLocalResults(items) {
  const byJob = new Map();
  for (const it of items) { const j = String(it.jobId || ''); if (!/^job-[\w-]+$/.test(j)) continue; if (!byJob.has(j)) byJob.set(j, []); byJob.get(j).push(it); }
  let removed = 0;
  for (const [jobId, its] of byJob) {
    const file = path.join(RESULTS_DIR, `${jobId}-success.jsonl`);
    let lines; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_e) { continue; }
    const kept = [];
    for (const line of lines) {
      let rec; try { rec = JSON.parse(line); } catch (_e) { kept.push(line); continue; }
      if (its.some((it) => _matchRec(rec, it))) { removed += 1; continue; }
      kept.push(line);
    }
    if (kept.length !== lines.length) _rewriteJsonl(file, kept);
  }
  return removed;
}
// 删本机 _pushed/<nodeId>.json 里的缓存记录(子机推上来的)。
function deletePushedResults(items) {
  const byNode = new Map();
  for (const it of items) { const nid = String(it.nodeId || '').replace(/[^\w-]/g, '-'); if (!nid) continue; if (!byNode.has(nid)) byNode.set(nid, []); byNode.get(nid).push(it); }
  let removed = 0;
  for (const [nid, its] of byNode) {
    const file = path.join(PUSHED_DIR, `${nid}.json`);
    let obj; try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { continue; }
    const before = (obj.accounts || []).length;
    obj.accounts = (obj.accounts || []).filter((rec) => !its.some((it) => _matchRec(rec, it)));
    if (obj.accounts.length !== before) { removed += before - obj.accounts.length; try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); } catch (_e) { /* ignore */ } }
  }
  return removed;
}
// 把非本机的记录按 nodeId 转发到源节点(仅在线子机 + 允许列表内),在源头删。
async function relayDeleteToRemotes(items) {
  const peers = getActivePeers();
  const allowed = _allowedDispatchBases();
  const byNode = new Map();
  for (const it of items) { const nid = String(it.nodeId || ''); if (!nid || nid === NODE_ID) continue; if (!byNode.has(nid)) byNode.set(nid, []); byNode.get(nid).push(it); }
  const out = [];
  for (const [nid, its] of byNode) {
    const peer = peers.find((p) => p.nodeId === nid);
    const base = peer ? _normBase(peer.url) : '';
    if (!base || !allowed.has(base)) { out.push({ nodeId: nid, ok: false, error: peer ? 'NOT_ALLOWED' : 'PEER_OFFLINE' }); continue; }
    try { const j = await _postJson(base + '/api/results/delete', { items: its, relay: false }, 15000); out.push({ nodeId: nid, ok: true, deleted: (j.localDeleted || 0) + (j.pushedDeleted || 0) }); }
    catch (e) { out.push({ nodeId: nid, ok: false, error: String(e.message || e) }); }
  }
  return out;
}
// POST /api/results/delete —— 删指定结果行(本机 jsonl + _pushed,选配转发远端)。
async function handleApiResultsDelete(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const items = Array.isArray(body.items) ? body.items.filter((it) => it && (it.email || it.apiKey)) : [];
  if (!items.length) { sendJson(res, 400, { error: 'NO_ITEMS' }); return; }
  const localItems = items.filter((it) => !it.nodeId || String(it.nodeId) === NODE_ID);
  // ★M10:在跑 job 的 success.jsonl 会在 job 收口被 engine-runner 全量覆写 → 此刻删行会被"复活"。
  //   跳过仍在跑的 jobId(procRegistry 跟踪 Python 引擎子进程),把它们报给前端 skippedRunning(让用户知道稍后再删)。
  const runningJobs = new Set();
  const safeLocalItems = localItems.filter((it) => {
    const j = String(it.jobId || '');
    if (j && procRegistry.has(j)) { runningJobs.add(j); return false; }
    return true;
  });
  const localDeleted = deleteLocalResults(safeLocalItems);
  const pushedDeleted = deletePushedResults(items);
  let remote = [];
  if (body.relay !== false) { try { remote = await relayDeleteToRemotes(items); } catch (_e) { remote = []; } }
  sendJson(res, 200, { ok: true, localDeleted, pushedDeleted, remote, skippedRunning: [...runningJobs] });
}
// POST /api/results/clear —— 清空本机所有成功结果(success.jsonl + _pushed 缓存)。不向远端广播。
async function handleApiResultsClear(req, res) {
  let body = {};
  try { body = await readJsonBody(req); } catch (_e) { body = {}; }
  // ★M10:清空会删所有 success.jsonl;若有 Python job 在跑,其文件会在收口被 engine-runner 重写"复活"且与删除竞争 → 拒绝。
  if (procRegistry.list().length > 0) { sendJson(res, 409, { error: 'JOB_RUNNING', message: '有任务在跑,稍后再清空结果(避免已删结果复活/文件竞争)' }); return; }
  let files = 0, records = 0;
  try { for (const f of listResultJsonl()) { const jobId = f.replace('-success.jsonl', ''); records += readJobRecords(jobId).length; fs.unlinkSync(path.join(RESULTS_DIR, f)); files += 1; } } catch (_e) { /* ignore */ }
  let pushedFiles = 0;
  if (body.includePushed !== false) { try { for (const f of fs.readdirSync(PUSHED_DIR).filter((x) => x.endsWith('.json'))) { fs.unlinkSync(path.join(PUSHED_DIR, f)); pushedFiles += 1; } } catch (_e) { /* ignore */ } }
  sendJson(res, 200, { ok: true, files, records, pushedFiles });
}

// ── 多机派发:中心机把一批账号拆给多台目标机(本机+在线子机)各自跑 ──────────
// 复用各机已有的 /jobs(playwright)/ /api/run(python)作为执行端口(已 token 门);
// 结果经已有 push/aggregate 回收(见结果聚合页)。本机作为目标=loopback 到自身 /jobs。
const DISPATCHES = []; // 最近派发记录(内存,封顶 20),供集群页展示
// 派发串行链:两次并发派发若同时挑资源,会把【同一批】代理/卡分给不同目标(代理重叠→多机同 IP 撞风控;
// 卡虽已由 reserveForDispatch 原子冻结防重叠,但串行化让"挑资源→下发→收尾释放"整段不交错,语义最干净)。
// 永不 reject 的 promise 链;派发是低频管理操作,串行等待可接受。
let _dispatchChain = Promise.resolve();
function _postJson(url, body, timeoutMs) {
  const headers = { 'Content-Type': 'application/json', ...(AUTH_TOKEN ? { 'X-Auth-Token': AUTH_TOKEN } : {}) };
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs || 20000) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
}
function _chunk(arr, n) { const g = Array.from({ length: n }, () => []); arr.forEach((x, i) => g[i % n].push(x)); return g; }
// 派发目标白名单:只准把(带 AUTH_TOKEN 的)请求发给"已配 cluster.hosts ∪ 在线子机 ∪ 本机"。
// 否则鉴权用户可借 target.url 让中心机向任意 URL 发请求并泄露令牌(轻度 SSRF)。
const _normBase = (u) => String(u || '').trim().replace(/\/+$/, '');
function _allowedDispatchBases() {
  const set = new Set();
  for (const h of loadClusterHosts()) { const n = _normBase(h); if (n) set.add(n); }
  for (const p of getActivePeers()) { const n = _normBase(p.url); if (n) set.add(n); }
  return set;
}
async function handleDispatch(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const engine = ['playwright', 'selenium', 'hybrid', 'split'].includes(body.engine) ? body.engine : 'playwright';
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  let targets = Array.isArray(body.targets) ? body.targets.filter((t) => t && t.url) : [];
  if (!targets.length) targets = [{ nodeId: NODE_ID, url: `http://127.0.0.1:${PORT}`, self: true }];
  const accountsAll = String(payload.accountsRaw || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!accountsAll.length) { sendJson(res, 400, { error: 'NO_ACCOUNTS' }); return; }
  // 全局 count(0=全部)先作用于"总列表"再分片;每个节点收 count:0 跑完自己那份。
  // 否则把同一个 count 原样转发给每台机 → 总处理量被放大为 count×节点数(尤其充值真扣钱)。
  const cap = Math.max(0, Number(payload.count) || 0);
  const accounts = cap > 0 ? accountsAll.slice(0, cap) : accountsAll;
  const groups = _chunk(accounts, targets.length);
  const ep = engine === 'playwright' ? '/jobs' : '/api/run';
  const parentJobId = 'job-disp-' + crypto.randomBytes(4).toString('hex');
  const allowed = _allowedDispatchBases();

  // 资源跨节点下发(shipResources=true):中心机解析本机池 → 代理/卡按目标【分片不重叠】、地址/验证码/邮箱密钥【复制】;
  // AdsPower 不下发(端点/环境是各机物理资源,目标用自己的池)。下发成功的卡在中心机冻结(markDispatched),
  // 不再被本机用或下次再发,杜绝同一张卡被两台机同时刷(重复扣款)。发给【本机自己(loopback)】的目标不覆盖资源
  // (本机直接用自己池),也不冻卡。资源解析失败则整体退回"不下发"(各目标用自己池)。
  const ship = payload.shipResources === true;
  // ── 串行化整段「挑资源 → 逐目标下发 → 收尾」:两次并发派发不交错(代理不重叠 / 卡预留-释放不打架)。──
  const _prevDispatch = _dispatchChain;
  let _releaseDispatchLock;
  _dispatchChain = new Promise((r) => { _releaseDispatchLock = r; });
  try { await _prevDispatch; } catch (_e) { /* 链永不 reject;前一次的错与本次无关 */ }

  const slices = [];
  const frozenCards = [];   // 成功下发的卡(打精确目标标签 + 计满) [{id,node}]
  let reservedCardIds = []; // 本次原子冻结的全部卡 id(收尾把未成功下发的解冻还原)
  const shippedCardIds = new Set();
  try {
    let proxSlices = []; let cardSlices = []; let shipAddrRaw = ''; const shipKeyPatch = {};
    if (ship) {
      try {
        const proxLines = String(proxyStore.activeLines() || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        proxSlices = proxLines.length ? _chunk(proxLines, targets.length) : [];
        // ★H2 修复(防派发清空整个卡池):只为【真正会收卡的远端目标(非 self)】按其账号数有界预留,
        //   而非旧的 reserveForDispatch() 无参(→ lim=Infinity 冻结全部可用卡 + markDispatched 计满 → 主机池被一次清空)。
        //   预留 budget = 远端账号数 × CARD_DISPATCH_FACTOR(默认1)。卡 maxUses 默认10 → 1卡/号已含~10×拒付余量;
        //   要更多余量可调大 CARD_DISPATCH_FACTOR。只分给远端目标,self 用本机池不收卡。
        //   仍是单锁内原子挑+冻(reserveForDispatch),保留"快照→下发→冻结"间隙的同卡多机防重叠保护。
        const remoteIdx = [];
        for (let i = 0; i < targets.length; i++) {
          const _self = targets[i].self || targets[i].url === 'self';
          if (!_self && groups[i] && groups[i].length) remoteIdx.push(i);
        }
        const remoteAccounts = remoteIdx.reduce((s, i) => s + groups[i].length, 0);
        if (remoteAccounts > 0) {
          const _factor = Number(process.env.CARD_DISPATCH_FACTOR) || 1;
          const budget = Math.max(1, Math.ceil(remoteAccounts * _factor));
          const reserved = await cardPool.reserveForDispatch(budget);  // [{id,line}] 已就地冻结(有界)
          reservedCardIds = reserved.map((x) => x.id);
          const _chunks = reserved.length ? _chunk(reserved, remoteIdx.length) : [];
          remoteIdx.forEach((ti, k) => { cardSlices[ti] = _chunks[k] || []; });   // 稀疏数组,按 target 下标对齐(self 下标留空 → 不发卡)
        }
        // remoteAccounts===0(全部目标为 self/loopback)→ 完全跳过卡预留:self 直接用本机池,绝不冻卡。
        shipAddrRaw = String(addressStore.activeLines() || '');
        const cap = serviceKeys.pickCaptcha() || {};
        const mb = serviceKeys.pickMailbox() || {};
        if (cap.apiKey) { shipKeyPatch.captchaApiKey = cap.apiKey; if (cap.provider) shipKeyPatch.captchaProvider = cap.provider; }
        if (mb.apiKey) { shipKeyPatch.mailboxApiKey = mb.apiKey; if (mb.apiBaseUrl) shipKeyPatch.mailboxApiBaseUrl = mb.apiBaseUrl; }
      } catch (_e) { proxSlices = []; cardSlices = []; shipAddrRaw = ''; }
    }

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; const grp = groups[i];
      if (!grp.length) continue;
      const isSelf = t.self || t.url === 'self';
      const base = isSelf ? `http://127.0.0.1:${PORT}` : _normBase(t.url);
      // 白名单外的目标:绝不向其发带令牌的请求(防 SSRF / 令牌泄露)。
      if (!isSelf && !allowed.has(base)) {
        slices.push({ target: t.nodeId || t.url, url: t.url, accepted: 0, count: grp.length, ok: false, error: 'TARGET_NOT_ALLOWED' });
        continue;
      }
      const url = base + ep;
      // count 已在中心机按总量截断并分片(上面 accounts.slice + _chunk),转发给目标机时归零,避免目标机对已切好的子集再按 count 砍一刀。
      const sendBody = { ...payload, engine, accountsRaw: grp.join('\n'), count: 0 };
      let cardIdsForTarget = [];
      if (ship && !isSelf) {
        if (proxSlices[i] && proxSlices[i].length) { sendBody.proxiesRaw = proxSlices[i].join('\n'); sendBody.useProxyPool = false; }
        if (shipAddrRaw) { sendBody.billingAddressesRaw = shipAddrRaw; sendBody.useAddressPool = false; }
        if (cardSlices[i] && cardSlices[i].length) { sendBody.cardsRaw = cardSlices[i].map((x) => x.line).join('\n'); cardIdsForTarget = cardSlices[i].map((x) => x.id); }
        Object.assign(sendBody, shipKeyPatch);
      }
      try {
        const j = await _postJson(url, sendBody);
        const shipped = (ship && !isSelf) ? { proxies: (proxSlices[i] || []).length, cards: cardIdsForTarget.length, addresses: shipAddrRaw ? 'replicated' : 0, keys: Object.keys(shipKeyPatch).length ? 'replicated' : 0 } : undefined;
        slices.push({ target: t.nodeId || t.url, url: t.url, jobId: j.jobId || '', accepted: j.accepted != null ? j.accepted : grp.length, count: grp.length, ok: true, shipped });
        for (const id of cardIdsForTarget) { shippedCardIds.add(id); frozenCards.push({ id, node: t.nodeId || base }); }
      } catch (e) {
        slices.push({ target: t.nodeId || t.url, url: t.url, accepted: 0, count: grp.length, ok: false, error: String((e && e.message) || e) });
      }
    }
    // 成功下发的卡:打精确目标标签并按"额度交给子机"计满(markDispatched 现会把 usedCount=maxUses,
    // 日后 enable() 只回 exhausted,防同卡多机重复扣款 M8)。单卡失败不致命。
    for (const { id, node } of frozenCards) { try { await cardPool.markDispatched(id, node); } catch (_e) { /* ignore */ } }
    // 收尾:把【已原子冻结但未成功下发】的卡(失败目标 / 没分到目标的余卡)解冻还原为 active,usedCount 不动 → 不丢卡不误计。
    for (const id of reservedCardIds) {
      if (shippedCardIds.has(id)) continue;
      try { await cardPool.releaseDispatch(id); } catch (_e) { /* ignore */ }
    }
  } finally {
    _releaseDispatchLock();
  }

  const rec = { parentJobId, at: Date.now(), engine, total: accounts.length, dispatched: slices.filter((s) => s.ok).length, targets: slices.length, slices, shipResources: ship, frozenCards: frozenCards.length };
  DISPATCHES.unshift(rec); if (DISPATCHES.length > 20) DISPATCHES.length = 20;
  sendJson(res, 200, { ok: slices.some((s) => s.ok), ...rec });
}
function handleDispatchRecent(res) { sendJson(res, 200, { dispatches: DISPATCHES }); }

// ── 卡池管理(受保护, /api/cards*) ─────────────────────────────────────────
function handleCardsList(res) {
  sendJson(res, 200, { cards: cardPool.snapshot(), available: cardPool.availableCount(), totalBalance: cardPool.totalBalance() });
}
// GET /api/cards/capacity?amount= —— 按当前充值额算「卡总充值容量可真充 N 次」+ 总金额(控制台/卡池页读数)
function handleCardsCapacity(res, query) {
  const amount = Math.max(0.01, Number(query.get('amount')) || 5);
  sendJson(res, 200, { amount, fundable: cardPool.fundableCount(amount), totalBalance: cardPool.totalBalance() });
}
async function handleCardsImport(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const parsed = cardPool.parseCardLines(body.cardsRaw || '', Number(body.maxUses) || 10);
  const errors = parsed.filter((c) => c._parseError).map((c) => ({ raw: c.raw, error: c._parseError }));
  const result = await cardPool.upsertMany(parsed);
  sendJson(res, 200, { ...result, parseErrors: errors, cards: cardPool.snapshot(), available: cardPool.availableCount() });
}
async function handleCardAction(req, res, action) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const id = String(body.id || '');
  // clear 不需要 id
  if (action === 'clear') { await cardPool.clear(); sendJson(res, 200, { ok: true, cards: cardPool.snapshot(), available: cardPool.availableCount() }); return; }
  if (!id) { sendJson(res, 400, { error: 'MISSING_ID' }); return; }
  if (action === 'disable') await cardPool.disable(id);
  else if (action === 'enable') await cardPool.enable(id);
  else if (action === 'remove') await cardPool.remove(id);
  else if (action === 'reset') await cardPool.resetCounters(id);
  else if (action === 'update') await cardPool.setMaxUses(id, Number(body.maxUses) || 1);
  else if (action === 'set-charge') await cardPool.setCardCharge(id, { chargeCap: body.chargeCap, balance: body.balance, chargeConcurrency: body.chargeConcurrency });
  sendJson(res, 200, { ok: true, cards: cardPool.snapshot(), available: cardPool.availableCount(), totalBalance: cardPool.totalBalance() });
}

// 充值台账(按邮箱记账)。
function handleBillingSummary(res) {
  sendJson(res, 200, billingLedger.summary());
}
async function handleBillingClear(res) {
  await billingLedger.clear();
  sendJson(res, 200, { ok: true, ...billingLedger.summary() });
}

// 账号进度状态（断点续跑）：列表 / 清空 / 单条重置。
function handleAccountsList(res, query) {
  const accounts = accountStore.list();
  // 按阶段汇总(漏斗):每号做到哪一步一目了然,避免重复在已跑过的步骤上做。
  // address/card 用 attainedLevel 判达标(declined/no-card/no-address 算 0,不误计);charge 看真实扣款。
  const lvl = (s) => accountStore.attainedLevel(s);
  const n = (p) => accounts.filter(p).length;
  const summary = {
    total: accounts.length,
    registered: n((a) => a.registered),
    key: n((a) => a.apiKey),
    address: n((a) => lvl(a.billingStatus) >= 1),
    card: n((a) => lvl(a.billingStatus) >= 2),
    charge: n((a) => (a.charged || 0) > 0),
    changepw: n((a) => a.passwordChanged),
    blacklisted: n((a) => a.blacklisted),
  };
  // summary 始终按【全量】算(漏斗/KPI/图表不受分页影响);accounts 默认全量,UI 可带 ?limit=&offset= 分页。
  const page = offsetPage(accounts, query);
  sendJson(res, 200, { count: accounts.length, returned: page.returned, offset: page.offset, limit: page.limit, nextOffset: page.nextOffset, accounts: page.rows, summary });
}
async function handleAccountsClear(res) {
  await accountStore.clear();
  sendJson(res, 200, { ok: true, count: 0, accounts: [] });
}
async function handleAccountsReset(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const email = String(body.email || '').trim();
  if (!email) { sendJson(res, 400, { error: 'MISSING_EMAIL' }); return; }
  await accountStore.reset(email);
  sendJson(res, 200, { ok: true });   // 客户端收到后即 invalidate+重拉 /api/accounts → 这里不回全量(原来要重新脱敏整表、客户端还白解析一遍丢掉)
}
// 手动新增/编辑账号进度(upsert;只接已知字段,密码字段允许写)。
async function handleAccountsUpsert(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const email = String(body.email || '').trim();
  if (!email || !/.+@.+/.test(email)) { sendJson(res, 400, { error: 'BAD_EMAIL' }); return; }
  const ALLOW = ['originalPassword', 'loginPassword', 'mailboxPassword', 'apiKey', 'billingStatus', 'cardLast4', 'exitIp', 'blacklisted', 'blacklistReason', 'registered', 'passwordChanged', 'note'];
  const fields = {};
  for (const k of ALLOW) if (k in (body.patch || {})) fields[k] = body.patch[k];
  await accountStore.update(email, fields);
  sendJson(res, 200, { ok: true });   // 同上:客户端 invalidate+重拉,不回全量
}
// 批量导入账号进度台账:每行 email:password(密码可空),逐行 upsert(已存在=更新,不存在=新建)。
async function handleAccountsImport(req, res) {
  const b = await _body(req, res); if (!b) return;
  const raw = String(b.raw || '');
  // 先解析整批为 items,再【一次】updateMany(只过一次 mutex、只 flush 一次)→ 大批量导入不再逐条 await 拖很久。
  const items = []; let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const em = s.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
    if (!em) { bad++; continue; }
    const email = em[0];
    const after = s.slice((em.index || 0) + email.length);
    const pm = after.match(/[\s:|,;\t]+(\S[^\s|,;\t]*)/);
    const password = pm ? pm[1].replace(/^["']|["']$/g, '').trim() : '';
    items.push({ email, fields: password ? { originalPassword: password } : {} });
  }
  const { added, updated } = await accountStore.updateMany(items);
  sendJson(res, 200, { ok: true, added, updated, bad });   // 客户端 invalidate+重拉,不回全量
}

// 错误策略：查看(含说明+生效) / 配置覆盖 / 重置。
function handlePolicyGet(res) {
  sendJson(res, 200, { actions: failurePolicy.ACTIONS, policy: failurePolicy.effectivePolicy() });
}
async function handlePolicySet(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const code = String(body.code || '').trim();
  if (!code || !failurePolicy.CATALOG[code] || code.startsWith('_')) { sendJson(res, 400, { error: 'BAD_CODE' }); return; }
  if (!failurePolicy.ACTIONS.includes(body.action)) { sendJson(res, 400, { error: 'BAD_ACTION' }); return; }
  const n = Number(body.maxRetries);
  if (!Number.isInteger(n) || n < 0 || n > 10) { sendJson(res, 400, { error: 'BAD_MAX_RETRIES' }); return; }
  await policyStore.setOverride(code, { action: body.action, maxRetries: n });
  sendJson(res, 200, { ok: true, actions: failurePolicy.ACTIONS, policy: failurePolicy.effectivePolicy() });
}
async function handlePolicyReset(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const code = String(body.code || '').trim();
  if (code) await policyStore.resetOverride(code); else await policyStore.clear();
  sendJson(res, 200, { ok: true, policy: failurePolicy.effectivePolicy() });
}

// 错误记录：汇总 / 清空。
function handleErrorsSummary(res) {
  sendJson(res, 200, errorLog.summary());
}
async function handleErrorsClear(res) {
  await errorLog.clear();
  sendJson(res, 200, { ok: true, ...errorLog.summary() });
}

// ── 运行历史 + 总览(只读聚合,补「无 job 级汇总」「无总览」的洞)────────────
const _failedRecCache = new Map(); // file -> { mtimeMs, size, rows }:与 readJobRecords 同款 mtime+size memo(原来 failed 没缓存,每次详情请求都冷读+解析)
function readFailedRecords(jobId) {
  const file = path.join(RESULTS_DIR, `${jobId}-failed.jsonl`);
  try {
    const st = fs.statSync(file);
    const c = _failedRecCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.rows;
    const out = [];
    fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .forEach((line) => { try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ } });
    _failedRecCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows: out });
    return out;
  } catch (_e) { return []; }  // 无文件/读失败 → 空(不缓存,下次重试)
}
// GET /api/runs —— 本节点任务历史列表(最新在前)
function handleApiRuns(res, query) {
  sendJson(res, 200, { nodeId: NODE_ID, runs: runsStore.list(Number(query.get('limit')) || 50) });
}
// GET /api/runs/detail?jobId= —— 单次下钻:Python 引擎读 per-job 详情快照(data/run-details/),Node 读 batch-results。
function handleApiRunsDetail(res, query) {
  const jobId = query.get('jobId') || '';
  if (!/^job-[\w-]+$/.test(jobId)) { sendJson(res, 400, { error: 'BAD_JOB_ID' }); return; }
  const summary = runsStore.get(jobId);
  const detail = engineRunner.readDetail(jobId);   // Python(selenium/hybrid/split)引擎:per-job 快照
  if (detail) { sendJson(res, 200, { jobId, summary, success: detail.success || [], failed: detail.failed || [], incomplete: detail.incomplete || [] }); return; }
  sendJson(res, 200, { jobId, summary, success: readJobRecords(jobId), failed: readFailedRecords(jobId), incomplete: [] });
}
async function handleApiRunsClear(res) {
  await runsStore.clear();
  sendJson(res, 200, { ok: true });
}

// ── 多引擎统一启动器:POST /api/run(selenium|hybrid|split → spawn Python);playwright 仍走 /jobs ──
async function handleApiRun(req, res) {
  let payload;
  try { payload = await readJsonBody(req); } catch (err) { sendJson(res, 400, { error: err.message }); return; }
  const engine = ['selenium', 'hybrid', 'split'].includes(payload.engine) ? payload.engine : null;
  if (!engine) { sendJson(res, 400, { error: 'BAD_ENGINE', message: 'engine 必须是 selenium|hybrid|split(playwright 走 /jobs)' }); return; }
  resolvePools(payload);
  const accounts = parseAccounts(payload.accountsRaw);
  const proxies = parseProxies(payload.proxiesRaw);
  if (!accounts.length) { sendJson(res, 400, { error: 'NO_ACCOUNTS', message: '账号凭证为空' }); return; }
  if (!proxies.length) { sendJson(res, 400, { error: 'NO_PROXIES', message: 'Python 引擎建 AdsPower 环境必须配代理' }); return; }
  // 共享卡池:带了卡文本先合并入池(Node/Python 同一份 data/card-pool.json)
  if (payload.cardsRaw && String(payload.cardsRaw).trim()) {
    const parsed = cardPool.parseCardLines(payload.cardsRaw, Number(payload.cardMaxUses) || 10);
    await cardPool.upsertMany(parsed).catch(() => {});
  }
  const runCount = Math.max(0, Math.floor(Number(payload.count) || 0)) || accounts.length; // 负数/NaN→全部
  const sliced = accounts.slice(0, runCount);
  const r = launchPythonJob(engine, sliced, proxies, payload, null);
  if (r.duplicate) { sendJson(res, 409, { error: 'DUPLICATE_SUBMIT', message: `相同账号批次已在运行中(jobId …${String(r.conflictJobId).slice(-10)}),已挡掉重复提交防重复扣费;等它结束或用「续跑这批」。` }); return; }
  sendJson(res, 200, r);
}

// Python 引擎(selenium|hybrid|split)统一起跑:落 manifest(供续跑)→ 记 running → spawn → 收口历史。
// resumedFrom = 续跑来源 jobId(普通提交传 null)。返回 { jobId, accepted, engine }。
// 【A2 修】同批账号在跑互斥:前端 submittingRef 只挡单标签双击,挡不住双标签/重试/多客户端 →
//   两个并发 /api/run 各起一个 job 把同号重复跑(含真扣款)。这里按 引擎+排序后account集 做指纹,
//   整个 job 生命周期内挡掉相同批次的二次提交(返回 duplicate),job 结束清除 → 之后可正常再提交。
const _batchInflight = new Map(); // batchKey -> jobId
function _batchKey(engine, accounts) {
  const emails = (accounts || []).map((a) => String(a.email || '').toLowerCase()).sort().join(',');
  return engine + ':' + crypto.createHash('sha1').update(emails).digest('hex');
}

function launchPythonJob(engine, sliced, proxies, payload, resumedFrom) {
  const batchKey = _batchKey(engine, sliced);
  const conflict = _batchInflight.get(batchKey);
  if (conflict) return { duplicate: true, conflictJobId: conflict };
  const jobId = `job-${NODE_ID}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  _batchInflight.set(batchKey, jobId);
  // 落 job.json:除账号/代理/卡文本外的完整参数,供「续跑这批」忠实重建(凭证在 accounts.txt/proxies.txt,不重复存)。
  try {
    const manifest = { ...payload, engine };
    delete manifest.accountsRaw; delete manifest.proxiesRaw; delete manifest.cardsRaw;
    delete manifest.accounts; delete manifest.proxies;
    // 【C1 修】resolvePools 会把 billingAddressesRaw(真实地址 PII)/adspowerEnvIdsRaw/browserEnvIdsRaw 注入 payload。
    //   Python 引擎绑地址用 rand_address() 自己生成、不吃 web 地址 → 这些字段对续跑无用,删掉免 PII 落 job.json。
    delete manifest.billingAddressesRaw; delete manifest.adspowerEnvIdsRaw; delete manifest.browserEnvIdsRaw;
    tempInputs.writeManifest(jobId, manifest);
  } catch (_e) { /* manifest 落盘失败不阻断:续跑会回退 runs.json 精简参数 */ }
  try {
    // 配置快照:记下本次跑用的【激活引擎预设 / 执行方案 / 高级参数】→ 历史可溯源"上批是哪套配置跑出的"。纯只读,不改任何 store。
    let configSnapshot = null;
    try {
      const ec = require('./engine-config-store');
      const en = (((ec.getAll() || {}).engines) || {})[engine] || {};
      configSnapshot = {
        advanced: require('./advanced-store').get() || {},
        enginePresetId: en.activeId || null,
        // ★按值快照引擎opts(不只存 activeId 指针)→ 预设后续被编辑也能溯源【当时真正跑的参数】。
        engineOpts: (typeof ec.activeOpts === 'function') ? ec.activeOpts(engine) : null,
        schemeId: (((require('./schemes-store').getAll() || {}).schemes) || {}).activeId || null,
      };
    } catch (_e2) { /* 快照失败不影响起 job */ }
    runsStore.start({
      jobId, nodeId: NODE_ID, engine, startedAt: Date.now(), total: sliced.length, resumedFrom: resumedFrom || null,
      params: { engine, concurrency: Math.max(1, Math.floor(Number(payload.concurrency) || 1)), doApiKey: payload.doApiKey !== false, doCard: !!payload.doCard, doPurchase: !!payload.doPurchase, solveHcaptcha: payload.solveHcaptcha || 'random', configSnapshot },
    });
  } catch (_e) { /* 历史落盘失败不阻断 */ }
  if (resumedFrom) eventBus.publish(jobId, 'log', `续跑自 ${resumedFrom.slice(-14)}:断点续跑(resume=on)将自动跳过已完成的号`);
  Promise.resolve()
    .then(() => engineRunner.spawnEngine(jobId, engine, { ...payload, accounts: sliced, proxies }, eventBus.publish))
    // spawnEngine 子进程崩溃时不 reject,而是返回带 error 字段的 summary → 据此判失败,否则会被当成"完成 0/0"。
    .then((summary) => { try { if (summary && summary.error) runsStore.fail(jobId, new Error(summary.error)); else runsStore.finish(jobId, summary); } catch (_e) { /* ignore */ } })
    .catch((err) => {
      try { runsStore.fail(jobId, err); } catch (_e) { /* ignore */ }
      eventBus.publish(jobId, 'log', `引擎异常终止: ${err && err.message}`);
      eventBus.publish(jobId, 'job-done', { jobId, error: err && err.message });
    })
    .finally(() => { _batchInflight.delete(batchKey); });   // job 结束(成败均)释放互斥,之后可正常再提交同批
  return { jobId, accepted: sliced.length, engine };
}

// POST /api/run/resume —— 「续跑这批」:读源 job 残留输入(accounts.txt/proxies.txt/job.json)→ 强制 resume → 新起一个 job。
// 仅对中断/异常(输入未被清理)的任务可用;正常跑完的任务输入已清,返回 404。
async function handleApiRunResume(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { sendJson(res, 400, { error: err.message }); return; }
  const srcJobId = String((body && body.jobId) || '').trim();
  if (!srcJobId) { sendJson(res, 400, { error: 'MISSING_JOB_ID', message: '缺少 jobId' }); return; }
  const inp = tempInputs.readResumeInputs(srcJobId);
  if (!inp) { sendJson(res, 404, { error: 'NO_INPUTS', message: '该任务的输入已被清理(正常跑完的任务不保留输入),无法一键续跑;请到控制台重新提交账号。' }); return; }
  const row = runsStore.get(srcJobId);
  const base = inp.manifest || {};
  // 引擎来源:manifest → runs 行 engine → runs 行 params.engine
  const pick = (v) => (['selenium', 'hybrid', 'split'].includes(v) ? v : null);
  // 引擎来源优先级:请求显式 engine(前端从详情页 summary 带来) → manifest → runs 行 → runs.params → split 自动识别(A/B 文件)
  const engine = pick(body && body.engine) || pick(base.engine) || pick(row && row.engine)
    || pick(row && row.params && row.params.engine) || (inp.splitHint ? 'split' : null);
  if (!engine) { sendJson(res, 400, { error: 'BAD_ENGINE', message: '无法确定源任务引擎(可能是 Playwright 引擎或历史已清);可在请求中显式指定 engine 续跑' }); return; }
  // 无 manifest(早于本功能的老任务)→ 用 runs.json 精简 params 拼最小可用参数集
  const fallback = (!inp.manifest && row && row.params) ? {
    concurrency: row.params.concurrency, doApiKey: row.params.doApiKey, doCard: row.params.doCard,
    doPurchase: row.params.doPurchase, solveHcaptcha: row.params.solveHcaptcha,
  } : {};
  // 续跑强制 resume=true(只跑没完成的、跳过已完成,绝不重复扣费);代理/账号用残留的真实输入。
  const payload = { ...base, ...fallback, engine, accountsRaw: inp.accountsRaw, proxiesRaw: inp.proxiesRaw, resume: true };
  let accounts = parseAccounts(payload.accountsRaw);
  const proxies = parseProxies(payload.proxiesRaw);
  if (!accounts.length) { sendJson(res, 400, { error: 'NO_ACCOUNTS', message: '残留账号文件为空,无法续跑' }); return; }
  // ★「只续跑未完整的」:前端可传 onlyEmails 子集(运行详情页第三桶「未完整」按钮)→ 只重跑这些号,其余不动。
  //   仍强制 resume=true(对子集内已完成的环节也跳过、防重复扣费);子集与残留账号取交集(防注入不在本批的号)。
  if (Array.isArray(body.onlyEmails) && body.onlyEmails.length) {
    const want = new Set(body.onlyEmails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
    const subset = accounts.filter((a) => want.has(String(a.email || '').toLowerCase()));
    if (!subset.length) { sendJson(res, 400, { error: 'NO_MATCH', message: '指定的续跑邮箱都不在该任务的残留账号里,无法续跑' }); return; }
    accounts = subset;
  }
  const r = launchPythonJob(engine, accounts, proxies, payload, srcJobId);
  if (r.duplicate) { sendJson(res, 409, { error: 'DUPLICATE_SUBMIT', message: `相同账号批次已在运行中(jobId …${String(r.conflictJobId).slice(-10)}),已挡掉重复续跑防重复扣费;等它结束后再试。` }); return; }
  sendJson(res, 200, { ...r, resumedFrom: srcJobId });
}

// POST /api/jobs/stop —— 杀 Python 引擎进程树(含 Playwright/浏览器);进程 close 后正常收口 job-done。
async function handleStopJob(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const jobId = String(body.jobId || '');
  if (!/^job-[\w-]+$/.test(jobId)) { sendJson(res, 400, { error: 'BAD_JOB_ID' }); return; }
  if (!procRegistry.has(jobId)) { sendJson(res, 200, { ok: false, reason: 'NOT_RUNNING_OR_PLAYWRIGHT' }); return; }
  const pids = procRegistry.stop(jobId);
  eventBus.publish(jobId, 'log', `🛑 收到停止:已杀进程树 pid=${pids.join(',')}(含 Python+浏览器)`);
  sendJson(res, 200, { ok: true, jobId, killed: pids });
}
function handleApiJobsActive(res) { sendJson(res, 200, { jobs: procRegistry.list() }); }

// ── 设置中心:配置脱敏读 / 安全写 + 健康自检 ───────────────────────────────
function handleApiConfigGet(res) {
  try { sendJson(res, 200, { config: configRw.view(), secrets: configRw.SECRETS, note: '密钥只回是否已设置(set:bool),不回明文;保存时密钥留空=保持原值不变。改完需重启 node web/server.js 才对新任务生效。' }); }
  catch (e) { sendJson(res, 500, { error: 'CONFIG_READ_FAILED', message: String(e && e.message) }); }
}
// GET /api/config/secret?key= —— 按需取单个密钥明文(设置中心「显示」用;只允许 3 个密钥;天然受 token 保护)
function handleApiConfigSecret(res, query) {
  const key = query.get('key') || '';
  if (!configRw.SECRETS.includes(key)) { sendJson(res, 400, { error: 'BAD_KEY' }); return; }
  sendJson(res, 200, { key, value: configRw.getSecret(key) });
}
async function handleApiConfigSet(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  const patch = body && typeof body.patch === 'object' ? body.patch : null;
  if (!patch) { sendJson(res, 400, { error: 'NO_PATCH' }); return; }
  try {
    const r = configRw.writeLocal(patch);
    sendJson(res, 200, { ok: true, written: r.written, skipped: r.skipped, config: configRw.view(), note: '已写入 config.local.json。重启 node web/server.js 才对新任务生效。' });
  } catch (e) { sendJson(res, 500, { error: 'CONFIG_WRITE_FAILED', message: String(e && e.message) }); }
}
// ── 环节命名策略预设:读 / 存 / 删 / 设激活 ──────────────────────────────
function handleStrategiesGet(res) {
  try { sendJson(res, 200, strategiesStore.getAll()); }
  catch (e) { sendJson(res, 500, { error: 'STRATEGIES_READ_FAILED', message: String(e && e.message) }); }
}
const STRATEGY_ERR = { BAD_STAGE: 400, NO_PRESET: 404, BUILTIN_LOCKED: 409 };
async function handleStrategiesSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = strategiesStore.savePreset(String(body.stage || ''), { id: body.id, name: body.name, opts: body.opts });
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, STRATEGY_ERR[e.code] || 500, { error: e.code || 'SAVE_FAILED' }); }
}
async function handleStrategiesDelete(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = strategiesStore.deletePreset(String(body.stage || ''), String(body.id || ''));
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, STRATEGY_ERR[e.code] || 500, { error: e.code || 'DELETE_FAILED' }); }
}
async function handleStrategiesActive(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = strategiesStore.setActive(String(body.stage || ''), String(body.id || ''));
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, STRATEGY_ERR[e.code] || 500, { error: e.code || 'ACTIVE_FAILED' }); }
}
// ── 失败恢复策略(单一全局命名空间·多预设):读 / 存 / 删 / 设激活 ──────────────────
const RECOVERY_ERR = { NO_PRESET: 404, BUILTIN_LOCKED: 409 };
function handleRecoveryGet(res) {
  try { sendJson(res, 200, recoveryStore.getAll()); }
  catch (e) { sendJson(res, 500, { error: 'RECOVERY_READ_FAILED', message: String(e && e.message) }); }
}
async function handleRecoverySave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = recoveryStore.savePreset({ id: body.id, name: body.name, opts: body.opts });
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, RECOVERY_ERR[e.code] || 500, { error: e.code || 'SAVE_FAILED' }); }
}
async function handleRecoveryDelete(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = recoveryStore.deletePreset(String(body.id || ''));
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, RECOVERY_ERR[e.code] || 500, { error: e.code || 'DELETE_FAILED' }); }
}
async function handleRecoveryActive(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = recoveryStore.setActive(String(body.id || ''));
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, RECOVERY_ERR[e.code] || 500, { error: e.code || 'ACTIVE_FAILED' }); }
}
// ── 执行方案(整套"怎么跑"命名预设):读 / 存 / 删 / 设激活 ──────────────────
const SCHEME_ERR = { NO_PRESET: 404, BUILTIN_LOCKED: 409 };
function handleSchemesGet(res) {
  try { sendJson(res, 200, schemesStore.getAll()); }
  catch (e) { sendJson(res, 500, { error: 'SCHEMES_READ_FAILED', message: String(e && e.message) }); }
}
async function handleSchemesSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try { sendJson(res, 200, { ok: true, ...schemesStore.savePreset({ id: body.id, name: body.name, cfg: body.cfg }) }); }
  catch (e) { sendJson(res, SCHEME_ERR[e.code] || 500, { error: e.code || 'SAVE_FAILED' }); }
}
async function handleSchemesDelete(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try { sendJson(res, 200, { ok: true, ...schemesStore.deletePreset(String(body.id || '')) }); }
  catch (e) { sendJson(res, SCHEME_ERR[e.code] || 500, { error: e.code || 'DELETE_FAILED' }); }
}
async function handleSchemesActive(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try { sendJson(res, 200, { ok: true, ...schemesStore.setActive(String(body.id || '')) }); }
  catch (e) { sendJson(res, SCHEME_ERR[e.code] || 500, { error: e.code || 'ACTIVE_FAILED' }); }
}
// ── 引擎配置(per-engine 命名预设):读 / 存 / 删 / 设激活 ──────────────────
// 与环节策略同范式,顶层键是引擎(playwright/selenium/hybrid/split)。opts 已被 store 按 engine-schema 白名单过滤。
function handleEngineConfigsGet(res) {
  try { sendJson(res, 200, engineConfigStore.getAll()); }
  catch (e) { sendJson(res, 500, { error: 'ENGINE_CONFIGS_READ_FAILED', message: String(e && e.message) }); }
}
const ENGINE_CFG_ERR = { BAD_ENGINE: 400, NO_PRESET: 404, BUILTIN_LOCKED: 409 };
async function handleEngineConfigsSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = engineConfigStore.savePreset(String(body.engine || ''), { id: body.id, name: body.name, opts: body.opts });
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, ENGINE_CFG_ERR[e.code] || 500, { error: e.code || 'SAVE_FAILED' }); }
}
async function handleEngineConfigsDelete(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = engineConfigStore.deletePreset(String(body.engine || ''), String(body.id || ''));
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, ENGINE_CFG_ERR[e.code] || 500, { error: e.code || 'DELETE_FAILED' }); }
}
async function handleEngineConfigsActive(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try {
    const r = engineConfigStore.setActive(String(body.engine || ''), String(body.id || ''));
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) { sendJson(res, ENGINE_CFG_ERR[e.code] || 500, { error: e.code || 'ACTIVE_FAILED' }); }
}

// ── 高级参数(全局/共用调优旋钮,advanced-store):读 / 存。只存用户显式覆盖值,空=清除回落代码默认。──
function handleAdvancedGet(res) {
  try { sendJson(res, 200, advancedStore.get()); }
  catch (e) { sendJson(res, 500, { error: 'ADVANCED_READ_FAILED', message: String(e && e.message) }); }
}
async function handleAdvancedSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try { sendJson(res, 200, { ok: true, values: advancedStore.save(body || {}) }); }
  catch (e) { sendJson(res, 500, { error: 'ADVANCED_SAVE_FAILED', message: String(e && e.message) }); }
}

// ── 元素选择器维护(selectors-store):读注册表+覆盖值 / 存覆盖。空=回落 builtin 内置默认。──
function handleSelectorsGet(res) {
  try { sendJson(res, 200, { steps: selectorsSchema.STEPS, values: selectorsStore.get() }); }
  catch (e) { sendJson(res, 500, { error: 'SELECTORS_READ_FAILED', message: String(e && e.message) }); }
}
async function handleSelectorsSave(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return; }
  try { sendJson(res, 200, { ok: true, values: selectorsStore.save(body || {}) }); }
  catch (e) { sendJson(res, 500, { error: 'SELECTORS_SAVE_FAILED', message: String(e && e.message) }); }
}

// ── 资源池:代理 / 账单地址 / AdsPower 环境(持久化 CRUD)─────────────────
async function _body(req, res) { try { return await readJsonBody(req); } catch (e) { sendJson(res, 400, { error: e.message }); return null; } }

// 代理
function handleProxiesGet(res) { sendJson(res, 200, { items: proxyStore.list() }); }
async function handleProxiesAdd(req, res) { const b = await _body(req, res); if (!b) return; const r = proxyStore.add(b.raw || ''); sendJson(res, 200, { ok: true, ...r, items: proxyStore.list() }); }
async function handleProxiesUpdate(req, res) { const b = await _body(req, res); if (!b) return; const it = proxyStore.update(String(b.id || ''), b.patch || {}); if (!it) { sendJson(res, 404, { error: 'NO_PROXY' }); return; } sendJson(res, 200, { ok: true, items: proxyStore.list() }); }
async function handleProxiesRemove(req, res) { const b = await _body(req, res); if (!b) return; proxyStore.remove(String(b.id || '')); sendJson(res, 200, { ok: true, items: proxyStore.list() }); }
async function handleProxiesClear(res) { proxyStore.clear(); sendJson(res, 200, { ok: true, items: [] }); }
async function handleProxiesSetType(req, res) { const b = await _body(req, res); if (!b) return; const r = proxyStore.setAllType(String(b.type || '')); sendJson(res, 200, { ok: true, ...r, items: proxyStore.list() }); }
// TCP 连通性测试(仅可达性 + 延迟,不做规避评分)
function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false;
    const sock = net.connect({ host, port: Number(port) });
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_e) { /* */ } resolve({ ok, latencyMs: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs || 8000);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}
// 有界并发执行 fn(item):同时最多 limit 个在飞;单项失败不连累整体。把「测全部代理/端点/余额」从串行(N×超时,
// 200 个死代理 ×8s ≈ 26 分钟把请求挂死)改并行(墙钟≈最慢一个)。JS 单线程,fn 的 await 只在 ping/HTTP 处让出,
// recordTest 等同步写在 await 之间原子执行,不会互相穿插。
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch (_e) { /* 单项已各自兜底,继续 */ } }
  });
  await Promise.all(workers);
}
async function handleProxiesTest(req, res) {
  const b = await _body(req, res); if (!b) return;
  const ids = Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : proxyStore.list().map((p) => p.id));
  const byId = new Map(proxyStore.list().map((x) => [x.id, x]));   // 一次建索引,免循环里每个 id 都 list().find() 退化成 O(n²)
  await mapLimit(ids, 20, async (id) => { const p = byId.get(id); if (!p) return; const r = await tcpPing(p.host, p.port, 8000); proxyStore.recordTest(id, r); });
  sendJson(res, 200, { ok: true, items: proxyStore.list() });
}

// 账单地址
function handleAddressesGet(res) { sendJson(res, 200, { items: addressStore.list() }); }
async function handleAddressesImport(req, res) { const b = await _body(req, res); if (!b) return; const r = addressStore.importRaw(b.raw || ''); sendJson(res, 200, { ok: true, ...r, items: addressStore.list() }); }
async function handleAddressesUpdate(req, res) { const b = await _body(req, res); if (!b) return; const it = addressStore.update(String(b.id || ''), b.patch || {}); if (!it) { sendJson(res, 404, { error: 'NO_ADDRESS' }); return; } sendJson(res, 200, { ok: true, items: addressStore.list() }); }
async function handleAddressesRemove(req, res) { const b = await _body(req, res); if (!b) return; addressStore.remove(String(b.id || '')); sendJson(res, 200, { ok: true, items: addressStore.list() }); }
async function handleAddressesClear(res) { addressStore.clear(); sendJson(res, 200, { ok: true, items: [] }); }

// AdsPower 环境编号池
function handleAdspowerGet(res) { sendJson(res, 200, { items: adspowerStore.list() }); }
async function handleAdspowerAdd(req, res) { const b = await _body(req, res); if (!b) return; const r = adspowerStore.add(b.raw || '', b.endpoint || ''); sendJson(res, 200, { ok: true, ...r, items: adspowerStore.list() }); }
async function handleAdspowerUpdate(req, res) { const b = await _body(req, res); if (!b) return; const it = adspowerStore.update(String(b.id || ''), b.patch || {}); if (!it) { sendJson(res, 404, { error: 'NO_ENV' }); return; } sendJson(res, 200, { ok: true, items: adspowerStore.list() }); }
async function handleAdspowerRemove(req, res) { const b = await _body(req, res); if (!b) return; adspowerStore.remove(String(b.id || '')); sendJson(res, 200, { ok: true, items: adspowerStore.list() }); }
async function handleAdspowerClear(res) { adspowerStore.clear(); sendJson(res, 200, { ok: true, items: [] }); }
// AdsPower 端点连通测试:GET {apiBase}/status → Promise<{ok,latencyMs,status,body,error}>
// apiKey 非空 → /status 也带鉴权头(与引擎一致),这样「测试连通」对错密钥/带鉴权的远程网关能真正校验,
// 而不是只测 apiBase 可达。头名/前缀沿用同一组 env 覆盖,默认 Authorization: Bearer <token>。
function pingAdspower(apiBase, apiKey) {
  return new Promise((resolve) => {
    const base = String(apiBase || '').replace(/\/+$/, '');
    let url; try { url = new URL(base + '/status'); } catch (_e) { resolve({ ok: false, error: 'BAD_API_BASE', apiBase: base }); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {};
    const tok = String(apiKey || '').trim();
    if (tok) {
      const hn = process.env.OPENROUTER_ADSPOWER_AUTH_HEADER || 'Authorization';
      const pfx = process.env.OPENROUTER_ADSPOWER_AUTH_PREFIX != null ? process.env.OPENROUTER_ADSPOWER_AUTH_PREFIX : 'Bearer ';
      headers[hn] = pfx + tok;
    }
    const t0 = Date.now(); let done = false;
    const finish = (obj) => { if (done) return; done = true; resolve({ apiBase: base, latencyMs: Date.now() - t0, ...obj }); };
    const r = lib.get(url, { headers }, (resp) => { let s = ''; resp.on('data', (d) => { s += d; if (s.length > 4096) resp.destroy(); }); resp.on('end', () => finish({ ok: resp.statusCode === 200, status: resp.statusCode, body: s.slice(0, 300) })); });
    r.setTimeout(6000, () => { try { r.destroy(); } catch (_e) { /* */ } finish({ ok: false, error: 'TIMEOUT' }); });
    r.on('error', (e) => finish({ ok: false, error: String(e && e.message) }));
  });
}
// 本机默认端点(config)连通测试 — 端点池为空时的兜底
async function handleAdspowerPing(res) {
  const ap = (configRw.readMerged() || {}).adspower || {};
  sendJson(res, 200, await pingAdspower(ap.apiBase || 'http://127.0.0.1:50325', ap.apiKey));
}
// 部署引导『真开浏览器』自测:跑 adspower_env --selftest(建→启→接管→停→删)→ 验证 AdsPower 真能开浏览器
//   (光 ping /status 不够)。有任务在跑则拒绝(自测占用 AdsPower、限频);自测自身 finally 删环境防孤儿。
async function handleAdspowerLaunchSelftest(res) {
  try {
    // 有任务在跑就拒绝(自测会占用 AdsPower、本地接口限频 ~1req/s)。procRegistry 只跟踪 Python 引擎子进程 →
    //   再用 runsStore 的 running 行兜底覆盖【Playwright 引擎】任务(它不进 procRegistry)。
    let running = procRegistry.list().length > 0;
    if (!running) { try { running = (runsStore.list() || []).some((r) => r && r.status === 'running'); } catch (_e) { /* 读不到当未跑 */ } }
    if (running) return void sendJson(res, 409, { ok: false, detail: '有任务正在运行 —— 自测会占用 AdsPower(本地接口限频 ~1req/s),请待任务结束后再试' });
    const r = await engineRunner.adspowerSelftest({ timeoutMs: 90000 });
    sendJson(res, r && r.busy ? 409 : 200, r);
  } catch (e) { sendJson(res, 500, { ok: false, detail: String((e && e.message) || e) }); }
}
// 端点池 CRUD
function handleEndpointsGet(res) { sendJson(res, 200, { items: adspowerEndpointStore.list() }); }
async function handleEndpointsAdd(req, res) { const b = await _body(req, res); if (!b) return; try { adspowerEndpointStore.add({ label: b.label, apiBase: b.apiBase, apiKey: b.apiKey }); sendJson(res, 200, { ok: true, items: adspowerEndpointStore.list() }); } catch (e) { sendJson(res, 400, { error: e.code || 'ADD_FAILED' }); } }
async function handleEndpointsUpdate(req, res) { const b = await _body(req, res); if (!b) return; const it = adspowerEndpointStore.update(String(b.id || ''), b.patch || {}); if (!it) { sendJson(res, 404, { error: 'NO_ENDPOINT' }); return; } sendJson(res, 200, { ok: true, items: adspowerEndpointStore.list() }); }
async function handleEndpointsRemove(req, res) { const b = await _body(req, res); if (!b) return; adspowerEndpointStore.remove(String(b.id || '')); sendJson(res, 200, { ok: true, items: adspowerEndpointStore.list() }); }
async function handleEndpointsClear(res) { adspowerEndpointStore.clear(); sendJson(res, 200, { ok: true, items: [] }); }
async function handleEndpointsTest(req, res) {
  const b = await _body(req, res); if (!b) return;
  const ids = Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : adspowerEndpointStore.list().map((e) => e.id));
  await mapLimit(ids, 20, async (id) => { const ep = adspowerEndpointStore.getFull(id); if (!ep) return; const r = await pingAdspower(ep.apiBase, ep.apiKey); adspowerEndpointStore.recordTest(id, r); });
  sendJson(res, 200, { ok: true, items: adspowerEndpointStore.list() });
}

// ── 诊断/排查:按 email/card/proxy/env 跨资源关联(只读)─────────────────────
function _norm(s) { return String(s || '').trim().toLowerCase(); }
function handleApiDiagnose(res, q) {
  const by = q.get('by') || 'email';
  const value = q.get('value') || '';
  if (!value) { sendJson(res, 400, { error: 'NO_VALUE' }); return; }
  let errAll = []; let billAll = [];
  try { errAll = errorLog.summary(5000).entries || []; } catch (_e) { /* */ }
  try { billAll = billingLedger.summary(5000).entries || []; } catch (_e) { /* */ }
  if (by === 'email') {
    const v = _norm(value);
    const account = accountStore.get(value);
    const usage = usageStore.byEmail(value);
    const errors = errAll.filter((e) => _norm(e.email) === v);
    const billing = billAll.filter((e) => _norm(e.email) === v);
    const cards = [...new Set([...usage.map((u) => u.cardLast4), ...billing.map((b) => b.cardLast4), account && account.cardLast4].filter(Boolean))];
    const proxies = [...new Map(usage.filter((u) => u.host || u.proxyId || u.exitIp).map((u) => [u.proxyId || u.host || u.exitIp, { proxyId: u.proxyId || '', host: u.host || '', exitIp: u.exitIp || '' }])).values()];
    const envs = [...new Set(usage.map((u) => u.envId).filter(Boolean))];
    sendJson(res, 200, { by, value, account, usage, errors, billing, related: { cards, proxies, envs } });
    return;
  }
  let usage = [];
  if (by === 'card') usage = usageStore.byCard(value);
  else if (by === 'proxy') usage = usageStore.byProxy(value);
  else if (by === 'env') usage = usageStore.byEnv(value);
  else { sendJson(res, 400, { error: 'BAD_BY' }); return; }
  const emails = [...new Set(usage.map((u) => u.email).filter(Boolean))];
  const eset = new Set(emails.map(_norm));
  const errors = errAll.filter((e) => eset.has(_norm(e.email)));
  const billing = by === 'card' ? billAll.filter((b) => String(b.cardLast4) === String(value)) : billAll.filter((b) => eset.has(_norm(b.email)));
  sendJson(res, 200, { by, value, usage, emails, errors, billing });
}

// ── 验证码 / 邮箱 key 池(管多个 key + 选用 + 余额;不碰求解逻辑)──────────────
function handleCaptchaList(res) { sendJson(res, 200, { items: captchaStore.list() }); }
async function handleCaptchaAdd(req, res) { const b = await _body(req, res); if (!b) return; try { captchaStore.add({ label: b.label, provider: b.provider, apiKey: b.apiKey }); sendJson(res, 200, { ok: true, items: captchaStore.list() }); } catch (e) { sendJson(res, 400, { error: e.code || 'ADD_FAILED' }); } }
async function handleCaptchaUpdate(req, res) { const b = await _body(req, res); if (!b) return; const it = captchaStore.update(String(b.id || ''), b.patch || {}); if (!it) { sendJson(res, 404, { error: 'NO_KEY' }); return; } sendJson(res, 200, { ok: true, items: captchaStore.list() }); }
async function handleCaptchaRemove(req, res) { const b = await _body(req, res); if (!b) return; captchaStore.remove(String(b.id || '')); sendJson(res, 200, { ok: true, items: captchaStore.list() }); }
async function handleCaptchaClear(res) { captchaStore.clear(); sendJson(res, 200, { ok: true, items: [] }); }
async function handleCaptchaImport(req, res) { const b = await _body(req, res); if (!b) return; const r = captchaStore.importRaw(b.raw || ''); sendJson(res, 200, { ok: true, ...r, items: captchaStore.list() }); }
// 余额查询:2captcha / capsolver 都是 POST {base}/getBalance {clientKey}
async function captchaBalance(provider, apiKey) {
  const base = provider === '2captcha' ? 'https://api.2captcha.com' : 'https://api.capsolver.com';
  try {
    const r = await fetch(base + '/getBalance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey }), signal: AbortSignal.timeout(12000) });
    const j = await r.json().catch(() => ({}));
    // 只接受有限数余额;非数字 balance 字段(异常体)会变 NaN 毒化 captchaStore.pickActive,当作查询失败处理。
    const n = j && j.balance != null ? Number(j.balance) : NaN;
    if (Number.isFinite(n)) return { balance: n };
    return { error: j.errorDescription || j.errorCode || ('HTTP ' + r.status) };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
async function handleCaptchaBalance(req, res) {
  const b = await _body(req, res); if (!b) return;
  const ids = Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : captchaStore.list().map((k) => k.id));
  await mapLimit(ids, 10, async (id) => { const k = captchaStore.getFull(id); if (!k) return; const r = await captchaBalance(k.provider, k.apiKey); captchaStore.recordBalance(id, r); });   // 外部 HTTP 12s,并发压低到 10
  sendJson(res, 200, { ok: true, items: captchaStore.list() });
}
// 邮箱
function handleMailboxList(res) { sendJson(res, 200, { items: mailboxStore.list() }); }
async function handleMailboxAdd(req, res) { const b = await _body(req, res); if (!b) return; try { mailboxStore.add({ label: b.label, provider: b.provider, apiKey: b.apiKey, apiBaseUrl: b.apiBaseUrl }); sendJson(res, 200, { ok: true, items: mailboxStore.list() }); } catch (e) { sendJson(res, 400, { error: e.code || 'ADD_FAILED' }); } }
async function handleMailboxUpdate(req, res) { const b = await _body(req, res); if (!b) return; const it = mailboxStore.update(String(b.id || ''), b.patch || {}); if (!it) { sendJson(res, 404, { error: 'NO_KEY' }); return; } sendJson(res, 200, { ok: true, items: mailboxStore.list() }); }
async function handleMailboxRemove(req, res) { const b = await _body(req, res); if (!b) return; mailboxStore.remove(String(b.id || '')); sendJson(res, 200, { ok: true, items: mailboxStore.list() }); }
async function handleMailboxClear(res) { mailboxStore.clear(); sendJson(res, 200, { ok: true, items: [] }); }
async function handleMailboxImport(req, res) { const b = await _body(req, res); if (!b) return; const r = mailboxStore.importRaw(b.raw || ''); sendJson(res, 200, { ok: true, ...r, items: mailboxStore.list() }); }

let _pkgVersion = '';
function pkgVersion() {
  if (_pkgVersion) return _pkgVersion;
  try { _pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version || '?'; } catch (_e) { _pkgVersion = '?'; }
  return _pkgVersion;
}
function dirBytes(dir) {
  let bytes = 0; let files = 0;
  try { for (const f of fs.readdirSync(dir)) { try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { bytes += st.size; files += 1; } } catch (_e) { /* skip */ } } } catch (_e) { /* none */ }
  return { bytes, files };
}
// GET /api/health —— 节点/集群/存储/配置自检 + 告警
function handleApiHealth(res) {
  const cfg = configRw.secretsState();
  const results = dirBytes(RESULTS_DIR);
  let runsBytes = 0; try { runsBytes = fs.statSync(runsStore._RUNS_FILE).size; } catch (_e) { /* none */ }
  const warnings = [];
  if (!cfg.captchaKeySet) warnings.push('未配置验证码(captcha)key —— Turnstile/hCaptcha 无法自动求解(设置中心填,或环境变量 OPENROUTER_CAPTCHA_KEY)');
  if (!cfg.mailboxKeySet) warnings.push('未配置邮箱(mailbox)key —— 收不到/读不了验证邮件,注册会卡住');
  if (!cfg.tokenSet && HOST === '0.0.0.0') warnings.push('监听所有网卡且未设访问令牌 —— 任何能连本端口的人都能拉你的账号/Key,建议设 security.token');
  // ★卡池健康:活跃/禁用/耗尽 + 剩余可用次数 + 今日消耗 + 预计耗尽天数 → 低于阈值告警提醒补卡。
  let cardPoolHealth = null;
  try {
    const cp = cardPool.stats();
    let todayConsumed = 0;
    try {
      const bu = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'selenium-e2e', 'state', 'bin-usage.json'), 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      const day = bu[today] || {};
      for (const binStat of Object.values(day)) todayConsumed += (binStat && typeof binStat === 'object' ? (binStat.assigned || 0) : 0);
    } catch (_e) { /* 没有 bin-usage 就算 0 */ }
    const projectedDays = todayConsumed > 0 ? Math.round((cp.remaining / todayConsumed) * 10) / 10 : null;   // 按今日消耗速率估剩余天数
    cardPoolHealth = { ...cp, todayConsumed, projectedDays };
    if (cp.available <= 10) warnings.push(`卡池可用卡仅 ${cp.available} 张(剩余可用次数 ${cp.remaining})—— 偏低,建议尽快补卡(卡池页导入)`);
    else if (projectedDays != null && projectedDays < 2) warnings.push(`按今日消耗(${todayConsumed})卡池约 ${projectedDays} 天耗尽 —— 建议补卡`);
  } catch (_e) { /* 卡池统计失败不致命 */ }
  sendJson(res, 200, {
    nodeId: NODE_ID, hostname: os.hostname(), role: nodeRole(), centralUrl: getCentralUrl(),
    uptimeSec: Math.round(process.uptime()), version: pkgVersion(),
    peers: getActivePeers().map((p) => ({ nodeId: p.nodeId, url: p.url, ageSec: Math.round((Date.now() - p.lastSeen) / 1000) })),
    storage: { resultFiles: results.files, resultsBytes: results.bytes, runsBytes },
    cardPool: cardPoolHealth,
    config: cfg,
    warnings,
  });
}

// GET /api/setup/status —— 首次部署引导:逐步「是否已配」实时算 + completed/dismissed 标志
function handleSetupStatus(res) {
  const cfg = configRw.secretsState();
  const merged = (() => { try { return configRw.readMerged() || {}; } catch (_e) { return {}; } })();
  const cnt = (fn, fallback) => { try { return fn(); } catch (_e) { return fallback; } };

  const adspowerEndpoints = cnt(() => adspowerEndpointStore.list().filter((e) => e.status !== 'disabled').length, 0);
  const adspowerApiBase = (merged.adspower && merged.adspower.apiBase) ? String(merged.adspower.apiBase).trim() : '';
  const proxies = cnt(() => proxyStore.list().length, 0);
  const cardsAvail = cnt(() => cardPool.availableCount(), 0);
  const addresses = cnt(() => addressStore.list().length, 0);
  const adsEnvs = cnt(() => adspowerStore.list().length, 0);
  const listenAll = HOST === '0.0.0.0';
  // 向导从「验证码/邮箱」页加的 key 进的是 key 池(captcha-store/mailbox-store),不是 config;done 必须也认 key 池,
  // 否则用向导加完 key,步骤仍显"未配置" → allRequiredDone 永不齐 → 每次进总览又被弹回 /setup。
  const capDone = !!cfg.captchaKeySet || cnt(() => captchaStore.list().some((k) => k.apiKeySet && k.status !== 'disabled'), false);
  const mbDone = !!cfg.mailboxKeySet || cnt(() => mailboxStore.list().some((k) => k.apiKeySet && k.status !== 'disabled'), false);

  const steps = [
    { key: 'captcha', group: 'secret', required: true, label: '验证码 key',
      done: capDone, detail: capDone ? (cfg.captchaProvider || '已配置') : '未配置' },
    { key: 'mailbox', group: 'secret', required: true, label: '邮箱 key',
      done: mbDone, detail: mbDone ? (cfg.mailboxProvider || '已配置') : '未配置' },
    { key: 'adspower', group: 'secret', required: true, label: 'AdsPower 连接',
      done: !!(adspowerEndpoints > 0 || adspowerApiBase), detail: adspowerEndpoints > 0 ? `端点池 ${adspowerEndpoints} 个` : (adspowerApiBase || '未配置') },
    { key: 'token', group: 'secret', required: false, label: '访问令牌(建议)',
      done: !!cfg.tokenSet, detail: cfg.tokenSet ? '已设置' : (listenAll ? '未设 · 监听所有网卡有风险' : '未设(单机可选)') },
    { key: 'proxies', group: 'pool', required: true, label: '代理 / IP',
      done: proxies > 0, detail: proxies > 0 ? `${proxies} 条` : '空' },
    { key: 'cards', group: 'pool', required: true, label: '卡池',
      done: cardsAvail > 0, detail: cardsAvail > 0 ? `可用 ${cardsAvail} 张` : '空' },
    { key: 'addresses', group: 'pool', required: true, label: '账单地址',
      done: addresses > 0, detail: addresses > 0 ? `${addresses} 条` : '空' },
    { key: 'adsenvs', group: 'pool', required: false, label: 'AdsPower 环境(可选)',
      done: adsEnvs > 0, detail: adsEnvs > 0 ? `${adsEnvs} 个` : '空 · 全新跑会自动建' },
  ];
  const st = setupStore.getState();
  const allRequiredDone = steps.filter((s) => s.required).every((s) => s.done);
  sendJson(res, 200, { completed: st.completed, dismissed: st.dismissed, allRequiredDone, steps });
}

// POST /api/setup/complete —— 走完引导(默认)或「以后再说」(body.dismissed=true)
async function handleSetupComplete(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const st = body && body.dismissed ? setupStore.setDismissed() : setupStore.setCompleted();
  sendJson(res, 200, { ok: true, ...st });
}

// POST /api/system/kill-orphans —— 一键清理本机孤儿 chromedriver(强杀残留的自动化驱动)。
// 有任务在跑默认拒绝(body.force=true 强清)。只杀 chromedriver(_stealth),不碰 chrome / AdsPower。
async function handleKillOrphans(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const r = procCleanup.killOrphanDrivers({ force: !!(body && body.force) });
  sendJson(res, r.refused ? 409 : 200, r);
}

// GET /api/overview —— 仪表盘 KPI:聚合现有 summary(runs / 卡池 / 台账 / 错误 + 7 天趋势)
// 失败分析:漏斗 / 环节失败排名 / 智能分类+建议 / IP战绩 / 卡战绩 / 错误分布 / 趋势(只读现算)。
function handleApiAnalytics(res, query) {
  try {
    sendJson(res, 200, failureAnalytics.analyze({ engine: query.get('engine') || 'all', sinceDays: Number(query.get('days')) || 0 }));
  } catch (e) {
    sendJson(res, 500, { error: 'ANALYTICS_FAILED', message: String(e && e.message) });
  }
}

function handleApiOverview(res) {
  const runs = runsStore.list(500);
  const finished = runs.filter((r) => r.status === 'finished');
  const accSuccess = finished.reduce((a, r) => a + (r.success || 0), 0);
  const accFailed = finished.reduce((a, r) => a + (r.failed || 0), 0);
  const accTotal = accSuccess + accFailed;
  const cards = (() => { try { return cardPool.snapshot(); } catch (_e) { return []; } })();
  const cardCount = (k) => cards.filter((c) => c.status === k).length;
  let billing = { totalCharged: 0, success: 0, declined: 0 };
  try { const b = billingLedger.summary(); billing = { totalCharged: b.totalCharged || 0, success: b.success || 0, declined: b.declined || 0 }; } catch (_e) { /* none */ }
  let errors = { total: 0, topReasons: [] };
  try { const e = errorLog.summary(); errors = { total: e.total || 0, topReasons: Object.entries(e.byReason || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([code, n]) => ({ code, n })) }; } catch (_e) { /* none */ }
  // 7 天趋势(按 startedAt 当地日期分桶)
  const trendMap = {};
  for (const r of runs) {
    if (!r.startedAt) continue;
    const d = new Date(r.startedAt); const day = `${d.getMonth() + 1}/${d.getDate()}`;
    const t = trendMap[day] || (trendMap[day] = { day, runs: 0, success: 0, failed: 0 });
    t.runs += 1; t.success += r.success || 0; t.failed += r.failed || 0;
  }
  const trend = Object.values(trendMap).slice(0, 7).reverse();
  sendJson(res, 200, {
    nodeId: NODE_ID,
    runs: { total: runs.length, finished: finished.length, running: runs.filter((r) => r.status === 'running').length,
      accSuccess, accFailed, accTotal, successRate: accTotal ? Math.round((accSuccess / accTotal) * 100) : 0,
      recent: runs.slice(0, 6) },
    cards: { total: cards.length, available: (() => { try { return cardPool.availableCount(); } catch (_e) { return cardCount('active'); } })(), exhausted: cardCount('exhausted'), disabled: cardCount('disabled') + cardCount('declined') },
    billing, errors, trend,
  });
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
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf8')); if (c.security && typeof c.security.gateStatic === 'boolean') return c.security.gateStatic; } catch (_e) { /* none */ }
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
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf8')); if (c.security && c.security[key] !== undefined) return c.security[key]; } catch (_e) { /* none */ }
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

// 兜底:任一异步 handler 抛出的未捕获 rejection / 异常,不让单进程服务整体退出(否则所有 SSE/在跑任务一起断)。
// 只记日志、保活;部分资源池 handler(proxies/addresses/adspower 的 add/update/remove)未逐个包 try/catch,靠这层托底。
process.on('unhandledRejection', (err) => { try { console.error('[unhandledRejection]', err && err.stack || err); } catch (_e) { /* ignore */ } });
process.on('uncaughtException', (err) => { try { console.error('[uncaughtException]', err && err.stack || err); } catch (_e) { /* ignore */ } try { flushAllStores(); } catch (_e) { /* ignore */ } });

// 优雅退出(REL-10/REL-5):SIGTERM / SIGINT(Ctrl+C)/ beforeExit 时,先把【延迟落盘】的 store 同步刷盘
// —— account/billing/policy/error-log 都用 setTimeout(flushNow,400)+unref(),不主动刷就会丢最近 <400ms 的写
// (账号进度/充值台账/失败策略/错误日志);再杀掉本机在跑的子进程(Windows 下子进程不随父死 → 否则残留孤儿
// Python/浏览器占代理与句柄);然后关闭 server 退出。幂等(_shuttingDown 防重入)。
let _shuttingDown = false;
function flushAllStores() {
  for (const [name, fn] of [['account', accountStore.flushNow], ['billing', billingLedger.flushNow], ['policy', policyStore.flushNow], ['error-log', errorLog.flushNow], ['recovery', recoveryStore.flushNow]]) {
    try { if (typeof fn === 'function') fn(); } catch (e) { try { console.error(`[shutdown] ${name} 刷盘失败:`, e && e.message); } catch (_e) { /* ignore */ } }
  }
}
function gracefulShutdown(signal) {
  if (_shuttingDown) return; _shuttingDown = true;
  try { console.log(`[Openrouter Web] 收到 ${signal} → 刷盘 + 清子进程后退出`); } catch (_e) { /* ignore */ }
  flushAllStores();
  try { for (const j of procRegistry.list()) { try { procRegistry.stop(j.jobId); } catch (_e) { /* ignore */ } } } catch (_e) { /* ignore */ }
  try { server.close(); } catch (_e) { /* ignore */ }
  setTimeout(() => process.exit(0), 300);   // 给 server.close 回调一点时间,然后强制退出
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('beforeExit', () => { if (!_shuttingDown) flushAllStores(); });   // 自然退出兜底:只刷盘,不强杀

// ── 一键重启(供页面「重启服务」按钮)────────────────────────────────────────
// 因为控制台多是手动 `node server.js` 直起(无 pm2/nodemon 守护),光退出不会自动拉起 →
// 这里【自重启】:拉起一个分离的新实例(同 node/argv/cwd/env)→ 刷盘 → 关旧 server → 退旧进程。
// 新实例遇端口未释放会自动重试绑定(见底部 server.on('error'))。
// 【不强杀子进程】:在跑的 Python 任务继续(避免一键重启误断批);仅重启 Node 控制台本身。
function respawnSelf() {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit',
    windowsHide: false,   // ★特例:Node 自重启,stdio:inherit 共用用户终端 → 故意【不】隐藏(否则新服务端没有可见日志窗)
  });
  child.unref();
}
let _restarting = false;
function doRestart() {
  if (_restarting) return; _restarting = true;
  try { console.log('[Openrouter Web] 一键重启 → 刷盘 → 拉起新实例 → 退出旧实例'); } catch (_e) { /* */ }
  try { flushAllStores(); } catch (_e) { /* */ }
  // 先停止接收新连接,再【强制断开存量长连接(SSE /events 等)】—— 否则端口被 SSE 常连占着,直到 process.exit 才释放,
  // 新实例可能在端口释放前耗尽重试。closeAllConnections 是 Node 18.2+;旧版本退回靠下面 process.exit 硬释放。
  try { server.close(); } catch (_e) { /* */ }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_e) { /* */ }
  try { respawnSelf(); } catch (e) { try { console.error('[restart] 拉起新实例失败:', e && e.message); } catch (_e2) { /* */ } }
  setTimeout(() => process.exit(0), 500);   // 响应送达 + 端口释放兜底,然后退出
}
async function handleServerRestart(req, res) {
  const b = await _body(req, res); if (!b) return;   // POST(经鉴权 + body 解析)
  sendJson(res, 200, { ok: true, msg: '正在重启控制台服务…约 2-3 秒后刷新页面' });
  setTimeout(doRestart, 300);   // 先把响应发出去再重启
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  // 子机注册/推送:来自任意 IP/域名(异地子机),只靠 token 鉴权,不受 IP/域名白名单限制。
  // 其余(页面/查看/聚合/下载)才受 allowHosts + allowIps 限制(如"只让公司出口IP看")。
  const ipHostExempt = (pathname === '/api/register' || pathname === '/api/push');
  if (!ipHostExempt) {
    if (!hostAllowed(req)) { res.writeHead(403); res.end('Forbidden (host not allowed)'); return; }
    if (!ipAllowed(req)) { res.writeHead(403); res.end('Forbidden (ip not allowed)'); return; }
  }
  if (isProtectedRoute(pathname) && !checkAuth(req, res, url)) return;

  if (req.method === 'POST' && pathname === '/jobs') return void handleStartJob(req, res);
  if (req.method === 'GET' && pathname === '/events') return void handleEvents(req, res, url.searchParams);
  if (req.method === 'GET' && pathname === '/download') return void handleDownload(req, res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/node') return void sendJson(res, 200, { nodeId: NODE_ID, hostname: os.hostname(), role: nodeRole(), centralUrl: getCentralUrl() });
  if (req.method === 'GET' && pathname === '/api/cluster') return void sendJson(res, 200, { nodeId: NODE_ID, hosts: loadClusterHosts(), peers: getActivePeers().map((p) => ({ nodeId: p.nodeId, url: p.url, ageSec: Math.round((Date.now() - p.lastSeen) / 1000) })) });
  if (req.method === 'GET' && pathname === '/api/results') return void handleApiResults(res);
  if (req.method === 'GET' && pathname === '/api/results/all') return void handleApiResultsAll(res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/results/job') return void handleApiResultsJob(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/register') return void handleRegister(req, res);
  if (req.method === 'POST' && pathname === '/api/push') return void handlePush(req, res);
  if (req.method === 'POST' && pathname === '/api/aggregate') return void handleApiAggregate(req, res);
  if (req.method === 'POST' && pathname === '/api/results/delete') return void handleApiResultsDelete(req, res);
  if (req.method === 'POST' && pathname === '/api/results/clear') return void handleApiResultsClear(req, res);
  if (req.method === 'GET' && pathname === '/api/cards') return void handleCardsList(res);
  if (req.method === 'GET' && pathname === '/api/cards/capacity') return void handleCardsCapacity(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/cards/import') return void handleCardsImport(req, res);
  if (req.method === 'POST' && pathname === '/api/cards/set-charge') return void handleCardAction(req, res, 'set-charge');
  if (req.method === 'POST' && pathname === '/api/cards/disable') return void handleCardAction(req, res, 'disable');
  if (req.method === 'POST' && pathname === '/api/cards/enable') return void handleCardAction(req, res, 'enable');
  if (req.method === 'POST' && pathname === '/api/cards/remove') return void handleCardAction(req, res, 'remove');
  if (req.method === 'POST' && pathname === '/api/cards/reset') return void handleCardAction(req, res, 'reset');
  if (req.method === 'POST' && pathname === '/api/cards/update') return void handleCardAction(req, res, 'update');
  if (req.method === 'POST' && pathname === '/api/cards/clear') return void handleCardAction(req, res, 'clear');
  if (req.method === 'GET' && pathname === '/api/billing') return void handleBillingSummary(res);
  if (req.method === 'POST' && pathname === '/api/billing/clear') return void handleBillingClear(res);
  if (req.method === 'GET' && pathname === '/api/accounts') return void handleAccountsList(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/accounts/clear') return void handleAccountsClear(res);
  if (req.method === 'POST' && pathname === '/api/accounts/reset') return void handleAccountsReset(req, res);
  if (req.method === 'POST' && pathname === '/api/accounts/upsert') return void handleAccountsUpsert(req, res);
  if (req.method === 'POST' && pathname === '/api/accounts/import') return void handleAccountsImport(req, res);
  if (req.method === 'GET' && pathname === '/api/policy') return void handlePolicyGet(res);
  if (req.method === 'POST' && pathname === '/api/policy/set') return void handlePolicySet(req, res);
  if (req.method === 'POST' && pathname === '/api/policy/reset') return void handlePolicyReset(req, res);
  if (req.method === 'GET' && pathname === '/api/errors') return void handleErrorsSummary(res);
  if (req.method === 'POST' && pathname === '/api/errors/clear') return void handleErrorsClear(res);
  if (req.method === 'GET' && pathname === '/api/runs') return void handleApiRuns(res, url.searchParams);
  if (req.method === 'GET' && pathname === '/api/runs/detail') return void handleApiRunsDetail(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/runs/clear') return void handleApiRunsClear(res);
  if (req.method === 'GET' && pathname === '/api/overview') return void handleApiOverview(res);
  if (req.method === 'GET' && pathname === '/api/analytics') return void handleApiAnalytics(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/run') return void handleApiRun(req, res);
  if (req.method === 'POST' && pathname === '/api/run/resume') return void handleApiRunResume(req, res);
  if (req.method === 'POST' && pathname === '/api/jobs/stop') return void handleStopJob(req, res);
  if (req.method === 'GET' && pathname === '/api/jobs/active') return void handleApiJobsActive(res);
  if (req.method === 'GET' && pathname === '/api/config') return void handleApiConfigGet(res);
  if (req.method === 'GET' && pathname === '/api/config/secret') return void handleApiConfigSecret(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/config') return void handleApiConfigSet(req, res);
  if (req.method === 'GET' && pathname === '/api/strategies') return void handleStrategiesGet(res);
  if (req.method === 'POST' && pathname === '/api/strategies/save') return void handleStrategiesSave(req, res);
  if (req.method === 'POST' && pathname === '/api/strategies/delete') return void handleStrategiesDelete(req, res);
  if (req.method === 'POST' && pathname === '/api/strategies/active') return void handleStrategiesActive(req, res);
  if (req.method === 'GET' && pathname === '/api/recovery') return void handleRecoveryGet(res);
  if (req.method === 'POST' && pathname === '/api/recovery/save') return void handleRecoverySave(req, res);
  if (req.method === 'POST' && pathname === '/api/recovery/delete') return void handleRecoveryDelete(req, res);
  if (req.method === 'POST' && pathname === '/api/recovery/active') return void handleRecoveryActive(req, res);
  if (req.method === 'GET' && pathname === '/api/schemes') return void handleSchemesGet(res);
  if (req.method === 'POST' && pathname === '/api/schemes/save') return void handleSchemesSave(req, res);
  if (req.method === 'POST' && pathname === '/api/schemes/delete') return void handleSchemesDelete(req, res);
  if (req.method === 'POST' && pathname === '/api/schemes/active') return void handleSchemesActive(req, res);
  if (req.method === 'GET' && pathname === '/api/engine-configs') return void handleEngineConfigsGet(res);
  if (req.method === 'POST' && pathname === '/api/engine-configs/save') return void handleEngineConfigsSave(req, res);
  if (req.method === 'POST' && pathname === '/api/engine-configs/delete') return void handleEngineConfigsDelete(req, res);
  if (req.method === 'POST' && pathname === '/api/engine-configs/active') return void handleEngineConfigsActive(req, res);
  if (req.method === 'GET' && pathname === '/api/advanced') return void handleAdvancedGet(res);
  if (req.method === 'POST' && pathname === '/api/advanced/save') return void handleAdvancedSave(req, res);
  if (req.method === 'GET' && pathname === '/api/selectors') return void handleSelectorsGet(res);
  if (req.method === 'POST' && pathname === '/api/selectors/save') return void handleSelectorsSave(req, res);
  if (req.method === 'GET' && pathname === '/api/proxies') return void handleProxiesGet(res);
  if (req.method === 'POST' && pathname === '/api/proxies/add') return void handleProxiesAdd(req, res);
  if (req.method === 'POST' && pathname === '/api/proxies/update') return void handleProxiesUpdate(req, res);
  if (req.method === 'POST' && pathname === '/api/proxies/remove') return void handleProxiesRemove(req, res);
  if (req.method === 'POST' && pathname === '/api/proxies/clear') return void handleProxiesClear(res);
  if (req.method === 'POST' && pathname === '/api/proxies/set-type') return void handleProxiesSetType(req, res);
  if (req.method === 'POST' && pathname === '/api/proxies/test') return void handleProxiesTest(req, res);
  if (req.method === 'GET' && pathname === '/api/addresses') return void handleAddressesGet(res);
  if (req.method === 'POST' && pathname === '/api/addresses/import') return void handleAddressesImport(req, res);
  if (req.method === 'POST' && pathname === '/api/addresses/update') return void handleAddressesUpdate(req, res);
  if (req.method === 'POST' && pathname === '/api/addresses/remove') return void handleAddressesRemove(req, res);
  if (req.method === 'POST' && pathname === '/api/addresses/clear') return void handleAddressesClear(res);
  if (req.method === 'GET' && pathname === '/api/adspower') return void handleAdspowerGet(res);
  if (req.method === 'POST' && pathname === '/api/adspower/add') return void handleAdspowerAdd(req, res);
  if (req.method === 'POST' && pathname === '/api/adspower/update') return void handleAdspowerUpdate(req, res);
  if (req.method === 'POST' && pathname === '/api/adspower/remove') return void handleAdspowerRemove(req, res);
  if (req.method === 'POST' && pathname === '/api/adspower/clear') return void handleAdspowerClear(res);
  if (req.method === 'GET' && pathname === '/api/adspower/ping') return void handleAdspowerPing(res);
  if (req.method === 'POST' && pathname === '/api/adspower/launch-selftest') return void handleAdspowerLaunchSelftest(res);
  if (req.method === 'GET' && pathname === '/api/adspower/endpoints') return void handleEndpointsGet(res);
  if (req.method === 'POST' && pathname === '/api/adspower/endpoints/add') return void handleEndpointsAdd(req, res);
  if (req.method === 'POST' && pathname === '/api/adspower/endpoints/update') return void handleEndpointsUpdate(req, res);
  if (req.method === 'POST' && pathname === '/api/adspower/endpoints/remove') return void handleEndpointsRemove(req, res);
  if (req.method === 'POST' && pathname === '/api/adspower/endpoints/clear') return void handleEndpointsClear(res);
  if (req.method === 'POST' && pathname === '/api/adspower/endpoints/test') return void handleEndpointsTest(req, res);
  if (req.method === 'GET' && pathname === '/api/diagnose') return void handleApiDiagnose(res, url.searchParams);
  if (req.method === 'POST' && pathname === '/api/dispatch') return void handleDispatch(req, res);
  if (req.method === 'GET' && pathname === '/api/dispatch/recent') return void handleDispatchRecent(res);
  if (req.method === 'GET' && pathname === '/api/captcha/keys') return void handleCaptchaList(res);
  if (req.method === 'POST' && pathname === '/api/captcha/keys/add') return void handleCaptchaAdd(req, res);
  if (req.method === 'POST' && pathname === '/api/captcha/keys/update') return void handleCaptchaUpdate(req, res);
  if (req.method === 'POST' && pathname === '/api/captcha/keys/remove') return void handleCaptchaRemove(req, res);
  if (req.method === 'POST' && pathname === '/api/captcha/keys/clear') return void handleCaptchaClear(res);
  if (req.method === 'POST' && pathname === '/api/captcha/keys/import') return void handleCaptchaImport(req, res);
  if (req.method === 'POST' && pathname === '/api/captcha/keys/balance') return void handleCaptchaBalance(req, res);
  if (req.method === 'GET' && pathname === '/api/mailbox/keys') return void handleMailboxList(res);
  if (req.method === 'POST' && pathname === '/api/mailbox/keys/add') return void handleMailboxAdd(req, res);
  if (req.method === 'POST' && pathname === '/api/mailbox/keys/update') return void handleMailboxUpdate(req, res);
  if (req.method === 'POST' && pathname === '/api/mailbox/keys/remove') return void handleMailboxRemove(req, res);
  if (req.method === 'POST' && pathname === '/api/mailbox/keys/clear') return void handleMailboxClear(res);
  if (req.method === 'POST' && pathname === '/api/mailbox/keys/import') return void handleMailboxImport(req, res);
  if (req.method === 'GET' && pathname === '/api/health') return void handleApiHealth(res);
  if (req.method === 'POST' && pathname === '/api/restart') return void handleServerRestart(req, res);
  if (req.method === 'GET' && pathname === '/api/setup/status') return void handleSetupStatus(res);
  if (req.method === 'POST' && pathname === '/api/setup/complete') return void handleSetupComplete(req, res);
  if (req.method === 'POST' && pathname === '/api/system/kill-orphans') return void handleKillOrphans(req, res);
  if (req.method === 'GET') return void serveStatic(req, res, pathname);

  res.writeHead(405); res.end('Method Not Allowed');
});

const onListening = () => {
  // eslint-disable-next-line no-console
  console.log(`[Openrouter Web] 控制台已启动: http://${HOST}:${PORT}  (本机: http://localhost:${PORT})`);
  // 回收上次进程崩溃/重启遗留的僵尸「运行中」(子进程随 server 一起死,不可能还在跑)。
  try { const _reaped = runsStore.reapStale(); if (_reaped) console.log(`🧹 已回收 ${_reaped} 条中断的僵尸运行(标记为 interrupted) —— 重提交同批账号即断点续跑`); } catch (_e) { /* ignore */ }
  // ★回收上次崩溃遗留的【充值在飞预留】(进程崩了 reserveCharge 没 commit/release → 卡额度被永久占住)。10min 阈值只清真陈旧的。
  try { Promise.resolve(cardPool.reapStaleInflight(600000)).then((r) => { if (r && r.reaped) console.log(`🧹 已回收 ${r.reaped} 笔陈旧的充值在飞预留(卡额度释放)`); }).catch(() => {}); } catch (_e) { /* ignore */ }
  if (ALLOW_IPS.length) console.log(`🔒 IP 白名单(+本机): ${ALLOW_IPS.join(', ')}${TRUST_PROXY ? ' [信任 X-Forwarded-For]' : ''}`);
  if (ALLOW_HOSTS.length) console.log(`🔒 域名白名单(+localhost): ${ALLOW_HOSTS.join(', ')}`);

  // 子机自动注册:配了中心机地址就启动时 + 每 30s 心跳上报,中心机自动聚合本机。
  const CENTRAL_URL = getCentralUrl();
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
    let _pushing = false;   // 防重叠:单次 push 若超过 30s 周期,下一个 beat 不再叠起并发 POST(否则越堆越多)
    const pushResults = async () => {
      if (_pushing) return;
      _pushing = true;
      try {
        const records = [];
        for (const f of listResultJsonl()) { const jobId = f.replace('-success.jsonl', ''); for (const r of readJobRecords(jobId)) records.push({ nodeId: NODE_ID, jobId, ...r }); }
        if (!records.length) return;
        await fetch(base + '/api/push', { method: 'POST', headers: authHdr, body: JSON.stringify({ nodeId: NODE_ID, accounts: records }), signal: AbortSignal.timeout(20000) });
      } catch (_e) { /* 忽略,下次重试 */ }
      finally { _pushing = false; }
    };
    const beat = () => { register(); pushResults(); };
    beat();
    const _hb = setInterval(beat, 30000); if (_hb.unref) _hb.unref();   // unref:与本模块其它后台定时器(PEERS 驱逐等)一致,不阻止进程优雅退出
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
};
// 一键重启平滑交接:新实例启动时旧实例可能还没释放端口 → EADDRINUSE 自动重试绑定(最多 ~12s)再接管;
// 也修了"第二个实例直接崩"的旧行为。其它监听错误才退出。
let _bindTries = 0;
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && _bindTries < 40) {   // 最多 ~20s 重试,覆盖旧实例 SSE 长连释放端口的窗口
    _bindTries += 1;
    if (_bindTries === 1) console.log(`[Openrouter Web] 端口 ${PORT} 被占用(旧实例退出中?)→ 重试绑定…`);
    if (_bindTries === 40) console.error(`[Openrouter Web] ⚠ 端口 ${PORT} 重试 20s 仍被占用,最后一次尝试…`);
    setTimeout(() => server.listen(PORT, HOST, onListening), 500);
  } else {
    console.error('[Openrouter Web] 监听失败:', (e && e.message) || e);
    process.exit(1);
  }
});
server.listen(PORT, HOST, onListening);

module.exports = { server, parseAccounts, parseProxies };
