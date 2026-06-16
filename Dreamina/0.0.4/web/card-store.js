'use strict';

// ═══════════════════════════════════════════════════════════════════════
// web 卡池 store —— billing/card-pool 的薄封装（供 Cards 页 / REST 用）
//
// 文件定位：Dreamina/0.0.4/web/card-store.js
//
// 只做「文本导入 → 解析 → upsert」与只读快照/统计/启停，不复制卡池逻辑——
// 单一来源仍是 billing/card-pool.js（含跨进程文件锁、状态机、充值容量账本）。
// ═══════════════════════════════════════════════════════════════════════

const cardPool = require('../billing/card-pool');

// 从「每行一卡」文本导入（号|有效期|CVC|可选次数/邮编），返回 {added, errors}。
async function importFromText(text, defaultMaxUses) {
  const parsed = cardPool.parseCardLines(text, defaultMaxUses);
  const ok = parsed.filter((c) => !c._parseError);
  const errors = parsed.filter((c) => c._parseError).map((c) => ({ raw: c.raw, error: c._parseError }));
  const res = ok.length ? await cardPool.upsertMany(ok) : { upserted: 0 };
  return { added: (res && (res.upserted || res.added)) || ok.length, parsed: parsed.length, errors };
}

async function snapshot() { return await cardPool.snapshot(); }
async function stats() { return await cardPool.stats(); }
async function availableCount() { return await cardPool.availableCount(); }
async function disable(id) { return await cardPool.disable(id); }
async function enable(id) { return await cardPool.enable(id); }
async function setMaxUses(id, n) { return await cardPool.setMaxUses(id, n); }
async function remove(id) { return await cardPool.remove(id); }

module.exports = { importFromText, snapshot, stats, availableCount, disable, enable, setMaxUses, remove };
