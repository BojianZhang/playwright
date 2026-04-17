# 架构评审报告：v0.0.2（老架构）vs 0.0.3（新架构）

> 分析日期：2026-04-17
> 分析人：架构评审顾问（AI）
> 分析范围：`D:\playwright\Dreamina\history\v0.0.2` vs `D:\playwright\Dreamina\0.0.3`
> 排除：docs/ tests/ node_modules/ dist/ build/
> 每个结论附有文件/函数/调用链引用，并标注「事实 / 推断 / 建议」

---

## 模块地图（分析前置）

### v0.0.2 老架构文件结构

```
Dreamina/history/v0.0.2/
├── runner.js            (54KB / 1024行)  ← 主入口：批量调度 + 代理管理 + 窗口布局 + 预检 + 结果落盘
├── task-register.js     (68KB / 1274行)  ← 注册主流程：页面操作 + 验证码 + 生日 + 状态检测
├── dreamina-health.js   (19KB)           ← Dreamina 页面健康检测
├── firstmail-*.js       (21KB)           ← 验证码 API 拉取
├── proxy-precheck.js    (21KB)           ← 独立代理预检脚本
├── worker-status-tracker.js (7KB)        ← Worker 状态面板
├── config.json          (4KB / 152个字段) ← 平铺 key-value 配置
└── 其他辅助文件（logger.js, loader.js等）
```

### 0.0.3 新架构文件结构

```
Dreamina/0.0.3/
├── Dreamina-batch-runner.js  (81KB / 1838行)  ← 批量调度层（本次分析主体）
├── Dreamina-register.js      (104KB / 2531行) ← 单账号主链编排层
├── failure-classifier.js     (7KB / 143行)    ← 失败分类模块
├── config.json               (2KB / 82行)     ← 结构化分节配置
├── S0-proxy-precheck/
│   ├── proxy-precheck-adapter.js (28KB)
│   ├── proxy-health-store.js     (27KB)
│   └── local-proxy-loader.js     (7KB)
├── S1-entry/
│   ├── adapter.js          (56KB / 1568行)   ← 站点 adapter
│   └── entry-adapter.js    (78KB)            ← 时间线 adapter
├── S2-credential/
│   └── credential-adapter.js (67KB)
├── S3-verification/
│   └── verification-adapter.js (70KB)
├── S4-profile-completion/
│   └── profile-completion-adapter.js (73KB)
├── S5-post-auth-ready/
│   └── post-auth-ready-adapter.js (35KB)
└── S6-account-delivery/
    └── account-delivery-adapter.js (37KB)
```

---

## A. 老架构值得继承的优点

### A1. 代理互斥锁（Proxy Mutex）— 防止并发冲突
**【事实】** `runner.js:19-26` 实现了一个轻量 Promise 链互斥量：
```js
function createMutex() {
  let current = Promise.resolve();
  return async (task) => {
    const run = current.then(() => task());
    current = run.catch(() => {});
    return run;
  };
}
```
配合 `proxyInUseSet`（`runner.js:613`），调用链为：
- `acquireProxy()` → 加入 `proxyInUseSet` → 使用完 → `releaseProxy()` → 移出 Set

**【事实】** 这确保了同一时刻一条代理只被一个 Worker 占用，避免同 IP 并发触发风控。

---

### A2. 双 Mutex 文件写锁（State + File 分离）
**【事实】** `runner.js:614-615`：
```js
const withStateLock = createMutex();  // 保护内存状态（accountCursor, proxyInUseSet）
const withFileLock = createMutex();   // 保护文件追加（防止行乱序）
```
两个 Mutex 职责分离，不互相阻塞。这是一个设计细节但实际价值高。

---

### A3. 运行时代理热剔除（Hot Eviction）
**【事实】** `runner.js:653-666`，`removeProxyFromRuntimePool()` 从 `proxies[]` 数组中原地 splice：
```js
async function removeProxyFromRuntimePool(proxyRaw) {
  await withStateLock(async () => {
    const index = proxies.findIndex(item => item.raw === proxyRaw);
    if (index >= 0) proxies.splice(index, 1);
    proxyInUseSet.delete(proxyRaw);
    proxyFailureMap.delete(proxyRaw);
  });
}
```
连续失败 N 次（`proxyFailureDowngradeThreshold`）的代理会被从运行时内存池移除，不再分配给后续任务。

