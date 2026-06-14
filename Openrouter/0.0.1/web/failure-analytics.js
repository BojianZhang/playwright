'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 失败分析聚合(只读)— Openrouter / web / failure-analytics
//
// 把 Python 结果 jsonl(results.jsonl / hybrid_results.jsonl)+ 错误日志 + 充值台账 + 运行历史,
// 聚合成:漏斗(注册→取Key→加卡→绑成) / 环节失败排名 / 智能分类+优化建议 / IP战绩 / 卡战绩 /
//         错误分布(byStage·byReason) / 按天趋势。供「失败分析」页只读展示。
//
// 零依赖 CommonJS。范式同 usage-store:读文件、容错(缺失/空 → 空结构不抛)、每次现算。
// 复用 engine-runner 的 RESULTS(jsonl 路径)/ readTail(读全部)/ isSuccessRow(成功判定)。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { RESULTS, readTail, isSuccessRow } = require('./engine-runner');
let runsStore = null; try { runsStore = require('./runs-store'); } catch (_e) { /* 趋势缺省为空 */ }

const DATA = path.join(__dirname, '..', 'data');
function _readJsonArr(f) { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(o) ? o : []; } catch (_e) { return []; } }

// 解析后的 jsonl 行按【文件 mtime+size】memo 缓存:results.jsonl/hybrid_results.jsonl 是 append-only 大文件,
// 分析页 15s 轮询每次都 readTail(file,0) 全量读+逐行 JSON.parse(随文件涨成 O(file) 的重活,正是"分析页加载慢")。
// 解析结果是文件字节的纯函数 → mtime+size 没变就直接复用(append 必改 size,故 size 比低精度 mtime 更可靠)。
// 注:只缓存"解析行",时间窗 cutoff 过滤仍每次现算 → sinceDays>0 的时间窗结果照样新鲜、不被缓存冻住。
const _rowsCache = new Map(); // file -> { mtimeMs, size, rows }
function _readRowsCached(file) {
  try {
    const st = fs.statSync(file);
    const c = _rowsCache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.rows;
    const rows = readTail(file, 0);
    _rowsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows });
    return rows;
  } catch (_e) {
    return readTail(file, 0); // 文件缺失/stat 失败 → 退回直接读(readTail 自身容错返回 [])
  }
}

// 行时间 → epoch ms:jsonl 是本地 "YYYY-MM-DD HH:MM:SS",error-log/billing 是 ISO;解析失败回 0(不被时间窗过滤掉)。
function _ts(at) { if (!at) return 0; const t = Date.parse(String(at).replace(' ', 'T')); return Number.isFinite(t) ? t : 0; }
function _dayKey(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }  // YYYY-MM-DD(含年,跨年不合并)
function _hist(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value); }
function _shortErr(e) {
  e = String(e || '');
  if (/AdsPower|Check Proxy|启动失败|代理/.test(e)) return 'AdsPower启动/代理失败';
  if (/session|window|reachable|connect|disconnect|10053|10054/i.test(e)) return '浏览器会话崩/不可达';
  return e.slice(0, 48) || '(空)';
}

// ── 失败归因:把一条失败结果行归到单一环节(stage)+ 细节(detail) ──
function classifyBlame(r) {
  const s = r.steps || {};
  if (r.error) return { stage: 'A.基建', detail: _shortErr(r.error) };
  if (r.not_allowed) return { stage: 'B.号被拒', detail: 'not_allowed' };
  if (typeof s.auth === 'string' && s.auth !== 'ok') return { stage: 'C.注册/登录', detail: 'auth:' + s.auth };
  if (s.pw === false) return { stage: 'C.注册/登录', detail: 'pw:' + (s.pw_reason || 'fail') };
  if (s.giveup) return { stage: 'E.加卡放弃', detail: 'giveup:' + s.giveup };
  if (s.card && s.card !== 'card-bound') return { stage: 'D.加卡', detail: 'card:' + s.card };
  return { stage: 'Z.其它', detail: JSON.stringify(s).slice(0, 40) };
}

