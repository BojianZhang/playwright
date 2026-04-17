# ARCHITECTURE_ANALYSIS.md — Dreamina/0.0.3

> **新旧架构对照进化记录**（`v0.0.2` → `0.0.3`）
> 最后更新：2026-04-17（第六轮：单文件报错自修复）
> 对应指令：【单文件报错自修复指令】

---

> [!NOTE]
> **第六轮修复记录**（2026-04-17）
>
> **报错类型**：结构损坏 × 2（新逻辑接入点偏移 + 函数重复定义）
>
> **根因一**：第五轮 `_exp_migrate1.js` 的 EXP-9 注入脚本在计算 `batchContext.concurrencyPolicy` 块后位置时，`indexOf('\n  };\n', batchContextEndIdx)` 误命中文件头 `'use strict';` 行中 `};` 的相似模式，将注入块嵌入文件第 1-12 行，导致 `'use strict';` 被劈成 `'use`（行1）和 ` strict';`（行12）→ SyntaxError at line 1。
>
> **根因二**：早期某轮 `multi_replace_file_content` 对 `createBatchRunContext` 的 summary 初始化做替换时产生了**两份函数定义**：行 610（summary 字段不完整的残本）+ 行 702（完整副本），残本中 `summary: {` 提前关闭后堆叠了来自其他函数的 `return { ... }` 片段 → SyntaxError: Unexpected token 'return' at line 690。
>
> **修复步骤**：
> 1. 将 EXP-9 注入块从文件头（行 1-12 碎片）移除，恢复 `'use strict';` 完整第一行，并将 EXP-9 代码重新注入到正确位置（`batchContext.concurrencyPolicy` 块之后）。
> 2. 删除损坏的 `createBatchRunContext` 重复副本（行 610-701），保留完整的行 702 版本。
>
> **验证**：`node --check` → exit 0；28/28 功能校验点全通过。

---

## 一、模块职责映射（v0.0.2 → 0.0.3）

| v0.0.2 文件 | 0.0.3 对应模块 | 映射关系 |
|---|---|---|
| `runner.js` | `Dreamina-batch-runner.js` + `shared-batch-orchestration/` | 拆分：调度逻辑 → batch-runner；并发原语 → shared-batch-orchestration |
| `task-register.js` | `Dreamina-register.js` + `S1~S6/adapter.js` | 拆分：主链编排 → Dreamina-register；各阶段 DOM 操作 → Si adapter |
| `runner.js:proxyInUseSet + mutex` | `shared-batch-orchestration/mutex.js:createProxyLockSet` | 抽取为可复用原语，接口语义完全对等 |
| `runner.js:precheckProxy()` | `S0-proxy-precheck/` + `shared-proxy-precheck/` | 拆分：本地运行入口 → S0；通用 precheck 逻辑 → shared |
| `runner.js:classifyFailureReason()` | `failure-classifier.js` | 直接对应，新架构独立成模块 |
| `runner.js:acquireProxy() / releaseProxy()` | `acquireNextProxy()` + `lockSet` | 新架构已补全（本轮修复 FIX-C5） |
| `runner.js:removeProxyFromRuntimePool()` | `acquireNextProxy()` 的 `isProxyHardBlocked` 过滤 + 热剔除 | 新架构更精细（基于 healthScore 而非简单 Set） |
| `config.json` | `config.json` | 结构大幅优化（平铺→嵌套分节） |
| `window-layout-profile-loader.js` | `shared-window-layout/` | 提取为 shared 模块 ✅ |
| `worker-status-tracker.js` | `shared-utils/worker-status-tracker.js` | 直接迁入 shared-utils ✅ |
| `dreamina-register-profile.json` | `S1~S6/profiles/*.json` | 拆分为各阶段独立 profile ✅（更细粒度） |

**无对应项（老架构有，新架构未实现）：**
- `withFileLock` 文件写入互斥锁 → 新架构 `migrateAccountOutOfLocalPool` 等函数直接同步写文件（⚠️ 见 GAP-1）
- `noIdleProxyRetryWait`（无代理时等待后重试同账号）→ 新架构直接返回 NO_PROXY_AVAILABLE（⚠️ 见 GAP-2）
- `fail reason 可配置化`（config.json 中 `hardProxyFailureReasons`/`businessFailureReasons`）→ 新架构 `failure-classifier.js` 中硬编码（⚠️ 见 GAP-3）

---

## 二、老架构值得继承的优点

