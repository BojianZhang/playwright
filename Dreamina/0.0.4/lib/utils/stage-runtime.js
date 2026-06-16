'use strict';

/**
 * shared-utils/stage-runtime.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 将当前 Stage 执行步骤的状态同步写入 Worker 状态追踪器（worker-status-tracker）。
 * ❌ 不负责 —— 任何页面交互（不做点击、填写、reload）。
 * ❌ 不负责 —— 日志输出（只写状态，不打印日志行）。
 * ❌ 不负责 —— 阶段决策（不判断成功/失败，不决定 next stage）。
 * ❌ 不负责 —— 持有 Worker 状态存储（由 worker-status-tracker 单例持有）。
 *
 * 使用场景：
 * - 所有 Stage 文件在每个关键步骤处调用 syncStageStep()，
 *   驱动 Dreamina-batch-runner 的 Worker 监控面板实时刷新
 *   （即你看到的 WK | STATUS | ACCOUNT | STAGE | STEP | TRY 那张表格）
 */

// 引入 Worker 状态追踪器，stage-runtime 通过它写入 Worker 实时状态。
const { updateWorkerStatus } = require('./worker-status-tracker'); // shared-utils/worker-status-tracker.js

/**
 * 同步当前 Stage 的执行步骤状态到 Worker 追踪器。
 *
 * 边界：
 * - 如果 workerId 无法从 options 或 runtime 中获取，直接返回，不做任何写入。
 * - 只做状态写入，不做任何 await / 异步操作（是同步函数）。
 * - patch 中的字段会覆写 Worker 追踪器中对应的字段。
 * - 不抛异常（worker-status-tracker 内部出错时影响隔离）。
 *
 * 典型用法（Stage 文件内）：
 * ```js
 * syncStageStep(options, { stage: 'credential-submit', step: 'fill-email' });
 * ```
 *
 * @param {object} [options={}] - Stage 调用规范 options（含 context / account / proxy / runtime）
 * @param {{
 *   status?: string,    // Worker 状态标签（默认 'running-register-stage'）
 *   stage?: string,     // 当前阶段 key（如 'credential-submit'）
 *   step?: string,      // 当前步骤 key（如 'fill-email'）
 *   lastState?: string, // 最近一次 state（用于监控面板的 reason 列）
 *   lastReason?: string // 最近一次 reason
 * }} [patch={}]
 */
function syncStageStep(options = {}, patch = {}) {
  // 从 options.context 或 options.runtime 中取 workerId，取不到时直接返回。
  const context = options?.context || {};
  const workerId = context?.workerId ?? options?.runtime?.workerId ?? null;
  if (!workerId) return;

  // 将当前步骤的完整状态写入 Worker 追踪器，触发监控面板刷新。
  updateWorkerStatus(workerId, {
    status: patch.status || 'running-register-stage',
    // 账号邮箱优先从 options.account 取，降级到 context.account。
    account: options?.account?.email || context?.account?.email || '',
    stage: patch.stage || '',
    step: patch.step || '',
    // attempt 优先从 context 取，降级到 runtime。
    attempt: context?.attempt ?? options?.runtime?.attempt ?? 0,
    // proxy 依次从 options.proxy / context.proxy / context 的摘要中取。
    proxy: options?.proxy?.server || context?.proxy?.server || context?.proxySummary?.server || '',
    lastState: patch.lastState || '',
    lastReason: patch.lastReason || '',
  });
}

module.exports = {
  syncStageStep,
};
