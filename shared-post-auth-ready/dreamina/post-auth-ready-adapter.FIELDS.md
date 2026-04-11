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
- 口径：
  - 一般来自 `state`
  - 如果外层已提前改写 reason，则这里接收的是改写后的原始原因

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
- 口径：
  - `true` = 站点语义下已经是非常明确、通常不值得继续轻量等待的失败
  - `false` = 仍可能通过等待、补信号或下一轮确认继续收敛

---

# 六、`detail` 内部字段压实说明

## `detail.postAuthReady`
- 类型：`object | null`
- 含义：第五阶段入口 ready 判断结果原文

### `detail.postAuthReady.ok`
- 类型：`boolean`
- 含义：第五阶段入口是否已确认可开始

### `detail.postAuthReady.state`
- 类型：`string`
- 含义：第五阶段入口判断的原始状态码

### `detail.postAuthReady.source`
- 类型：`string`
- 含义：入口 ready 信号来源

### `detail.postAuthReady.value`
- 类型：`string`
- 含义：命中的 ready selector / text / url 片段

### `detail.postAuthReady.strength`
- 类型：`string`
- 含义：入口 ready 信号强度

### `detail.postAuthReady.waitStepMs`
- 类型：`number`
- 含义：入口 ready 在第几个等待步收敛

## `detail.sessionInspection`
- 类型：`object | null`
- 含义：session / storage 检查结果原文

### `detail.sessionInspection.ok`
- 类型：`boolean`
- 含义：是否已经出现可用态基础信号

### `detail.sessionInspection.state`
- 类型：`string`
- 含义：session 检查原始状态码

### `detail.sessionInspection.source`
- 类型：`string`
- 含义：当前 session 信号主要来源

### `detail.sessionInspection.value`
- 类型：`string`
- 含义：命中的 cookie/storage key 或辅助摘要

### `detail.sessionInspection.strength`
- 类型：`string`
- 含义：session 信号强度

### `detail.sessionInspection.stateChanged`
- 类型：`boolean | null`
- 含义：本轮 session 检查前后状态是否出现有意义变化

### `detail.sessionInspection.cookieSummary`
- 类型：`object | null`
- 含义：cookie 侧摘要

### `detail.sessionInspection.localStorageSummary`
- 类型：`object | null`
- 含义：localStorage 侧摘要

### `detail.sessionInspection.sessionStorageSummary`
- 类型：`object | null`
- 含义：sessionStorage 侧摘要

## `detail.uiConfirmation`
- 类型：`object | null`
- 含义：登录后 UI 确认结果原文

### `detail.uiConfirmation.ok`
- 类型：`boolean`
- 含义：是否确认登录后 UI 已经出现

### `detail.uiConfirmation.state`
- 类型：`string`
- 含义：UI 确认原始状态码

### `detail.uiConfirmation.source`
- 类型：`string`
- 含义：UI 信号来源

### `detail.uiConfirmation.value`
- 类型：`string`
- 含义：命中的 UI selector / text / 辅助值

### `detail.uiConfirmation.strength`
- 类型：`string`
- 含义：UI 信号强度

## `detail.resultConfirmation`
- 类型：`object | null`
- 含义：第五阶段最终收口结果原文

### `detail.resultConfirmation.ok`
- 类型：`boolean`
- 含义：最终是否已经确认 registration-complete

### `detail.resultConfirmation.state`
- 类型：`string`
- 含义：最终结果原始状态码

### `detail.resultConfirmation.nextStage`
- 类型：`string`
- 含义：成功后应推进到哪个最终阶段

### `detail.resultConfirmation.source`
- 类型：`string`
- 含义：最终结果主要来源

### `detail.resultConfirmation.value`
- 类型：`string`
- 含义：最终成功/失败信号值或辅助摘要

### `detail.resultConfirmation.strength`
- 类型：`string`
- 含义：最终结果信号强度

### `detail.resultConfirmation.settleStage`
- 类型：`string`
- 含义：最终结果是在第几层确认里收敛出来的

### `detail.resultConfirmation.stateChanged`
- 类型：`boolean | null`
- 含义：最终结果确认过程中页面是否发生了有意义变化

### `detail.resultConfirmation.retryCount`
- 类型：`number`
- 含义：第五阶段内部轻量重试次数

## `detail.classified`
- 类型：`object | null`
- 含义：第五阶段失败分类结果原文

### `detail.classified.reason`
- 类型：`string`
- 含义：输入侧原始 reason/state

### `detail.classified.siteReason`
- 类型：`string`
- 含义：Dreamina 收敛后的站点语义失败原因

### `detail.classified.hardFailure`
- 类型：`boolean`
- 含义：该失败在站点语义下是否应视作强失败