### A1. 代理互斥锁 + 精确 finally 释放（runner.js:L682-703, L944）
**优点**：`acquireProxy()` 用 Mutex 序列化入 Set，`finally` 块中 `releaseProxy()` 确保任何路径都释放，无死锁风险。  
**值得继承的原因**：并发下不加锁会导致同 IP 多请求，触发风控。  
**在新架构中的落点**：`shared-batch-orchestration/mutex.js:createProxyLockSet` + FIX-C5 接入（✅ 已完成）

### A2. 失败分类覆盖配置化（runner.js:L369-395 + config.json:L44-54）
**优点**：`hardProxyFailureReasons` 和 `businessFailureReasons` 定义在 config.json，不需要改代码就能调整分类边界。  
**值得继承的原因**：生产环境频繁发现新的失败 reason，改代码上线风险高；改 config.json 成本低。  
**在新架构中的落点**：`failure-classifier.js` 当前硬编码枚举 → 待演进为从 config.json 读取（⚠️ GAP-3）

### A3. 文件写入互斥锁（runner.js:L645-651, L614-615）
**优点**：`withFileLock` 序列化所有文件 append 操作，防止并发写入导致行截断或文件损坏。  
**值得继承的原因**：Node.js `appendFileSync` 在并发下实际上是安全的（内核保证原子 append），但 `writeFileSync`（覆写模式）在并发下会损坏文件。  
**在新架构中的落点**：`migrateAccountOutOfLocalPool` 等函数使用 writeFileSync 覆写 → 并发安全风险（⚠️ GAP-1）

### A4. 运行时 `runtimeMode` 降级策略（runner.js:L564-591）
**优点**：`STANDARD_RUN → DEGRADED_RUN` 自动降级（当 ok 池耗尽时启用 weak 池），有明确的运行时状态标签。  
**值得继承的原因**：生产环境代理池状态动态变化，需要自动降级而非硬停。  
**在新架构中的落点**：新架构使用健康评分（healthScore + decay），策略更精细，本质等价 ✅

### A5. `inferFailurePhase()` 失败阶段推断（runner.js:L416-425）
**优点**：从 reason code 反推失败发生在哪个流程阶段（precheck / open_dreamina / verification / signup_result），用于精细统计。  
**值得继承的原因**：只有 reason code 时很难判断是哪层出的问题，阶段标签极大提升调试效率。  
**在新架构中的落点**：新架构有 `finalStage` 字段记录阶段，但无从 reason 反推的逻辑 → 已被 `stageBuckets` 覆盖 ✅（方式不同但等价）

### A6. 断点续跑机制（runner.js:L559-563）
**优点**：`doneAccountRawSet` 在启动时就排除已成功账号，且包含 `verificationRateLimitedAccounts` 跳过逻辑。  
**值得继承的原因**：批量任务中途中断后能续跑，避免重复注册。  
**在新架构中的落点**：`pruneKnownRegisteredFromLocalPool` + `knownExistsAccounts` Set ✅（已实现，逻辑等价）

---

## 三、老架构反模式案例（沉淀为失败经验）

### AN-1. 单体大文件：一个 runner.js 承载全部职责（54KB + task-register.js 67KB）
**问题**：配置读取、代理池管理、账号状态管理、浏览器控制、结果落盘、并发调度全在同一文件。任何一层改动都有误触其他层的风险。  
**维护代价**：找一个函数需要全文搜索；修改代理策略时容易改坏账号管理逻辑。  
**新架构是否规避**：✅ 已规避，通过 `shared-*` + `Si-adapter` 分层彻底解耦。  
**残留风险**：`Dreamina-batch-runner.js` 当前仍有 88KB（含账号池管理领域逻辑），参见 D2 演进项。

### AN-2. config.json 平铺 152 个字段，run/test 双份并列
**问题**：`runFirstLoadGraceWaitMs` 和 `testFirstLoadGraceWaitMs` 形成平行字段，容易出现只改一个忘记改另一个的情况；字段膨胀导致 config.json 难以维护。  
**维护代价**：152 行 config，没有分节说明，新维护者不知道字段之间的关系。  
**新架构是否规避**：✅ 已规避，采用嵌套分节（`navigation.run` / `navigation.test`），字段减少到 82 行。  
**补充说明**：新架构的 `_comment` 字段在 `loadBatchConfig()` 中被自动过滤，不影响运行时。

### AN-3. 代理失败原因码硬编码在 runner.js 内部（L369-395）—— 但同时又在 config.json 可配置，形成双轨
**问题**：`isHardProxyFailureReason()` 既从 config.json 读列表，又在函数内有 fallback 默认值，两处维护。实际配置和代码默认值可能不同步。  
**维护代价**：修了 config.json 但忘记更新代码默认值，或反之。  
**新架构是否规避**：⚠️ 未完全规避 —— `failure-classifier.js` 中枚举完全硬编码在 JS 中，config.json 无法覆盖（GAP-3）。

