'use strict';

/**
 * Compatibility forwarding layer.
 *
 * Window-layout planning and concurrency policy have moved to:
 * - shared-window-layout/profile-loader
 * - shared-window-layout/planner
 * - shared-window-layout/policy
 *
 * Keep this file as a stable compatibility surface for older imports,
 * but stop hosting the canonical implementation here.
 */

module.exports = require('../shared-window-layout');
