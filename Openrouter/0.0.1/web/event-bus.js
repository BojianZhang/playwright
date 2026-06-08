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

/**
 * 发布一条 job 事件。
 * @param {string} jobId
 * @param {string} type   事件类型：account-success | account-failed | failure-stats | worker-update | job-done | log
 * @param {*} data        事件载荷
 */
function publish(jobId, type, data) {
  if (!jobId) return;
  emitter.emit(jobId, { type, data, ts: Date.now() });
}

/**
 * 订阅某个 job 的所有事件。
 * @param {string} jobId
 * @param {(evt: {type:string, data:*, ts:number}) => void} listener
 * @returns {() => void} 退订函数
 */
function subscribe(jobId, listener) {
  emitter.on(jobId, listener);
  return () => emitter.off(jobId, listener);
}

module.exports = { publish, subscribe };