### AN-4. 文件写入逻辑分散在 runner.js 主循环中（20+ appendLineSafe 调用）
**问题**：结果落盘逻辑与调度逻辑交织，很难只测试落盘路径。  
**维护代价**：修改输出格式需要通读整个主循环。  
**新架构是否规避**：✅ 已规避，新架构通过 `updateBatchSummary()` + `writeBatchAccountRecordFile()` 集中处理结果落盘。

### AN-5. 无代理时 `attempt -= 1` 无限循环等待（runner.js:L736-741）
**问题**：当没有空闲代理时，循环 `attempt -= 1` 让同账号无限等待，日志看起来像卡住。若代理全部失效则永远不会终止。  
**维护代价**：生产环境代理全失效时批次卡死，需要手动中断。  
**新架构是否规避**：✅ 改为返回 NO_PROXY_AVAILABLE，批次整洁终止。  
**权衡**：新架构牺牲了"代理暂时不足时等待"的能力（GAP-2），可能在代理池紧张时不必要地放弃账号。

### AN-6. `task-register.js` 同时负责 DOM 操作和截图和存储路径管理
**问题**：截图路径、storage 保存、DOM 定位、验证码重试全在同一个 1274 行文件中。  
**维护代价**：调试截图逻辑时需要理解整个注册流程；添加新页面检测逻辑时容易引入副作用。  
**新架构是否规避**：✅ 已规避，各 Si adapter 只负责本阶段 DOM 操作，截图逻辑内聚于 adapter 内部。

---

## 四、新架构当前存在的边界问题（GAP 清单）

### GAP-1. 账号池文件写入缺乏并发互斥 ✅ **第三轮已修复**
**修复方案**：在 `Dreamina-batch-runner.js` 顶部注入模块级 `withPoolFileLock = createMutex()`，将 4 个高风险 `writeFile`（覆写模式）调用包裹：
- `pruneKnownRegisteredFromLocalPool()` → `LOCAL_ACCOUNTS_FILE`
- `writeKnownExistsAccounts()` → `KNOWN_EXISTS_FILE` + `KNOWN_REGISTERED_FILE`（原子块）
- `migrateAccountOutOfLocalPool()` → `LOCAL_ACCOUNTS_FILE` + `REGISTERED_ACCOUNTS_FILE`（两处）

互斥原语来源：`shared-batch-orchestration/mutex.js:createMutex`（v0.0.2 的 `withFileLock` 等价实现）。

**验证**：6/6 通过

---

### GAP-2. 无代理时直接放弃账号 ✅ **第三轮已修复（可配置策略）**
**修复方案**：
- `config.json` 新增 `noProxyPolicy` 节（`strategy` / `retryWaitMs` / `retryMaxAttempts`）
- `processBatchTask()` 中的无代理分支替换为策略路由：

| strategy | 行为 |
|---|---|
| `skip_account`（默认） | 直接返回 NO_PROXY_AVAILABLE，账号不再重试 |
| `retry` | 等待 `retryWaitMs` 后重试代理分配，超过 `retryMaxAttempts` 次后退化为 skip_account |
| `retry_then_defer` | 同 retry，超限后额外记录日志（持久化延迟队列待后续实现） |
| `stop_batch` | 抛出 NO_PROXY_AVAILABLE_STOP_BATCH 错误，整批停止 |

- `loadBatchConfig()` 中增加 `noProxyPolicy` 节初始化保障

**当前默认**：`skip_account`（最保守，与修复前行为一致），无破坏性变更。

**验证**：7/7 通过

**待确认（仍开放）**：
- `retry_then_defer` 中的"持久化延迟队列"当前仅记录日志，未实现真正的队列持久化 → 如需支持跨批次续跑延迟账号，需要后续单独实现
- 当前 `retry` 策略下等待期间不消耗 `attempt` 计数，可能导致 `attempt` 和实际等待次数语义不同步 → 已在代码注释中说明，待后续确认

---

### GAP-3. failure-classifier.js 枚举硬编码，无法通过 config.json 配置 ✅ **第三轮已修复**
**修复方案**：
- `failure-classifier.js` 新增 `createFailureClassifier(config)` 工厂函数：
  - `hardSet` = 内置 `PROXY_HARD_FAILURE_REASONS` + `config.failureClassifier.proxyHardReasons`（追加）
  - `bizSet` = 内置 `BUSINESS_FAILURE_REASONS` + `config.failureClassifier.businessReasons`（追加）
  - `reasonOverrides` = 精确覆盖，优先级最高（高于 hardSet / bizSet）
