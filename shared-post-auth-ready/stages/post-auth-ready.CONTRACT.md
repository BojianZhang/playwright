# post-auth-ready 阶段契约

对应文件：
- `D:\playwright\shared-post-auth-ready\stages\post-auth-ready.js`

这个文档只做一件事：
**把阶段 5（post-auth ready）的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、阶段定位

`post-auth-ready` 是注册主链里的**阶段 5**。

它的职责边界是：
- 从页面已经离开 profile-completion 阶段上下文开始
- 到确认进入 `registration-complete`，或确认阶段 5 内失败为止

它不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- birthday / profile completion
- browser/context 创建
- runner 层代理调度、结果落盘

---

# 二、统一输入

`runPostAuthReadyStage(options)` 当前输入：

## `page`
- 类型：Playwright Page
- 含义：当前真实执行动作的页面对象
- 要求：页面已经进入 post-auth-ready 所在上下文，或至少已经离开第四阶段并呈现登录后信号

## `account`
- 类型：object
- 常用字段：
  - `account.email`
  - `account.password`
- 含义：当前账号上下文
- 作用：
  - 日志标识
  - 第五阶段失败分类辅助上下文

## `adapter`
- 类型：object
- 含义：当前站点的阶段 5 适配器
- 作用：承接站点专属的 ready / inspect-session / confirm / classify 逻辑

## `runtime`
- 类型：object
- 含义：阶段运行时参数
- 当前常见用途：
  - post-auth ready 等待节奏
  - session-ready 检查等待
  - 最终结果确认等待
  - 第五阶段轻量重试预算

## `context`
- 类型：object
- 含义：附加上下文
- 当前常见用途：
  - 日志函数
  - 阶段间共享结果
  - 第四阶段传入的背景信息
  - page/context/browser 辅助对象

---

# 三、统一输出

`runPostAuthReadyStage(...)` 应返回统一结构：

```js
{
  success,
  stage,
  state,
  reason,
  nextStage,
  signalStrength,
  settleStage,
  detectionSource,
  stateChanged,
  retryCount,
  detail,
}
```

---

# 四、字段逐项说明

## 1. `success`
- 类型：`boolean`
- 含义：阶段 5 是否成功完成
- 口径：
  - `true` = 已确认页面进入可用的已登录态 / 已注册态，并可推进到 `registration-complete`
  - `false` = 阶段 5 失败，或当前结果不足以确认最终成功

## 2. `stage`
- 类型：`string`
- 固定值：`post-auth-ready`
- 含义：当前结果所属阶段名

## 3. `state`
- 类型：`string`
- 含义：阶段 5 的原始状态码 / 阶段内结果状态
- 示例：
  - `POST_AUTH_READY`
  - `SESSION_SIGNAL_DETECTED`
  - `USER_PANEL_VISIBLE`
  - `REGISTRATION_COMPLETE`
  - `POST_AUTH_READY_TIMEOUT`
  - `POST_AUTH_RESULT_UNKNOWN`

## 4. `reason`
- 类型：`string`
- 含义：外层更适合消费的失败/结果原因
- 来源：
  - 成功时通常等于 `state`
  - 失败时优先使用 adapter 的分类结果

## 5. `nextStage`
- 类型：`string`
- 含义：当前阶段成功后应推进到哪个阶段
- 当前阶段 5 成功时：
  - 通常为 `registration-complete`
- 失败时：
  - 为空字符串 `''`

## 6. `signalStrength`
- 类型：`string`
- 常见值：
  - `strong`
  - `medium`
  - `weak`
  - `''`
- 含义：当前结果依据的信号强度
- 口径：
  - `strong` = 高置信已登录 / 已注册完成信号
  - `medium` = 可用态强辅助信号，但仍建议和其他结果联合判断
  - `weak` = 辅助判断信号，单独不足以宣布主链完成

## 7. `settleStage`
- 类型：`string`
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `session-check`
  - `ui-check`
  - `storage-check`
  - `none`
- 含义：最终结果是在第几层确认里收敛出来的

## 8. `detectionSource`
- 类型：`string`
- 常见值：
  - `selector`
  - `text`
  - `url`
  - `cookie`
  - `local-storage`
  - `session-storage`
  - `user-panel`
  - `dashboard`
  - `''`
- 含义：当前结果主要基于哪种检测来源得出的

## 9. `stateChanged`
- 类型：`boolean | null`
- 含义：第五阶段等待或确认过程中，页面是否发生了有意义变化

## 10. `retryCount`
- 类型：`number`
- 含义：阶段 5 内部已经发生了多少次轻量重试
- 注意：
  - 这里是第五阶段内部重试，不是 runner 全局重试

## 11. `detail`
- 类型：`object | null`
- 含义：阶段内部的详细上下文结果
- 当前常见内容建议：
  - `postAuthReady`
  - `sessionInspection`
  - `uiConfirmation`
  - `resultConfirmation`
  - `classified`

### `detail.postAuthReady`
- 类型：`object | null`
- 含义：第五阶段入口 ready 判断结果

### `detail.sessionInspection`
- 类型：`object | null`
- 含义：cookie / storage / session 可用态检查结果

### `detail.uiConfirmation`
- 类型：`object | null`
- 含义：用户面板 / 工作台 / 已登录 UI 信号确认结果

### `detail.resultConfirmation`
- 类型：`object | null`
- 含义：最终成功/失败/未知收口结果

### `detail.classified`
- 类型：`object | null`
- 含义：adapter 对失败原因的站点语义分类结果

---

# 五、成功与失败的最小判定口径

## 成功
满足以下任一高置信条件后，阶段 5 可判成功：
- 已确认页面进入登录后工作台 / 用户主页 / 控制台
- 已确认用户态 / session 可用态建立
- 且返回：
  - `success = true`
  - `nextStage = 'registration-complete'`

## 失败
当以下情况发生时，阶段 5 应判失败：
- post-auth-ready 阶段不 ready
- 长时间未建立登录后信号
- session / storage / 用户态强失败
- 命中站点明确的登录后失败页或拦截页
- 最终结果未知且未确认进入 registration-complete

---

# 六、阶段边界

## 阶段 4 -> 阶段 5
阶段 4 的终点应该是：
- 已确认进入 `post-auth-ready`

阶段 5 的起点应该是：
- 开始确认登录后可用态
- 开始确认最终用户态 / session 是否建立

## 阶段 5 -> registration-complete
阶段 5 的终点应该是：
- 确认当前注册主链已完成
- 确认可以把结果交给外层作为最终完成态

---

# 七、一句话总结

`post-auth-ready` 的稳定契约不是“我看到一点像登录成功的东西”，而是：
**把“当前账号已经真正进入可用用户态”这件事确认干净，并把最终结果交给外层。**
