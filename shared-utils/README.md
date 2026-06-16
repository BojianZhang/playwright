# shared-utils — 工具层模块说明

> **层级定位**：跨产品通用工具，零业务编排，零平台（Dreamina / OpenRouter / GLM）adapter 耦合。
> **约束**：本目录任何文件**不得**引用 `Dreamina/`、`Openrouter/`、`GLM/`、`shared-browser-runtime/` 或任何平台 adapter；只依赖 node 内置或本目录纯同侪。

---

## 准入边界（什么能放进来 / 什么不能）

收口到 shared-* 是为了消除三项目复制粘贴的「修复不传播」。**只有满足下列全部条件的模块才进 shared-utils**：

**✅ 准入**
- 无状态、无副作用（或副作用只作用于**调用方显式传入**的资源，如传入的 page/dataDir）。
- **不**用 `__dirname`/`process.cwd()` 去解析「项目本地」路径（带 `data/` 落盘的 store 不属于这里）。
- 只依赖 node 内置模块或本目录纯同侪。
- 跨产品语义一致：同一份输入 → 同一份输出。

**❌ 不准入（放别处）**
- 业务/产品编排逻辑（`server.js`、`engine-runner.js`、`pipeline.py` 那一类）—— 各产品自留，**绝不强并**。
- 平台 adapter / 浏览器运行时 —— 走 `shared-browser-runtime`。
- 反检测核心规避逻辑（指纹/验证码/Radar/卡池容量判定）—— 见仓库工程边界，不在此硬化。
- 带项目本地 `data/` 落盘的 `*-store.js` —— 走去重路线图**第二层**「传 `dataDir` 的共享工厂」，不是直接搬。

---

## 模块清单（职责 + 边界）

### A. 自动化通用工具（既有）

| 文件 | 职责 | 边界 |
|------|------|------|
| `stage-logger.js` | 阶段日志规范化输出（`…/▶/✔/✘`） | 只格式化输出，不决定流程 |
| `stage-runtime.js` | 阶段步骤状态同步 `syncStageStep` | 只同步状态对象 |
| `timing.js` | 高精度计时 `createTimer/formatMs` | 纯计时 |
| `until.js` | Promise 轮询等待 `until/waitFor` | 纯等待原语 |
| `config-schema.js` / `config-doctor.js` / `config-defaults.js` | config.json 约束/诊断/默认 | 通用 config，不含产品业务键 |
| `file-utils.js` | 文件读写（JSON 数组、行追加） | 路径由调用方传入 |
| `firstmail-api.js` | Firstmail 邮件 API 封装 | 只收信，不含注册流程 |
| `locator.js` / `page.js` | Playwright 定位/页面工具 | 只包装 page，不含站点步骤 |
| `profile.js` / `birthday.js` | 账号资料/生日随机生成 | 纯数据生成 |
| `worker-status-tracker.js` | Worker 状态实时跟踪 | 内存状态，不落盘 |

### B. Web 控制台后端运行时（2026-06 三项目去重收口）

| 文件 | 职责 | 边界（不该做什么） |
|------|------|------|
| `json-safe.js` | 容错读 JSON（`readJsonOr`：文件损坏不致命，**绝不静默退空覆盖**，★H4） | 只做安全读/校验；不绑定具体 `data` 文件、不含业务逻辑 |
| `spawn-safe.js` | `child_process` spawn 封装，默认 `windowsHide`（防 Win 黑窗） | 只管「怎么起子进程」；不决定起什么、不管生命周期 |
| `paginate.js` | offset 分页 + 读分页 query 参数 | 纯函数，只切数组/读参；不碰数据源 |
| `event-bus.js` | 进程内事件总线（环形缓冲 + Last-Event-ID 重放） | **单进程内存**；不跨进程、不持久化 |
| `proc-registry.js` | 在跑子进程登记 + 杀进程树 `killTree` | 只记 PID / 杀树；不决定「何时」杀 |
| `proc-cleanup.js` | 孤儿驱动清理（按镜像名，依赖 `proc-registry`） | **只杀 chromedriver 等驱动；绝不碰 chrome/AdsPower 本体** |

### C. 控制台配置 schema（OR↔GLM 共享）

| 文件 | 职责 | 边界 |
|------|------|------|
| `selectors-schema.js` | 元素选择器注册表（`STEPS/KEYS`，后端唯一真相源） | 纯数据；**仅 OpenRouter 系控制台（OR/GLM）共享**，非控制台产品（如 Dreamina）不引用 |
| `strategy-schema.js` | 环节策略后端镜像（`STAGES/DEFAULTS/KEYS` 白名单） | 纯数据；**必须与前端 `src/lib/strategySchema.ts` 同步**，改一处同步两处 |

> ⚠️ **C 组的耦合说明**：这两个 schema 编码的是「OpenRouter 系控制台」的领域知识（步骤名/选择器/环节），严格说不是平台中立工具。它们放这里是因为 OR 与 GLM（z.ai 移植）共用同一套控制台骨架。若将来出现「要用 shared-utils 但不要控制台 schema」的消费者，可把 C 组迁出到独立的 `shared-console-schema/` 包。

---

## shim 契约（改这里，不改 shim）

- **规范实现在本目录**；各项目原位置（`<项目>/web/<name>.js`）是一行 re-export shim：
  ```js
  module.exports = require('../../../shared-utils/<name>');
  ```
- shim 只为兼容现存 `require('./<name>')` 调用点。**改逻辑改这里，绝不改 shim**。
- 新增共享模块：① 放本目录 ② 各项目原位置改 shim（相对路径按文件深度算）③ 跑下方验证。
- 改/删导出面：shim 透传**整个** `module.exports`，故三项目一起验证。

## 漂移规则 + 验证

- 收口/合并近似文件时**取正确超集**，绝不把某个 fork 的修复/导出悄悄丢掉（历史教训：`json-safe` 的 H4、`__init__` 的 `classify_decline` 都曾只落一个 fork）。
- 改完必跑：
  ```bash
  node --check shared-utils/<name>.js
  node --test Openrouter/0.0.1/web/*.test.js GLM/0.0.1/web/*.test.js   # 行为不变
  # 并确认身份：require(项目 shim) === require(shared 规范实现)
  ```

---

## 使用约束（引用方向）

```
✅ shared-credential   → 可引用 stage-logger, stage-runtime, timing
✅ shared-verification  → 可引用 stage-logger, firstmail-api, until
✅ 各产品 web/ 后端     → 经 shim 引用 B/C 组
❌ shared-utils         → 不得引用任何 shared-utils 以外的目录
```