- `config.json` 新增 `failureClassifier` 节（`proxyHardReasons`、`businessReasons`、`reasonOverrides` 默认均为空）
- `loadBatchConfig()` 增加 `failureClassifier` 节初始化保障
- 原有 `isProxyHardFailure`/`isBusinessFailure`/`classifyFailure` 函数保持不变（向后兼容）

**config.json 使用示例**（发现新 reason 时直接改配置，无需改代码）：
```json
"failureClassifier": {
  "proxyHardReasons": ["MY_NEW_PROXY_ERROR"],
  "reasonOverrides": {
    "SIGNUP_REJECTED_IP_BANNED": "proxy-hard"
  }
}
```

**验证**：7/7 通过

**第四轮追加**：`createFailureClassifier(batchConfig)` 已接入 `batchContext.classifier`；`failureClassBuckets` 桶计数已在 `updateBatchSummary` 中落地；`BATCH_FAILURE_CLASS` 已在 `buildBatchOverviewLines` 中输出。✅ **完全落地**

---

### GAP-4. runtime 对象字段无 schema 文档 ✅ **第四轮已完成**
**位置**：`Dreamina-batch-runner.js:runSingleAccountWithNewArchitecture()` → `runtime` 对象  
**产出**：[runtime-params.md](./runtime-params.md) — 全量 33 字段表格，含来源、默认值、消费阶段、硬编码字段说明和 verificationBudget 优先级说明。

### GAP-5. Dreamina-register.js 内 buildDreaminaEntryStageAdapter() 边界（待演进）
**当前状态**：⬜ D1 Step2 待后续执行。

---

## 五、已完成修复（本轮之前）

| 轮次 | 修复 | 对应 GAP/问题 |
|------|------|--------------|
| 第三轮 | 账号池 writeFile 并发互斥（GAP-1） | C5 / AN-3 |
| 第三轮 | noProxyPolicy 可配置策略（GAP-2 初始） | GAP-2 |
| 第三轮 | createFailureClassifier 工厂创建（GAP-3 初始） | GAP-3 |
| 第三轮 | 新旧架构对照分析文档 | 新增 |
| **第四轮** | **GAP-3 接入点**：createFailureClassifier 接入 batchContext.classifier，failureClassBuckets 统计，BATCH_FAILURE_CLASS 显示 | GAP-3 |
| **第四轮** | **GAP-2 retry_then_defer 最小追踪**：deferredAccounts 内存追踪 + deferredFile JSONL 持久化 | GAP-2 |
| **第四轮** | **GAP-4 runtime-params.md**：runtime 对象全量字段文档（来源/默认值/消费阶段） | GAP-4 |
| 第二轮 | S1-entry README 架构边界说明 | D1/D5 |

---

**第四轮完成后，以下待确认项已全部收敛：**

| 项目 | 状态 |
|------|------|
| GAP-3 接入点：工厂函数接入 batchContext | ✅ 已完成 |
| GAP-2 retry_then_defer：最小 JSONL 追踪 | ✅ 已完成（持久化延迟队列如需完整实现，后续另立 issue） |
| GAP-4 runtime-params.md | ✅ 已完成 |

**剩余开放项**：
1. **D2 Step2**：`account-pool-manager.js` 实际创建与迁移（中风险，需独立规划）
2. **GAP-5**：`Dreamina-register.js` 胶水层与 S1-entry 双实现评估（低风险，可随时处理）
3. **dreaminaHomeUrl 配置化**：当前硬编码，可迁入 config.json `site` 节（低风险）

---

## 七、架构进化状态总览

```
v0.0.2（单体）                  0.0.3（分层，当前状态 · 第五轮后）
─────────────────────────────────────────────────────
runner.js（调度+代理+账号+结果） ── Dreamina-batch-runner.js（调度层）
                                  ├─ 仍含账号池逻辑（⚠️ D2 待迁移）
                                  ├─ 已接入代理互斥锁 ✅
                                  ├─ failure-events/run-log 路径已就绪（⚠️ 写入待接入 EVO-1/2）
                                  └─ accountsDoneFile / perKindResultFiles 路径已就绪（⚠️ EVO-7/12/13）

task-register.js（全部 DOM）     ── Dreamina-register.js（编排层）
                                  ├─ S1～S6 adapter（各阶段 DOM）✅
                                  └─ S1 胶水层仍在编排层（⚠️ D1 待整理）

config.json（平铺 152 字段）     ── config.json（分节 15 节）✅
                                  ├─ proxyHealthPool / site / resultRouting / log 节已就绪（第五轮）
                                  └─ 配置节接入 batch-runner.js 为后续演进项

dreamina-health.js（健康检查）   ── failure-classifier.js:inferFailurePhase() ✅（第五轮导出）
                                  └─ failurePhaseBuckets 统计桶已就绪

嵌入式 mutex                     ── shared-batch-orchestration/mutex.js ✅
嵌入式 proxy precheck            ── shared-proxy-precheck/ ✅
嵌入式 window-layout             ── shared-window-layout/ ✅
嵌入式 worker-status             ── shared-utils/worker-status-tracker.js ✅
```

