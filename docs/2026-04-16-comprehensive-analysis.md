# 2026-04-16 — 项目综合分析报告

> 分析范围：`D:\playwright\` 全项目（框架层 + 运行层 + 配置层）
> 结论基于：逐文件代码扫描 + 新旧架构差距比对

---

## 一、整体架构评价

### 当前状态

```
D:\playwright/
├── shared-*/          ← 框架层（11模块）✅ 已完成，职责清晰
├── Dreamina/0.0.3/    ← 运行层（S0~S6）✅ 已完成，adapter + profiles 齐备
├── Dreamina/history/  ← 旧架构归档       ✅ 归档完毕
├── docs/              ← 分析备注         ✅ 本次新建
├── tests/             ← Playwright 测试   ⚠ 仅有手工调试用例，无框架集成测试
└── package.json       ← npm 脚本         ⚠ scripts 仍指向老架构（runner.js）
```

架构分层已经到位，框架层（shared-*）与运行内容层（0.0.3/）边界清晰，这是这个项目最大的优势。

---

## 二、框架层（shared-*）缺失能力

### 🔴 P0 — 缺少核心基础设施

#### 1. 没有全局 `config.json`（最高优先级）

**现状**：关键运行参数分散在三处：
- CLI 参数（`--headed --slow-mo --concurrency`）
- batch-runner.js 里的硬编码默认值（如 `entryGotoTimeoutMs: 120000`）
- window-layout-profile.json（仅管窗口和验证码预算）

**缺失的核心参数**（参考 v0.0.2 config.json 约70个字段）：

| 类别 | 关键参数 | 影响 |
|------|---------|------|
| Firstmail API | `firstmailApiKey`、`firstmailApiBaseUrl` | 验证码拉取 API 鉴权，目前只靠环境变量 |
| 超时控制 | `runDreaminaNavigationTimeoutMs`（当前硬编码120s）| 无法按需调整 |
| 并发控制 | `maxProxyRetriesPerAccount`（当前默认2）| 硬编码在 batch-runner |
| 模式切换 | `runMode: run/test`、`run*/test*` 双参数集 | 无法在不改代码的情况下切换测试/生产行为 |
| Firstmail 行为 | `firstmailPollJitterMinMs/MaxMs`、`firstmailFallbackLookbackMs` | 硬编码0 |
| 安全参数 | `runHumanPauseMinMs/MaxMs` | 无人工延迟模拟 |

**建议**：新建 `Dreamina/0.0.3/config.json`，统一运行时配置。

---

#### 2. 没有生产代理池文件（`proxies.txt`）

**现状**：
- `S0-proxy-precheck/local-proxies.txt` —— 仅有调试用的1~2条代理
- 没有标准的生产代理输入文件入口

**建议**：在 `Dreamina/0.0.3/` 建立 `proxies.txt`（与 `local-accounts.json` 并列），格式为 `host:port:user:pass`，并在 `Dreamina-batch-runner.js` 中统一从此处读取。

---

#### 3. 代理互斥锁（Proxy Mutex）未实现

**现状分析**：batch-runner.js 中 `acquireNextProxy()` 是**纯内存轮询**，没有锁——
多个 Worker 并发时可能同时拿到同一条代理，对目标站点表现为同 IP 并发，触发风控。

**老架构解法（`runner.js/createMutex`）**：
```js
// 老架构：同一时刻一条代理只允许一个 Worker 使用
const proxyMutex = createMutex();
const proxy = await proxyMutex(() => acquireAndLockProxy());
// 使用完后：releaseProxy(proxy.raw)
```

**建议**：在 `shared-batch-orchestration` 中提供 `createMutex()` 工具，或在
`Dreamina-batch-runner.js` 的 `acquireNextProxy()` 加入 Set 占用标记 + 释放机制。

---

#### 4. 运行时代理热剔除（Runtime Proxy Eviction）未实现

**现状**：`proxy-health-store.js` 能记录代理状态，但 batch-runner
在批次执行中不会动态把失效代理从内存池移除。

**影响**：代理在第3个任务失效后，第7、11、15个任务还会继续被分配到它。

**建议**：在 `processBatchTask` 失败回调里，根据 `isProxyHardBlocked()` 结果，
从 `batchContext.proxies` 数组中原地移除该代理。

---

### 🟡 P1 — 缺少稳定性保障

#### 5. 失败类型分类系统（失败不惩罚代理）

**现状**：所有失败都统一处理，不区分：
- **业务失败**（账号已存在、验证码错误）→ 不应惩罚代理
- **技术失败**（代理超时、页面崩溃）→ 代理失败计数 +1

**老架构有** `isBusinessFailureReason()` 函数，包含约15个业务失败枚举。

**建议**：在 `Dreamina/0.0.3/` 新建 `failure-classifier.js`，提供：
```js
isBusinessFailure(reason)   // 仅影响账号，不惩罚代理
isProxyFailure(reason)      // 应惩罚代理
isHardFailure(reason)       // 应立即中止整个 Worker
```

---

#### 6. 失败账号输出文件（`failed.txt` / `existed.txt`）

**现状**：失败结果只记录在 `batch-results/*.jsonl`，没有独立的文本摘要文件。

**影响**：无法快速知道有哪些账号注册失败，也无法直接将失败账号复制重跑。

**建议**：在 `batch-results/latest/` 下增加：
- `failed.txt` —— 技术失败账号列表（可重跑）
- `existed.txt` —— 账号已存在列表（标记跳过）

---

#### 7. `accounts.txt` 文本格式支持

**现状**：`local-accounts.json` 只接受 JSON 格式。粘贴账号列表需手动转换格式。

**建议**：在 `Dreamina-batch-runner.js` 的账号加载函数中，同时支持读取 `accounts.txt`（每行 `email:password` 或 `email----password`），优先级低于 `local-accounts.json`。

---

### 🟠 P1.5 — 可观测性缺口

#### 8. `package.json` npm scripts 仍指向老架构

**现状**：
```json
"start": "node runner.js",      // ← 老架构，不存在
"run": "node runner.js",        // ← 老架构，不存在
"precheck": "node proxy-precheck.js"  // ← 老架构，不存在
```

**建议**：更新为：
```json
"start": "node Dreamina/Dreamina-batch-runner.js",
"run": "node Dreamina/Dreamina-batch-runner.js",
"precheck": "node Dreamina/0.0.3/S0-proxy-precheck/local-proxy-loader.js"
```

---

#### 9. `tests/` 目录只有手工调试用例，无框架集成测试

**现状**：`tests/` 下5个文件全是手工录制的一次性调试脚本（test-1/2/4等），
未与新框架 adapter 集成。

**建议**：建立 `tests/integration/` 目录，为每个 shared-* 模块写一个冒烟测试：
- `shared-proxy-precheck.spec.ts` — 代理预检完整链
- `shared-credential.spec.ts` — 凭据填写框架层
- `batch-orchestration.spec.ts` — 并发调度逻辑

---

### 🟢 P2 — 未来提升项

| # | 缺失能力 | 说明 |
|---|---------|------|
| 10 | **环境变量支持**（`.env` 文件） | `firstmailApiKey` 应从 `.env` 读取，而非 `config.json` 明文 |
| 11 | **run/test 双模式参数集** | 支持 `--mode test` 切换为测试用超时/等待参数 |
| 12 | **代理轮换策略配置化** | 当前按 workerId 取模，应支持 roundRobin / weightedRandom |
| 13 | **`--dry-run` 模式** | 验证账号/代理读取配置，但不真正启动浏览器 |
| 14 | **账号去重幂等保护** | 防止同一邮箱在并发下被两个 Worker 同时处理 |
| 15 | **结果 Dashboard**（可选） | 批次结束后生成 HTML 摘要，替代纯 console 输出 |

---

## 三、行动优先级总览

```
┌─────────────────────────────────────────────────┐
│  P0（立即）  建议先处理 1 + 2 + 3 + 4           │
│  → config.json / proxies.txt / 互斥锁 / 热剔除  │
├─────────────────────────────────────────────────┤
│  P1（近期）  建议第二批处理 5 + 6 + 7 + 8       │
│  → 失败分类 / failed.txt / accounts.txt / npm   │
├─────────────────────────────────────────────────┤
│  P2（未来）  按需选做 10~15                      │
└─────────────────────────────────────────────────┘
```

---

## 四、框架层现有能力评分

| 维度 | 评分 | 备注 |
|------|------|------|
| 阶段链路完整度 | ⭐⭐⭐⭐⭐ | S0~S6 全覆盖，adapter 契约清晰 |
| 并发调度 | ⭐⭐⭐⭐ | 框架结构好，缺互斥锁 |
| 代理管理 | ⭐⭐⭐ | health-store 有，缺动态剔除和互斥 |
| 配置管理 | ⭐⭐ | 分散在多处，无统一 config 入口 |
| 可观测性 | ⭐⭐⭐⭐ | Worker 面板 + JSONL 归档，缺失败摘要文件 |
| 测试覆盖 | ⭐ | 只有手工调试脚本 |
| 文档完整度 | ⭐⭐⭐⭐⭐ | 每个文件有边界说明 + 字段注释，本次已补全 |
