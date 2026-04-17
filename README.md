# D:\playwright — Dreamina 批量注册自动化平台

> **面向**：人类维护者 + AI Agent  
> **更新时间**：2026-04-17  
> **v1.0.2** | Node.js + Playwright | 架构：阶段化 shared-* 模块 + Dreamina 平台适配层

---

## 项目简介

本仓库实现了基于 Playwright 的 **Dreamina 账号批量全自动注册**流水线。

- **解决的问题**：通过代理池轮换 + 邮箱验证自动化，批量完成 Dreamina 平台的账号注册表单；支持断点续跑、失败分类（黑名单/可重试）、域名黑洞过滤。
- **Dreamina 的角色**：当前唯一已接入生产的平台。所有 Dreamina 专属逻辑（页面选择器、错误提示解析、适配器）均放在 `Dreamina/0.0.3/Sn-*/` 下，不进入 `shared-*` 层。
- **为什么用 shared-* 模块化**：将注册流程的 7 个阶段（S0～S6）抽象为可跨平台复用的公共骨架，平台专属实现通过 adapter 注入。未来接入新平台（如 OpenAI、Midjourney）只需添加对应的 `Sn-*/adapter.js`，不修改共享层。

---

## 仓库结构总览

```
D:\playwright\
├── README.md                          ← 本文件（仓库入口）
├── package.json                       ← npm scripts 入口（见下方"快速开始"）
├── playwright.config.ts               ← Playwright 测试配置（仅用于 tests/）
├── .gitignore                         ← 保护账号数据和运行产物不进入版本控制
│
├── docs/                              ← 仓库级架构文档与治理记录
│
├── Dreamina/                          ← Dreamina 平台主目录
│   ├── Dreamina-batch-runner.js       ← 兼容性转发入口（1KB，指向 0.0.3/）
│   ├── 0.0.3/                         ← 当前主版本（生产用）
│   │   ├── Dreamina-batch-runner.js   ← 批量并发编排入口（主力，116KB）
│   │   ├── Dreamina-register.js       ← 单账号注册协调器（CLI 调试用，103KB）
│   │   ├── failure-classifier.js      ← Dreamina 专属失败分类（黑名单/重试/代理判定）
│   │   ├── config.json                ← 运行时统一配置（浏览器/代理/验证/批量参数）
│   │   ├── proxy-health.json          ← 代理健康池记录（运行时写入）
│   │   ├── smoke-register.js          ← 冒烟测试入口（preflight + 单账号注册 + 断言）
│   │   ├── runtime-params.md          ← 运行时参数说明文档
│   │   ├── Dreamina-register.README.md ← Dreamina-register.js 模块说明
│   │   │
│   │   ├── S0-proxy-precheck/         ← S0 代理预检阶段 adapter
│   │   ├── S1-entry/                  ← S1 入口页阶段 adapter
│   │   ├── S2-credential/             ← S2 凭据提交阶段 adapter
│   │   ├── S3-verification/           ← S3 验证码阶段 adapter
│   │   ├── S4-profile-completion/     ← S4 资料补全阶段 adapter
│   │   ├── S5-post-auth-ready/        ← S5 登录后就绪阶段 adapter
│   │   ├── S6-account-delivery/       ← S6 账号交付阶段 adapter
│   │   │
│   │   ├── account-state/             ← 账号生命周期状态（长期跨批次持久化）
│   │   │   ├── local-accounts.json        ← 待注册账号池（输入源）
│   │   │   ├── registered-accounts.json   ← 已完成账号存档
│   │   │   ├── blacklisted-accounts.json  ← 硬失败黑名单（不再重试）
│   │   │   ├── retry-accounts.json        ← 软失败待重试（可回注）
│   │   │   ├── known-accounts.json        ← 跨批次已知已注册邮箱缓存（启动时快速跳过）
│   │   │   ├── recycle-retry.js           ← 软失败账号回注 local-accounts 工具
│   │   │   ├── state-doctor.js            ← 账号状态文件健康诊断
│   │   │   └── result-doctor.js           ← 批量结果文件健康诊断
│   │   │
│   │   ├── docs/                      ← Dreamina 版本级架构约束文档
│   │   │   ├── ARCHITECTURE_CONTRACTS.md  ← Agent 可执行的边界约束 + 状态机规则
│   │   │   └── 新框架能力缺口分析.md      ← 已知缺口与落地状态
│   │   │
│   │   ├── batch-results/             ← 批量运行产物（可定期清理）
│   │   ├── session-records/           ← 注册成功 Session 凭证记录
│   │   └── results/                   ← CLI 单跑结果（开发调试用）
│   │
│   └── history/                       ← 归档的旧版本（v0.0.2，仅供参考）
│
├── shared-account-delivery/           ← S6 账号交付阶段公共骨架
├── shared-batch-orchestration/        ← 批量并发调度框架（task-queue/worker-state/mutex）
├── shared-browser-runtime/            ← Playwright 浏览器实例创建与指纹管理
├── shared-credential/                 ← S2 凭据提交阶段公共骨架
├── shared-entry/                      ← S1 入口页阶段公共骨架
├── shared-post-auth-ready/            ← S5 登录后就绪确认公共骨架
├── shared-profile-completion/         ← S4 资料补全阶段公共骨架
├── shared-proxy-precheck/             ← S0 代理健康预检公共骨架
├── shared-utils/                      ← 通用工具层（日志/计时/配置/API/文件操作）
├── shared-verification/               ← S3 验证码提交公共骨架（含 resend-on-timeout 逻辑）
├── shared-window-layout/              ← 多浏览器窗口并发布局计算
│
├── tests/                             ← Playwright 测试（UI E2E，非框架单元测试）
└── test-results/                      ← 测试运行产物（自动生成，不提交）
```

