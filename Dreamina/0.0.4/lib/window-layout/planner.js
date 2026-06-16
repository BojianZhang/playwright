'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-window-layout
//
// 文件定位：shared-window-layout/planner.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 核心调度逻辑计算窗口位置排布算法（Grid/Focus模式），并提供最佳实践 Preset 缩放比。
// ❌ 不负责 —— 文件 IO 读取 Profile，配置解析等功能 (由 profile-loader 负责)。
// ❌ 不负责 —— 和系统或 Playwright Launcher 的实际交互工作。
// ═══════════════════════════════════════════════════════════════════════

const { readLayoutProfile, resolveLayoutProfilePath } = require('./profile-loader');

/**
 * 为特定的并发场景挑选最匹配的 Preset 布局档位。
 * 
 * @param {object} [presets={}]
 * @param {number} [concurrency=1]
 * @returns {object|null}
 */
function pickPreset(presets = {}, concurrency = 1) {
  const target = Math.max(1, Number(concurrency) || 1);
  if (presets[String(target)]) return presets[String(target)];
  const numericKeys = Object.keys(presets)
    .map(key => Number(key))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!numericKeys.length) return null;
  let winner = numericKeys[0];
  let bestDistance = Math.abs(target - winner);
  for (const value of numericKeys) {
    const distance = Math.abs(target - value);
    if (distance < bestDistance || (distance === bestDistance && value > winner)) {
      winner = value;
      bestDistance = distance;
    }
  }
  return presets[String(winner)] || null;
}

/**
 * 计算后备或回退 Preset 布局属性。
 *
 * @param {number} concurrency
 * @param {object} [defaults={}]
 * @returns {object} fallback preset
 */
function buildFallbackPreset(concurrency, defaults = {}) {
  const target = Math.max(1, Number(concurrency) || 1);
  const maxAutoColumns = Math.max(1, Number(defaults.maxAutoColumns || 5));
  const cols = Math.min(maxAutoColumns, Math.ceil(Math.sqrt(target)));
  const rows = Math.ceil(target / cols);
  const scale = target <= 4 ? 1 : target <= 8 ? 0.85 : target <= 12 ? 0.75 : 0.62;
  const usageRatio = target <= 4 ? 0.9 : target <= 8 ? 0.95 : 0.98;
  return {
    cols,
    rows,
    scale,
    usageRatio,
    mode: target <= 4 ? 'focus' : target <= 8 ? 'grid' : target <= 15 ? 'compact' : 'monitor',
  };
}

/**
 * 提取并返回用于渲染分析的 Presets。
 *
 * @param {object} [options={}]
 * @returns {object}
 */
function resolveLayoutPreset({ concurrency = 1, profile = null } = {}) {
  const defaults = profile?.defaults || {};
  const presets = profile?.presets || {};
  return pickPreset(presets, concurrency) || buildFallbackPreset(concurrency, defaults);
}

/**
 * 根据外部环境计算当前特定 WorkerId 进程被分配渲染所需的 Layout 定位信息 (宽高, x/y偏移).
 *
 * 字段说明（输出）:
 * - x: 起始距屏基点横坐
 * - y: 起始距屏基点纵坐
 * - width / height: UI窗口缩放前的基准大小
 *
 * @param {object} [options={}]
 * @returns {object} layout instance with x,y coords
 */
function computeWorkerWindowLayout(options = {}) {
  const {
    workerId = 1,
    concurrency = 1,
    profile = null,
  } = options;

  const display = profile?.display || {};
  const defaults = profile?.defaults || {};
  const preset = resolveLayoutPreset({ concurrency, profile });

  const workspaceWidth = Math.max(800, Number(display.workspaceWidth || 2560));
  const workspaceHeight = Math.max(600, Number(display.workspaceHeight || 1440));
  const taskbarReservedPx = Math.max(0, Number(display.taskbarReservedPx || 40));
  const gap = Math.max(0, Number(preset?.gapOverride ?? display.gap ?? 8));
  const outerMargin = Math.max(0, Number(preset?.outerMarginOverride ?? display.outerMargin ?? 8));
  const baseUsableWidth = Math.max(200, workspaceWidth - outerMargin * 2);
  const baseUsableHeight = Math.max(200, workspaceHeight - taskbarReservedPx - outerMargin * 2);

  const cols = Math.max(1, Number(preset?.cols || 1));
  const rows = Math.max(1, Number(preset?.rows || 1));
  const scale = Number(preset?.scale || defaults.defaultScale || 1);
  const mode = String(preset?.mode || defaults.layoutMode || 'grid');
  const usageRatio = Math.max(0.6, Math.min(1, Number(preset?.usageRatio || defaults.defaultUsageRatio || 1)));

  const usableWidth = Math.floor(baseUsableWidth * usageRatio);
  const usableHeight = Math.floor(baseUsableHeight * usageRatio);
  const layoutOffsetX = outerMargin + Math.max(0, Math.floor((baseUsableWidth - usableWidth) / 2));
  const layoutOffsetY = outerMargin + Math.max(0, Math.floor((baseUsableHeight - usableHeight) / 2));

  const cellWidth = Math.floor((usableWidth - gap * (cols - 1)) / cols);
  const cellHeight = Math.floor((usableHeight - gap * (rows - 1)) / rows);
  const width = Math.max(Number(defaults.minWindowWidth || 420), cellWidth);
  const height = Math.max(Number(defaults.minWindowHeight || 320), cellHeight);

  const index = Math.max(0, Number(workerId || 1) - 1);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = layoutOffsetX + col * (cellWidth + gap);
  const y = layoutOffsetY + row * (cellHeight + gap);

  return {
    enabled: true,
    workerId: Number(workerId) || 0,
    concurrency: Math.max(1, Number(concurrency) || 1),
    mode,
    cols,
    rows,
    usageRatio,
    gap,
    outerMargin,
    x,
    y,
    width,
    height,
    cellWidth,
    cellHeight,
    scale,
    viewport: {
      width: Math.max(320, Math.floor(width / Math.max(0.55, scale))),
      height: Math.max(240, Math.floor(height / Math.max(0.55, scale))),
    },
  };
}

/**
 * 对外开放的 Layout 初始化暴露接口。
 *
 * @param {object} [options={}]
 * @returns {object} { profilePath, profile, resolve: func }
 */
function createWindowLayoutPlanner(options = {}) {
  const profilePath = resolveLayoutProfilePath(options.profilePath);
  const profile = readLayoutProfile(profilePath) || {};

  return {
    profilePath,
    profile,
    resolve(workerId, concurrency) {
      return computeWorkerWindowLayout({ workerId, concurrency, profile });
    },
  };
}

module.exports = {
  resolveLayoutPreset,
  computeWorkerWindowLayout,
  createWindowLayoutPlanner,
};
