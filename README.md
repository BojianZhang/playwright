# D:\playwright — 浏览器自动化多平台仓库(Dreamina · OpenRouter · GLM)

> **面向**:人类维护者 + AI Agent
> **更新时间**:2026-06-17
> **v1.0.2** | Node.js + Playwright + Python/Selenium | 架构:`shared-*` 公共能力层 + 各平台适配层

---

## 项目简介

本仓库是一个**多平台浏览器自动化 monorepo**:用一套 `shared-*` 公共能力骨架 + 各平台专属适配层,实现多个目标站点的账号批量自动化。

- **当前已接入 3 个平台**:
  - **Dreamina**(`Dreamina/`)—— 批量**注册** dreamina 账号(Playwright,7 阶段 S0–S6)。
  - **OpenRouter**(`Openrouter/`)—— 账号**全生命周期**:注册 → 取 API Key → 绑卡(Stripe)→ 充值(Selenium+Playwright 混合 + Node Web 控制台)。
  - **GLM / z.ai**(`GLM/`)—— chat.z.ai 账号全生命周期:注册(滑块拼图)→ 建 Key → 订阅 GLM Coding Plan 付费(纯 Selenium,架构移植自 OpenRouter)。
- **为什么用 `shared-*` 模块化**:把"代理预检 / 浏览器运行时 / 窗口布局 / 批量调度 / 账单工具 / 控制台 store / 前端 UI 原语 / 通用工具"等**跨平台可复用**的能力抽成公共层,平台专属逻辑(选择器、错误解析、支付流程)通过 adapter / lib 注入,**不进 `shared-*`**。新增平台只加自己的适配层,不改共享层。
- **历史背景**:本仓库最初只做 Dreamina;OpenRouter/GLM 是后续加入的独立平台,各自自包含(有独立 `config`/`data`/`web`/安装脚本)。下方"快速开始"的 `npm run *` 脚本**只服务 Dreamina**;OpenRouter/GLM 有各自的入口与控制台。

---

## 平台总览

| 平台 | 版本 | 做什么 | 主引擎 | 主入口 | 控制台 | 平台文档 |
|------|------|--------|--------|--------|--------|---------|
| **Dreamina** | `0.0.3`(已接线生产)<br>`0.0.4`(自包含重构,未切换) | 批量注册 dreamina 账号 | Playwright(S0–S6) | `npm run batch` | `0.0.4` 带 Web `:4417` | [0.0.3 ARCHITECTURE_CONTRACTS](./Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md) · [0.0.4 ARCHITECTURE](./Dreamina/0.0.4/ARCHITECTURE.md) |
| **OpenRouter** | `0.0.1` | 注册→取Key→绑卡→充值 | Selenium+PW 混合 / Web-PW / split | `python selenium-e2e/hybrid_run.py`<br>+ `node web/server.js` | Web `:4317`(`OPENROUTER_WEB_PORT`) | [项目说明文档](./Openrouter/0.0.1/项目说明文档.md) · [ARCHITECTURE](./Openrouter/0.0.1/ARCHITECTURE.md) |
| **GLM(z.ai)** | `0.0.1` | 注册(滑块)→建Key→订阅付费 | 纯 Selenium | `node web/server.js` + Python | Web `:4317`(`GLM_WEB_PORT`) | [GLM README](./GLM/0.0.1/README.md) |

> OpenRouter 与 GLM 默认都用 `:4317` —— 同机同时跑需用各自环境变量改端口避免冲突。

---

## 仓库结构总览

