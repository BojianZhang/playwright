'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Web 层 — Openrouter / web / event-bus
//
// 文件定位：Openrouter/0.0.1/web/event-bus.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 提供进程内的发布/订阅通道，解耦「自动化执行层」与「SSE 推送层」。
// ❌ 不负责 —— 任何 http / Playwright 逻辑。job-runner 只 publish，server 只 subscribe。
//
// 设计：每个 jobId 是一个 EventEmitter 事件名；事件载荷为 { type, data, ts }。
// ═══════════════════════════════════════════════════════════════════════

const { EventEmitter } = require('events');

const emitter = new EventEmitter();
// 一个 job 可能有多个 SSE 订阅者；放宽上限避免 MaxListeners 警告。
emitter.setMaxListeners(0);

// 每个 job 一个有界事件缓冲:供 SSE 重放——client 连上前(任务刚起的启动事件)或断线重连(Last-Event-ID)
// 期间 publish 的事件不丢。每条带单调 seq;超额按"最旧丢弃",job-done 后延迟清理,并对总 job 数设上限防泄漏。
const BUFFER = new Map();           // jobId -> { seq, events:[{seq,type,data,ts}], lastAt }
const MAX_EVENTS = 2000;            // 每 job 最多留多少条
const MAX_JOBS = 64;                // 最多同时缓冲多少 job(超出淘汰最旧)
const DROP_AFTER_DONE_MS = 120000;  // job-done 后保留多久再清(给重连 client 重放终态)
function _bufFor(jobId) {
  let b = BUFFER.get(jobId);
  if (!b) {
    if (BUFFER.size >= MAX_JOBS) {
      let oldest = null; let oldestAt = Infinity;
      for (const [k, v] of BUFFER) if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldest = k; }
      if (oldest) BUFFER.delete(oldest);
    }
    b = { seq: 0, events: [], lastAt: Date.now() };
    BUFFER.set(jobId, b);
  }
  return b;
}

/**
 * 发布一条 job 事件。
 * @param {string} jobId
 * @param {string} type   事件类型：account-success | account-failed | failure-stats | worker-update | job-done | log
 * @param {*} data        事件载荷
 */
function publish(jobId, type, data) {
  if (!jobId) return;
  // 诊断镜像：把关键事件打到服务端 stdout（→ _server.log），便于排查 worker 卡在哪一步。
  try {
    if (type === 'log') console.log(`[${jobId}] ${data}`);
    else if (type === 'account-failed') console.log(`[${jobId}] ✗FAIL ${data && data.email} | ${data && data.reason} | ${data && (data.detail || '').toString().slice(0, 120)}`);
    else if (type === 'account-success') console.log(`[${jobId}] ✓OK ${data && (data.email || (data.raw && data.raw.email) || '')}`);
    else if (type === 'worker-update' && data && data.worker) console.log(`[${jobId}] W${data.worker.workerId} → ${data.worker.stage || data.worker.status || ''}`);
    else if (type === 'job-done') console.log(`[${jobId}] DONE ${JSON.stringify(data)}`);
  } catch (_e) { /* ignore */ }
  // 同步 emit 会把任一订阅者(SSE 写)抛出的异常冒泡回发布方(job-runner/engine-runner 的 readline/timer 回调),
  // 那里没有 try 包裹 → 未捕获异常会打挂整个 server 进程。这里兜底,确保一个订阅者出错不影响发布与其它订阅者。
  // 进有界缓冲(供 SSE 重放),分配单调 seq;超额丢最旧,job-done 后延迟清理。
  const b = _bufFor(jobId);
  const evt = { seq: ++b.seq, type, data, ts: Date.now() };
  b.lastAt = evt.ts;
  b.events.push(evt);
  if (b.events.length > MAX_EVENTS) b.events.splice(0, b.events.length - MAX_EVENTS);
  if (type === 'job-done') { const t = setTimeout(() => BUFFER.delete(jobId), DROP_AFTER_DONE_MS); if (t.unref) t.unref(); }
  try { emitter.emit(jobId, evt); } catch (_e) { /* 单个订阅者抛错不致命 */ }
}

/**
 * 取某 job 缓冲中 seq > afterSeq 的事件(afterSeq=0/缺省 → 全部)。供 SSE 连接时重放漏掉的事件。
 */
function getBuffered(jobId, afterSeq) {
  const b = BUFFER.get(jobId);
  if (!b) return [];
  const after = Number(afterSeq) || 0;
  return after > 0 ? b.events.filter((e) => e.seq > after) : b.events.slice();
}

/**
 * 订阅某个 job 的所有事件。
 * @param {string} jobId
 * @param {(evt: {type:string, data:*, ts:number}) => void} listener
 * @returns {() => void} 退订函数
 */
function subscribe(jobId, listener) {
  // 包一层 try/catch:任一订阅者(如某条已断开的 SSE 写)抛错都被就地吞掉,
  // 既不冒泡回发布方(否则未捕获→打挂进程),也不会让 EventEmitter.emit 在抛错处中断、漏发给后续订阅者。
  const safe = (evt) => { try { listener(evt); } catch (_e) { /* 单订阅者出错不影响发布与其它订阅者 */ } };
  emitter.on(jobId, safe);
  return () => emitter.off(jobId, safe);
}

module.exports = { publish, subscribe, getBuffered };