---

# 七、summary 子字段压实说明

## `cookieSummary.expectedKeys`
- 类型：`array<string>`
- 含义：当前 profile 里预期要观察的关键 cookie 键名列表
- 注意：
  - 这里是“期望规则”，不代表这些 key 当前一定存在

## `cookieSummary.presentKeys`
- 类型：`array<string>`
- 含义：当前实际检测到存在的关键 cookie 键名列表

## `cookieSummary.matchedRule`
- 类型：`string`
- 含义：当前命中的 cookie 规则名或命中的代表 key

## `localStorageSummary.expectedKeys`
- 类型：`array<string>`
- 含义：当前 profile 里预期要观察的关键 localStorage 键名列表

## `localStorageSummary.presentKeys`
- 类型：`array<string>`
- 含义：当前实际检测到存在的关键 localStorage 键名列表

## `localStorageSummary.matchedRule`
- 类型：`string`
- 含义：当前命中的 localStorage 规则名或命中的代表 key

## `sessionStorageSummary.expectedKeys`
- 类型：`array<string>`
- 含义：当前 profile 里预期要观察的关键 sessionStorage 键名列表

## `sessionStorageSummary.presentKeys`
- 类型：`array<string>`
- 含义：当前实际检测到存在的关键 sessionStorage 键名列表

## `sessionStorageSummary.matchedRule`
- 类型：`string`
- 含义：当前命中的 sessionStorage 规则名或命中的代表 key

---

# 八、state 字典（当前草案）

## `POST_AUTH_READY`
- 含义：已确认页面进入第五阶段上下文

## `POST_AUTH_NOT_READY`
- 含义：当前还未确认页面进入第五阶段上下文

## `SESSION_SIGNAL_DETECTED`
- 含义：已检测到 cookie / storage 侧的可用态基础信号

## `SESSION_SIGNAL_NOT_FOUND`
- 含义：当前未检测到关键 session / storage 信号

## `SESSION_INSPECTION_UNKNOWN`
- 含义：session 检查当前没有足够信息收敛

## `USER_PANEL_VISIBLE`
- 含义：已检测到较强的登录后用户面板信号

## `DASHBOARD_VISIBLE`
- 含义：已检测到登录后工作台 / 控制台 UI 信号

## `POST_AUTH_UI_NOT_CONFIRMED`
- 含义：当前还未确认登录后 UI 信号

## `POST_AUTH_SUCCESS`
- 含义：已根据联合信号确认第五阶段成功，但未必来自单一强 selector

## `REGISTRATION_COMPLETE`
- 含义：已确认注册主链完成，可推进到最终完成态

## `POST_AUTH_FAILED`
- 含义：已命中第五阶段明确失败信号

## `POST_AUTH_RESULT_UNKNOWN`
- 含义：当前尚未收敛到成功或明确失败

## `POST_AUTH_ADAPTER_METHOD_MISSING`
- 含义：第五阶段必需 adapter 方法缺失，导致公共骨架无法继续

---

# 九、source 字典（当前草案）

## `selector`
- 含义：基于 DOM selector 直接命中的信号

## `text`
- 含义：基于页面文本直接命中的信号

## `url`
- 含义：基于页面 URL / 路由片段的信号

## `cookie`
- 含义：基于 cookie 侧观察得到的信号

## `local-storage`
- 含义：基于 localStorage 侧观察得到的信号

## `session-storage`
- 含义：基于 sessionStorage 侧观察得到的信号

## `user-panel`
- 含义：基于登录后用户面板容器得到的信号

## `dashboard`
- 含义：基于登录后工作台 / 控制台容器得到的信号

## `session+ui`
- 含义：最终结果不是由单一信号得出，而是由 session 与 UI 联合收敛得出

## `''`
- 含义：当前没有足够信息确认主要来源

---

# 十、同名字段统一口径补充

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
- `session+ui`
  - 表示由 session 与 UI 联合收敛出的结果来源

## `strength`
- `strong`
  - 高置信最终可用态信号
- `medium`
  - 强辅助信号
- `weak`
  - 辅助判断信号
- `''`
  - 当前没有明确强度

---

# 十一、`reason / siteReason / hardFailure` 关系说明

## `reason`
- 表示输入侧原始失败状态
- 往往更接近阶段公共层输出的 `state`

## `siteReason`
- 表示 Dreamina 站点语义下收敛后的失败原因
- 用途：
  - 给运维看
  - 给日志聚类看
  - 给后续策略层消费

## `hardFailure`
- 表示这个失败在站点语义下是否已经足够明确到不值得继续轻量等待
- 这不是 runner 全局决策，只是站点适配层给出的失败强度标签
