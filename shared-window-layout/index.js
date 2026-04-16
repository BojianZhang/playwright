'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-window-layout
//
// 文件定位：shared-window-layout/index.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 统一对外导出本模块所有公共 API。
// ❌ 不负责 —— 任何实现逻辑（各模块分别在对应文件中实现）。
//
// 导出内容：
// - readLayoutProfile           — 读取 window-layout-profile.json 文件（I/O 层）
// - resolveLayoutProfilePath    — 将相对路径转换为绝对路径
// - resolveLayoutPreset         — 按并发数从 profile.presets 中选取最匹配的布局档位
// - computeWorkerWindowLayout   — 计算单个 Worker 的窗口位置（x/y/width/height/viewport）
// - createWindowLayoutPlanner   — 创建 layout planner 实例（预加载 profile，暴露 resolve 方法）
// - resolvePolicyByConcurrency  — 通用按并发量分档策略选取（底层工具函数）
// - resolveVerificationBudget   — 解析验证码预算策略（轮询次数 / 间隔 / 重试）
// - resolveProxyPolicy          — 解析代理探活超时策略（各目标超时 / stagger 延迟）
// ═══════════════════════════════════════════════════════════════════════

const { readLayoutProfile, resolveLayoutProfilePath } = require('./profile-loader');
const { resolveLayoutPreset, computeWorkerWindowLayout, createWindowLayoutPlanner } = require('./planner');
const { resolvePolicyByConcurrency, resolveVerificationBudget, resolveProxyPolicy } = require('./policy');

module.exports = {
  readLayoutProfile,
  resolveLayoutProfilePath,
  resolveLayoutPreset,
  computeWorkerWindowLayout,
  createWindowLayoutPlanner,
  resolvePolicyByConcurrency,
  resolveVerificationBudget,
  resolveProxyPolicy,
};
