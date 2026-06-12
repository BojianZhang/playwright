# account-state/ — 数据层:运行态 JSON + 读写模块

在三引擎架构中的定位见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。本目录是**跨任务、跨重启、跨进程**的运行态数据 + 其薄读写模块。

## ✅ 负责
- 持久化数据(JSON):`card-pool.json`(卡池,★含完整卡号/CVC)、`accounts.json`(账号台账)、`billing-ledger.json`(充值台账)、`error-log.json`、`policy.json`(失败策略覆盖)、各 `*.backup*/*.bak.*`。
- 薄读写模块:`account-store.js`(账号增删查/黑名单/续跑判定)、`policy-store.js`(用户策略覆盖,守护式)。

## ❌ 不负责
- **业务逻辑** → 卡池语义在 `../billing/card-pool.js`、账号编排在 `../playwright/`;本层只存取。
- **card-pool.json 的字段语义** → 由 `../billing/card-pool.js`(Node)与 `../selenium-e2e/common.py`(Python)双方共同约定(两端读写同一文件)。

## ★安全(最高优先级)
- `card-pool.json`/`accounts.json`/`billing-ledger.json` 及所有备份含**真实卡号·CVC·邮箱·密码·API key** → **全部 gitignore,绝不入库**。
- 跨进程提醒:Node(`createMutex`)与 Python(`_CARD_LOCK`)各自进程内加锁,但**不互斥**;生产建议同一卡池单写端(别 Node 与 Python 同时写)。

## 依赖
被 `../playwright/`(account-store/error-log)、`../billing/`(卡池/台账落盘)、`../web/`(展示)、`../selenium-e2e/common.py`(同读 card-pool.json)使用。本层不反向依赖任何引擎。
