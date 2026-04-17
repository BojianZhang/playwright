# shared-utils — 工具层模块说明

> **层级定位**：跨平台通用工具，零业务依赖，零平台（Dreamina/OpenAI）耦合。  
> **约束**：本目录下的任何文件**不得**引用 `Dreamina/`、`shared-browser-runtime/` 或任何平台 adapter。

---

## 模块清单

| 文件 | 职责 | 核心导出 |
|------|------|----------|
| `stage-logger.js` | 阶段日志规范化输出（`…/▶/✔/✘` 前缀） | `logStageStart / logStageProgress / logStageSuccess / logStageFail` |
| `stage-runtime.js` | 阶段步骤状态同步 | `syncStageStep` |
| `timing.js` | 高精度计时器 | `createTimer / formatMs` |
| `until.js` | Promise 轮询等待工具 | `until / waitFor` |
| `config-schema.js` | config.json 字段类型约束定义 | `CONFIG_SCHEMA` |
| `config-doctor.js` | 运行时 config 诊断检查 | `diagnoseConfig` |
| `config-defaults.js` | config 字段默认值 | `CONFIG_DEFAULTS` |
| `file-utils.js` | 文件读写工具（JSON 数组、行追加） | `readJsonArrayFile / appendUniqueFileLine` |
| `firstmail-api.js` | Firstmail 邮件 API 封装 | `fetchVerificationCode` |
| `locator.js` | Playwright 定位器工具 | `waitForLocator / fillLocator` |
| `page.js` | 页面级工具（goto / waitFor） | `safeGoto / waitForSelector` |
| `profile.js` | 账号资料随机生成 | `generateProfile / generateBirthday` |
| `birthday.js` | 生日字段处理 | `parseBirthday / formatBirthday` |
| `worker-status-tracker.js` | Worker 状态实时跟踪 | `updateWorkerStatus / getWorkerSummary` |

---

## 使用约束

```
✅ shared-credential  → 可引用 stage-logger, stage-runtime, timing
✅ shared-verification → 可引用 stage-logger, firstmail-api, until
✅ Dreamina-register  → 可引用全部 shared-utils
❌ shared-utils       → 不得引用任何 shared-* 以外的目录
```
