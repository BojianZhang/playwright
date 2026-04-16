'use strict';

/**
 * shared-utils/worker-status-tracker.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 以进程内单例 Map 维护所有 Worker 的实时状态（status / account / stage / step / ...）。
 * ✅ 负责 —— 将 Worker 状态渲染为终端监控面板（buildWorkerOverviewPanel）。
 * ✅ 负责 —— 计时（stage 耗时 / total 耗时）的实时计算。
 * ❌ 不负责 —— 任何页面交互或阶段决策。
 * ❌ 不负责 —— 持久化（状态仅存在于当前 Node.js 进程，进程退出后消失）。
 * ❌ 不负责 —— 日志输出（不调用 console.log，只返回字符串列表供调用方打印）。
 * ❌ 不负责 —— 抛出异常（所有方法均做安全兜底处理）。
 *
 * 设计说明：
 * - 采用模块级单例 state（Map），确保同一进程内所有引用方共享同一状态。
 * - Worker ID 归一化为 Number，0 或 NaN 视为无效（调用方需保证 ID 有效）。
 *
 * 使用场景：
 * - Dreamina-batch-runner.js 周期性调用 buildWorkerOverviewPanel 渲染监控表格
 * - stage-runtime.js 的 syncStageStep 调用 updateWorkerStatus 写入阶段步骤
 * - Dreamina-register.js 在注册完成 / 失败后调用 markWorkerIdle 重置 Worker
 */

/**
 * 进程级单例状态对象。
 *
 * 边界：
 * - 仅在本模块内可见，所有外部访问均通过导出函数进行。
 * - workers Map 的 key 为数字型 workerId。
 * - startedAt 记录模块初始化时刻，用于全局批次耗时统计。
 */
const state = {
  workers: new Map(),
  startedAt: Date.now(),
};

/**
 * 返回当前时间戳（毫秒）。
 *
 * @returns {number}
 */
function nowMs() {
  return Date.now();
}

/**
 * 确保 workerId 对应的 Worker 记录存在，不存在时初始化默认值。
 *
 * 边界：
 * - workerId 会被 Number() 归一化，NaN / 0 视为 key=0。
 * - 初始 status 为 'idle'，所有字段均有默认值，不会出现 undefined。
 * - 返回的是 Map 内部的引用（可直接修改）。
 *
 * @param {number|string} workerId
 * @returns {object} Worker 状态记录
 */
function ensureWorker(workerId) {
  const key = Number(workerId || 0);
  if (!state.workers.has(key)) {
    // 首次访问时初始化全套字段，避免后续 Object.assign 出现 undefined。
    state.workers.set(key, {
      workerId: key,
      status: 'idle',
      account: '',
      stage: '',
      step: '',
      attempt: 0,
      startedAt: nowMs(),
      updatedAt: nowMs(),
      stageStartedAt: 0,
      stageDurationMs: 0,
      totalDurationMs: 0,
      proxy: '',
      lastReason: '',
      lastState: '',
    });
  }
  return state.workers.get(key);
}

/**
 * 更新指定 Worker 的状态，并实时计算 stageElapsed / totalElapsed。
 *
 * 边界：
 * - 当 stage 字段发生变化时，自动重置 stageStartedAt（阶段计时从 0 重新开始）。
 * - 返回 Worker 状态的浅拷贝（不暴露 Map 内部引用）。
 * - patch 中任意字段均可覆写，调用方负责传入正确值。
 *
 * @param {number|string} workerId
 * @param {object} [patch={}] - 需要覆写的字段
 * @returns {object} 更新后的 Worker 状态快照
 */
function updateWorkerStatus(workerId, patch = {}) {
  const worker = ensureWorker(workerId);
  const currentNow = nowMs();

  // 判断 stage 是否发生切换，切换时重置阶段计时起点。
  const nextStage = Object.prototype.hasOwnProperty.call(patch, 'stage')
    ? String(patch.stage || '').trim()
    : worker.stage;
  if (nextStage && nextStage !== worker.stage) {
    worker.stageStartedAt = currentNow;
    worker.stageDurationMs = 0;
  }

  // 将 patch 合并到 worker 记录，并强制刷新 updatedAt。
  Object.assign(worker, patch, { updatedAt: currentNow });
  // stage 字段单独赋值，确保 trim 后的值生效。
  worker.stage = nextStage;
  // 动态计算 totalDurationMs / stageDurationMs，确保每次读取时都是最新值。
  worker.totalDurationMs = worker.startedAt ? Math.max(0, currentNow - worker.startedAt) : 0;
  worker.stageDurationMs = worker.stageStartedAt ? Math.max(0, currentNow - worker.stageStartedAt) : 0;

  // 返回浅拷贝，避免调用方持有并意外修改内部引用。
  return { ...worker };
}

