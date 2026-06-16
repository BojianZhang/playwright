'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-batch-orchestration
//
// 文件定位：shared-batch-orchestration/task-queue.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 对批量任务的队列状态在内存中进行管理，包含（出队、完成、异常捕获）。
// ✅ 负责 —— 统计任务大盘概要数据（pending, running, done, failed）。
// ❌ 不负责 —— I/O 和实际任务的具体执行。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 为并发调度器创建简单内存队列结构。
 *
 * @param {any[]} [items=[]] 外部投递的任务列表结构
 * @returns {object} queue interface
 */
function createTaskQueue(items = []) {
  const queue = Array.isArray(items)
    ? items.map((item, index) => ({
        id: item?.id || `task-${index + 1}`,
        status: 'pending',
        attempts: 0,
        payload: item,
        result: null,
      }))
    : [];

  return {
    items: queue,

    /** 取出下一条未执行的任务 */
    next() {
      const found = queue.find(item => item.status === 'pending');
      if (!found) return null;
      found.status = 'running';
      found.attempts += 1;
      return found;
    },

    /** 将任务标记为成功完成 */
    complete(taskId, result = null) {
      const found = queue.find(item => item.id === taskId);
      if (!found) return null;
      found.status = 'done';
      found.result = result;
      return found;
    },

    /** 将任务标记为执行失败 */
    fail(taskId, result = null) {
      const found = queue.find(item => item.id === taskId);
      if (!found) return null;
      found.status = 'failed';
      found.result = result;
      return found;
    },

    /** 导出队列实时状况，便于调试和日志投递 */
    snapshot() {
      return queue.map(item => ({ ...item }));
    },

    /** 提供队列简短总结摘要，配合大盘监控模块 */
    summary() {
      const summary = { total: queue.length, pending: 0, running: 0, done: 0, failed: 0 };
      for (const item of queue) {
        if (item.status === 'pending') summary.pending += 1;
        else if (item.status === 'running') summary.running += 1;
        else if (item.status === 'done') summary.done += 1;
        else if (item.status === 'failed') summary.failed += 1;
      }
      return summary;
    },
  };
}

module.exports = {
  createTaskQueue,
};