// ── 智能分类层:6+ 类,带"是否外部不可控" + 一句优化建议 ──
const CATEGORIES = {
  radar:    { name: '外部·Stripe Radar 审核', external: true,  advice: 'server-error=Save 卡在 Saving 未放行(约一半抽签),502=后端拒绑。换更干净的住宅 IP、降并发、拉长冷却;代码层面无解。' },
  cardenv:  { name: '外部·卡/环境(declined/AVS)', external: true,  advice: 'declined 多是 ZIP/AVS/IP 环境因素而非卡坏。换卡源、确认 ZIP 重试在跑、查卡质量。' },
  hcaptcha: { name: '外部·hCaptcha', external: true,  advice: '多为隐形企业框,2Captcha 硬解常无效。用「只点框 → 过不去换卡/切IP」(swap),别烧 2Captcha。' },
  infra:    { name: '基建(代理/AdsPower/浏览器)', external: false, advice: '代理不可达、AdsPower 不稳、浏览器会话崩。测代理连通、查 AdsPower、适当降并发。' },
  auth:     { name: '注册/登录(部分可改代码)', external: false, advice: 'REGISTER_UNCONFIRMED=重注册已存在号(查"已注册直登"覆盖);API_KEY_MODAL/SIGNIN=取Key/登录时序。' },
  detect:   { name: '加卡检测盲点(可改代码)', external: false, advice: 'card=unknown=找不到加卡入口或判不出结果,疑页面没渲染完或判定太严。值得查代码捞回。' },
  banned:   { name: '号被拒(不可控)', external: true,  advice: 'OpenRouter 永久拒该号(已自动登记跳过)。属号源质量。' },
  other:    { name: '其它/未明', external: false, advice: '步骤信号不完整,需个案看运行日志。' },
};
function categoryOf(blame) {
  const d = (blame.detail || '').toLowerCase();
  if (blame.stage === 'A.基建') return 'infra';
  if (blame.stage === 'B.号被拒') return 'banned';
  if (blame.stage === 'C.注册/登录') return 'auth';
  if (blame.stage === 'D.加卡' || blame.stage === 'E.加卡放弃') {
    if (d.includes('unknown') || d.includes('fill-fail')) return 'detect';
    if (d.includes('declined')) return 'cardenv';
    if (d.includes('hcaptcha')) return 'hcaptcha';
    if (d.includes('server-error') || d.includes('card-deadline') || d.includes('502') || d.includes('no-good-proxy')) return 'radar';
    return 'radar';
  }
  return 'other';
}

function filesFor(engine) {
  if (engine === 'selenium') return [['selenium', RESULTS.selenium]];
  if (engine === 'hybrid') return [['hybrid', RESULTS.hybrid]];
  if (engine === 'split') return [['selenium', RESULTS.selenium], ['hybrid', RESULTS.hybrid]];
  if (engine === 'playwright') return [];
  return [['selenium', RESULTS.selenium], ['hybrid', RESULTS.hybrid]]; // all
}

function _engineReport(label, file, cutoff) {
  const all = _readRowsCached(file).filter((r) => !cutoff || _ts(r.at) >= cutoff || _ts(r.at) === 0);
  const total = all.length;
  const ok = all.filter(isSuccessRow).length;
  const reachedKey = all.filter((r) => r.api_key && String(r.api_key).length > 10).length;
  const reachedCard = all.filter((r) => r.steps && r.steps.card).length;
  const bound = all.filter((r) => r.steps && r.steps.card === 'card-bound').length;
  const cardStates = _hist(all.map((r) => (r.steps && r.steps.card) || '(未到加卡)'));
  return {
    engine: label, total, ok, fail: total - ok, okRate: total ? Math.round(1000 * ok / total) / 10 : 0,
    funnel: {
      key: reachedKey, card: reachedCard, bound,
      keyPct: total ? Math.round(100 * reachedKey / total) : 0,
      cardPct: total ? Math.round(100 * reachedCard / total) : 0,
      boundPct: total ? Math.round(100 * bound / total) : 0,
      diedAtCard: reachedCard - bound,
    },
    cardStates,
    _rows: all, // 内部用,顶层会删
  };
}