```
D:\playwright\
├── README.md                          ← 本文件(仓库入口)
├── package.json                       ← npm scripts(★均为 Dreamina;见"快速开始")
├── playwright.config.ts               ← Playwright 测试配置(仅 tests/)
├── .gitignore                         ← 保护账号/卡/凭证数据不进版本控制
│
├── docs/                              ← 仓库级架构文档与治理记录(主要面向 Dreamina/shared-*)
│
├── Dreamina/                          ← 平台① Dreamina(批量注册)
│   ├── Dreamina-batch-runner.js       ← 兼容转发入口(指向 0.0.3/)
│   ├── 0.0.3/                         ← 当前已接线主版本(npm scripts 指向这里)
│   │   ├── Dreamina-batch-runner.js / Dreamina-register.js   ← 批量编排 / 单账号 CLI
│   │   ├── S0-proxy-precheck/ … S6-account-delivery/         ← 7 阶段平台 adapter
│   │   ├── account-state/             ← 账号生命周期状态(跨批次持久化)
│   │   ├── failure-classifier.js / config.json / docs/
│   │   └── batch-results/ session-records/ results/
│   ├── 0.0.4/                         ← 自包含重构版(独立 config/data/web/lib,Web :4417,未切换)
│   └── history/                       ← 归档旧版本(v0.0.2)
│
├── Openrouter/                        ← 平台② OpenRouter(全流程:取Key/绑卡/充值)
│   ├── 0.0.1/                         ← 主版本:playwright/ + selenium-e2e/ + web/(:4317) + billing/ + data/
│   │   └── 项目说明文档.md / ARCHITECTURE.md / docs/        ← 平台文档(从这里入门)
│   └── adspowerPlus/                  ← AdsPower 辅助
│
├── GLM/                               ← 平台③ GLM / z.ai(纯 Selenium,订阅付费)
│   └── 0.0.1/                         ← selenium-e2e/ + web/(:4317) + README.md + docs/
│
├── ── 共享能力层(shared-*)───────────────────────────────
├── shared-utils/                      ← 通用工具(日志/计时/配置/Firstmail API/文件/locator),依赖树最底层
├── shared-browser-runtime/            ← Playwright 浏览器实例创建与指纹管理
├── shared-window-layout/              ← 多浏览器窗口并发布局计算
├── shared-batch-orchestration/        ← 批量并发调度(task-queue/worker-state/proxy-mutex)
├── shared-proxy-precheck/  (S0)       ┐
├── shared-entry/           (S1)       │
├── shared-credential/      (S2)       │  Dreamina 注册 7 阶段「骨架」
├── shared-verification/    (S3)       │  (stage orchestrator;平台实现由 adapter 注入)
├── shared-profile-completion/ (S4)    │
├── shared-post-auth-ready/ (S5)       │
├── shared-account-delivery/ (S6)      ┘
├── shared-billing/                    ← ★跨产品 billing 纯工具(卡池/填卡/台账/地址;OpenRouter/GLM/Dreamina0.0.4 共用)
├── shared-console-stores/             ← ★Web 控制台后端落盘 store 工厂层
├── shared-web-ui/                     ← ★React 控制台「产品中立」UI 原语 + 工具库
│
├── scripts/                           ← 仓库级脚本(run-secret-scan.js / secret_scan.py 等)
├── tools/                             ← 仓库级工具(fingerprint_probe.js 等)
├── output/                            ← 临时调试产物(截图等,可清理)
├── tests/ + test-results/             ← Playwright E2E 测试 + 产物
└── node_modules/
```

> **共享层的两个家族**:① **Dreamina 注册 7 阶段骨架**(S0–S6,见 [SHARED_MODULES_OVERVIEW](./docs/SHARED_MODULES_OVERVIEW.md));② **跨产品基础库**(`shared-utils`/`shared-browser-runtime`/`shared-window-layout`/`shared-batch-orchestration` + 新增 `shared-billing`/`shared-console-stores`/`shared-web-ui`)。后三个是 OpenRouter/GLM/Dreamina-0.0.4 去重抽出的共用层。

---

## Dreamina 平台(注册流水线)

> 这是仓库最早、`npm run *` 直接驱动的平台。OpenRouter/GLM 见各自平台文档。

