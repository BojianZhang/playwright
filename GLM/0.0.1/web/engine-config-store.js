// ⟦去重 shim⟧ 规范实现在 shared-console-stores/engine-config-store.js(工厂);注入本项目 data + 本项目 engine-schema(分歧,不共享)。
const path = require('path');
module.exports = require('../../../shared-console-stores/engine-config-store')({ dataDir: path.join(__dirname, '..', 'data'), engineSchema: require('./engine-schema') });