---

## 主流程概览

### 推荐主入口

```bash
npm run batch
# 等价于：node Dreamina/Dreamina-batch-runner.js
# 实际执行：Dreamina/0.0.3/Dreamina-batch-runner.js（转发层透传）
```

### 历史/调试入口

```bash
# CLI 单账号注册（调试用，有界面）
node Dreamina/0.0.3/Dreamina-register.js --account-index 0 --proxy-index 5 --headed --slow-mo 200
```

### 注册流程阶段（S0 → S6）

```
S0 proxy-precheck   代理健康预检         shared-proxy-precheck   → S0-proxy-precheck/adapter.js
S1 entry            入口页加载与检测     shared-entry            → S1-entry/adapter.js
S2 credential       邮箱+密码填写提交    shared-credential       → S2-credential/adapter.js
S3 verification     邮件验证码获取与填写  shared-verification     → S3-verification/adapter.js
S4 profileCompletion 账号资料补全       shared-profile-completion → S4-profile-completion/adapter.js
S5 postAuthReady    登录后状态确认       shared-post-auth-ready  → S5-post-auth-ready/adapter.js
S6 accountDelivery  账号交付与结果输出   shared-account-delivery → S6-account-delivery/adapter.js
```

每个 `shared-*` 模块提供**阶段骨架（stage orchestrator）**，`Sn-*/adapter.js` 提供**平台专属实现（page ops/selectors）**。骨架调用 adapter，不包含任何平台代码。

### 批量调度机制

`Dreamina-batch-runner.js` 启动时：
1. 读取 `config.json` → 运行 `config-doctor` 诊断
2. 读取 `account-state/local-accounts.json` → 过滤已完成（EVO-13 断点续跑）→ 过滤域名黑洞
3. 通过 `shared-batch-orchestration` 分发并发 Worker（默认 `concurrency=2`）
4. 每个 Worker 独占一个代理，串行执行 S0→S6
5. 每账号结束后写入状态（`account-state/` 分流）+ 写入批次结果（`batch-results/`）

---

## 核心架构原则

### 1. shared-* 是能力层，不是业务层

