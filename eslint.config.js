'use strict';
// ESLint flat config(v9)—— 宽松起步:只抓明显 bug(未用变量/空块/无效正则),大多降为 warn 不阻断。
// 存量大,首次 `npm run lint` 会有不少 warning,渐进清理即可。装依赖: npm install
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    // 不扫:依赖/数据/日志/历史归档/scratch/构建产物/浏览器扩展/TS(playwright 测试)
    ignores: [
      '**/node_modules/**', '**/data/**', '**/logs/**', '**/batch-results/**',
      'Dreamina/history/**', '**/state/**', '**/__pycache__/**',
      '**/_*.js', '**/*.min.js', '**/test-results/**', '**/playwright-report/**',
      'Openrouter/0.0.1/billing/card-fill/extension/**', '**/*.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      // 代码里既有 Node(require/process/__dirname)又有 page.evaluate 里的浏览器(document/window)
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
      'no-cond-assign': ['warn', 'except-parens'],
    },
  },
];
