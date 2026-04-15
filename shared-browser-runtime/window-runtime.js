'use strict';

/**
 * Shared window runtime execution layer.
 *
 * Boundary:
 * - convert resolved windowLayout into browser launch args
 * - stay focused on window execution only
 * - do not own layout planning or concurrency policy
 */

function applyWindowLayoutToLaunchOptions(launchOptions = {}, options = {}) {
  const next = {
    ...(launchOptions && typeof launchOptions === 'object' ? launchOptions : {}),
  };

  const headed = Boolean(options?.headed);
  const windowLayout = options?.windowLayout && typeof options.windowLayout === 'object' ? options.windowLayout : null;
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
