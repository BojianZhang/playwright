# post-auth-ready-adapter 字段说明

对应文件：
- `D:\playwright\shared-post-auth-ready\dreamina\post-auth-ready-adapter.js`

这个文档只做一件事：
**把第五阶段 adapter 里所有关键返回对象字段、重要中间对象字段讲清楚。**

---

# 一、`waitForPostAuthReady(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认页面已进入第五阶段上下文

## `state`
- 类型：`string`
- 常见值：
  - `POST_AUTH_READY`
  - `POST_AUTH_NOT_READY`

## `source`
- 类型：`string`
- 含义：当前 ready 信号来源
- 常见值：
  - `selector`
  - `text`
  - `url`

## `value`
- 类型：`string`
- 含义：命中的 selector / text / url 摘要

## `strength`
- 类型：`string`
- 含义：当前 ready 信号强度

## `waitStepMs`
- 类型：`number`
- 含义：本次 ready 判定是在第几个等待步命中的

---

# 二、`inspectPostAuthSession(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认 session / storage 侧至少出现了可用态基础信号

## `state`
- 类型：`string`
- 常见值：
  - `SESSION_SIGNAL_DETECTED`
  - `SESSION_SIGNAL_NOT_FOUND`
  - `SESSION_INSPECTION_UNKNOWN`

## `source`
- 类型：`string`
- 含义：当前 session 信号主要来源
- 常见值：
  - `cookie`
  - `local-storage`
  - `session-storage`

## `value`
- 类型：`string`
- 含义：命中的 cookie key / storage key / 辅助摘要

## `strength`
- 类型：`string`
- 含义：当前 session 信号强度

## `stateChanged`
- 类型：`boolean | null`
- 含义：本轮 session 检查前后，状态是否发生了有意义变化

## `cookieSummary`
- 类型：`object | null`
- 含义：cookie 侧摘要

### `cookieSummary.presentKeys`
- 类型：`array<string>`
- 含义：当前命中的关键 cookie 键名列表

### `cookieSummary.matchedRule`
- 类型：`string`
- 含义：当前命中的 cookie 规则名

## `localStorageSummary`
- 类型：`object | null`
- 含义：localStorage 侧摘要

### `localStorageSummary.presentKeys`
- 类型：`array<string>`
- 含义：当前命中的关键 localStorage 键名列表

### `localStorageSummary.matchedRule`
- 类型：`string`
- 含义：当前命中的 localStorage 规则名

## `sessionStorageSummary`
- 类型：`object | null`
- 含义：sessionStorage 侧摘要

### `sessionStorageSummary.presentKeys`
- 类型：`array<string>`
- 含义：当前命中的关键 sessionStorage 键名列表

### `sessionStorageSummary.matchedRule`
- 类型：`string`
- 含义：当前命中的 sessionStorage 规则名

---

# 三、`confirmPostAuthUi(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认登录后 UI 信号已经出现

## `state`
- 类型：`string`
- 常见值：
  - `USER_PANEL_VISIBLE`
  - `DASHBOARD_VISIBLE`
  - `POST_AUTH_UI_NOT_CONFIRMED`

## `source`
- 类型：`string`
- 含义：当前 UI 信号来源
- 常见值：
  - `selector`
  - `text`
  - `user-panel`
  - `dashboard`

## `value`
- 类型：`string`
- 含义：命中的 UI selector / text / 辅助值

## `strength`
- 类型：`string`
- 含义：当前 UI 信号强度

---

# 四、`confirmPostAuthResult(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认第五阶段已经成功完成

## `state`
- 类型：`string`
- 常见值：
  - `REGISTRATION_COMPLETE`
  - `POST_AUTH_SUCCESS`
  - `POST_AUTH_RESULT_UNKNOWN`
  - `POST_AUTH_FAILED`

## `nextStage`
- 类型：`string`
- 含义：第五阶段成功后应推进到哪个最终阶段
- 当前成功时通常为：
  - `registration-complete`

## `source`
- 类型：`string`
- 含义：当前最终结果的主要来源

## `value`
- 类型：`string`
- 含义：命中的最终成功/失败信号值或辅助摘要

## `strength`
- 类型：`string`
- 含义：最终结果信号强度

## `settleStage`
- 类型：`string`
- 含义：最终结果是在第几层确认里收敛出来的

## `stateChanged`
- 类型：`boolean | null`
- 含义：第五阶段确认过程中页面是否发生了有意义变化

## `retryCount`
- 类型：`number`
- 含义：第五阶段内部轻量重试次数

---

# 五、`classifyPostAuthFailure(...)` 返回字段

## `reason`
- 类型：`string`
- 含义：输入侧原始失败状态

## `siteReason`
- 类型：`string`
- 含义：Dreamina 语义下收敛后的失败原因
- 示例：
  - `DREAMINA_POST_AUTH_NOT_READY`
  - `DREAMINA_SESSION_SIGNAL_NOT_FOUND`
  - `DREAMINA_POST_AUTH_UI_NOT_CONFIRMED`
  - `DREAMINA_POST_AUTH_RESULT_UNKNOWN`

## `hardFailure`
- 类型：`boolean`
- 含义：是否应视为强失败

---

# 六、同名字段统一口径补充

## `value`
- `waitForPostAuthReady.value`
  - 表示命中的 ready selector / text / url 摘要
- `inspectPostAuthSession.value`
  - 表示命中的 cookie key / storage key / 辅助摘要
- `confirmPostAuthUi.value`
  - 表示命中的 UI selector / text / 用户面板辅助值
- `confirmPostAuthResult.value`
  - 表示最终结果命中的成功/失败信号值或辅助摘要

## `source`
- `selector` / `text`
  - 表示基于 DOM 直接命中的信号
- `url`
  - 表示基于页面地址或路由摘要的信号
- `cookie` / `local-storage` / `session-storage`
  - 表示基于存储层信号的判断来源
- `user-panel` / `dashboard`
  - 表示基于登录后 UI 容器的判断来源

## `strength`
- `strong`
  - 高置信最终可用态信号
- `medium`
  - 强辅助信号
- `weak`
  - 辅助判断信号
- `''`
  - 当前没有明确强度