---

## 八、实战经验迁移（第五轮）

### 8.1 本轮已落地补强（12 项）

| 经验 | 文件 | 内容 |
|------|------|------|
| EXP-1 `failureEventsFile` 路径 | `Dreamina-batch-runner.js` | `batchContext.paths.failureEventsFile` |
| EXP-2 `runLogFile` 路径 | `Dreamina-batch-runner.js` | `batchContext.paths.runLogFile` |
| EXP-3 `inferFailurePhase()` | `failure-classifier.js` | 独立函数 + 导出；`failurePhaseBuckets` |
| EXP-9 `RUN START` 标记 | `Dreamina-batch-runner.js` | 控制台 + 写 runLogFile |
| EXP-11 `proxyExitIp` 字段 | `buildBatchAccountRecord()` | 从 extra.proxy / result.meta 提取 |
| EXP-12 `perKindResultFiles` 5 条路径 | `batchContext.paths` | wrong-code / signup-rejected / rate-limited / ip-banned / proxy-hard |
| EXP-13 `accountsDoneFile` 路径 | `batchContext.paths` | 为断点续跑准备路径 |
| EXP-17 `precheckLevel` 字段 | `buildBatchAccountRecord()` | 记录代理预检等级 |
| EXP-4/5 `proxyHealthPool` 配置节 | `config.json` | softPenaltyThreshold=2 / fallbackToWeakPool / speedTierFilter |
| EXP-6 `site` 配置节 | `config.json` | homeUrl / precheckUrl / connectivity check URLs |
| EXP-7/12 `resultRouting` 配置节 | `config.json` | per-kind file 开关 |
| EXP-2/9 `log` 配置节 | `config.json` | writeRunLog / writeFailureEvents / workerStatusIntervalMs |

### 8.2 演进队列（EVO-* Issues）

| ID | 优先级 | 风险 | 描述 |
|----|--------|------|------|
| **EVO-1** | P1 | 低 | `updateBatchSummary` else 分支写 `failure-events.jsonl` |
| **EVO-2** | P1 | 低 | 关键节点写 `run-log.txt`（TRY/FAIL/SUCCESS） |
| **EVO-6** | P2 | 低 | 将 `dreaminaHomeUrl` 硬编码替换为 `batchConfig.site?.homeUrl` |
| **EVO-9** | P2 | 低 | `runDreaminaBatch` 末尾写 `RUN END` 标记 |
| **EVO-4** | P2 | 中 | 接入 `proxyHealthPool.softPenaltyThreshold` 计数器 |
| **EVO-7** | P2 | 中 | `verificationRateLimited` 写独立文件 + 启动时跳过 |
| **EVO-12** | P2 | 中 | `perKindResultFiles` 写入逻辑接入（wrongCode/signupRejected/ipBanned） |
| **EVO-19** | P3 | 中 | Worker 状态面板定期写 `runLogFile` |
| **EVO-13** | P1 | 高 | 断点续跑：启动时读 `accountsDoneFile`，成功时写入（需要安全设计） |
| **EVO-5** | P3 | 高 | `DEGRADED_RUN` 模式实现（weak pool fallback） |
| **EVO-8** | P3 | 高 | 代理速度档过滤实现（需代理行格式标准化） |
| **EVO-15** | P3 | 低 | `normalizeFailureReason()` 提取为 `failure-classifier.js` 导出 |

### 8.3 老架构反模式（沉淀为反例）

- **大函数单体**：`runner.js` 1024 行承担所有职责 → 0.0.3 已拆分 ✅
- **业务+IO 混合**：`processAccount()` 读写和业务混合 → 0.0.3 分层 ✅
- **配置平铺爆炸**：`runSlowMo / testSlowMo ...` → 0.0.3 分节 ✅
- **failure reason 内联硬编码**：无工厂模式 → 0.0.3 `createFailureClassifier()` ✅
- **无 deferred 策略**：无代理死等或放弃 → 0.0.3 `noProxyPolicy` 四种策略 ✅
- **dreaminaHomeUrl 未强制配置化**：dreamina-health.js 有 fallback 但不显眼 → 0.0.3 `config.json:site.homeUrl`（EVO-6 接入）

### 8.4 待确认项

