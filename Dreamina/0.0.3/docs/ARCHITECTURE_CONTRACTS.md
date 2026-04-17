# ARCHITECTURE_CONTRACTS.md
# Dreamina 0.0.3 架构边界约束 & 状态机规则

> **定位**：本文件是 Agent 可直接执行的架构决策文档。  
> 每次做代码修改前，先读本文件确认边界，避免误改 shared 层或混淆数据归属。  
> 更新时间：2026-04-17

---

## 1. 目录职责矩阵（Authority Table）

| 目录 / 文件 | 层级 | 职责 | 禁止写入者 |
|-------------|------|------|-----------|
| `account-state/local-accounts.json` | 状态 | 待注册账号池（输入） | shared-* 模块 |
| `account-state/registered-accounts.json` | 状态 | 已完成账号存档 | shared-* 模块、手工删除 |
| `account-state/blacklisted-accounts.json` | 状态 | 硬失败黑名单，不再重试 | shared-* 模块 |
| `account-state/retry-accounts.json` | 状态 | 软失败待重试，可通过 recycle-retry.js 回注 | shared-* 模块 |
| `account-state/recycle-retry.js` | 运维脚本 | 软失败账号回注工具 | 无 |
| `batch-results/` | 运行产物 | 单次批量跑汇总（JSON + txt），不放长期状态 | 人工不应手动写入 |
| `batch-results/accounts-done.txt` | 运行产物 | EVO-13 跨批次断点续跑 done 集合（仅含 email 行） | 仅 batch-runner |
| `results/` | 运行产物 | CLI 单跑（`Dreamina-register.js`）的结果文件 | 仅 register CLI |
| `session-records/` | 运行产物 | Session 详细记录（JSONL+TXT），按时间戳分批 | 仅 batch-runner |
| `config.json` | 配置 | 运行时统一参数，不放账号数据 | 任何运行态代码不应直接写入 |
| `failure-classifier.js` | 代码 | Dreamina 专属失败分类，不跨平台 | 不放到 shared-* |
| `Sn-*/` | 代码 | 各阶段 adapter，只负责页面操作 | 不写账号状态文件 |
| `shared-*/` | 代码 | 跨平台公共骨架，零平台依赖 | 不引用 0.0.3/ 下任何文件 |
| `docs/` | 文档 | 架构分析与约束文档（本目录） | 不放代码 |

---

## 2. 账号状态机

```
                    ┌─────────────┐
                    │   PENDING   │  ← local-accounts.json
                    └──────┬──────┘
                           │ batch-runner / register CLI 执行
               ┌───────────┼───────────────┐
               ↓           ↓               ↓
        ┌────────────┐ ┌─────────┐ ┌─────────────┐
        │ REGISTERED │ │ BLACKLIST│ │  RETRYABLE  │
        └────────────┘ └─────────┘ └──────┬──────┘
registered-accounts.json   blacklisted-   retry-
+ accounts-done.txt        accounts.json   accounts.json
                                          │
                                          │ recycle-retry.js 执行
                                          ↓
                                    ┌─────────────┐
                                    │   PENDING   │  ← 回注到 local-accounts.json
                                    └─────────────┘
```

### 状态转换规则

| 当前状态 | 触发条件 | 目标状态 | 写入文件 |
|----------|----------|----------|---------|
| PENDING | 注册成功（S6 DELIVERY_COMPLETE） | REGISTERED | registered-accounts.json + accounts-done.txt |
| PENDING | 账号已存在（ACCOUNT_ALREADY_EXISTS） | REGISTERED | registered-accounts.json + accounts-done.txt |
| PENDING | 硬失败（见黑名单判定规则） | BLACKLIST | blacklisted-accounts.json |
| PENDING | 软失败（见重试判定规则） | RETRYABLE | retry-accounts.json |
| RETRYABLE | recycle-retry.js 执行 | PENDING | local-accounts.json（追加），retry-accounts.json（清空） |

---

## 3. 黑名单（BLACKLIST）判定规则

以下 `finalReason` 出现时，账号写入 `blacklisted-accounts.json`，**不应再被重试**：

