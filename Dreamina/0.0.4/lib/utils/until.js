'use strict';

/**
 * shared-utils/until.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 有限时间内的循环轮询骨架（timeout / interval / staged-interval / probe / done / abort）。
 * ❌ 不负责 —— 任何业务语义（不知道 Dreamina / credential / verification）。
 * ❌ 不负责 —— 页面交互（不做点击、填写、reload、恢复动作）。
 * ❌ 不负责 —— 结果解释（isDone / abortWhen / onTick 由调用方注入，本函数只执行钩子）。
 * ❌ 不负责 —— 抛出业务异常（超时时返回 { ok:false, timeout:true }，不抛异常）。
 *
 * 使用场景：
 * - 所有 Stage 的 ready 检测轮询层（entry / credential / verification / profile-completion / ...）
 * - 需要"最多等 N 毫秒、每隔 M 毫秒探测一次"的通用场景
 */

/**
 * 有限轮询骨架。
 *
 * 在 timeoutMs 内循环执行 probe，直到 isDone 返回 true 或 abortWhen 触发中止。
 *
 * 边界：
 * - probe 必须是函数，否则立即抛出配置错误。
 * - isDone 必须是函数，否则立即抛出配置错误。
 * - abortWhen / onTick 可选，不传时跳过对应逻辑。
 * - intervals 优先于 intervalMs：传入 intervals 数组时，按轮次索引取对应等待时间。
 * - 超时时返回 { ok: false, timeout: true }，由调用方决定后续策略，本函数不抛异常。
 * - 结果结构固定为 { ok, aborted, timeout, round, elapsedMs, result }。
 *
 * @param {{
 *   timeoutMs?: number,           // 最长等待时间（毫秒），默认 0（立即超时）
 *   intervalMs?: number,          // 每轮固定等待时间（毫秒），默认 250
 *   intervals?: number[]|null,    // 按轮次分阶的等待时间列表（优先于 intervalMs）
 *   probe: (ctx: { round: number, elapsedMs: number }) => any,  // 每轮探测函数
 *   isDone: (result: any, ctx: { round: number, elapsedMs: number }) => boolean,  // 成功判断
 *   abortWhen?: (result: any, ctx: { round: number, elapsedMs: number }) => boolean,  // 中止判断
 *   onTick?: (result: any, ctx: { round: number, elapsedMs: number }) => void,  // 每轮回调
 * }} options
 * @returns {Promise<{ ok: boolean, aborted: boolean, timeout: boolean, round: number, elapsedMs: number, result: any }>}
 */
async function until(options = {}) {
  const {
    timeoutMs = 0,
    intervalMs = 250,
    intervals = null,
    probe,
    isDone,
    abortWhen,
    onTick,
  } = options;

  // probe 和 isDone 是必须项，缺失视为调用方配置错误。
  if (typeof probe !== 'function') {
    throw new Error('until requires probe');
  }
  if (typeof isDone !== 'function') {
    throw new Error('until requires isDone');
  }

  const startedAt = Date.now();
  let round = 0;
  let lastResult = null;

  // 主循环：在 timeoutMs 截止时间内持续轮询。
  while (Date.now() - startedAt <= Math.max(0, Number(timeoutMs || 0))) {
    round += 1;
    const elapsedMs = Math.max(0, Date.now() - startedAt);

    // 每轮执行探测函数，获取当前状态。
    const result = await probe({ round, elapsedMs });
    lastResult = result;

    // 如果调用方注册了 onTick，每轮探测后都回调一次（用于日志打印 / 状态同步）。
    if (typeof onTick === 'function') {
      await onTick(result, { round, elapsedMs });
    }

    // 如果调用方注册了 abortWhen 且触发，立即中止并标记 aborted=true。
    if (typeof abortWhen === 'function' && abortWhen(result, { round, elapsedMs })) {
      return {
        ok: false,
        aborted: true,
        timeout: false,
        round,
        elapsedMs,
        result,
      };
    }

    // 如果 isDone 判断本轮结果已满足完成条件，返回成功结构。
    if (isDone(result, { round, elapsedMs })) {
      return {
        ok: true,
        aborted: false,
        timeout: false,
        round,
        elapsedMs,
        result,
      };
    }

    // 选取本轮等待时间：有阶梯配置时按轮次索引取，否则用固定 intervalMs。
    const dynamicIntervals = Array.isArray(intervals) ? intervals : null;
    const waitMs = dynamicIntervals && Number.isFinite(Number(dynamicIntervals[round - 1]))
      ? Math.max(0, Number(dynamicIntervals[round - 1]))
      : Math.max(0, Number(intervalMs || 0));

    // waitMs 为 0 时跳过 setTimeout，直接进入下一轮（busy-poll 场景）。
    if (waitMs <= 0) {
      continue;
    }

    // 计算剩余可用时间，避免等待超出 timeout 截止。
    const remainingMs = Math.max(0, Number(timeoutMs || 0) - (Date.now() - startedAt));
    if (remainingMs <= 0) {
      break;
    }

    // 实际等待时间取 waitMs 与剩余时间的较小值，避免空转浪费。
    await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, remainingMs)));
  }

  // 超出 timeoutMs 仍未满足 isDone，返回超时结构。
  return {
    ok: false,
    aborted: false,
    timeout: true,
    round,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    result: lastResult,
  };
}

module.exports = {
  until,
};
