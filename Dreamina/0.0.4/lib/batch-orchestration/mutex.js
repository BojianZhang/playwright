'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-batch-orchestration
//
// 文件定位：shared-batch-orchestration/mutex.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 提供内存级并发互斥原语（Promise 链式串行锁）。
// ✅ 负责 —— 提供代理独占池（同一代理同一时刻只允许一个 Worker 持有）。
// ❌ 不负责 —— 任何业务逻辑（不判断代理是否可用、不决定代理分配策略）。
// ❌ 不负责 —— 持久化（所有锁状态仅存在于内存，进程退出即清空）。
// ❌ 不负责 —— 分布式锁（仅适用于单进程内的并发场景）。
//
// 场景：
//   - createMutex()：确保某段代码同一时刻只有一个协程在执行（如写文件、调 API）
//   - createProxyLockSet()：确保同一条代理不被多个 Worker 同时占用
//
// 调用方：Dreamina/0.0.3/Dreamina-batch-runner.js
// ═══════════════════════════════════════════════════════════════════════

/**
 * 创建一个 Promise 链式串行互斥锁。
 *
 * 特性：
 * - 同一时刻只允许一个任务持有锁并执行。
 * - 后续任务按调用顺序排队，前一个完成后自动触发下一个。
 * - 如果持有锁的任务抛出异常，不影响后续任务继续执行。
 *
 * 典型用法：
 * ```js
 * const mutex = createMutex();
 * // 并发安全地写文件
 * await mutex(() => fs.promises.appendFile(logPath, line + '\n'));
 * ```
 *
 * @returns {(task: () => Promise<any>) => Promise<any>} 互斥执行器
 */
function createMutex() {
  // current 始终指向最新一个任务的 Promise
  // 每次调用都把新任务接在 current 之后，形成串行链
  let current = Promise.resolve();

  return async function mutex(task) {
    // run = current 完成后再执行 task
    const run = current.then(() => task());
    // current 更新为 run（忽略错误，避免整个链断掉）
    current = run.catch(() => {});
    return run;
  };
}

/**
 * 创建代理独占锁集合。
 *
 * 特性：
 * - 用 Set 跟踪当前"已被占用"的代理 key。
 * - tryAcquire 返回 false 时表示该代理已被其他 Worker 占用，调用方应跳过。
 * - release 必须在 Worker 完成任务后调用（无论成功/失败），避免代理被永久锁住。
 *
 * 典型用法：
 * ```js
 * const lockSet = createProxyLockSet();
 * const proxy = pickProxy();
 * if (!lockSet.tryAcquire(proxy.proxyKey)) continue;  // 已被占用，跳过
 * try {
 *   await runTask(proxy);
 * } finally {
 *   lockSet.release(proxy.proxyKey);  // 务必释放
 * }
 * ```
 *
 * @returns {{ tryAcquire, release, isLocked, lockedCount }}
 */
function createProxyLockSet() {
  /** @type {Set<string>} 当前被占用的代理 key 集合 */
  const locked = new Set();

  return {
    /**
     * 尝试独占某个代理。
     *
     * @param {string} proxyKey - 代理唯一标识（通常为 host:port:user 或自定义 key）
     * @returns {boolean} true = 独占成功；false = 已被占用
     */
    tryAcquire(proxyKey) {
      const key = String(proxyKey || '');
      if (!key) return false;
      if (locked.has(key)) return false;
      locked.add(key);
      return true;
    },

    /**
     * 释放某个代理的独占锁。
     * 如果该代理不在锁集合中（已被热剔除或未曾锁定），静默忽略。
     *
     * @param {string} proxyKey
     */
    release(proxyKey) {
      locked.delete(String(proxyKey || ''));
    },

    /**
     * 查询某个代理是否正在被占用。
     *
     * @param {string} proxyKey
     * @returns {boolean}
     */
    isLocked(proxyKey) {
      return locked.has(String(proxyKey || ''));
    },

    /**
     * 当前被占用的代理数量（用于监控/日志）。
     *
     * @returns {number}
     */
    get lockedCount() {
      return locked.size;
    },
  };
}

module.exports = {
  createMutex,
  createProxyLockSet,
};