| 原因码 | 语义 | 来源 |
|--------|------|------|
| `SIGNUP_REJECTED` | 注册被平台拒绝 | S2 credential 阶段 |
| `DREAMINA_SIGNUP_REJECTED` | 同上（Dreamina 前缀） | S2 |
| `SIGNUP_REJECTED_IP_BANNED` | IP 被封禁 | S2 |
| `DREAMINA_SIGNUP_REJECTED_IP_BANNED` | 同上 | S2 |
| `VERIFICATION_CODE_RATE_LIMITED` | 验证码限流，该邮箱不可用 | S3 |
| `DREAMINA_VERIFICATION_CODE_RATE_LIMITED` | 同上 | S3 |

**代码位置**：`Dreamina-batch-runner.js → isBlacklistFailure()`

---

## 4. 软失败可重试（RETRYABLE）判定规则

以下 `finalReason` 出现时，账号写入 `retry-accounts.json`，**可通过 `recycle-retry.js` 回注后重试**：

| 原因码 | 语义 | 来源 |
|--------|------|------|
| `DREAMINA_PROXY_CONNECTIVITY_FAILED` / `PROXY_CONNECTIVITY_FAILED` | 代理无法连通（偶发） | S0 |
| `DREAMINA_PROXY_PRECHECK_BAD` / `PROXY_PRECHECK_BAD` | 代理预检失败 | S0 |
| `DREAMINA_BROWSER_SMOKE_BLANK_PAGE` / `DREAMINA_BROWSER_SMOKE_FAILED` | 浏览器启动异常 | S0 |
| `DREAMINA_ENTRY_PAGE_OPEN_TIMEOUT` / `ENTRY_PAGE_OPEN_FAILED` | 入口页加载失败 | S1 |
| `DREAMINA_ENTRY_PAGE_OPEN_FAILED` | 入口页失败 | S1 |
| `DREAMINA_WHITE_SCREEN` / `DREAMINA_FIRST_LOAD_DEAD_PAGE` | 白屏/死页 | S1 |
| `DREAMINA_READY_SIGNAL_MISSING` | 入口 ready 信号缺失 | S1 |
| `DREAMINA_HOME_SHELL_WITHOUT_LOGIN_ENTRY` | 首页无登录入口 | S1 |
| `DREAMINA_LOGIN_ENTRY_NOT_FOUND` / `LOGIN_ENTRY_FAILED` | 登录入口不可用 | S1 |
| `LOGIN_ENTRY_CLICK_NO_STATE_CHANGE` | 点击登录按钮无响应 | S1 |
| `DREAMINA_CREDENTIAL_SUBMIT_RESULT_UNKNOWN` / `CREDENTIAL_SUBMIT_RESULT_UNKNOWN` | 提交后页面无明确响应 | S2 |

**代码位置**：`Dreamina-batch-runner.js → isAccountRetryFailure()`

> ⚠️ `isRetryableProxyOrEnvironmentFailure`（用于代理重试调度）与 `isAccountRetryFailure`（用于写 retry-accounts.json）枚举相同，但语义不同：前者决定是否立即换代理再试，后者决定是否跨批次持久化失败账号。

---

## 5. shared-* 模块边界约束

| 模块 | 允许 | 禁止 |
|------|------|------|
| `shared-credential` | 调用 adapter 方法、归一化结果 | 引用任何 `0.0.3/` 文件 |
| `shared-verification` | resend 调度、轮次控制 | 直接调用 firstmail API（通过 adapter） |
| `shared-utils` | 工具函数（logger、timer、config） | 业务逻辑 |
| `shared-browser-runtime` | 浏览器/页面创建 | 账号状态操作 |

---

## 6. 常见 Agent 误判风险

| 风险 | 正确做法 |
|------|----------|
| 分析失败账号时只看 `batch-results/` | CLI 单跑失败在 `results/`，批量失败在 `batch-results/`，两者不同 |
| 把 `accounts-done.txt` 当作完整账号记录 | 它只有 email 行，完整记录在 `registered-accounts.json` |
| 修改 `shared-*` 中的失败分类逻辑 | 分类逻辑在 `Dreamina/0.0.3/failure-classifier.js`，不在 shared 层 |
| 在失败后直接删除 `local-accounts.json` 条目 | 应先判断是 blacklist 还是 retry，再分流写入对应状态文件 |
| 认为 `retry-accounts.json` 会自动被重跑 | **不会**，需要手动执行 `recycle-retry.js` 后才会回注 |