1. **断点续跑路径一致性**：`batch-results/` vs v0.0.2 的 `results/`，accountsDoneFile 跨批次续跑时路径是否需要可配置？
2. **weak pool 数据源**：EVO-5 DEGRADED_RUN 需明确 weak pool 文件来源（代理预检 WEAK 结果？还是运行时降级标记？）
3. **`runBatchOrchestration` 回调**：EVO-19 需要 Worker 状态快照回调接口，需确认 orchestration 是否支持。
4. **`resultRouting.enabled` 粒度**：按种类单独开关还是统一控制？

> [!NOTE]
> **第七轮记录**（2026-04-17）
>
> **问题类型**：运行前置条件错误 / 数据缺失（A 类）
>
> **根因**：local-accounts.json 存在且 JSON 合法，但内容为空数组。路径和加载链均正确，属于数据缺失问题。
>
> **修复内容**：
> 1. Dreamina-batch-runner.js — 在 accounts.length 校验前插入三段诊断计数日志（原始/有效/已剔除/切片后），throw 消息增强为含数字诊断的详细说明
> 2. Dreamina-register.README.md — 追加 local-accounts.json 格式说明和 A/B/C 三类根因对应的排查指引
>
> **验证**：node --check exit=0；实际运行输出诊断计数并 exit 1（预期，因文件为空）
>
> **数据修复（用户侧）**：向 Dreamina/0.0.3/local-accounts.json 填入待注册账号后即可启动。

> [!NOTE]
> **第八轮记录**（2026-04-17）
>
> **执行指令**：【新旧架构实战经验对照指令】 + 【低风险补强指令】
>
> **本轮已落地（5项 EVO）：**
>
> | EVO | 文件 | 内容 | 状态 |
> |-----|------|------|------|
> | **EVO-1** | `Dreamina-batch-runner.js` | 在 `updateBatchSummary` 中写 `failure-events.jsonl`（fire-and-forget appendFile，含 time/runId/account/proxy/outcome/phase/reason/failureKind 8 字段） | ✅ |
> | **EVO-2** | `Dreamina-batch-runner.js` | 在 `updateBatchSummary` 中写 `run-log.txt`（每条记录含 [SUCCESS]/[FAIL]/[EXISTS]/[SKIP] + ISO timestamp + reason + stage） | ✅ |
> | **EVO-9** | `Dreamina-batch-runner.js` | 在 `runDreaminaBatch` 末尾写 `RUN END` 标记（含 elapsed 计算）；同时在 RUN START 后注入 `_runStartTs` 时间戳 | ✅ |
> | **EVO-6** | `Dreamina-batch-runner.js` | `dreaminaHomeUrl` 改为读 `batchConfig.site?.homeUrl`，旧硬编码作 fallback | ✅ |
> | **EVO-10** | `failure-classifier.js` | 提取 `normalizeFailureReason(reason) → {code, detail}`，支持 `CODE|detail` 格式，导出到 module.exports | ✅ |
>
> **验证**：`node --check` 两文件均 exit 0；31/31 功能校验点全通过。
>
> **演进队列剩余项（按优先级）：**
> - P1 EVO-13：断点续跑（accountsDoneFile 读写，高风险需设计）
> - P2 EVO-4：代理软惩罚计数器（config.proxyHealthPool.softPenaltyThreshold=2 已就绪）
> - P2 EVO-7：verificationRateLimited 写独立文件 + 启动跳过
> - P2 EVO-12：perKindResultFiles 写入逻辑接入
> - P2 EVO-HARD-EVICT：硬失败代理写 bad-proxies.txt 持久化
> - P3 EVO-5：DEGRADED_RUN weak pool fallback
> - P3 EVO-8：代理速度档过滤
>
> **待审查项（5项，仅代码审查，不改业务逻辑）：**
> 1. `processBatchTask` 是否对业务失败跳过代理惩罚（EXP-03）
> 2. `processBatchTask` 是否有带代理切换的多次重试循环（EXP-05）
> 3. S0 precheck 结果是否包含 exitIp 并传递到 runtime（EXP-14）
> 4. S6 delivery 是否写"国家-sessionId"格式（EXP-23）
> 5. `buildBatchAccountRecord.proxyExitIp` 是否实际被填充

