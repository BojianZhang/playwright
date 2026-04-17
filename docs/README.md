# D:\playwright\docs — 分析与治理文档索引

> 规范：**所有分析输出、架构备注、差距比对、设计决策记录、治理审计**统一存放于此目录。  
> 文件命名格式：`YYYY-MM-DD-<主题>.md`  
> 最后更新：2026-04-17

---

## 文件清单（按时间倒序）

| 文件名 | 日期 | 状态 | 内容摘要 |
|--------|------|------|---------|
| **[SHARED_MODULES_OVERVIEW.md](./SHARED_MODULES_OVERVIEW.md)** | 2026-04-17 | 🟢 常青 | 11 个 shared-* 模块的职责一览、依赖约束、扩展规则 |
| **[目录边界收敛报告.md](./目录边界收敛报告.md)** | 2026-04-17 | 🟢 最新 | 四目录职责定性 + 边界重叠清单 + KNOWN_EXISTS 迁移落地 + session-records 归档建议 |
| **[自动验收闭环落地报告.md](./自动验收闭环落地报告.md)** | 2026-04-17 | 🟢 最新 | state-doctor / result-doctor / smoke-register 三脚本落地，package.json 新增 5 条 npm scripts |
| **[新框架能力缺口分析-v2.md](./新框架能力缺口分析-v2.md)** | 2026-04-17 | 🟢 最新 | 五项检查：自动验收、机器可读状态机、编排入口、目录边界、Agent 拖慢点。TOP 3：P1 失败路由策略文件、P2 CLI runtime 漂移、P3 done.txt 双写 |
| **[2026-04-17-governance-audit.md](./2026-04-17-governance-audit.md)** | 2026-04-17 | 🟢 最新 | 仓库级治理审计：目录职责矩阵、.gitignore 修复、状态机文档落地、P1~P3 收束 |
| [2026-04-17-arch-review-v0.0.2-vs-0.0.3.md](./2026-04-17-arch-review-v0.0.2-vs-0.0.3.md) | 2026-04-17 | 🟡 部分关闭 | 架构评审报告：D1~D6 问题清单（D2/D3 已关闭，D1/D6 仍开启） |
| [2026-04-16-p0-fix-plan.md](./2026-04-16-p0-fix-plan.md) | 2026-04-16 | 🟡 部分关闭 | P0 修复计划（代理互斥锁已落地，热剔除部分实现） |
| [2026-04-16-comprehensive-analysis.md](./2026-04-16-comprehensive-analysis.md) | 2026-04-16 | 🟡 部分关闭 | 全项目综合分析：15 项缺口（约 10 项已通过后续迭代解决） |
| [2026-04-16-arch-gap-analysis.md](./2026-04-16-arch-gap-analysis.md) | 2026-04-16 | 🟢 已关闭 | config.json、代理互斥锁、失败分类已全部落地 |
| [architecture_analysis.md](./architecture_analysis.md) | 2026-04-15 | 🔵 历史 | 新旧架构对比（快照，不再更新） |
| [project_analysis.md](./project_analysis.md) | 2026-04-15 | 🔵 历史 | 项目整体分析（快照，不再更新） |

---

## 当前架构状态（2026-04-17 治理审计后更新）

```
D:\playwright\
├── shared-*/                   ← 框架层（11个模块，S0~S6 调度骨架，零平台依赖）
│   ├── shared-utils/           ← 工具层（有 README，含 config-schema/doctor）
│   ├── shared-credential/      ← S2 凭据提交骨架
│   ├── shared-verification/    ← S3 验证码提交骨架（含 resend-on-timeout）
│   └── shared-*/               ← S0/S1/S4/S5/S6 各阶段骨架
│
├── Dreamina/
│   └── 0.0.3/                  ← 新架构运行包（当前主力）
│       ├── Sn-*/               ← 各阶段业务 adapter
│       ├── account-state/      ← 账号生命周期状态（NEW，本轮落地）
│       │   ├── local-accounts.json       ← 待注册池（.gitignore 保护）
│       │   ├── registered-accounts.json  ← 已完成存档（.gitignore 保护）
│       │   ├── blacklisted-accounts.json ← 硬失败黑名单（.gitignore 保护）
│       │   ├── retry-accounts.json       ← 软失败待重试（.gitignore 保护）
│       │   ├── recycle-retry.js          ← 软失败回注工具（NEW）
│       │   └── README.md                 ← 边界说明
│       ├── docs/               ← 版本级文档（ARCHITECTURE_CONTRACTS.md）
│       ├── batch-results/      ← 单次批量跑汇总（.gitignore 保护）
│       ├── session-records/    ← Session 详细日志（.gitignore 保护）
│       ├── results/            ← CLI 单跑结果（.gitignore 保护）
│       ├── config.json         ← 运行时统一配置
│       ├── failure-classifier.js
│       ├── Dreamina-batch-runner.js      ← 批量并发入口（116KB）
│       └── Dreamina-register.js          ← 单次注册协调器（103KB）
│
├── docs/                       ← 仓库级治理文档（本目录）
├── .gitignore                  ← 已更新：覆盖 account-state/*.json 等敏感文件
└── package.json                ← scripts: start/run/batch → Dreamina/ 转发层
```

---

## 已确认开放问题（需后续跟进）

| 编号 | 问题 | 严重度 | 来源文档 |
|------|------|--------|---------|
| D1 | `Dreamina-register.js` 内嵌 entry stage 业务逻辑，与 `S1-entry/adapter.js` 双实现 | 中 | 2026-04-17-arch-review |
| D6 | `failure-classifier.js` 与 `batch-runner.js` 内失败判断逻辑并行存在，漂移风险 | 中 | 2026-04-17-arch-review |
| - | `session-records/` 无归档/清理策略（当前 310+ 子文件） | 低 | 2026-04-17-gap-analysis |
| - | `results/` vs `batch-results/` 双轨并存，未来整合为单一 output 体系 | 低 | 2026-04-17-gap-analysis |

---

## 已关闭问题（2026-04-17 本轮收束）

| 问题 | 落地文件 |
|------|---------|
| 账号状态文件散放根目录 | `account-state/` 目录建立，文件迁移完成 |
| retry 软失败无回注机制 | `account-state/recycle-retry.js` |
| blacklist/retry 无自动写入逻辑 | `Dreamina-batch-runner.js → isBlacklistFailure / isAccountRetryFailure / appendToAccountStateFile` |
| 无统一架构约束文档 | `Dreamina/0.0.3/docs/ARCHITECTURE_CONTRACTS.md` |
| shared-utils 无 README | `shared-utils/README.md` |
| .gitignore 未覆盖账号数据 | `.gitignore`（本轮更新） |
| CLI 单跑存在多余 exists precheck | `Dreamina-register.js` 传入 `skipCredentialExistsPrecheckAfterEmail` flag |
| 验证码超时无 resend 逻辑 | `verification-submit.js` resend-on-timeout 链路 |
| 域名黑洞无预过滤 | `config.json → batchFilter.skipEmailDomains` + batch-runner 启动过滤 |
