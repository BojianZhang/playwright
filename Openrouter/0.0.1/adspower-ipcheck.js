'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 工具 — AdsPower 环境出口IP干净度批量检测
//
// 文件定位：Openrouter/0.0.1/adspower-ipcheck.js
//
// 用途：逐个启动 AdsPower 环境 → CDP 接管 → 查出口IP的 proxy/hosting 标记 → 关闭，
//       输出 proxy=false && hosting=false 的「干净环境」列表，便于挑选用于加卡。
//
// 用法：
//   node adspower-ipcheck.js k1db9yk8 k1db9yk7 ...   # 检测指定环境(user_id 或 serial)
//   node adspower-ipcheck.js --all                   # 检测全部环境(慢，逐个启动)
//   node adspower-ipcheck.js --all --limit 30        # 只测前 30 个
//
// 注意：你的代理多为轮换住宅，出口IP每次连接可能不同，结果是「此刻快照」，非永久结论。
// ═══════════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const adspower = require('./openrouter-adspower');

const API = adspower.DEFAULT_API;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(pathQ, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const resp = await fetch(`${API}${pathQ}`, { signal: ctrl.signal }); return await resp.json(); }
  finally { clearTimeout(t); }
}

async function listAllEnvs() {
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const j = await apiGet(`/api/v1/user/list?page=${page}&page_size=100`).catch(() => ({}));
    const list = (j && j.data && j.data.list) || [];
    if (!list.length) break;
    for (const e of list) out.push(e.user_id);
    if (list.length < 100) break;
  }
  return out;
}

// 检测单个环境的出口IP。
async function checkEnv(id) {
  const started = await adspower.startEnv(id, { apiBase: API, headless: 1 });
  if (!started.ok) return { id, ok: false, error: started.error };
  let browser = null;
  try {
    for (let i = 0; i < 5 && !browser; i += 1) {
      try { browser = await chromium.connectOverCDP(started.ws, { timeout: 30000 }); }
      catch (e) { await sleep(1500); }
    }
    if (!browser) return { id, ok: false, error: 'CDP_CONNECT_FAILED' };
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    const fields = 'status,country,countryCode,regionName,city,zip,timezone,isp,proxy,hosting,query';
    await page.goto(`http://ip-api.com/json/?fields=${fields}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const geo = JSON.parse(body);
    return { id, ok: true, geo };
  } catch (e) {
    return { id, ok: false, error: String((e && e.message) || e).slice(0, 80) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await adspower.stopEnv(id, { apiBase: API }).catch(() => {});
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const limIdx = argv.indexOf('--limit');
  const limit = limIdx >= 0 ? Number(argv[limIdx + 1]) : 0;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') { i += 1; continue; }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }

  if (!(await adspower.isApiUp(API))) {
    console.log('AdsPower 本地 API 不在线，请先打开 AdsPower 客户端');
    process.exit(1);
  }

  let targets = positional;
  if (all || !targets.length) {
    console.log('拉取全部环境列表…');
    targets = await listAllEnvs();
    if (limit > 0) targets = targets.slice(0, limit);
    console.log(`共 ${targets.length} 个环境待检测（逐个启动，较慢）`);
  }

  const clean = [];
  const dirty = [];
  const failed = [];
  for (let i = 0; i < targets.length; i += 1) {
    const id = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${id} ... `);
    const r = await checkEnv(id);
    if (!r.ok) { console.log(`FAIL ${r.error}`); failed.push({ id, error: r.error }); continue; }
    const g = r.geo;
    const isClean = g.status === 'success' && !g.proxy && !g.hosting;
    console.log(`${isClean ? 'CLEAN' : 'DIRTY'}  ${g.query}  ${g.country}/${g.regionName}  proxy=${g.proxy} hosting=${g.hosting}  ${g.isp}`);
    (isClean ? clean : dirty).push({ id, ...g });
  }

  console.log('\n══════════ 结果 ══════════');
  console.log(`干净环境(proxy=false hosting=false) ${clean.length} 个：`);
  clean.forEach((c) => console.log(`   ${c.id}  ${c.query}  ${c.country}/${c.regionName}  tz=${c.timezone}`));
  console.log(`脏环境 ${dirty.length} 个 | 失败 ${failed.length} 个`);
  console.log('\n可直接复制以下干净环境ID到控制台「AdsPower 环境ID」框：');
  console.log(clean.map((c) => c.id).join('\n'));
  process.exit(0);
})().catch((e) => { console.error('检测出错:', e.message); process.exit(1); });