> [!NOTE]
> **第九轮记录**（2026-04-17）审查5项 + EVO-4/7/12 落地
>
> **待审查项结论：**
> 1. processBatchTask业务失败代理惩罚：✅已具备（isTerminalBusinessFailure→L963，直接return不换代理）
> 2. processBatchTask多次代理重试循环：✅已具备（while attempt<=maxAttempts，L1619，acquireNextProxy换代理）
> 3. S0 exitIp传递链路：⚠️部分具备（exitIpOk=ok/fail，实际IP字符串body未解析）
> 4. S6 country-sessionId格式：⚠️部分具备（字段有，format写出缺）
> 5. proxyExitIp实际填充：⚠️部分具备（字段定义完整，上游S0未输出resolvedIp值）
>
> **本轮落地（3项）：**
> | EVO | 文件 | 内容 |
> |-----|------|------|
> | EVO-4 | Dreamina-batch-runner.js | 软惩罚计数器（_proxySoftFailCount，达softPenaltyThreshold后list末尾软降级） |
> | EVO-7 | Dreamina-batch-runner.js | verificationRateLimited独立文件写入（fire-and-forget appendFile） |
> | EVO-12 | Dreamina-batch-runner.js | per-kind结果文件路由（wrongCode/signupRejected/ipBanned/proxyHard） |
>
> **验证**：node --check exit=0；9项功能校验全OK；2160行。
>
> **EVO-13设计草案**：引入global-accounts-done.txt（batch-results/不含runId），Step1路径+Step2写入+Step3读取过滤+Step4互斥保护。待确认：done定义范围/目录可配置/--ignore-done是否同步实现。
>
> **新增演进项**：EVO-ExitIp（S0exitIp body解析）、EVO-23（S6 sessions-with-country格式写出）。

> [!NOTE]
> **第十轮记录**（2026-04-17）EVO-ExitIp + EVO-23 + EVO-13 落地
>
> **本轮落地（3项 EVO）：**
>
> | EVO | 文件 | 内容 | 验证 |
> |-----|------|------|------|
> | **EVO-ExitIp** | Dreamina-register.js + Dreamina-batch-runner.js | buildProxyPrecheckSummary 新增 resolvedIp 字段（读 result.ip）；processBatchTask 将 resolvedIp 写回 proxy.exitIp；buildBatchAccountRecord 读取 proxy.exitIp → proxyExitIp 字段完整数据流 | ✅ |
> | **EVO-23** | Dreamina-batch-runner.js | createBatchRunContext.paths.perKindResultFiles.successSessions 路径定义；updateBatchSummary success 分支提取 sessionId + countryCode 写 sessions-with-country.txt | ✅ |
> | **EVO-13** | Dreamina-batch-runner.js | globalDoneFile = batch-results/accounts-done.txt（固定路径，不含 runId）；parseBatchCliArgs 新增 --ignore-done；updateBatchSummary success+exists 时追加写 email；runDreaminaBatch 启动时读取并过滤已完成账号 | ✅ |
>
> **验证**：node --check 三文件均 exit 0；23/23 功能校验全通过；runner=2205行 register=2532行。
>
> **剩余演进队列：**
> - EVO-5：DEGRADED_RUN weak pool fallback（P3，高风险，需定义 weak pool 数据源）
> - EVO-8：代理速度档过滤（P3，高风险，需代理行格式标准化）
>
> **累计完成 EVO 数量**：EVO-1/2/4/6/7/9/10/12/13/23 + EVO-ExitIp = 11项

> [!NOTE]
> **第十一轮记录**（2026-04-17）高风险设计收敛模式
>
> **里程碑冻结**：11项低风险EVO全部完成，语法/功能验证通过，代码库稳定。
>
> **EVO-8 设计已收敛（不落代码）**
> - speedTier枚举：FAST(≥75)/NORMAL([40,75))/SLOW(<40)/UNKNOWN(无记录)
> - 过滤层：acquireNextProxy() activeList.filter()
> - 阈值来源：healthScore（复用已有字段，不新增探测），与 proxy-health-store.js 共享
> - 待拍板：FAST/NORMAL阈值；默认speedTierFilter是否全放行；UNKNOWN代理是否允许
>
> **EVO-5 设计已收敛（不落代码）**
> - weak pool定义：healthScore<40（SLOW tier），复用EVO-8 getProxySpeedTier函数
> - 触发条件：ok pool耗尽 + fallbackToWeakPool=true（config已配置）
> - 不持久化weak pool本身；只写run-log.txt标记DEGRADED_RUN激活事件
> - 退出条件：acquireNextProxy每次动态判断，ok代理恢复后自动退出
> - 依赖EVO-8先落地
>
> **等待决策（3项）**：
> 1. speedTier阈值（推荐FAST≥75/NORMAL[40,75)）
> 2. 默认speedTierFilter（推荐全放行含UNKNOWN）
> 3. UNKNOWN代理调度策略（推荐始终允许）