### 主入口与流程
```bash
npm run batch      # = node Dreamina/Dreamina-batch-runner.js → 透传 0.0.3/
# CLI 单账号调试:
node Dreamina/0.0.3/Dreamina-register.js --account-index 0 --proxy-index 5 --headed --slow-mo 200
```

注册流程阶段(S0 → S6),每个 `shared-*` 提供**阶段骨架**,`Sn-*/adapter.js` 提供**平台专属实现**:
```
S0 proxy-precheck    代理健康预检          shared-proxy-precheck    → S0-proxy-precheck/adapter.js
S1 entry             入口页加载与检测       shared-entry             → S1-entry/adapter.js
S2 credential        邮箱+密码填写提交       shared-credential        → S2-credential/adapter.js
S3 verification      邮件验证码获取与填写    shared-verification      → S3-verification/adapter.js
S4 profileCompletion 账号资料补全           shared-profile-completion → S4-profile-completion/adapter.js
S5 postAuthReady     登录后状态确认         shared-post-auth-ready   → S5-post-auth-ready/adapter.js
S6 accountDelivery   账号交付与结果输出      shared-account-delivery  → S6-account-delivery/adapter.js
```

### 批量调度机制
`Dreamina-batch-runner.js` 启动时:① 读 `config.json` 跑 config-doctor;② 读 `account-state/local-accounts.json` → 过滤已完成(断点续跑)+ 域名黑洞;③ 经 `shared-batch-orchestration` 分发并发 Worker(默认 `concurrency=2`);④ 每 Worker 独占代理串行 S0→S6;⑤ 结束写状态(`account-state/` 分流)+ 批次结果(`batch-results/`)。

### 四目录职责边界
| 目录 | 定性 | 可清理 | 进版本控制 |
|------|------|--------|-----------|
| `account-state/` | **状态源**(跨批次持久化) | ❌ 不可随意删 | ❌(含凭证,在 .gitignore) |
| `batch-results/` | **批次运行产物** | ✅ | ❌ |
| `session-records/` | **会话证据**(纯只写) | ✅ 可归档 | ❌ |
| `results/` | **CLI 单跑输出**(调试) | ✅ | ❌ |

### Retry vs Blacklist
| 类型 | 触发条件(示例) | 写入文件 | 后续 |
|------|----------|---------|---------|
| **Blacklist(永不重试)** | `SIGNUP_REJECTED`、`IP_BANNED`、`VERIFICATION_CODE_RATE_LIMITED` | `blacklisted-accounts.json` | 不回注,人工审查 |
| **Retry(可重试)** | `PROXY_CONNECTIVITY_FAILED`、`ENTRY_HEALTH_FAILED`、`CREDENTIAL_SUBMIT_RESULT_UNKNOWN` | `retry-accounts.json` | `npm run recycle` 回注后重跑 |

> 判定逻辑:`Dreamina/0.0.3/Dreamina-batch-runner.js` → `isBlacklistFailure()` / `isAccountRetryFailure()`。

---

## OpenRouter 平台(取Key / 绑卡 / 充值)

完整的账号全流程自动化系统(三引擎 + 共享库 + 数据层),含一个功能完备的 **Node Web 控制台(`:4317`)**:批量下发向导、SSE 实时进度、运行历史/详情、结果聚合(改密 / 取新Key / 导出)、全部资源池管理、失败分析、系统健康、集群聚合。

- **入门文档**:[Openrouter/0.0.1/项目说明文档.md](./Openrouter/0.0.1/项目说明文档.md)(说明 + 架构 + 24 页功能总览)。
- **快速跑**:
  ```bash
  cd Openrouter/0.0.1
  start.bat                       # Windows:装好后启动 Web 控制台 :4317
  # 或命令行混合引擎(最稳):
  python selenium-e2e/hybrid_run.py --accounts a.txt --proxies p.txt --op-pw 'pw' --concurrency 3
  ```
