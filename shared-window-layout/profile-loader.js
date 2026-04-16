'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-window-layout
//
// 文件定位：shared-window-layout/profile-loader.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 读取布局 JSON 配置 / 排版策略 Profile (I/O 层)。
// ❌ 不负责 —— 计算和决定具体的屏幕排列（交由 planner.js）。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

/**
 * 读取布局配置文件 JSON。
 *
 * @param {string} profilePath
 * @returns {object|null}
 */
function readLayoutProfile(profilePath) {
  try {
    if (!profilePath || !fs.existsSync(profilePath)) return null;
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 转换合并成绝对路径。
 *
 * @param {string} [profilePath='']
 * @returns {string}
 */
function resolveLayoutProfilePath(profilePath = '') {
  return profilePath ? path.resolve(profilePath) : '';
}

module.exports = {
  readLayoutProfile,
  resolveLayoutProfilePath,
};