| 约束 | 说明 |
|------|------|
| `shared-*` 不引用 `Dreamina/` | 共享骨架不依赖平台实现 |
| `shared-*` 不写运行态 JSON | 账号状态、结果文件只由 Dreamina 层写入 |
| `shared-utils` 不引用其他 `shared-*` | 工具层处于依赖树底层 |
| adapter 由外部注入 | `shared-credential` 等通过 `options.adapter` 接收平台实现 |

### 2. 四目录职责边界

| 目录 | 定性 | 可清理 | 进版本控制 |
|------|------|--------|-----------|
| `account-state/` | **状态源**（跨批次持久化） | ❌ 不可随意删 | ❌（含凭证，在 .gitignore） |
| `batch-results/` | **批次运行产物** | ✅ 可按需清理 | ❌ |
| `session-records/` | **会话证据**（纯只写） | ✅ 可归档 | ❌ |
| `results/` | **CLI 单跑输出**（调试用） | ✅ 可清理 | ❌ |

### 3. Retry vs Blacklist

| 类型 | 触发条件 | 写入文件 | 后续处理 |
|------|----------|---------|---------|
| **Blacklist（永不重试）** | `SIGNUP_REJECTED`、`IP_BANNED`、`VERIFICATION_CODE_RATE_LIMITED` | `blacklisted-accounts.json` | 不回注，人工审查 |
| **Retry（可重试）** | `PROXY_CONNECTIVITY_FAILED`、`ENTRY_HEALTH_FAILED`、`CREDENTIAL_SUBMIT_RESULT_UNKNOWN` | `retry-accounts.json` | 执行 `npm run recycle` 回注后重跑 |

> 判定逻辑在 `Dreamina/0.0.3/Dreamina-batch-runner.js` → `isBlacklistFailure()` / `isAccountRetryFailure()`

### 4. 配置统一入口

所有运行时参数通过 `Dreamina/0.0.3/config.json` 配置，启动时由 `shared-utils/config-doctor.js` 自动诊断。CLI 单跑模式也从 `config.json` 读取（fallback 默认值写在代码字面量中）。

---

## 文档导航

| 文档 | 作用 |
|------|------|
| [docs/README.md](./docs/README.md) | 所有文档的索引入口（含历史版本） |
| [docs/SHARED_MODULES_OVERVIEW.md](./docs/SHARED_MODULES_OVERVIEW.md) | 11 个 shared-* 模块的职责一览表 |
| [Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md](./Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md) | **Agent 必读**：目录矩阵、状态机、判定规则 |
| [Dreamina/0.0.3/docs/新框架能力缺口分析.md](./Dreamina/0.0.3/docs/新框架能力缺口分析.md) | 已知缺口与落地状态 |
| [docs/新框架能力缺口分析-v2.md](./docs/新框架能力缺口分析-v2.md) | 最新缺口分析（v2） |
| [docs/目录边界收敛报告.md](./docs/目录边界收敛报告.md) | 四目录边界定性与收敛结论 |
| [Dreamina/0.0.3/runtime-params.md](./Dreamina/0.0.3/runtime-params.md) | config.json 各参数说明 |
| [shared-utils/README.md](./shared-utils/README.md) | shared-utils 14 个工具模块的职责说明 |

---

## 快速开始

### 安装依赖

```bash
npm install
npx playwright install chromium
```

### 批量注册

```bash
# 启动批量注册（读取 account-state/local-accounts.json）
npm run batch

# 等价写法
node Dreamina/Dreamina-batch-runner.js
```

### 维护操作

```bash
# ── 日常诊断 ──────────────────────────────────────────────
# 账号状态文件一致性检查（批次前推荐执行）
npm run state:check

# 结果文件健康检查（含最近批次成功率）
npm run result:check
npm run result:check -- --last-batch   # 附加失败原因分布

# 两项合并执行
npm run doctor

# ── 软失败账号回注 ────────────────────────────────────────
npm run recycle

# ── 冒烟测试（验证主链路可用性）────────────────────────────
npm run smoke
# 或指定账号和代理
node Dreamina/0.0.3/smoke-register.js --account-index 0 --proxy-index 5

# ── 清理结果文件 ──────────────────────────────────────────
npm run reset          # 清理 results/
npm run reset:all      # 清理所有产物（含报告）

# ── 单账号 CLI 调试 ───────────────────────────────────────
node Dreamina/0.0.3/Dreamina-register.js --account-index 0 --proxy-index 5 --headed --slow-mo 200
```