- **核心壁垒**:**Fix C 原生 CDP 绑卡**(脱 chromedriver 躲 Stripe 检测)、纯 Selenium 过 Turnstile、登录 factor-two 邮箱 OTP、加卡抗 Radar(切IP/换卡)、逐阶段续跑、碰钱多层防重。改这些前务必读平台文档与 `Openrouter/0.0.1/ARCHITECTURE.md`。

---

## GLM / z.ai 平台(订阅付费)

chat.z.ai(GLM Coding Plan)账号全生命周期:**注册(滑块拼图 + 邮箱链接验证)→ 登录 → 建 API Key → 订阅套餐 + 信用卡支付**。纯 Selenium + AdsPower,带 React 控制台(`:4317`,`GLM_WEB_PORT` 可改),逐阶段续跑 + 防重复扣款。架构移植自 OpenRouter/0.0.1(选择器/反检测/支付替换为 z.ai 的滑块 + 订阅)。

- **入门文档**:[GLM/0.0.1/README.md](./GLM/0.0.1/README.md) 及 `GLM/0.0.1/docs/`。

---

## 文档导航

### 仓库级 / 共享层
| 文档 | 作用 |
|------|------|
| [docs/README.md](./docs/README.md) | 仓库文档索引入口 |
| [docs/SHARED_MODULES_OVERVIEW.md](./docs/SHARED_MODULES_OVERVIEW.md) | 共享 `shared-*` 模块职责一览(以 Dreamina S0–S6 + 框架层为主) |
| [shared-utils/README.md](./shared-utils/README.md) · [shared-billing/README.md](./shared-billing/README.md) · [shared-console-stores/README.md](./shared-console-stores/README.md) · [shared-web-ui/README.md](./shared-web-ui/README.md) | 各共享层边界说明 |
| [docs/目录边界收敛报告.md](./docs/目录边界收敛报告.md) · [docs/新框架能力缺口分析-v2.md](./docs/新框架能力缺口分析-v2.md) | 目录边界 / 缺口分析 |

### Dreamina
| 文档 | 作用 |
|------|------|
| [Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md](./Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md) | **Agent 必读**:目录矩阵、状态机、判定规则 |
| [Dreamina/0.0.3/runtime-params.md](./Dreamina/0.0.3/runtime-params.md) | `config.json` 各参数说明 |
| [Dreamina/0.0.4/ARCHITECTURE.md](./Dreamina/0.0.4/ARCHITECTURE.md) | 0.0.4 自包含重构架构(及与 0.0.3 切换步骤) |

### OpenRouter / GLM
| 文档 | 作用 |
|------|------|
| [Openrouter/0.0.1/项目说明文档.md](./Openrouter/0.0.1/项目说明文档.md) | OpenRouter 总入口(说明 + 架构 + 功能) |
| [Openrouter/0.0.1/ARCHITECTURE.md](./Openrouter/0.0.1/ARCHITECTURE.md) | OpenRouter 三引擎边界 / 跨层契约 |
| [GLM/0.0.1/README.md](./GLM/0.0.1/README.md) | GLM(z.ai)平台说明 |

---

## 快速开始(Dreamina 平台)

> 以下 `npm run *` 脚本**只驱动 Dreamina**。OpenRouter/GLM 请用各平台目录下的 `install.*` / `start.*` 与 Python 入口。

```bash
# 安装依赖(仓库级)
npm install
npx playwright install chromium

# 批量注册(读 Dreamina/0.0.3/account-state/local-accounts.json)
npm run batch

# 日常诊断
npm run state:check        # 账号状态文件一致性
npm run result:check       # 结果文件健康(加 -- --last-batch 看失败分布)
npm run doctor             # 上两项合并

# 软失败账号回注 / 冒烟测试 / 清理产物
npm run recycle
npm run smoke
npm run reset       # 清 results/
npm run reset:all   # 清所有产物

# 质量与安全
npm run lint        # eslint
npm run format      # prettier
npm run secret-scan # 全仓密钥扫描(scripts/run-secret-scan.js)
```

