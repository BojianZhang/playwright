# shared-billing — billing 纯工具层

> **层级定位**：跨产品共享的 **billing 纯工具**，零状态、零业务编排、零平台 adapter 耦合。
> **约束**：本目录任何文件**不得**引用 `Dreamina/`、`Openrouter/`、`GLM/`、`shared-browser-runtime/`；只依赖 node 内置或本目录纯同侪。
> 从 OR/0.0.1、GLM/0.0.1、Dreamina/0.0.4 三处**逐字相同**的副本收口于此，各项目原位置保留一行 re-export shim。

---

## 准入边界（什么能放进来 / 什么不能）

**✅ 准入**
- 无状态、无副作用（或副作用只作用于调用方显式传入的资源，如传入的 page）。
- 不用 `__dirname`/`process.cwd()` 解析项目本地路径；不绑定具体 `data/` 文件。
- 跨产品语义一致（三端共用同一份 `card-pool.json` 时数值口径必须一致）。

**❌ 不准入（放别处）**
- 带 `data/` 落盘的 `card-pool.js`、`billing-ledger.js` —— 走去重路线图**第二层**「传 `dataDir` 的共享工厂」。
- 按引擎分化的 `card-fill/engines/*`（playwright/selenium/api/extension/osinput）—— 各产品自留或单独抽核心。
- 站点专属选择器 `card-fill/selectors.js`、收银台编排 —— 按产品分化，不强并。
- 反检测核心规避逻辑 —— 见仓库工程边界，**只搬运既有实现，不在此硬化**。

---

## 模块清单（职责 + 边界）

| 文件 | 职责 | 边界（不该做什么） |
|------|------|------|
| `address-gen.js` | 生成美国真实感账单地址（姓名/街道/城市/州/ZIP；默认免税州） | 纯数据生成；不发请求、不填表单 |
| `taxfree-zips.js` | 免税州 ZIP 表 + `buildZipCandidates`（declined 后 ZIP 重试自救） | 纯数据 / 纯函数；不决定何时重试 |
| `env-tunables.js` | 从 `process.env`(优先) → `cfg.billing.*`(兜底) → 硬默认 读 billing 可调参（`envInt/envFloat`） | 只读取/归一参数；阈值的**业务决策**不在这里 |
| `card-fill/fill-primitive.js` | 跨主框架 + 子 iframe 找首个可见输入框并可信填值（`fillAcross/humanPause`） | 只做「找到可见框并填」；**不知道**填的是卡号还是 CVC、不决定填什么 |
| `card-fill/human-behavior.js` | 拟人节奏/轨迹原语（`moveMouseTo/readingDwell/warmup/rand`） | 只产生时序/轨迹；★行为维度反风控补充，**按工程边界只搬不强化** |

> 数值口径铁律：`env-tunables` 的默认值必须对齐 Selenium 侧（`common.py`/`hybrid_run.py`），
> 否则 Node 与 Python 两端共用同一份 `card-pool.json` 时语义会漂移（见 `taxfree-zips` 对齐 `steps_billing.py`）。

---

## shim 契约（改这里，不改 shim）

- **规范实现在本目录**；各项目原位置（`<项目>/billing/[card-fill/]<name>.js`）是一行 re-export shim：
  ```js
  module.exports = require('../../../shared-billing/<name>');           // billing/<name>.js
  module.exports = require('../../../../shared-billing/card-fill/<name>'); // billing/card-fill/<name>.js
  ```
- shim 只为兼容现存 `require('./<name>')` / `require('../fill-primitive')` 调用点。**改逻辑改这里，绝不改 shim**。
- 新增共享模块：① 放本目录 ② 各项目原位置改 shim（相对路径按文件深度算）③ 跑下方验证。

## 漂移规则 + 验证

- 收口/合并近似文件时**取正确超集**，绝不丢某个 fork 的修复。
- 改完必跑：
  ```bash
  node --check shared-billing/**/*.js
  node --test Openrouter/0.0.1/billing/*.test.js GLM/0.0.1/billing/*.test.js \
              Dreamina/0.0.4/playwright/tests/*.test.js     # 行为不变
  # 并确认身份：require(项目 shim) === require(shared 规范实现)
  ```
