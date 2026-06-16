// ⟦去重 shim⟧ 规范实现在 shared-console-stores/adspower-store.js(工厂);本文件注入本项目 data 目录。
const path = require('path');
module.exports = require('../../../shared-console-stores/adspower-store')({ dataDir: path.join(__dirname, '..', 'data') });
