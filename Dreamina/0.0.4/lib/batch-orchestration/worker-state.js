'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-batch-orchestration
//
// 文件定位：shared-batch-orchestration/worker-state.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 维护单个工作线程 (Worker) 当前正在处理的任务状态结构体。
// ✅ 负责 —— 提供工信状态转换的纯函数（启动/空闲/完成）。
// ❌ 不负责 —— 具体任务的挂载（通过 patch object 处理外部业务）。
// ❌ 不负责 —— 并发控制逻辑调用。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 创建干净的 worker 初始状态。
 *
 * @param {number|string} workerId 序列化编号
 * @param {object} [extra={}]
 * @returns {object} worker state
 */
function createWorkerState(workerId, extra = {}) {
  return {
    workerId: Number(workerId) || 0,
    status: 'idle',
    stage: '',
    step: '',
    attempt: 0,
    account: null,
    proxy: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    totalElapsedMs: 0,
    stageElapsedMs: 0,
    detail: null,
    ...extra,
  };
}

/**
 * 深度复制当前 worker 状态数据。
 *
 * @param {object} [state={}]
 * @returns {object} cloned state
 */
function cloneWorkerState(state = {}) {
  return {
    ...state,
    account: state?.account || null,
    proxy: state?.proxy || null,
    detail: state?.detail || null,
  };
}

/**
 * 合并新状态字段。
 *
 * @param {object} [state={}]
 * @param {object} [patch={}]
 * @returns {object} updated new state
 */
function updateWorkerState(state = {}, patch = {}) {
  const next = cloneWorkerState(state);
  Object.assign(next, patch || {});
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * 标记为运行状态。
 *
 * @param {object} [state={}]
 * @param {object} [patch={}]
 * @returns {object}
 */
function markWorkerRunning(state = {}, patch = {}) {
  const startedAt = patch?.startedAt || state?.startedAt || new Date().toISOString();
  return updateWorkerState(state, {
    status: 'running',
    startedAt,
    ...patch,
  });
}

/**
 * 标记为空闲状态，清空残留上下文。
 *
 * @param {object} [state={}]
 * @param {object} [patch={}]
 * @returns {object}
 */
function markWorkerIdle(state = {}, patch = {}) {
  return updateWorkerState(state, {
    status: 'idle',
    stage: '',
    step: '',
    account: null,
    proxy: null,
    stageElapsedMs: 0,
    detail: null,
    ...patch,
  });
}

/**
 * 标记为完成状态（可能是任务成功完成）。
 *
 * @param {object} [state={}]
 * @param {object} [patch={}]
 * @returns {object}
 */
function markWorkerDone(state = {}, patch = {}) {
  return updateWorkerState(state, {
    status: 'done',
    ...patch,
  });
}

/**
 * 对全局多个 worker 的运行情况做总览统计。
 *
 * @param {object[]} [states=[]]
 * @returns {{total: number, idle: number, running: number, done: number, failed: number}}
 */
function summarizeWorkerStates(states = []) {
  const list = Array.isArray(states) ? states : [];
  const summary = {
    total: list.length,
    idle: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const item of list) {
    const status = String(item?.status || '').trim().toLowerCase();
    if (status === 'running') summary.running += 1;
    else if (status === 'done') summary.done += 1;
    else if (status === 'failed') summary.failed += 1;
    else summary.idle += 1;
  }
  return summary;
}

module.exports = {
  createWorkerState,
  cloneWorkerState,
  updateWorkerState,
  markWorkerRunning,
  markWorkerIdle,
  markWorkerDone,
  summarizeWorkerStates,
};
