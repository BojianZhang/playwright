# shared-batch-orchestration

公共批量编排层。

## 作用

负责：
- worker / queue / batch orchestration
- worker state
- task queue
- batch-stage orchestration

不负责：
- layout planner canonical implementation
- browser runtime 执行
- 指纹 / 资源拦截
- 站点业务逻辑

## 当前布局

- `index.js`：统一导出入口
- `worker-state.js`：worker 状态模型
- `task-queue.js`：任务队列
- `stages/batch-orchestration.js`：批量编排主流程
- `window-layout.js`：兼容转发层，canonical 实现已迁到 `../shared-window-layout`

这个目录专门放“批量任务并发调度 / worker 生命周期 / 队列编排”相关的共享模块，避免继续把并发控制、worker 状态、任务分发逻辑散落在 batch-runner 或站点主链里。

## 计划放置内容

- `worker-state.js`
  - worker 状态数据结构与状态变更 helper
  - 负责 worker 当前账号 / 代理 / stage / step / 尝试次数 / 累计耗时 的只读快照更新

- `task-queue.js`
  - 通用任务队列 / 取任务 / 结果回写 / 失败记录骨架
  - 负责 account/proxy 等运行单元的排队与消费

- `stages/batch-orchestration.js`
  - 并发调度 orchestrator
  - 负责 worker 池、并发上限、任务领取、结果收口、统计摘要

- `policies/`
  - 并发 / 节流 / 重试 / early-stop 等策略（后续再扩）

## 边界

这个目录只负责“谁什么时候跑、由谁跑、跑完怎么收口”的共享能力：
- worker 池生命周期
- 并发上限控制
- 任务排队 / 领取 / 释放
- 运行期 worker 状态聚合
- batch 级别统计与摘要
- 运行失败后的 batch 级收口

不负责：
- 代理可用性判断（属于 `shared-proxy-precheck`）
- entry 打开与恢复（属于 `shared-entry`）
- credential submit
- verification submit
- profile completion
- post-auth-ready
- account-delivery
- 浏览器页面内业务动作

## 最小落地版

第一版只建议先落 3 个能力，不要一次扩成大总控：

1. **worker 状态骨架**
   - 统一描述 worker 当前运行态
   - 提供 update / idle / done / fail 等 helper

2. **任务队列骨架**
   - 统一 account task / proxy task 的排队与领取
   - 不引入站点业务判断

3. **batch orchestrator 骨架**
   - 用固定并发消费任务队列
   - 聚合 success / failed / skipped / pending / running 统计
   - 输出可供 batch-runner 消费的结构化结果

## shared / policy / stage 的职责拆分

### shared：`worker-state.js` / `task-queue.js`
只放通用骨架：
- 数据结构
- 状态更新
- 队列读写
- 统计汇总

### stage：`stages/batch-orchestration.js`
只放编排动作：
- worker 启动
- 并发消费
- 每个任务调用 runner
- 收集结果

### policy：`policies/*`
只放调度策略：
- 并发限制
- 节流策略
- early stop
- retry budget

## 当前迁移建议

第一步：先把新架构缺失的并发调度壳补上，作为 batch-runner 的共享内核。
第二步：待壳稳定后，再把 worker status 面板、dynamic concurrency、failure bucket throttle 等高级策略继续收进来。
第三步：确认稳定后，再考虑把老 `runner.js` 里的运行时编排经验按 policy 形式迁入，不把旧单体主链回灌进来。
