'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-batch-orchestration
//
// 文件定位：shared-batch-orchestration/index.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 统一对外导出本模块所有公共 API。
// ❌ 不负责 —— 任何实现逻辑（各模块分别在对应文件中实现）。
//
// 导出内容：
// - runBatchOrchestration  — 并发调度主循环（核心入口）
// - createWorkerState      — 创建 Worker 状态对象
// - transitionWorkerState  — Worker 状态机转换
// - createTaskQueue        — 创建内存任务队列
// - createMutex            — Promise 链式串行互斥锁（通用）
// - createProxyLockSet     — 代理独占锁集合（防止同一代理被多 Worker 同时持有）
// ═══════════════════════════════════════════════════════════════════════

const { runBatchOrchestration } = require('./batch-orchestration');
const { createWorkerState, transitionWorkerState } = require('./worker-state');
const { createTaskQueue } = require('./task-queue');
const { createMutex, createProxyLockSet } = require('./mutex');

module.exports = {
  runBatchOrchestration,
  createWorkerState,
  transitionWorkerState,
  createTaskQueue,
  createMutex,
  createProxyLockSet,
};