---

### A4. config.json 双模式参数结构（run/test）
**【事实】** v0.0.2 `config.json` 全部152个字段按 `run<Key>` / `test<Key>` 双前缀组织，实现了在不修改代码的情况下切换 test/run 行为：
```json
"runHumanPauseMinMs": 0,    "testHumanPauseMinMs": 800,
"runSlowMo": 0,             "testSlowMo": 120,
"runBlockResourceTypes": [], "testBlockResourceTypes": []
```
`task-register.js:144-175` 的 `resolveRunMode / isTestMode / shouldCaptureScreenshots` 函数体系统一读取这些参数。

---

### A5. 失败分类系统（业务失败 vs 代理失败）
**【事实】** `runner.js:370-414` 包含完整的三层分类：
- `getProxyPenaltyConfig()` → 从 config.json 读取 `hardProxyFailureReasons` / `businessFailureReasons`
- `isHardProxyFailureReason()` → 代理硬失败（换代理）
- `isBusinessFailureReason()` → 业务失败（不惩罚代理）
- `classifyFailureReason()` → 返回 `ACCOUNT_EXISTS / WRONG_CODE / SIGNUP_REJECTED / HARD_PROXY / GENERAL_FAIL`

可配置化（通过 config.json 字段数组扩展），不是硬编码。

---

### A6. 基础设施层与业务层的交互契约
**【事实】** `runner.js:800-1024` 中 `processAccount()` 的调用链结构明确：
1. `acquireProxy()` → 加锁
2. `precheckProxy()` → 代理层（纯网络，无页面）
3. `runRegisterTask()` → 业务层（纯页面操作，无代理管理）
4. 结果处理 → 按分类分发到不同结果文件
5. `releaseProxy()` → 解锁

这种"调度层不穿透到业务层"的模式是正确的分层设计。

---

### A7. 窗口布局计算（精确数学公式）
**【事实】** `runner.js:124-210` 的 `buildUniformGridWindowSlots()` 是一套完整的网格布局算法，考虑了：
- 屏幕分辨率自适应、最小窗口尺寸约束
- 列数回退（当窗口太小时自动减列）
- Margin / Gap / TopInset / BottomInset 精确计算

这个算法经过调试验证，是可以直接继承的基础设施。

---

## B. 老架构的缺点与根因

### B1. runner.js 承担了所有层次的职责（最严重）
**【事实】** `runner.js` 的1024行包含：
- **基础设施**：`requestViaHttpProxy()` (L427-468)，原生 HTTP/HTTPS/TLS 代理请求实现
- **领域逻辑**：`precheckProxy()` (L484-504)，代理检测流程
- **代理管理**：`acquireProxy / releaseProxy / removeProxyFromRuntimePool`
- **调度编排**：`processAccount()` 主循环
- **配置解析**：`resolveRunMode / resolveSlowMo / resolveHumanPauseRange`（L37-70）
- **数据格式化**：`buildRunSummary / buildSessionFormats / getCountryNameZh`（L288-544）
- **文件 IO**：`appendLine / removeProxyFromList / readLines`（L216-248）

**【推断】** 根因是单文件快速迭代模式，每次新增功能直接在文件末尾追加函数，没有提取模块边界的阶段性停顿。

**【事实】** `runner.js` 和 `task-register.js` 之间大量函数重复：
- `resolveRunMode` 在两个文件中各有一份（`runner.js:37` 和 `task-register.js:144`）
- `isTestMode`、`shouldCaptureScreenshots`、`resolveSlowMo`、`resolveHumanPauseRange` 均重复

---

### B2. config.json 平铺结构导致命名混乱
**【事实】** v0.0.2 `config.json` 的152个字段全部在同一层级，命名无规律：
- `firstmailApiKey` vs `firstmailApiBaseUrl`（有前缀）
- `headless` vs `slowMo`（无前缀，属于哪一类不清楚）
- `dreaminaHomeUrl`（业务特定）与 `concurrency`（调度参数）混在一起
- `dreaminaMaxRecoveries` 同时存在（= 3），以及 `runDreaminaMaxRecoveries`（= 1）和 `testDreaminaMaxRecoveries`（= 3），产生歧义

