'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 框架层（FRAMEWORK LAYER）— shared-browser-runtime
//
// 文件定位：shared-browser-runtime/window-runtime.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 将从 shared-window-layout 计算得出的排版（x, y, width, height）
//            转换为 Chromium 特有命令行参数（--window-position, --window-size）。
// ❌ 不负责 —— 尺寸本身逻辑的计算（由 shared-window-layout 负责）。
// ❌ 不负责 —— 指纹伪装控制。
// ═══════════════════════════════════════════════════════════════════════

/**
 * 将窗口布局配置应用到 Chromium Launch 参数上
 *
 * @param {object} [launchOptions={}] - 当前的 config
 * @param {object} [options={}]
 * @param {boolean} [options.headed=false] - 是否为有头模式
 * @param {object} [options.windowLayout=null] - 布局对象
 * @returns {object} updated launchOptions
 */
function applyWindowLayoutToLaunchOptions(launchOptions = {}, options = {}) {
  const next = {
    ...(launchOptions && typeof launchOptions === 'object' ? launchOptions : {}),
  };

  const headed = Boolean(options?.headed);
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;
  // 无头模式下或未启用排版系统时，不添加窗口位置与大小参数
  if (!headed || !windowLayout?.enabled) {
    return next;
  }

  next.args = [
    ...(Array.isArray(next.args) ? next.args : []),
    `--window-position=${Number(windowLayout.x || 0)},${Number(windowLayout.y || 0)}`,
    `--window-size=${Number(windowLayout.width || 1440)},${Number(windowLayout.height || 900)}`,
  ];

  return next;
}

module.exports = {
  applyWindowLayoutToLaunchOptions,
};
