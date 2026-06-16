'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-batch-orchestration
//
// 文件定位：shared-batch-orchestration/batch-orchestration.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 提供高并发任务的执行骨架（while(true) queue.next() 模型）。
// ✅ 负责 —— 驱动多个独立的 Worker 并行执行，并汇报各 Worker 执行大盘状态。
// ❌ 不负责 —— 账号注册/验证码重试等业务流程（通过传参 runTask 控制回调执行）。
// ═══════════════════════════════════════════════════════════════════════

const {
  createWorkerState,
  markWorkerRunning,
  markWorkerIdle,
  markWorkerDone,
  updateWorkerState,
  summarizeWorkerStates,
} = require('./worker-state');
const { createTaskQueue } = require('./task-queue');

/**
 * 驱动并发任务的执行。
 *
 * 参数说明 (options)：
 * - tasks          {Array}    — 所有需要执行的任务队列
 * - concurrency    {number}   — 并行执行 Worker 的最大数量
 * - runTask        {Function} — 每个 Worker 领到任务后实际的业务回调函数
 * - onWorkerUpdate {Function} — (可选) 用于 UI 刷新/日志透出的状态通知钩子
 *
 * @param {object} [options={}]
 * @returns {Promise<object>} StageResult 标准结果结构
 */
async function runBatchOrchestration(options = {}) {
  const {
    tasks = [],
    concurrency = 1,
    runTask,
    onWorkerUpdate = null,
  } = options;

  if (typeof runTask !== 'function') {
    return {
      success: false,
      stage: 'batch-orchestration',
      state: 'BATCH_ORCHESTRATOR_RUNNER_MISSING',
      reason: 'BATCH_ORCHESTRATOR_RUNNER_MISSING',
      detail: null,
    };
  }

  const queue = createTaskQueue(tasks);
  const workerCount = Math.max(1, Number(concurrency) || 1);
  const workers = Array.from({ length: workerCount }, (_, index) => createWorkerState(index + 1));
  const results = [];

  const emit = async (workerState) => {
    if (typeof onWorkerUpdate === 'function') {
      await onWorkerUpdate(workerState, {
        workers: workers.map(item => ({ ...item })),
        workerSummary: summarizeWorkerStates(workers),
        queueSummary: queue.summary(),
      });
    }
  };

  /**
   * 单一 Worker 消费并执行循环体
   *
   * @param {number} workerIndex
   */
  async function consume(workerIndex) {
    while (true) {
      const task = queue.next();
      if (!task) break;

      const workerId = workerIndex + 1;
      const startedAtMs = Date.now();
      workers[workerIndex] = markWorkerRunning(workers[workerIndex], {
        account: task?.payload?.account || null,
        proxy: task?.payload?.proxy || null,
        attempt: task?.attempts || 1,
        detail: { taskId: task.id },
      });
      await emit(workers[workerIndex]);

      try {
        const result = await runTask({
          workerId,
          task,
          payload: task.payload,
        });
        queue.complete(task.id, result);
        results.push({ taskId: task.id, success: true, result });
        workers[workerIndex] = markWorkerDone(workers[workerIndex], {
          totalElapsedMs: Date.now() - startedAtMs,
          detail: { taskId: task.id, result },
        });
        await emit(workers[workerIndex]);
      } catch (error) {
        const failedResult = {
          success: false,
          reason: error?.message || 'UNKNOWN',
        };
        queue.fail(task.id, failedResult);
        results.push({ taskId: task.id, success: false, result: failedResult });
        workers[workerIndex] = updateWorkerState(workers[workerIndex], {
          status: 'failed',
          totalElapsedMs: Date.now() - startedAtMs,
          detail: { taskId: task.id, error: failedResult },
        });
        await emit(workers[workerIndex]);
      }

      workers[workerIndex] = markWorkerIdle(workers[workerIndex]);
      await emit(workers[workerIndex]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, index) => consume(index)));

  const queueSummary = queue.summary();
  const workerSummary = summarizeWorkerStates(workers);
  return {
    success: true,
    stage: 'batch-orchestration',
    state: 'BATCH_ORCHESTRATION_COMPLETE',
    reason: 'BATCH_ORCHESTRATION_COMPLETE',
    nextStage: '',
    signalStrength: 'strong',
    settleStage: 'finalize',
    detectionSource: 'shared-batch-orchestration',
    stateChanged: true,
    retryCount: 0,
    detail: {
      queueSummary,
      workerSummary,
      workers: workers.map(item => ({ ...item })),
      results,
    },
  };
}

module.exports = {
  runBatchOrchestration,
};