**【事实】** `task-register.js:205-216` 读取 `dreaminaMaxRecoveries`，fallback 到 `runDreaminaMaxRecoveries`，逻辑存在 shadow 风险。

---

### B3. task-register.js 同时负责业务规则、IO 和流程编排
**【事实】** `task-register.js` 的1274行同时包含：
- **页面操作**：`enterVerificationCode()` (L295-390)
- **IO 操作**：`dumpPageDiagnostics()` (L597-618) 写文件
- **流程编排**：`waitForDreaminaLoginSignals()` (L477-543) 包含 recovery、countdown、阶段转移
- **配置解析**：`resolveRunMode / isTestMode` 与 runner.js 重复
- **帮助函数**：`randomBirthDate / getRandomFingerprint`（领域数据生成）

**【推断】** 没有明确的"这层只做什么"的约束，所有函数都处于同一命名空间，扩展时不知道该加到哪里。

---

### B4. 代理健康信息写入文件而非内存结构
**【事实】** `runner.js:547-551`，代理降级直接操作文件（`proxy-ok.txt` / `proxy-bad.txt`）：
```js
function removeProxyFromList(filePath, targetRaw) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  fs.writeFileSync(filePath, nextLines.join('\n'), 'utf8');
}
```
**【推断】** 文件写锁（`withFileLock`）虽然存在，但每次代理失败都会触发同步文件读写。在高并发下这是一个性能瓶颈，且代理的健康状态只有"在文件里 / 不在文件里"两个状态，没有分级评分。

---

### B5. 代理预检内嵌在 runner.js，无法独立复用
**【事实】** `runner.js:427-504` 包含完整的 HTTP CONNECT tunnel 实现和 `precheckProxy()`，这段代码只能在 runner.js 的上下文中使用，无法被其他模块复用。`proxy-precheck.js`（独立脚本）是另一份单独的实现，形成了代理预检逻辑的两处重复。

---

## C. 新架构对老架构的继承/规避情况

### C1. ✅ 正确继承：failure-classifier.js（失败分类，可配置）
**【事实】** `0.0.3/failure-classifier.js` 完整继承了老架构的失败分类思想：
- `PROXY_HARD_FAILURE_REASONS`（Set，L27-45）= 老架构 `hardProxyFailureReasons`
- `BUSINESS_FAILURE_REASONS`（Set，L55-77）= 老架构 `businessFailureReasons`
- `isProxyHardFailure / isBusinessFailure / classifyFailure` = 老架构同名函数

**改进**：新架构用 `Set` 替代了老架构的字符串数组 + `.some()` 查找，性能更好；且独立成模块，边界明确。

---

### C2. ✅ 正确继承：config.json 结构化分节
**【事实】** 新架构 `config.json` 将152字段→82行，通过分节消除歧义：
```json
"navigation": { "run": {...}, "test": {...} },
"browser": {...},
"proxy": {...},
"batch": {...}
```
这比老架构的平铺键名策略更清晰，消除了 `dreaminaMaxRecoveries` vs `runDreaminaMaxRecoveries` 的歧义问题。

---

### C3. ✅ 正确继承：代理健康评分（从文件升级到内存+持久化）
**【事实】** `0.0.3/S0-proxy-precheck/proxy-health-store.js` 实现了：
- 内存中的代理健康记录（`healthStore.records`）
- `computeDecayedHealthScore()`（时间衰减健康分数）
- `isProxyHardBlocked()`（硬封禁判定）
- 支持持久化到文件（`saveProxyHealthStore`）

这从根本上解决了老架构"健康信息只在文件里"的问题。

---

### C4. ✅ 正确继承：S1 adapter.js 的分层 ready 信号策略
**【事实】** `S1-entry/adapter.js` 中 `waitForDreaminaReady()` 继承了老架构 `dreamina-health.js` 的"多级 ready 信号"思想，并做了明确分级：
1. 强置信度结构化 selector（`DREAMINA_STRONG_READY_SELECTORS`）
2. 强置信度文本信号（`DREAMINA_STRONG_READY_TEXTS`）
3. body pattern 兜底

同时新增了 home shell 文本（仅观测，不作为成功条件），避免了老架构中把 "Explore Create Assets" 文本误判为登录入口就绪的潜在风险。

---

