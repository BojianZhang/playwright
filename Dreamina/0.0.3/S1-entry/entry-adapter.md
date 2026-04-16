# entry-adapter.js 文档

**文件位置**：`Dreamina/0.0.3/S1-entry/entry-adapter.js`
**阶段**：S1 — 首页入口

---

## 一、职责边界

| | 说明 |
|---|---|
| ✅ 负责 | 打开 / 校正 Dreamina 入口页（`openEntryPage`）|
| ✅ 负责 | 入口页健康检查（白屏 / 错误页 / 登录信号检测）|
| ✅ 负责 | 等待首页进入可推进 credential-submit 的状态（`waitForEntryReady`）|
| ✅ 负责 | 阶段 1 失败分类（`classifyEntryFailure`）|
| ✅ 负责 | 首页登录入口 staged wait（`waitForDreaminaLoginEntryReady`）|
| ❌ 不负责 | credential submit / verification / profile completion / post-auth |
| ❌ 不负责 | browser / context 创建，代理池调度 |
| ❌ 不负责 | runner 层调度与结果落盘 |

---

## 二、公共入参

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | Playwright Page | 当前浏览器页面对象（goto / 读取 DOM）|
| `runtime` | `object` | 阶段运行时参数（timeout / retry / 等待节奏，由 batch-runner 注入）|
| `context` | `object` | 附加上下文（logInfo / prefix / config / browser 等）|

### runtime 关键字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `entryGotoTimeoutMs` | `number` | 首页 goto 超时（默认 30000ms）|
| `entryWhiteScreenObserveMs` | `number` | 白屏观察等待（默认 2500ms）|
| `entryWhiteScreenRecoveryAttempts` | `number` | 白屏 reload 重试次数（默认 1）|
| `entryPostOverlayWaitMs` | `number` | overlay 点击后等待（默认 800ms，profile 可覆盖）|
| `entryLoginSignalStages` | `array` | 登录信号 staged wait 配置（覆盖 profile 中的 loginSignalStages）|
| `entryPostClickGateTransitionTimeoutMs` | `number` | 点击后 gate 切换超时（默认 3200ms）|

---

## 三、方法与返回值

### `openEntryPage(page, runtime, context)`
打开或校正 Dreamina 入口页（goto + 白屏检测 + 自动 reload 恢复）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 是否成功打开并通过白屏检测 |
| `state` | `string` | `ENTRY_PAGE_OPENED` / `ENTRY_PAGE_OPEN_FAILED` |
| `source` | `string` | `url`（已在域内）/ `goto`（新打开）/ `goto-login-entry`（失败）|
| `strength` | `string` | `weak`（URL 判断）/ `strong`（goto 成功）|
| `stateChanged` | `boolean` | 是否发生了实际导航（false=已在域内）|
| `detail.openTrace` | `object` | 导航细节（finalUrl / title / 白屏检测结果等）|

---

### `checkEntryHealth(page, runtime, context)`
检查 Dreamina 入口页健康状态（错误文本 / 登录信号 / 白屏）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 页面是否健康 |
| `state` | `string` | `ENTRY_HEALTH_OK` / `ENTRY_WHITE_SCREEN` / `ENTRY_ERROR_PAGE` |
| `source` | `string` | `text` / `login-signal` / `health-check` |
| `value` | `string` | 命中的文本或 `HEALTH_OK` / `BODY_TEXT_TOO_SHORT` |
| `strength` | `string` | `strong`（错误文本命中）/ `weak`（body 文本长度判断）|
| `overlayHandled` | `boolean` | 是否在健康检查前清理了 overlay |
| `healthTrace` | `object` | 检测过程记录（overlayHandled / errorTextHit / loginSignalFound 等）|

---

### `waitForEntryReady(page, runtime, context)`
等待并确认 Dreamina 入口已达到可推进 credential-submit 的状态。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 是否 ready |
| `state` | `string` | `ENTRY_READY` / `ENTRY_NOT_READY` 等 |
| `source` | `string` | `selector` / `text` / `url` |
| `value` | `string` | 命中的 ready 信号摘要 |
| `strength` | `string` | ready 信号强度 |

---

### `classifyEntryFailure(input)`
将阶段 1 失败 reason 收敛为 Dreamina 专属语义。

| 入参字段 | 说明 |
|---------|------|
| `input.reason` | 原始失败 state 码 |

| 返回字段 | 类型 | 说明 |
|---------|------|------|
| `reason` | `string` | 输入侧原始状态码 |
| `siteReason` | `string` | Dreamina 语义失败码（如 `DREAMINA_ENTRY_WHITE_SCREEN`）|
| `hardFailure` | `boolean` | 是否硬失败（当前仅 `ENTRY_ERROR_PAGE` 为 true）|

---

### `waitForDreaminaLoginEntryReady(page, runtime, context)`
> ⚠️ **legacy compatibility path** — 此函数是旧版混合 wait 实现，当前 Dreamina 主路径已迁至 `runDreaminaEntryFlow(...)`。保留仅用于兼容/回退/对照。

---

## 四、profile 字段说明（`profiles/dreamina-entry-profile.json`）

| 字段路径 | 类型 | 说明 |
|---------|------|------|
| `site` | `string` | 站点标识（固定 `dreamina`）|
| `stage` | `string` | 阶段标识（固定 `entry`）|
| `entryUrl` | `string` | Dreamina 入口首页 URL |
| `readySignals.selectors` | `string[]` | 页面 ready 时可用的 CSS selector 列表（当前为空）|
| `readySignals.texts` | `string[]` | 页面 ready 时可用的文本信号（当前为空）|
| `readySignals.urlIncludes` | `string[]` | 辅助判断 ready 的 URL 片段（如 `dreamina.com`）|
| `healthSignals.errorTexts` | `string[]` | 触发 `ENTRY_ERROR_PAGE` 的错误页文案 |
| `healthSignals.whiteScreenMinTextLength` | `number` | body 文本低于此值判为白屏（0=不启用）|
| `errorModal.texts` | `string[]` | 错误弹窗识别文案 |
| `errorModal.refreshButtonPattern` | `string` | 刷新按钮匹配模式 |
| `errorModal.postRecoveryWaitMs` | `number` | 错误弹窗关闭后等待时间（ms）|
| `loginSignals.entryTexts` | `string[]` | 可触发点击的登录入口文案（Sign in / Log in 等）|
| `loginSignals.readyTexts` | `string[]` | 只证明首页活跃、不可直接点击的文案 |
| `loginSignals.entryRolePattern` | `string` | 登录入口按钮 role name pattern（正则字符串）|
| `loginSignals.emailInputRoleName` | `string` | email input 的 role name（用于识别"已进入 email gate"）|
| `loginSignals.continueWithEmailText` | `string` | "Continue with email" 文案配置（中间门层识别）|
| `loginSignalStages` | `array` | 登录信号 staged wait 配置（每阶：`seconds` + `intervalMs`）|
| `acceleratedLoginSignalStages` | `array` | 加速模式下的 staged wait 配置（高频轮询）|
| `acceleratedLoginReadyTexts` | `string[]` | 加速模式提前退出的 ready 文案 |
| `overlays.enabled` | `boolean` | 是否启用 overlay 预处理 |
| `overlays.buttonNames` | `string[]` | 精确匹配的 overlay 按钮文案 |
| `overlays.buttonNamePattern` | `string` | 模糊匹配 overlay 按钮的正则字符串 |
| `overlays.extraSelectors` | `string[]` | 额外的 overlay 关闭 selector（当前为空）|
| `overlays.postOverlayWaitMs` | `number` | 点击 overlay 后的等待时间（ms，默认 1500）|
