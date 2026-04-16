'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 入口转发层（ENTRY FORWARDING）— Dreamina
//
// 文件定位：Dreamina/Dreamina-batch-runner.js
//
// 说明：
//   本文件是兼容性入口，保证原有命令行调用路径不变：
//     node Dreamina/Dreamina-batch-runner.js [--options]
//
//   实际实现已迁移至 0.0.3 架构包内：
//     Dreamina/0.0.3/Dreamina-batch-runner.js
//
// ❌ 请勿在此文件编写任何业务逻辑。
// ═══════════════════════════════════════════════════════════════════════

require('./0.0.3/Dreamina-batch-runner');