### C5. ❌ 尚未实现：代理互斥锁（Proxy Mutex）
**【事实】** `0.0.3/Dreamina-batch-runner.js:252-277` 的 `acquireNextProxy()` 没有锁机制。有 `preferred / fallback` 分层逻辑，有 `isProxyHardBlocked()` 过滤，但参考老架构 `proxyInUseSet`，缺少"该代理正在被某 Worker 使用"的 Set 占用标记。

**【推断】** 在并发数 ≥ 2 时，两个 Worker 可能同时拿到同一条代理（如果代理池数量少于 Worker 数）。

---

### C6. ❌ 尚未实现：运行时代理热剔除
**【事实】** `processBatchTask()` (L1404-) 调用了 `isProxyHardBlocked()`，但没有执行 `splice` 操作将该代理从 `batchContext.proxies.list` 移除。老架构的 `removeProxyFromRuntimePool()` 在新架构中没有对等实现。

**【推断】** 已失效的代理在本批次剩余任务中仍会被 `acquireNextProxy()` 从池中返回（只有 `isProxyHardBlocked` 过滤，但这需要 `healthStore` 已被更新）。

---

### C7. ❌ 部分缺失：运行参数硬编码在 batch-runner 内
**【事实】** `0.0.3/Dreamina-batch-runner.js:1042-1091`，`runSingleAccountWithNewArchitecture()` 中有多个运行参数直接硬编码：
```js
runtime: {
  dreaminaHomeUrl: 'https://dreamina.capcut.com/ai-tool/home',
  entryGotoTimeoutMs: 120000,
  dreaminaNavigationTimeoutMs: 120000,
  firstLoadGraceWaitMs: 12000,   // ← 不读 config.json navigation.run.firstLoadGraceWaitMs
  ...
}
```
**【事实】** config.json 的 `navigation.run.firstLoadGraceWaitMs = 4000`，但代码里硬编码的是 12000（test 模式的值），且 navigation.run 节的参数完全没有被 `loadBatchConfig()` 注入到 runtime。

---

## D. 新架构中边界不清晰的地方

### D1. Dreamina-register.js 内嵌了 Entry Stage 的完整业务逻辑（最严重）
**【事实】** `0.0.3/Dreamina-register.js:48-542` 定义了函数 `buildDreaminaEntryStageAdapter()`，这个函数内部**直接实现**了：
- `detectEntryDeadPage()`（L49-78）
- `preprocessEntryOverlays()`（L81-108）
- `prepareDreaminaLoginPage()`（L111-201）
- `hasVisibleEntrySignals()`（L203-223）
- `observeDreaminaLoginPageAfterSignIn()`（L225-310）
- `recoverEntrySignals()`（L312-339）
- `captureEntryDebugSnapshot()`（L341-444）

**【事实】** 这些函数本应属于 `S1-entry/` 目录的 adapter 职责。实际上 `S1-entry/adapter.js` 和 `S1-entry/entry-adapter.js` 已经存在同类功能。

**【推断】** `Dreamina-register.js` 同时扮演了：
1. 主链编排角色（正确）
2. entry stage adapter 角色（越权）
3. 调用 `S1-entry/adapter.js` 的消费者角色（正确）

这造成了 S1 层逻辑存在**两处独立实现**：一处在 `Dreamina-register.js:buildDreaminaEntryStageAdapter()`，一处在 `S1-entry/adapter.js`。

---

### D2. Dreamina-batch-runner.js 承担了领域业务逻辑
**【事实】** `Dreamina-batch-runner.js` 按注释声明只负责"批量调度层"，但实际上还包含：

**账号迁移逻辑（L421-537 `migrateAccountOutOfLocalPool()`）**：
- 读取 `local-accounts.json`
- 写入 `registered-accounts.json`
- 解析 `deliveryPayload.sessionSummary`（业务领域数据）
- 更新 `firstSessionRecorded`、`countryCode`、`countryName` 等账号属性

这是典型的"业务领域逻辑"（账号状态管理），不应该在批量调度层实现。

**【事实】** 同文件中 `isExistsBusinessFailure()` (L849)、`isTerminalBusinessFailure()` (L859)、`isRetryableProxyOrEnvironmentFailure()` (L876) 三个函数与 `failure-classifier.js` 功能重叠，但未调用 `failure-classifier.js` 中的函数。

**调用链**：`processBatchTask()` → `isRetryableProxyOrEnvironmentFailure(result)` — 内联实现，没有 `require('./failure-classifier')`

