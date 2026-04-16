# 新架构（0.0.3）与老架构（v0.0.2）差距分析

> 分析时间：2026-04-16
> 老架构路径：`Dreamina/history/v0.0.2/`
> 新架构路径：`Dreamina/0.0.3/` + `shared-*/`

---

## ✅ 新架构已具备的能力

| 能力 | 说明 |
|------|------|
| S0~S6 完整阶段链路 | proxy-precheck → entry → credential → verification → profile → post-auth-ready → account-delivery |
| 多 Worker 并发调度 | 基于 `shared-batch-orchestration/runBatchOrchestration` |
| 代理健康评分 | `S0-proxy-precheck/proxy-health-store.js`（failCount / successCount / status / 衰减分） |
| 窗口自动排布 | `shared-window-layout`（Grid/Focus/Compact/Monitor + JSON Profile 按并发档位）|
| 验证码按并发分档预算 | `verificationBudgetByConcurrency`（poll次数 / 间隔 / 重试）|
| 代理策略按并发分档 | `proxyPolicyByConcurrency`（超时 / stagger 延迟）|
| 浏览器指纹随机化 | `shared-browser-runtime/fingerprint.js` |
| 资源拦截 | `shared-browser-runtime/resource-policy.js` |
| 批量结果 JSONL 归档 | `batch-results/` |
| Session 日志 | `session-records/` |
| CLI 参数支持 | `--concurrency / --account-start / --limit / --proxy-start / --headed / --slow-mo` |

---

## ❌ 新架构欠缺的内容（对比老架构）

### 🔴 P0 — 直接影响生产运行

#### 1. **没有全局 `config.json`（运行时配置文件）**

老架构有 `config.json`，共约 70+ 个参数，涵盖：

| 参数类别 | 关键字段 | 新架构现状 |
|---------|---------|-----------|
| Firstmail API | `firstmailApiKey`, `firstmailApiBaseUrl`, `firstmailApiMaxPollAttempts` | 硬编码在 adapter 或 shared-utils 中 |
| 超时参数 | `runDreaminaNavigationTimeoutMs`, `runPostRegisterReadyTimeoutMs` 等 | 分散在各 profile JSON |
| 重试参数 | `maxProxyRetriesPerAccount`, `verificationCodeRetryMaxAttempts` | 部分在 profile，部分硬编码 |
| 运行模式 | `runMode: run/test` | 无统一切换入口 |
| run/test 双模式参数 | `runSlowMo` / `testSlowMo`，`runHumanPauseMs` / `testHumanPauseMs` | 无 |

**影响：** 目前生产参数分散在各 profile JSON 里，无法一处全局调整。

---

#### 2. **缺少 `proxies.txt`（代理输入源）**

老架构：`proxies.txt`（根目录，多条代理，支持 `host:port:user:pass` 格式）  
新架构：`S0-proxy-precheck/local-proxies.txt`（仅有少量调试条目）

**影响：** 没有可供生产使用的代理池文件。

---

#### 3. **代理互斥锁（Proxy Mutex）尚未实现**

老架构 `runner.js` 有 `createMutex()` + `proxyMutex`：
- 同一时刻只允许一个 Worker 占用某条代理
- 代理用完后显式 `releaseProxy()`
- 防止多 Worker 同时用同一条代理导致 IP 被识别

新架构 `batch-runner.js` 目前代理分配策略是**静态分发**（按 workerId 取模），没有运行时独占保护。

**影响：** 高并发下同一代理可能被多 Worker 同时使用，增加封号风险。

---

#### 4. **代理池动态热剔除（Runtime Proxy Eviction）尚未实现**

老架构：代理探活失败后从内存运行时池中移除（`removeProxyFromRuntimePool()`），并自动降级到 bad/weak.txt  
新架构：`proxy-health-store.js` 可以记录状态，但 `batch-runner.js` 没有在运行中动态剔除失效代理的逻辑

**影响：** 一旦某条代理在批次中途失效，后续任务仍可能被分配到该代理。

---

#### 5. **代理 / 账号失败分类系统不完整**

老架构有 `classifyFailureReason()` + `isBusinessFailureReason()`：
- 区分"业务失败"（账号已存在、验证码错误）与"技术失败"（代理不通、页面死了）
- 业务失败不惩罚代理，技术失败才计入代理失败计数

新架构：失败原因码有标准化，但 batch-runner 没有对应的分类逻辑，所有失败都中止，不做类型区分。

---

### 🟡 P1 — 影响稳定性和可观测性

#### 6. **缺少统一 `accounts.txt` 输入格式支持**

老架构：`accounts.txt` 支持 `email:password` 或 `email----password` 两种格式，有注释行支持  
新架构：`local-accounts.json` 只支持 JSON 格式，无法快速粘贴文本格式账号

---

#### 7. **缺少 `results/` 失败账号文件（failed.txt / existed.txt）**

老架构：
- `results/failed.txt` — 最终失败账号列表
- 账号存在时特殊处理（ACCOUNT_EXISTS 分支），记录到独立文件

新架构：失败结果只在 `batch-results/*.jsonl` 里，没有独立的失败账号文本文件，难以快速查看和重跑

---

#### 8. **缺少明确的 `accounts.txt` → `local-proxies.txt` 关系约定**

老架构有明确的资源文件路径约定（README 里说明）  
新架构缺少：
- **代理输入文件位置**不清晰（`S0-proxy-precheck/local-proxies.txt` vs 根目录）
- **批量运行前的准备清单**（放多少账号、代理怎么格式化）

---

### 🟢 P2 — 未来优化项

| 项目 | 老架构有 | 新架构状态 |
|------|---------|----------|
| `--dry-run` 模式 | 有 | 无 |
| 代理池 `roundRobin` 策略 | 有 | 静态按 workerId 分配 |
| Worker 状态面板定时打印 | 有 | 有（10s 间隔）|
| `test_mode` vs `run_mode` 参数集 | 有 | 无 |
| 代理速度分档（fast/slow/weak） | 有 | 新架构用 health score 替代（更优）|

---

## 优先建议行动

```
P0 立即处理：
1. 补充 config.json（统一运行时配置）
2. 补充 proxies.txt / 代理输入约定
3. 实现代理互斥锁
4. 实现运行时代理热剔除

P1 近期处理：
5. failed.txt / existed.txt 输出支持
6. accounts.txt 文本格式支持
7. 失败类型分类（业务失败 vs 技术失败）
```