/**
 * 将指定 Worker 重置为空闲状态。
 *
 * 边界：
 * - 只清空 account / stage / step / proxy / attempt，保留 startedAt（总计时不重置）。
 * - 内部委托 updateWorkerStatus，不重复逻辑。
 *
 * @param {number|string} workerId
 * @returns {object} 重置后的 Worker 状态快照
 */
function markWorkerIdle(workerId) {
  return updateWorkerStatus(workerId, {
    status: 'idle',
    stage: '',
    step: '',
    account: '',
    attempt: 0,
    proxy: '',
  });
}

/**
 * 批量同步外部快照列表到本地 Worker 状态（用于跨进程状态同步场景）。
 *
 * 边界：
 * - 只合并 snapshot 中已有字段，不删除本地多余字段。
 * - 如果 snapshot 中的 stage 与当前不同，同样触发阶段计时重置。
 * - 同步完成后返回当前全量状态快照（同 snapshotWorkerStatuses）。
 *
 * @param {Array<object>} [snapshot=[]]
 * @returns {Array<object>}
 */
function syncWorkerSnapshot(snapshot = []) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  const currentNow = nowMs();
  for (const item of list) {
    const workerId = Number(item?.workerId || 0);
    if (!workerId) continue; // workerId 无效时跳过
    const worker = ensureWorker(workerId);
    const nextStage = String(item?.stage || '').trim();
    // 阶段切换时重置 stageStartedAt。
    if (nextStage && nextStage !== worker.stage) {
      worker.stageStartedAt = currentNow;
    }
    Object.assign(worker, {
      status: item?.status || worker.status,
      // account 支持对象（{ email }）和字符串两种格式。
      account: item?.account?.email || item?.account || '',
      stage: nextStage,
      step: String(item?.step || '').trim(),
      attempt: Number(item?.attempt || 0),
      // proxy 支持对象（{ raw }）和字符串两种格式。
      proxy: item?.proxy?.raw || item?.proxy || '',
      updatedAt: currentNow,
      totalDurationMs: Number(item?.totalElapsedMs || worker.totalDurationMs || 0),
      stageDurationMs: Number(item?.stageElapsedMs || worker.stageDurationMs || 0),
    });
  }
  return snapshotWorkerStatuses();
}

/**
 * 返回所有 Worker 当前状态快照，按 workerId 升序排列。
 *
 * 边界：
 * - 返回数组中每个元素均为浅拷贝（不暴露内部引用）。
 * - totalDurationMs / stageDurationMs 在返回时重新计算（精确到调用时刻）。
 *
 * @returns {Array<object>}
 */
function snapshotWorkerStatuses() {
  const currentNow = nowMs();
  return Array.from(state.workers.values())
    .sort((a, b) => a.workerId - b.workerId)
    .map(worker => ({
      ...worker,
      // 重新计算耗时，确保监控面板每次渲染都拿到最新数据。
      totalDurationMs: worker.startedAt ? Math.max(0, currentNow - worker.startedAt) : 0,
      stageDurationMs: worker.stageStartedAt ? Math.max(0, currentNow - worker.stageStartedAt) : 0,
    }));
}

/**
 * 将毫秒数格式化为人类可读字符串（< 1s 显示 ms，≥ 1s 显示 s）。
 *
 * 边界：
 * - 非有效数字时返回 '0ms'。
 * - ≥ 10000ms 时秒数保留 0 位小数；其余保留 1 位小数。
 *
 * @param {number} value
 * @returns {string}
 */
function formatDurationMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms)) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = (ms / 1000).toFixed(ms >= 10000 ? 0 : 1);
  return `${sec}s`;
}

/**
 * 右对齐填充字符串到指定宽度（不足则补空格）。
 *
 * 边界：只做字符串操作，不截断超长内容（超长时原样返回）。
 *
 * @param {any} value
 * @param {number} width
 * @returns {string}
 */