---

### D3. runtime 对象既是配置容器、又是领域状态载体
**【事实】** `runSingleAccountWithNewArchitecture()` 构造的 `runtime` 对象（L1033-1092）混合了：
- **配置参数**：`entryGotoTimeoutMs: 120000`（原本应来自 config.json）
- **调度参数**：`workerId`、`attempt`（运行时状态）
- **business 参数**：`dreaminaAuthMode: 'signup'`（业务领域决策）
- **可观测参数**：`proxyCountryCode`（账号属性）

这个对象被透传给所有 adapter，adapter 只消费自己需要的字段，但没有明确的 schema 约束，实际上任何 adapter 都可以读取调度层的内部状态。

---

### D4. config.json 的 navigation 节没有被实际消费
**【事实】** `0.0.3/config.json` 第36-58行定义了：
```json
"navigation": {
  "run": { "firstLoadGraceWaitMs": 4000, ... },
  "test": { "firstLoadGraceWaitMs": 12000, ... }
}
```

**【事实】** `loadBatchConfig()` (L65-80) 只处理了 `browser.headless`、`browser.slowMo`、`batch.concurrency`，没有将 `navigation` 节的值注入到任何地方。

**【事实】** `runSingleAccountWithNewArchitecture()` 硬编码了 `firstLoadGraceWaitMs: 12000`，这是 test 模式的值，但实际跑生产应该用 `4000`。

**【推断】** config.json 的 navigation 节是一个"写了但没人读"的死配置，等效于不存在。

---

### D5. S1-entry 存在双 adapter 文件，职责分割不清
**【事实】** `S1-entry/` 目录包含：
- `adapter.js`（56KB）—— 注释说明："Dreamina 首页 overlay / loading 状态，完成页面就绪等待"
- `entry-adapter.js`（78KB）—— 从文件大小判断是主要的时间线驱动 adapter

**【事实】** `Dreamina-register.js:45-47` 同时 require 两者：
```js
const dreaminaEntrySiteAdapter = require('./S1-entry/adapter');
const dreaminaEntryTimelineAdapter = require('./S1-entry/entry-adapter');
```
然后在 `buildDreaminaEntryStageAdapter()` 中将两者合并成一个 adapter 对象（L48-542）。

**【推断】** `adapter.js` 与 `entry-adapter.js` 之间的职责分割没有文字约定（只有文件名的隐式暗示），`buildDreaminaEntryStageAdapter` 是一个组合胶水层，但这层逻辑放在编排层（`Dreamina-register.js`）而不是 S1 目录内是边界问题。

---

### D6. failure-classifier.js 与 batch-runner 内的失败判断逻辑重复
**【事实】** `failure-classifier.js` 有 `isProxyHardFailure(reason)` (L91-93)。

**【事实】** `Dreamina-batch-runner.js` 中：
- 第54行 `require('./failure-classifier')` 导入了 `isProxyHardFailure`
- 但 L876-898 的 `isRetryableProxyOrEnvironmentFailure()` 是内联的原因码列表，未调用 `failure-classifier`

**【推断】** 这是两套并行的失败分类，维护时需要同步更新两处，存在漂移风险。

---

### D7. accounts.running 列表只增不减（状态泄漏）
**【事实】** `processBatchTask()` (L1417)：
```js
batchContext.accounts.running.push(account.email);
```
**【事实】** 函数内没有对应的 `.splice()` 或 `.filter()` 调用，账号完成后不会从 `running` 移除。

**【推断】** `batchContext.accounts.running` 会随批次推进不断膨胀，最终成为当前批次所有已处理账号的列表，而不是"正在运行"的账号列表。`buildBatchOverviewLines()` 使用 `orchestration.queueSummary.running` 展示 running 数量（与 `accounts.running` 是不同字段），但如果有人依赖 `accounts.running.length` 来判断当前运行数，会得到错误结果。

---

## E. 优先级最高的 3 个演进建议

### E1.【高风险】代理互斥锁 + 运行时热剔除（优先级 P0）

**问题根因**：参见 C5、C6。

**风险评估**：
- 并发 ≥ 2 时，无互斥锁可能导致同 IP 并发请求（风控风险）
- 运行时不热剔除失效代理，整批次会浪费在坏代理上

**建议实现**（低风险，最小改动）：