> [!NOTE]
> **第十二轮记录**（2026-04-17）EVO-8 + EVO-5 代码落地
>
> **本轮落地（2项 EVO）：**
>
> | EVO | 文件 | 内容 | 验证 |
> |-----|------|------|------|
> | **EVO-8** | Dreamina-batch-runner.js | getProxySpeedTier 函数（FAST>=75/NORMAL>=40/SLOW<40/UNKNOWN）；acquireNextProxy 新增 speedTier 过滤；默认全放行；config.json speedTierFilter 更新 | OK |
> | **EVO-5** | Dreamina-batch-runner.js | DEGRADED_RUN weak pool fallback；_runMode 标志；run-log 写入；overview 面板 BATCH_MODE 行；自动恢复 | OK |
>
> **验证结果**：node --check exit=0；18/18 功能校验；14/14 单元测试；runner=2286行。
>
> **v0.0.3 演进全部完成**：共 13项 EVO + EVO-ExitIp，无高风险遗留项。

> [!NOTE]
> **第十三轮记录**（2026-04-17）shared-utils 公共能力抽取与配置补强
>
> **新增文件（4个）：**
> | 文件 | 职责 | 状态 |
> |------|------|------|
> | shared-utils/config-defaults.js | 全量默认值骨架（14个section）+ mergeWithDefaults/getSection | ✅ 语法通过 + 集成测试通过 |
> | shared-utils/config-schema.js | 字段类型/枚举/range约束；getRequiredSections/getRequiredFields | ✅ |
> | shared-utils/config-doctor.js | 运行前诊断；diagnose/diagnoseConfigFile/printDiagnosticReport | ✅ 对当前config.json诊断结果ok=true |
> | shared-utils/file-utils.js | 抽自batch-runner的8个公共工具（ensureDir/sanitizeFileName/readJsonArrayFile等）| ✅ 单元测试通过 |
>
> **更新文件（1个）：**
> - Dreamina/0.0.3/runtime-params.md：重写为包含所有配置section/字段/CLI参数/前置检查用法的完整文档
>
> **可抽取但本轮未动（中/高风险）：**
> - batch-runner.js 中的 ensureDir/sanitizeFileName/incrementBucket/buildNumericStats：与 batchContext 有隐式依赖，抽取需调整所有调用点，列为 TODO。
> - appendUniqueFileLine：与 withPoolFileLock 互斥锁耦合，抽取需解耦，列为中风险演进项。
>
> **剩余中高风险项：**
> - batch-runner.js 实际调用点切换到 file-utils.js（需逐函数替换引用，中风险）
> - config-doctor 接入 runDreaminaBatch 启动前（低风险，一行调用）

> [!NOTE]
> **第十四轮记录**（2026-04-17）shared-utils 接入三步推进完成
>
> **Step1 — config.json 补全（4个新 section）**
> - resumePolicy：enabled/globalDoneFile/doneScope/ignoreDone（EVO-13 断点续跑配置化）
> - output：baseDir/latestDir/createDateSubdir（占位，统一输出路径设计）
> - storageSafety：enablePoolFileLock/writeRetryTimes/writeRetryDelayMs（GAP-1 互斥锁配置化）
> - runtime：workerAcquireTimeoutMs/stageFallbackTimeoutMs/gcIntervalMs（运行时调优占位）
> - 验证：JSON 有效，已有 section 全部完整，total keys=19
>
> **Step2 — config-doctor 接入 runDreaminaBatch**
> - require 行追加：const { diagnoseConfigFile } = require(...config-doctor)
> - runDreaminaBatch 开头 parseBatchCliArgs 之后立即调用 diagnoseConfigFile(CONFIG_PATH)
> - ERROR 级别打印警告（不中断），通过则打印 warnings 数量
> - 结构破损修复：entrySlowSamples block + buildBatchFinalSummaryLines 关闭 + runDreaminaBatch 开头全量恢复
> - 验证：node --check exit=0；10/10 结构检查通过
>
> **Step3 — file-utils 接入 batch-runner**
> - require 行追加：const _fileUtils = require(...file-utils)（别名引用，Step3 完成接入层）
> - 5个本地函数（ensureDir/sanitizeFileName/readJsonArrayFile/incrementBucket/buildNumericStats）追加 @shared-utils 标记
> - 本轮不替换调用点（中风险，调用点分散，本地函数保持兼容）
> - 验证：node --check exit=0；5/5 检查通过
>
> **runner 总行数**：2304行
>
> **剩余 TODO（中风险，后续处理）**：
> - batch-runner.js 8个本地函数的调用点逐一替换为 _fileUtils.xxx 引用，然后删除本地定义
> - appendUniqueFileLine 带 withPoolFileLock 包裹，需解耦后才能替换
