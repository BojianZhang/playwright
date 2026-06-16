// ⟦去重 shim⟧ 规范实现在 shared-console-stores/setup-store.js(工厂);本文件注入本项目 config 目录。
const path = require('path');
module.exports = require('../../../shared-console-stores/setup-store')({ dataDir: path.join(__dirname, '..', 'config') });