### 推荐批次前工作流

```bash
# 1. 检查账号状态
npm run state:check

# 2. 回注上次软失败账号（如有）
npm run recycle

# 3. 启动批量
npm run batch

# 4. 批次结束后查看失败原因
npm run result:check -- --last-batch
```

---

## 对 AI / Agent 的工作约束

### ✅ 允许修改的范围

| 范围 | 说明 |
|------|------|
| `Dreamina/0.0.3/` | 主版本目录，包含 adapter、配置、状态管理 |
| `Dreamina/0.0.3/config.json` | 运行时参数调整 |
| `account-state/*.js` | 维护脚本（state-doctor / result-doctor / recycle-retry） |
| `docs/` | 架构文档、分析报告 |
| `shared-*/README.md` | 只补充说明，不改代码 |

### ❌ 禁止修改

| 范围 | 原因 |
|------|------|
| `account-state/*.json` | 账号凭证，仅由运行时写入，禁止手动覆盖 |
| `shared-*/*.js`（业务逻辑部分） | 共享骨架，改动影响所有平台 |
| `tests/` | Playwright E2E 测试，不属于框架逻辑 |
| `node_modules/` | 依赖包，不手动修改 |
| `Dreamina/history/` | 归档版本，不修改 |

### 状态文件所有权矩阵

| 文件 | 唯一写入者 | 读取者 |
|------|-----------|--------|
| `account-state/local-accounts.json` | 人工 / `recycle-retry.js` | batch-runner / register CLI |
| `account-state/registered-accounts.json` | batch-runner | 人工查询 / state-doctor |
| `account-state/blacklisted-accounts.json` | batch-runner | 人工查询 |
| `account-state/retry-accounts.json` | batch-runner | `recycle-retry.js` |
| `account-state/known-accounts.json` | batch-runner | batch-runner 启动时 |
| `batch-results/accounts-done.txt` | batch-runner | batch-runner 启动时（EVO-13 断点续跑） |
| `Dreamina/0.0.3/config.json` | 人工维护 | batch-runner / register CLI（启动时读取） |

### 修改代码后补文档规则

| 修改内容 | 需更新的文档 |
|----------|------------|
| 新增失败原因码 | `ARCHITECTURE_CONTRACTS.md` Blacklist/Retry 规则表 |
| 新增 shared-* 模块 | `docs/SHARED_MODULES_OVERVIEW.md` + 对应 `README.md` |
| 修改账号状态流转 | `ARCHITECTURE_CONTRACTS.md` 状态机图 |
| 修改目录写入路径 | `docs/目录边界收敛报告.md` |
| 新增 npm script | 本 `README.md` 快速开始章节 |

---

## 后续维护建议

1. **新增 shared 模块**：在 `shared-*/` 下创建目录，必须同时新建 `README.md`，并更新 `docs/SHARED_MODULES_OVERVIEW.md`
2. **新增平台适配**：创建 `NewPlatform/0.0.1/Sn-*/adapter.js`，不修改任何 `shared-*` 代码
3. **新增失败分类**：在 `failure-classifier.js` 和 `Dreamina-batch-runner.js` 的 `isBlacklistFailure / isAccountRetryFailure` 中同步添加，并更新 `ARCHITECTURE_CONTRACTS.md`
4. **清理 session-records/**：超过 500 个文件时，将 7 天前的文件移到 `session-records/archive/`（见 `docs/目录边界收敛报告.md` 附录脚本）
5. **补充账号池**：将新账号（`email:password` 格式）写入 `account-state/local-accounts.json`，执行 `npm run doctor` 确认无冲突后再批跑
