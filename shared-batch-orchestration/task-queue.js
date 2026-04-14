'use strict';

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
    next() {
      const found = queue.find(item => item.status === 'pending');
      if (!found) return null;
      found.status = 'running';
      found.attempts += 1;
      return found;
    },
    complete(taskId, result = null) {
      const found = queue.find(item => item.id === taskId);
      if (!found) return null;
      found.status = 'done';
      found.result = result;
      return found;
    },
    fail(taskId, result = null) {
      const found = queue.find(item => item.id === taskId);
      if (!found) return null;
      found.status = 'failed';
      found.result = result;
      return found;
    },
    snapshot() {
      return queue.map(item => ({ ...item }));
    },
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