在 `Dreamina-batch-runner.js` 中增加 Set：
```js
// 在 createBatchRunContext() 返回值中增加
proxies: {
  ...existing,
  inUseSet: new Set(),   // 新增：正在使用的代理 key 集合
}
```

修改 `acquireNextProxy()`：
```js
function acquireNextProxy(batchContext) {
  const activeList = list.filter(proxy => {
    const key = proxy?.proxyKey || '';
    return !isProxyHardBlocked(records[key] || {})
        && !batchContext.proxies.inUseSet.has(key);  // 新增互斥过滤
  });
  // ... 选中后加入 inUseSet
  batchContext.proxies.inUseSet.add(proxy.proxyKey);
  return proxy;
}
```

在 `processBatchTask()` finally 块中释放并按需剔除：
```js
finally {
  if (lastProxy?.proxyKey) {
    batchContext.proxies.inUseSet.delete(lastProxy.proxyKey);
    if (isProxyHardFailure(lastResult?.finalReason)) {
      // 热剔除
      batchContext.proxies.list = batchContext.proxies.list.filter(
        p => p.proxyKey !== lastProxy.proxyKey
      );
    }
  }
}
```

---

### E2.【边界穿透】将 migrateAccountOutOfLocalPool 提取出 batch-runner（优先级 P1）

**问题根因**：参见 D2。

**风险评估**：
- 当前 `Dreamina-batch-runner.js` 同时是调度层和账号状态管理层
- 账号状态逻辑夹在调度代码中，任何调度层改动都有误触账号逻辑的风险

**建议实现**：

新建 `Dreamina/0.0.3/account-pool-manager.js`，将以下函数迁入：
- `migrateAccountOutOfLocalPool()` (L421-537)
- `pruneKnownRegisteredFromLocalPool()` (L204-231)
- `readKnownExistsAccounts()` (L302-313)
- `writeKnownExistsAccounts()` (L315-328)
- `appendFirstSessionRecord()` (L385-419)

`Dreamina-batch-runner.js` 中只保留 `require('./account-pool-manager')` 的调用点。

---

### E3.【配置死码】打通 config.json → runtime 的注入链（优先级 P1）

**问题根因**：参见 D4。

**风险评估**：
- `navigation.run.firstLoadGraceWaitMs = 4000` 永远不生效，生产实际使用了 12000ms（测试档位），白白多等 8 秒
- 每次想改超时参数都要改代码，而不是改 config.json

**建议实现**：

在 `loadBatchConfig()` 读取 navigation 节，在 `runSingleAccountWithNewArchitecture()` 消费：
```js
// loadBatchConfig 已返回
const navConfig = config.navigation?.[runMode === 'test' ? 'test' : 'run'] || {};

// runSingleAccountWithNewArchitecture 传入 runtime 时读取
runtime: {
  entryGotoTimeoutMs: navConfig.entryGotoTimeoutMs || 120000,
  firstLoadGraceWaitMs: navConfig.firstLoadGraceWaitMs || 4000,
  // ...
}
```

---

## 附录：关键调用链速查

| 场景 | 老架构调用链 | 新架构调用链 |
|------|------------|------------|
| 代理分配 | `runner.js:acquireProxy()` → `proxyInUseSet.add()` → mutex → 使用 → `releaseProxy()` | `batch-runner.js:acquireNextProxy()` → 无锁 → 使用 → 无释放 |
| 代理热剔除 | `runner.js:removeProxyFromRuntimePool()` → `proxies.splice()` | 未实现 |
| 失败分类 | `runner.js:classifyFailureReason()` → 读 config.json 枚举 | `failure-classifier.js:classifyFailure()` + `batch-runner.js:isRetryableProxyOrEnvironmentFailure()` 并行 |
| 配置读取 | `runner.js` 直接读 `config.json` 平铺字段 | `batch-runner.js:loadBatchConfig()` + runtime 硬编码（navigation 节未接入）|
| Entry 准备 | `task-register.js:waitForDreaminaLoginSignals()` | `Dreamina-register.js:buildDreaminaEntryStageAdapter()` + `S1-entry/adapter.js:waitForDreaminaReady()` 并行 |

---

*文档生成于 2026-04-17，基于代码扫描结果。如有架构变更，请在本文档末尾追加更新记录，不要删除历史结论。*
