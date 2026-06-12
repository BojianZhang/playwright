'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 工具 — 批量把账号(email:password)写进 AdsPower 环境的「账号平台」
//
// 文件定位：Openrouter/adspowerPlus/adspower-fill-accounts.js
//
// 用途：读 accounts.txt(每行 email:password) → 写进环境的 username/password
//       (对应系统变量 user_name / password)。默认只写「账号为空」的环境，按顺序配对。
//       保留每个环境原有代理(user_proxy_config)，不动它。
//
// 用法：
//   node adspower-fill-accounts.js                 # dry-run：只打印「账号 ↔ 环境」映射，不写
//   node adspower-fill-accounts.js --apply         # 真写入
//   node adspower-fill-accounts.js --file xxx.txt  # 指定账号文件(默认 accounts.txt)
//   node adspower-fill-accounts.js --ids a,b,c      # 只写这些 user_id(否则自动挑「username为空」的环境)
//   node adspower-fill-accounts.js --group 名字     # 只写某分组的环境
//   node adspower-fill-accounts.js --overwrite      # 允许覆盖已有账号的环境(默认只写空的)
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const API = process.env.OPENROUTER_ADSPOWER_API || 'http://local.adspower.net:50325';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? (process.argv[i + 1] || true) : def; }
const APPLY = process.argv.includes('--apply');
const OVERWRITE = process.argv.includes('--overwrite');
const FILE = arg('--file', path.join(__dirname, 'accounts.txt'));
const IDS = arg('--ids', '');
const GROUP = arg('--group', '');

async function apiGet(p, t = 30000) {
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), t);
  try { const r = await fetch(`${API}${p}`, { signal: c.signal }); return await r.json(); } finally { clearTimeout(timer); }
}
async function apiPost(p, body, t = 30000) {
  const c = new AbortController(); const timer = setTimeout(() => c.abort(), t);
  try { const r = await fetch(`${API}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: c.signal }); return await r.json(); } finally { clearTimeout(timer); }
}

function parseAccounts(file) {
  const out = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line.startsWith('#') || line.startsWith('=') || line.startsWith('Order') || line.startsWith('Shop') || line.startsWith('Package') || line.startsWith('Quantity') || line.startsWith('Has ') || line.startsWith('Total') || line.startsWith('Date')) continue;
    const m = line.match(/^([^\s:]+@[^\s:]+):(.+)$/);
    if (m) out.push({ email: m[1].trim(), password: m[2].trim() });
  }
  return out;
}

async function listEnvs() {
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const j = await apiGet(`/api/v1/user/list?page=${page}&page_size=100`).catch(() => ({}));
    const list = (j && j.data && j.data.list) || [];
    if (!list.length) break;
    for (const e of list) out.push(e);
    if (list.length < 100) break;
  }
  return out;
}

(async () => {
  // 0) API 在线？
  const st = await apiGet('/status', 5000).catch(() => ({}));
  if (!st || st.code !== 0) { console.log('❌ AdsPower 本地 API 不在线，先打开 AdsPower 客户端'); process.exit(1); }

  // 1) 账号
  const accounts = parseAccounts(FILE);
  if (!accounts.length) { console.log(`❌ ${FILE} 里没解析到 email:password`); process.exit(1); }
  console.log(`账号文件 ${path.basename(FILE)}：解析到 ${accounts.length} 个账号`);

  // 2) 目标环境
  const all = await listEnvs();
  let targets;
  if (IDS) {
    const set = new Set(String(IDS).split(',').map((s) => s.trim()).filter(Boolean));
    targets = all.filter((e) => set.has(e.user_id) || set.has(String(e.serial_number)));
  } else if (GROUP) {
    targets = all.filter((e) => (e.group_name || '') === GROUP);
  } else {
    targets = all.filter((e) => !String(e.username || '').trim()); // 默认：账号为空的环境
  }
  if (!OVERWRITE && !IDS) targets = targets.filter((e) => !String(e.username || '').trim());
  console.log(`候选环境：${targets.length} 个${IDS ? '(指定)' : GROUP ? `(分组 ${GROUP})` : '(账号为空)'}`);

  // 3) 配对（按顺序）
  const n = Math.min(accounts.length, targets.length);
  if (!n) { console.log('没有可配对的环境/账号（环境都已配账号？用 --overwrite 或 --ids 指定）'); process.exit(0); }
  console.log(`\n=== 计划映射（前 ${n} 对）===`);
  const pairs = [];
  for (let i = 0; i < n; i += 1) {
    const acc = accounts[i]; const env = targets[i];
    pairs.push({ acc, env });
    console.log(`  ${acc.email}  →  环境 ${env.user_id} (序号 ${env.serial_number})  代理 ${(env.user_proxy_config || {}).proxy_host || '?'}`);
  }
  if (accounts.length > targets.length) console.log(`⚠ 账号比环境多 ${accounts.length - targets.length} 个，多出的没写`);

  if (!APPLY) {
    console.log('\n（这是 dry-run，没有真写入。确认映射没问题后，加 --apply 再跑一次。）');
    process.exit(0);
  }

  // 4) 真写入（保留原代理）
  console.log('\n=== 开始写入 ===');
  let ok = 0; let fail = 0;
  for (const { acc, env } of pairs) {
    const body = { user_id: env.user_id, username: acc.email, password: acc.password };
    if (env.user_proxy_config && env.user_proxy_config.proxy_type) body.user_proxy_config = env.user_proxy_config; // 保留代理
    const r = await apiPost('/api/v1/user/update', body).catch((e) => ({ code: -1, msg: e.message }));
    if (r && r.code === 0) { ok += 1; console.log(`  ✓ ${acc.email} → ${env.user_id}`); }
    else { fail += 1; console.log(`  ✗ ${acc.email} → ${env.user_id} : ${r && r.msg}`); }
    await sleep(400); // 轻微节流
  }
  console.log(`\n完成：成功 ${ok} · 失败 ${fail}`);
  console.log('现在这些环境的「账号平台」已有账号，RPA 里注入系统变量 user_name/password 即可。');
  process.exit(0);
})().catch((e) => { console.error('出错:', e.message); process.exit(1); });
