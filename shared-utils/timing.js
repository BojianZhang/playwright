'use strict';

/**
 * shared-utils/timing.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 等待步列表构造等纯数学/时间辅助计算。
 * ❌ 不负责 —— 任何实际等待操作（不调用 page.waitForTimeout / setTimeout）。
 * ❌ 不负责 —— 理解业务语义（不知道"primary wait"对应哪个阶段）。
 * ❌ 不负责 —— 入参来源的业务配置解析（调用方自行从 runtime 中读取毫秒值）。
 *
 * 使用场景：
 * - 替代各 adapter 中重复出现的 `[...new Set([0, primaryMs, secondaryMs].filter(...))]` 模式
 */

/**
 * 构造去重、升序排列的等待步毫秒列表。
 *
 * 边界：
 * - 接受任意数量的 ms 数值（含 0 和非数字），自动去重并升序排列。
 * - 非数字输入会被 Number() 转换（NaN 归 0）。
 * - 负数会被夹取为 0（等待步不允许出现负值）。
 * - 返回 number[]，供调用方逐步执行 page.waitForTimeout(ms)。
 * - 不做节流、不做 setTimeout，只返回计划列表。
 *
 * @param {...number} stepMsList - 一个或多个等待步毫秒值
 * @returns {number[]} 去重且升序排列的等待步列表
 *
 * @example
 * buildStepWaitList(0, 300, 900)     // [0, 300, 900]
 * buildStepWaitList(0, 300, 0, 900)  // [0, 300, 900]  ← 自动去重
 * buildStepWaitList(0, -100, 500)    // [0, 500]        ← 负数归 0
 * buildStepWaitList(0, 'bad', 400)   // [0, 400]        ← 非数字归 0
 */
function buildStepWaitList(...stepMsList) {
  // 将所有入参归一化为非负整数，去重后升序排列。
  return [
    ...new Set(
      stepMsList.map(ms => Math.max(0, Number(ms) || 0))
    ),
  ].sort((a, b) => a - b);
}

module.exports = {
  buildStepWaitList,
};
