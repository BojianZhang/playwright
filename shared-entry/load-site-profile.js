'use strict';

/**
 * 兼容入口。
 *
 * 作用：
 * - 旧代码如果还在 require('shared-entry/load-site-profile')，这里先不断引用。
 * - 实际实现已经迁到 dreamina 包下。
 * - 后续全量切换完成后，这个文件可以再删除。
 */

module.exports = require('./dreamina/load-site-profile');