// 顶层:engine ∈ all|playwright|selenium|hybrid|split;sinceDays>0 限时间窗。
function analyze(opts) {
  opts = opts || {};
  const engine = ['all', 'playwright', 'selenium', 'hybrid', 'split'].includes(opts.engine) ? opts.engine : 'all';
  const sinceDays = Math.max(0, Number(opts.sinceDays) || 0);
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400000 : 0;

  const engines = filesFor(engine).map(([lab, f]) => _engineReport(lab, f, cutoff));
  const rows = engines.flatMap((e) => e._rows);
  const fails = rows.filter((r) => !isSuccessRow(r));

  // 失败归因 + 分类
  const blamed = fails.map((r) => { const b = classifyBlame(r); return { ...b, cat: categoryOf(b) }; });
  const blameByStage = _hist(blamed.map((b) => b.stage));
  const blameDetail = _hist(blamed.map((b) => b.stage + ' · ' + b.detail)).slice(0, 18);
  const catCounts = {};
  for (const b of blamed) catCounts[b.cat] = (catCounts[b.cat] || 0) + 1;
  const totalFail = fails.length || 1;
  const byCategory = Object.entries(catCounts).map(([key, count]) => ({
    key, name: CATEGORIES[key].name, external: CATEGORIES[key].external, advice: CATEGORIES[key].advice,
    count, pct: Math.round(1000 * count / totalFail) / 10,
  })).sort((a, b) => b.count - a.count);
  const externalN = byCategory.filter((c) => c.external).reduce((s, c) => s + c.count, 0);
  const fixableN = fails.length - externalN;

  // 资源战绩(只看进了加卡阶段的行)
  const carded = rows.filter((r) => r.steps && r.steps.card);
  const proxM = new Map();
  for (const r of carded) {
    const h = String(r.proxy || '').split(':')[0] || '?';
    const m = proxM.get(h) || { host: h, attempts: 0, bound: 0, serverError: 0, declined: 0 };
    m.attempts++; const c = r.steps.card;
    if (c === 'card-bound') m.bound++; else if (c === 'server-error') m.serverError++; else if (c === 'declined') m.declined++;
    proxM.set(h, m);
  }
  const byProxy = [...proxM.values()].map((m) => ({ ...m, boundPct: m.attempts ? Math.round(100 * m.bound / m.attempts) : 0 }))
    .sort((a, b) => b.attempts - a.attempts).slice(0, 40);
  const cardM = new Map();
  for (const r of carded) {
    const k = r.card_last4 || '?';
    const m = cardM.get(k) || { last4: k, attempts: 0, bound: 0, declined: 0 };
    m.attempts++; const c = r.steps.card;
    if (c === 'card-bound') m.bound++; else if (c === 'declined') m.declined++;
    cardM.set(k, m);
  }
  const byCard = [...cardM.values()].map((m) => ({ ...m, boundPct: m.attempts ? Math.round(100 * m.bound / m.attempts) : 0 }))
    .sort((a, b) => b.attempts - a.attempts).slice(0, 40);

  // Playwright 内置引擎:错误日志 + 充值台账(Python 引擎不写这两个,故仅在 all/playwright 展示)
  let errorLog = { total: 0, byStage: [], byReason: [] };
  let billing = { total: 0, byResult: [] };
  if (engine === 'all' || engine === 'playwright') {
    const el = _readJsonArr(path.join(DATA, 'error-log.json')).filter((e) => !cutoff || _ts(e.at) >= cutoff);
    errorLog = { total: el.length, byStage: _hist(el.map((e) => e.stage || '(无)')), byReason: _hist(el.map((e) => e.reason || '(无)')).slice(0, 15) };
    const bl = _readJsonArr(path.join(DATA, 'billing-ledger.json')).filter((e) => !cutoff || _ts(e.at) >= cutoff);
    billing = { total: bl.length, byResult: _hist(bl.map((e) => e.result || '(无)')) };
  }

  // 趋势:运行历史按天 runs/success/failed
  let trend = [];
  try {
    const runs = (runsStore ? runsStore.list(500) : []).filter((r) => (engine === 'all' || r.engine === engine) && r.startedAt && (!cutoff || r.startedAt >= cutoff));
    const dayM = new Map();
    for (const r of runs) {
      const k = _dayKey(r.startedAt);   // 跳过无 startedAt 的(上面 r.startedAt 已过滤),不落 epoch-0 桶
      const d = dayM.get(k) || { key: k, day: k.slice(5), runs: 0, success: 0, failed: 0 };
      d.runs++; d.success += r.success || 0; d.failed += r.failed || 0;
      dayM.set(k, d);
    }
    // 按日期正序(老→新)排好再取最近 30 天;Map 的插入序是 runs 的"最新在前",直接 slice(-30) 会取到最旧 30 且时间轴反向。
    trend = [...dayM.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(-30).map(({ key, ...rest }) => rest);
  } catch (_e) { /* 趋势缺省空 */ }

  const total = rows.length;
  const ok = rows.filter(isSuccessRow).length;
  return {
    generatedAt: Date.now(), engine, sinceDays,
    combined: { total, ok, fail: total - ok, okRate: total ? Math.round(1000 * ok / total) / 10 : 0 },
    engines: engines.map((e) => { const { _rows, ...rest } = e; return rest; }),
    blameByStage, blameDetail, byCategory,
    summary: { totalFail: fails.length, externalN, fixableN, externalPct: fails.length ? Math.round(100 * externalN / fails.length) : 0, fixablePct: fails.length ? Math.round(100 * fixableN / fails.length) : 0 },
    byProxy, byCard, errorLog, billing, trend,
  };
}

module.exports = { analyze, classifyBlame, categoryOf, CATEGORIES };