**推荐批次前工作流**:`npm run state:check` → `npm run recycle` → `npm run batch` → `npm run result:check -- --last-batch`。

---

## 对 AI / Agent 的工作约束

### ✅ 允许修改
| 范围 | 说明 |
|------|------|
| `Dreamina/0.0.3/` · `Openrouter/0.0.1/` · `GLM/0.0.1/` | 各平台主版本目录(adapter/lib、配置、状态、web) |
| 各平台 `config.json` / `config/config.local.json` | 运行时参数(密钥只在 `*.local.*`,gitignore) |
| `account-state/*.js`(维护脚本)| state-doctor / result-doctor / recycle-retry |
| `docs/` 与各平台 `docs/` · `shared-*/README.md` | 文档(README 只补说明不改共享代码) |

### ❌ 禁止 / 谨慎
| 范围 | 原因 |
|------|------|
| `account-state/*.json` · `data/*.json`(卡池/账号/台账) | 含账号凭证/完整卡号,仅运行时写入,禁止手动覆盖(全 gitignore) |
| `shared-*/*.js`(业务逻辑)| 共享骨架,改动影响**所有平台** —— 改前确认跨平台影响 |
| 反检测核心(OpenRouter Fix C / Turnstile、GLM 滑块、指纹逻辑) | 已验证闭环,非必要不重写;先读对应平台 `memory/` 经验记录 |
| `tests/` · `node_modules/` · `Dreamina/history/` | 测试 / 依赖 / 归档,不改 |

### 状态文件所有权(Dreamina)
| 文件 | 唯一写入者 | 读取者 |
|------|-----------|--------|
| `account-state/local-accounts.json` | 人工 / `recycle-retry.js` | batch-runner / register CLI |
| `account-state/{registered,blacklisted,retry,known}-accounts.json` | batch-runner | 人工 / state-doctor / recycle |
| `Dreamina/0.0.3/config.json` | 人工 | batch-runner / register CLI(启动时) |

### 改代码后补文档规则
| 修改内容 | 需更新 |
|----------|------------|
| 新增平台 | 本 README「平台总览」+ 结构树 + 文档导航 |
| 新增/改 `shared-*` 模块 | [docs/SHARED_MODULES_OVERVIEW.md](./docs/SHARED_MODULES_OVERVIEW.md) + 对应 README + 确认跨平台影响 |
| 新增 Dreamina 失败原因码 | `Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md` Blacklist/Retry 规则表 |
| 改 OpenRouter/GLM 功能 | 对应平台 `项目说明文档.md` / `README.md` / `ARCHITECTURE.md` |
| 新增 npm script | 本 README「快速开始」 |

---

## 后续维护建议

1. **新增平台**:在仓库根建 `NewPlatform/0.0.1/`,自包含(自带 config/data/web/安装脚本);可复用 `shared-*` 但**不改共享层**;更新本 README 平台总览。
2. **新增 shared 模块**:`shared-*/` 下建目录 + `README.md`,更新 `docs/SHARED_MODULES_OVERVIEW.md`;若被多平台引用,改动前评估跨平台影响。
3. **Dreamina 失败分类**:在 `failure-classifier.js` 与 `Dreamina-batch-runner.js` 的 `isBlacklistFailure/isAccountRetryFailure` 同步,并更新 `ARCHITECTURE_CONTRACTS.md`。
4. **Dreamina 0.0.3 → 0.0.4 切换**:0.0.4 已自包含但 npm scripts 仍指向 0.0.3 —— 切换步骤见 `Dreamina/0.0.4/ARCHITECTURE.md`,需人工确认数据迁移。
5. **清理**:`session-records/` 超 500 文件归档 7 天前的;`output/`、各平台 `batch-results/` 可定期清理。
6. **补账号池**:Dreamina 写 `account-state/local-accounts.json`(`email:password`)后 `npm run doctor`;OpenRouter/GLM 走各自控制台导入或 `accounts*.txt`。
