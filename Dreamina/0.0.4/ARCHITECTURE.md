# Dreamina 0.0.4 — 架构总图

本目录是 Dreamina（CapCut）账号自动化的 **自包含、分层** 实现，架构对齐参考项目 `Openrouter/0.0.1/`。
完整流程：**注册 → 邮箱验证(firstmail) → 生日 → 升级选套餐 → 收银台加卡支付 → 账号交付**。

> 改动前先读对应目录/文件头部的「边界说明（BOUNDARY）」注释。

```
Dreamina/0.0.4/
├── config/          config.json（非密，31+upgrade+billing 节）/ config.local.json（密钥，gitignore）
├── data/            运行产物（gitignore）：card-pool.json★含卡号 / billing-ledger.json / batch-results/ / results/ / session-records/ / proxy-health.json
├── account-state/   账号状态机：local/registered/blacklisted/retry/known + recycle-retry / state-doctor / result-doctor
├── lib/             ★vendored 公共骨架（自包含，零外部 shared-* 依赖）
│   ├── utils/             日志/计时/选择器/profile/firstmail-api/config-schema… （← shared-utils）
│   ├── browser-runtime/   浏览器/页面创建（← shared-browser-runtime）
│   ├── batch-orchestration/ 任务队列/worker-state/mutex（← shared-batch-orchestration）
│   ├── window-layout/     多窗口布局（← shared-window-layout）
│   └── stage-runners/     9 个「阶段公共 runner」（adapter 注入式）：proxy-precheck/entry/credential-submit/
│                          verification-submit/profile-completion-submit/post-auth-ready/upgrade★/payment★/account-delivery
├── playwright/      编排层 + 各阶段内容适配器
│   ├── Dreamina-register.js     单账号编排（注册表 + stageOrder S0→S8 + 流程）
│   ├── Dreamina-batch-runner.js 批量编排（并发/代理/账号状态/续跑）
│   ├── failure-policy.js        ★失败策略单一来源（原 failure-classifier + 原内联 6 决策谓词）
│   ├── cli-billing-flags.js     --dry-run/--plan/--tab/--amount… → env 覆盖
│   ├── smoke-register.js  tools/check-profiles.js  tests/（node:test 回归）
│   └── stages/  S0..S8 内容适配器（页面操作 + profiles/*.json 选择器单一来源）
├── billing/         ★加卡支付基础设施（← Openrouter/billing，~70% 复用）
│   ├── card-pool.js  billing-ledger.js  address-gen.js  env-tunables.js  taxfree-zips.js
│   └── card-fill/   index(引擎链) + fill-primitive + human-behavior + selectors★(改为 pipopayment 收银台) + engines/{playwright★,osinput}
├── browser-provider/ 指纹浏览器/代理池抽象（← Openrouter，adspower 等；Dreamina 主流程用 lib/browser-runtime，本目录为可选替代）
└── web/             Node-only 控制台（server + event-bus + engine-runner + card-store + public/ 原生控制台页）
```

## 9 阶段流水线（对应用户 6 步需求）

