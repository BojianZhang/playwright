'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Openrouter / 结果聚合脚本（分布式整合）
//
// 文件定位：Openrouter/0.0.1/aggregate-results.js
//
// 用途：
//   - 本机:扫描本地 batch-results/*-success.jsonl,汇总成功账号。
//   - 多机:逐台请求 http://host:port/api/results/all,拉取并合并去重。
//   - 输出:batch-results/<out>-<时间戳>.json 与 .txt（email:apiKey）。
//
// 用法示例：
//   # 只看/导出本机成功账号
//   node Openrouter/0.0.1/aggregate-results.js --local
//   # 聚合多台机器（逗号分隔）
//   node Openrouter/0.0.1/aggregate-results.js --hosts http://10.0.0.11:4317,http://10.0.0.12:4317
//   # 同时含本机 + 远程,自定义去重与输出名
//   node Openrouter/0.0.1/aggregate-results.js --local --hosts http://10.0.0.11:4317 --dedupe email --out merged
//   # 从配置文件读主机列表(aggregate.config.json: { "hosts": ["http://..."], "dedupe":"email" })
//   node Openrouter/0.0.1/aggregate-results.js --config Openrouter/0.0.1/aggregate.config.json
//
// 鉴权：若各节点开了 Basic Auth,设环境变量 OPENROUTER_WEB_USER / OPENROUTER_WEB_PASS,
//       或在 host URL 里写 http://user:pass@host:port。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'batch-results');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
function hasFlag(name) { return process.argv.includes(name); }

function loadConfig() {
  const p = arg('--config', '');
  if (!p) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error(`读取 config 失败: ${e.message}`); return {}; }
}

function authHeaderFor(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.username) return 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64');
  } catch (_e) { /* ignore */ }
  if (process.env.OPENROUTER_WEB_USER) {
    return 'Basic ' + Buffer.from(`${process.env.OPENROUTER_WEB_USER}:${process.env.OPENROUTER_WEB_PASS || ''}`).toString('base64');
  }
  return null;
}

// 读本机成功目录
function fromLocal() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('-success.jsonl')); } catch (_e) { /* none */ }
  for (const f of files) {
    const jobId = f.replace('-success.jsonl', '');
    try {
      fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8').split('\n').filter(Boolean).forEach((line) => {
        try { out.push({ nodeId: 'local', jobId, ...JSON.parse(line) }); } catch (_e) { /* skip */ }
      });
    } catch (_e) { /* skip file */ }
  }
  return out;
}

// 拉取远程节点
async function fromUrl(base) {
  const u = base.replace(/\/+$/, '') + '/api/results/all';
  const headers = {};
  const auth = authHeaderFor(base);
  if (auth) headers.Authorization = auth;
  const resp = await fetch(u, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json.accounts || [];
}

function dedupe(records, mode) {
  if (mode === 'none') return records;
  const seen = new Map();
  for (const r of records) {
    const key = mode === 'email+apiKey' ? `${r.email}|${r.apiKey}` : (r.email || JSON.stringify(r));
    // 同 key 时优先保留带 apiKey 的那条
    if (!seen.has(key) || (!seen.get(key).apiKey && r.apiKey)) seen.set(key, r);
  }
  return [...seen.values()];
}

(async () => {
  const cfg = loadConfig();
  const includeLocal = hasFlag('--local') || cfg.local || (!arg('--hosts', '') && !(cfg.hosts && cfg.hosts.length));
  const hosts = (arg('--hosts', '') ? arg('--hosts', '').split(',') : (cfg.hosts || [])).map((s) => s.trim()).filter(Boolean);
  const dedupeMode = arg('--dedupe', cfg.dedupe || 'email');
  const outBase = arg('--out', cfg.out || 'aggregated');

  const all = [];
  if (includeLocal) { const l = fromLocal(); console.log(`[local] ${l.length} 条`); all.push(...l); }
  for (const h of hosts) {
    try { const a = await fromUrl(h); console.log(`[${h}] ${a.length} 条`); all.push(...a); }
    catch (e) { console.error(`[${h}] 拉取失败: ${e.message}`); }
  }

  const merged = dedupe(all, dedupeMode);
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonFile = path.join(RESULTS_DIR, `${outBase}-${ts}.json`);
  const txtFile = path.join(RESULTS_DIR, `${outBase}-${ts}.txt`);
  fs.writeFileSync(jsonFile, JSON.stringify(merged, null, 2));
  fs.writeFileSync(txtFile, merged.map((r) => `${r.email || ''}:${r.apiKey || ''}`).join('\n'));

  console.log(`\n合计 ${all.length} 条,去重(${dedupeMode})后 ${merged.length} 条`);
  console.log(`已输出:\n  ${jsonFile}\n  ${txtFile}`);
})().catch((e) => { console.error('聚合失败:', e); process.exit(1); });
