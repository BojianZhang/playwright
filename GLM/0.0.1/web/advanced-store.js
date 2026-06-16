// ⟦去重 shim⟧ 规范实现在 shared-console-stores/advanced-store.js(工厂);注入本项目 data + 本项目 advanced-schema(品牌分歧,不共享)。
const path = require('path');
module.exports = require('../../../shared-console-stores/advanced-store')({ dataDir: path.join(__dirname, '..', 'data'), schema: require('./advanced-schema') });