| 阶段 | runner（lib/stage-runners） | 内容适配器（playwright/stages） | 用户步骤 |
|---|---|---|---|
| S0 proxy-precheck | proxy-precheck.js | S0-proxy-precheck/ | （前置：代理健康） |
| S1 entry | entry.js + site-entry-health.js | S1-entry/（**门面 entry-stage-adapter.js** 收口原 3 处胶水） | 1. 打开站点 + Sign in |
| S2 credential | credential-submit.js | S2-credential/ | 1. Continue with email → Sign Up → 邮箱+密码 → Continue |
| S3 verification | verification-submit.js | S3-verification/ | 2. firstmail 取验证码回填 |
| S4 profile-completion | profile-completion-submit.js | S4-profile-completion/ | 4. 选生日 → Continue |
| S5 post-auth-ready | post-auth-ready.js | S5-post-auth-ready/ | 4. 确认登录就绪 |
| **S7 upgrade★** | upgrade.js | **S7-upgrade/** | 5. 关 Octo 弹窗 → Upgrade → 选 tab+套餐 → 跳收银台 |
| **S8 payment★** | payment.js | **S8-payment/** | 6. 选信用卡 → 填卡 → Pay |
| S9 account-delivery | account-delivery.js | S6-account-delivery/ | 交付（含 plan/billing 字段） |

> stageOrder：`proxyPrecheck→entry→credential→verification→profileCompletion→postAuthReady→upgrade→payment→accountDelivery`。
> 每阶段返回统一 `StageResult{success,stage,state,reason,nextStage,detail}`；fail-fast；S7 把 `cashierPage` 经 `stageResults.upgrade.detail.cashierPage` 交给 S8。

## 加卡支付（S7/S8 + billing）

- **S7 upgrade**：`config.upgrade.{tab,plan,dismissOctoPopup,...}` 驱动；选择器/文案在 `stages/S7-upgrade/profiles/`。跳转检测兼容**新标签页**（hosted checkout 常开新 tab）。
- **S8 payment**：收银台 `cashier.pipopayment.us` 是**普通托管页（非 Stripe 跨域 iframe，无账单地址字段）**。流程：选信用卡 → 卡池 `acquire` → `card-fill` 填卡（卡号/CVC/有效期/**持卡人姓名**，姓名取 address-gen 生成名）→ 点 Pay → 判定 → 卡池 `report(success|declined|error)` + 写 `billing-ledger`；declined 换卡（`maxCardTries`）。
- **真实扣款开关**：`config.billing.realCharge` **默认 true（真实扣款）**。`--dry-run`（或 web Dry-run 勾选）→ `DREAMINA_REAL_CHARGE=0` → **填完卡但不点 Pay、卡不计用量**（零成本验证选择器/流程）。
- **失败语义**：`PAYMENT_SUCCESS / PAYMENT_DECLINED_EXHAUSTED / PAYMENT_NO_CARD / PAYMENT_DRY_RUN / PAYMENT_CASHIER_TIMEOUT / PAYMENT_PAGE_CLOSED`。

## Web 控制台（Node-only）

`node web/server.js`（端口 `DREAMINA_WEB_PORT`，默认 4417）。提供：开始批量跑、9 阶段实时 SSE 进度/日志、卡池导入/启停/快照、套餐/支付设置写回 config。
引擎驱动 `engine-runner.js` **不 spawn Python**（Dreamina 纯 Node），而是子进程拉起 `Dreamina-batch-runner.js` 并把 stdout/stderr 按行转 SSE。

## 已完成 vs 后续增强

**已完成并通过验证**（85 个 .js 全 `node --check`、0 跨模块 require、15 个 node:test 全绿、web 端点实测）：
自包含分层结构、S0–S8 九阶段流水线、S1 三处胶水收口为单门面（register 从 2549→1397 行）、failure-policy 收口（6 谓词 + 分类器同文件）、billing 复用 + 收银台适配、S7/S8 新阶段、CLI/env 旗标、Node-only 控制台 + 卡池/设置管理。

**后续增强（建议）**：
1. `Dreamina-batch-runner.js` 进一步拆分（account-pool-manager / proxy-allocator / result-aggregator / summary-builder / cli-args）——本次已做最高价值的 failure-policy 收口，其余因「改动核心编排器无法在此离线真机验证」按行为保真留待增量拆分。
2. 完整 React SPA（移植 `Openrouter/0.0.1/web/src` 各页）——当前为功能完备的原生控制台页，足以开跑/看进度/管卡/改设置。
3. S7/S8 **真机选择器验证**：第三方页面（升级弹窗、pipopayment 收银台）HTML 可能改版；用 `--dry-run` 作为零成本回归即可快速校正 profile 选择器。

## 从 0.0.3 切换（**未自动执行，需人工确认**）

0.0.3 仍原样保留；0.0.4 在其旁并存。切换步骤（你的本地运行态数据是 gitignore 的，须手动迁移）：
1. 迁移运行态数据：把本机 `Dreamina/0.0.3/account-state/{local,registered,blacklisted,retry}-accounts.json`、`proxies.txt`、`proxy-health.json` 等放到 `Dreamina/0.0.4/` 对应位置（account-state/ 同名；proxies.txt 放 0.0.4 根；其余产物入 `data/`）。
2. 切换根入口转发：把 `Dreamina/Dreamina-batch-runner.js` 的 `require('./0.0.3/...')` 改为 `require('./0.0.4/playwright/Dreamina-batch-runner')`。
3. 归档：`git mv Dreamina/0.0.3 Dreamina/history/0.0.3`。
> ⚠ 切换后默认流程将包含 S7/S8（升级+真实扣款）——务必先用 `--dry-run` 或 `--no-billing` 验证再开真扣。

## 验证命令

```bash
cd Dreamina/0.0.4
npm test                          # 15 个离线回归（failure-policy / cli-flags / card-pool）
node playwright/tools/check-profiles.js   # S0–S8 profile 完整性
node playwright/smoke-register.js --skip-preflight   # S0–S? 链路接线（需账号/代理数据）
node web/server.js                # 控制台 → http://127.0.0.1:4417
# 真机安全验证 S7/S8（零成本）：开 Dry-run，填完卡不点 Pay，核对四字段已回填
```
