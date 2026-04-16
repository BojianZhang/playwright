'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-browser-runtime
//
// 文件定位：shared-browser-runtime/index.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 统一对外导出本模块所有公共 API。
// ❌ 不负责 —— 任何实现逻辑（各模块分别在对应文件中实现）。
//
// 导出内容：
// - createRandomFingerprint        — 生成随机浏览器指纹参数（UA / viewport / locale 等）
// - buildContextFingerprintOptions — 生成 Playwright newContext() 所需的完整 contextOptions
// - normalizeBlockedResourceTypes  — 归一化要拦截的资源类型列表
// - applyResourcePolicy            — 在 BrowserContext 上应用资源拦截路由
// - applyWindowLayoutToLaunchOptions — 将窗口布局坐标注入 Chromium 启动参数
// - buildLaunchOptions             — 将运行配置归一化为 chromium.launch() 参数
// - createBrowserRuntime           — 创建完整 browser + context + page 实例（主入口）
// ═══════════════════════════════════════════════════════════════════════

const { createRandomFingerprint, buildContextFingerprintOptions } = require('./fingerprint');
const { normalizeBlockedResourceTypes, applyResourcePolicy } = require('./resource-policy');
const { applyWindowLayoutToLaunchOptions } = require('./window-runtime');
const { buildLaunchOptions, createBrowserRuntime } = require('./create-browser-runtime');

module.exports = {
  createRandomFingerprint,
  buildContextFingerprintOptions,
  normalizeBlockedResourceTypes,
  applyResourcePolicy,
  applyWindowLayoutToLaunchOptions,
  buildLaunchOptions,
  createBrowserRuntime,
};
