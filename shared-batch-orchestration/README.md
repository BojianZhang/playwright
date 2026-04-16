# shared-batch-orchestration

框架层 | 批次并发调度骨架

## 职责

| 负责 | 不负责 |
|------|--------|
| Worker 状态生命周期管理（idle / running / done / failed） | 浏览器实例与页面操作 |
| 内存任务队列（出队 / 完成 / 失败 / 统计） | 窗口布局计算（→ shared-window-layout）|
| 高并发 Worker 并行执行骨架 | 站点业务逻辑（→ Dreamina/0.0.3/Sn-*） |
| batch 级结果汇聚与摘要输出 | 指纹 / 资源拦截（→ shared-browser-runtime）|

## 目录结构

```
shared-batch-orchestration/
├── index.js                        ← 统一导出入口
├── worker-state.js                 ← Worker 状态数据结构与状态转换函数
├── task-queue.js                   ← 通用内存任务队列
└── batch-orchestration.js      ← 并发调度主循环（runBatchOrchestration）
```

## 关系

```
Dreamina-batch-runner.js
  └─ runBatchOrchestration()       ← 此框架
       └─ runTask(callback)        ← Dreamina-register.js 注入的业务回调
```
