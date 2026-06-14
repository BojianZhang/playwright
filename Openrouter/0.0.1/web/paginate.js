'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 通用分页助手(服务端)— Openrouter / web / paginate
//
// 文件定位:Openrouter/0.0.1/web/paginate.js
//
// 列表接口(/api/results/all、/api/aggregate、/api/accounts)在大集群下会涨到数万行,一次性回吐整张表
// → payload 几十 MB + 浏览器全量渲染卡死。本助手给这些接口加 offset/limit 分页能力。
//
// ★向后兼容铁律:不带 limit 参数(或 limit<=0)时【返回全量】,与改造前逐字节一致 —— 现有前端、节点间
//   /api/results/all 互拉、txt 导出都不受影响;前端按需带 ?limit=&offset= 才分页。total 永远是分页前的全量数,
//   汇总/计数据此显示「共 N」。零依赖、CommonJS。
// ═══════════════════════════════════════════════════════════════════════

function _int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// 从 query 取 limit/offset。query 可为 URLSearchParams(GET)或普通对象(POST body)。
// limit 缺省/<=0 → 0(不分页);limit 上限 MAX(防一次拉太多);offset 缺省 0。
function readPageParams(query, MAX = 2000) {
  const get = (k) => (query && typeof query.get === 'function') ? query.get(k) : (query ? query[k] : null);
  let limit = _int(get('limit'), 0);
  if (limit > MAX) limit = MAX;
  const offset = _int(get('offset'), 0);
  return { limit, offset };
}

// 对数组做 offset/limit 分页。limit=0 → 返回全量(向后兼容)。
// 返回 { rows, total, offset, limit, returned, nextOffset, truncated }:
//   total=分页前全量长度;returned=本页条数;nextOffset=下一页起点(无更多则 null);truncated=本响应非全量。
function offsetPage(arr, query, MAX = 2000) {
  const total = arr.length;
  const { limit, offset } = readPageParams(query, MAX);
  if (!limit) {
    return { rows: arr, total, offset: 0, limit: 0, returned: total, nextOffset: null, truncated: false };
  }
  const start = Math.min(offset, total);
  const rows = arr.slice(start, start + limit);
  const nextOffset = (start + rows.length < total) ? (start + rows.length) : null;
  return { rows, total, offset: start, limit, returned: rows.length, nextOffset, truncated: nextOffset !== null || start > 0 };
}

module.exports = { offsetPage, readPageParams };