function padRight(value, width) {
  const text = String(value || '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * 将值限制在指定列宽内，超长时尾部显示省略号（…）。
 *
 * 边界：
 * - width <= 1 时直接截断到 width，不加省略号。
 * - 不足 width 时右对齐填充（委托 padRight）。
 *
 * @param {any} value
 * @param {number} width
 * @returns {string}
 */
function fitValue(value, width) {
  const text = String(value || '');
  if (text.length <= width) return padRight(text, width);
  if (width <= 1) return text.slice(0, width);
  // 超长时截断到 (width-1) 位并追加省略号。
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * 包裹 ANSI 颜色代码。
 *
 * @param {string} text
 * @param {string} code - 完整的 ANSI 转义码前缀（如 '\x1b[90m'）
 * @returns {string}
 */
function color(text, code) {
  return `${code}${text}\x1b[0m`;
}

/**
 * 根据 Worker 状态为文本着色（idle=灰 / success=绿 / fail=红 / running=青）。
 *
 * 边界：
 * - 只做颜色映射，不修改 text 内容。
 * - 未匹配的状态返回原始 text（不加颜色）。
 *
 * @param {string} status
 * @param {string} text
 * @returns {string}
 */
function colorStatus(status, text) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'idle') return color(text, '\x1b[90m');
  if (normalized.includes('success')) return color(text, '\x1b[32m');
  if (normalized.includes('fail') || normalized.includes('exception')) return color(text, '\x1b[31m');
  if (normalized.includes('running')) return color(text, '\x1b[36m');
  return text;
}

/**
 * 构造 Worker 状态行列表（简单格式，用于日志文件 / 非表格场景）。
 *
 * 边界：
 * - 返回字符串数组，每行对应一个 Worker。
 * - 不依赖终端宽度，字段以 " | " 分隔。
 *
 * @returns {string[]}
 */
function buildWorkerStatusLines() {
  const snapshot = snapshotWorkerStatuses();
  if (!snapshot.length) return ['[worker-status] no workers'];
  return snapshot.map(item => {
    return [
      `[worker=${item.workerId}]`,
      `status=${item.status || 'idle'}`,
      item.account ? `account=${item.account}` : '',
      item.stage ? `stage=${item.stage}` : '',
      item.step ? `step=${item.step}` : '',
      item.attempt ? `attempt=${item.attempt}` : '',
      item.proxy ? `proxy=${item.proxy}` : '',
      `stageElapsed=${formatDurationMs(item.stageDurationMs)}`,
      `totalElapsed=${formatDurationMs(item.totalDurationMs)}`,
      item.lastState ? `lastState=${item.lastState}` : '',
      item.lastReason ? `lastReason=${item.lastReason}` : '',
    ].filter(Boolean).join(' | ');
  });
}

/**
 * 构造完整的 Worker 监控面板字符串数组（表格格式，含颜色）。
 *
 * 边界：
 * - 返回字符串数组，调用方负责逐行打印。
 * - 列宽固定，不动态适配终端宽度（当前约 140 字符宽度）。
 * - 包含 WORKER_OVERVIEW 汇总行、表头、分隔线和各 Worker 数据行。
 *
 * @returns {string[]}
 */
function buildWorkerOverviewPanel() {
  const snapshot = snapshotWorkerStatuses();

  // 统计各状态 Worker 数量，用于顶部汇总行。
  const running = snapshot.filter(item => String(item.status || '').includes('running')).length;
  const idle = snapshot.filter(item => String(item.status || '') === 'idle').length;
  const success = snapshot.filter(item => String(item.status || '') === 'success').length;
  const failed = snapshot.filter(item => /fail|exception/.test(String(item.status || ''))).length;

  const header = color(`WORKER_OVERVIEW | total=${snapshot.length} | running=${running} | idle=${idle} | success=${success} | failed=${failed}`, '\x1b[1m\x1b[97m');
  const divider = color('-'.repeat(140), '\x1b[90m');
  const title = color([
    padRight('WK', 4),
    padRight('STATUS', 20),
    padRight('ACCOUNT', 28),
    padRight('STAGE', 28),
    padRight('STEP', 28),
    padRight('TRY', 6),
    padRight('STAGE_ELAPSED', 14),
    padRight('TOTAL', 10),
  ].join(' | '), '\x1b[1m');

  // 每行对应一个 Worker，超长字段省略尾部并显示 "…"。
  const lines = snapshot.map(item => {
    const workerText      = fitValue(`#${item.workerId}`, 4);
    const statusText      = colorStatus(item.status || 'idle', fitValue(item.status || 'idle', 20));
    const accountText     = fitValue(item.account || '-', 28);
    const stageText       = fitValue(item.stage || '-', 28);
    const stepText        = fitValue(item.step || '-', 28);
    const tryText         = fitValue(item.attempt ? String(item.attempt) : '0', 6);
    const stageElapsedText = fitValue(formatDurationMs(item.stageDurationMs), 14);
    const totalText       = fitValue(formatDurationMs(item.totalDurationMs), 10);
    const base = [workerText, statusText, accountText, stageText, stepText, tryText, stageElapsedText, totalText].join(' | ');
    // 有最近失败原因时，追加暗淡灰色的 reason 字段。
    if (item.lastReason) {
      return `${base} | ${color(`reason=${fitValue(item.lastReason, 40)}`, '\x1b[90m')}`;
    }
    return base;
  });

  return [header, divider, title, divider, ...lines, divider];
}

module.exports = {
  updateWorkerStatus,
  markWorkerIdle,
  syncWorkerSnapshot,
  snapshotWorkerStatuses,
  buildWorkerStatusLines,
  buildWorkerOverviewPanel,
  formatDurationMs,
  padRight,
  fitValue,
};
