# web/ — 引擎③ Node Web 控制台

在三引擎架构中的定位见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。本层是 http 控制台(默认 `:4317`,`OPENROUTER_WEB_PORT` 可改),把表单配置喂给引擎① 批量跑,并经 SSE 实时回推进度。

## ✅ 负责
- http 服务 + 静态页(`server.js` + `public/`:index.html / controller.js)。
- 接收前端表单(账号/代理/并发/billingAction/cardFillEngine/maxCardTries…),**校验后**调 `../playwright/Openrouter-job-runner` 跑批。
- SSE / 事件总线(`event-bus.js`)实时推 worker-update / 日志 / 卡池快照 / 账单台账。
- 集群主从:子机心跳上报、主机聚合多机进度(`/api/register` 等)。

## ❌ 不负责
- **页面自动化本身** → 全部委托引擎① `../playwright/`(web 只编排、不碰浏览器)。
- **卡池/台账数据** → 只读 `../billing/card-pool`、`../billing/billing-ledger`、`../data/*` 做展示,不自行定义其语义。
- **加卡 Fix C / 纯Selenium** → 那是 `../selenium-e2e/` 的命令行模式,web 不涉及。

## 关键文件 / 依赖
- `server.js` — 路由 + 调度;依赖 `../playwright/Openrouter-job-runner`、`../playwright/failure-policy`、`../playwright/error-log`、`../billing/card-pool`、`../billing/billing-ledger`、`../data/account-store`、`../data/policy-store`、`./event-bus`。
- `public/` — 前端(controller.js 组装 payload:`cardFillEngine` 默认 playwright、`billingAction` 由勾选阶段推导)。
- 启动:`node web/server.js`。
