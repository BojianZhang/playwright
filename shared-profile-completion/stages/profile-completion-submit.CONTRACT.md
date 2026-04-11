# profile-completion-submit 阶段契约

对应文件：
- `D:\playwright\shared-profile-completion\stages\profile-completion-submit.js`

这个文档只做一件事：
**把阶段 4（profile completion submit）的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、阶段定位

`profile-completion-submit` 是注册主链里的**阶段 4**。

它的职责边界是：
- 从页面已经进入 birthday / profile-completion 阶段上下文开始
- 到确认进入 `post-auth-ready` 阶段，或确认阶段 4 内失败为止

它不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- post-auth-ready 最终确认
- session / storage
- runner 层代理调度、结果落盘

---

# 二、统一输入

`runProfileCompletionSubmitStage(options)` 当前输入：

## `page`
- 类型：Playwright Page
- 含义：当前真实执行动作的页面对象
- 要求：页面已经进入 birthday / profile-completion 所在上下文

## `account`
- 类型：object
- 常用字段：
  - `account.email`
  - `account.password`
- 含义：当前账号上下文
- 作用：
  - 日志标识
  - 阶段 4 失败分类辅助上下文

## `adapter`
- 类型：object
- 含义：当前站点的阶段 4 适配器
- 作用：承接站点专属的 ready / build-plan / fill / submit / confirm / classify 逻辑

## `runtime`
- 类型：object
- 含义：阶段运行时参数
- 当前常见用途：
  - profile-completion ready 等待节奏
  - birthday 随机策略
  - submit 后结果确认等待
  - 阶段 4 内部轻量重试预算

## `context`
- 类型：object
- 含义：附加上下文
- 当前常见用途：
  - 日志函数
  - 阶段间共享结果
  - 上一阶段传入的背景信息

---

# 三、统一输出

`runProfileCompletionSubmitStage(...)` 应返回统一结构：

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
- 含义：阶段 4 是否成功完成
- 口径：
  - `true` = 资料填写成功提交，并确认推进到下一阶段 `post-auth-ready`
  - `false` = 阶段 4 失败，或当前结果不足以确认成功

## 2. `stage`
- 类型：`string`
- 固定值：`profile-completion-submit`
- 含义：当前结果所属阶段名

## 3. `state`
- 类型：`string`
- 含义：阶段 4 的原始状态码 / 阶段内结果状态
- 示例：
  - `PROFILE_COMPLETION_READY`
  - `BIRTHDAY_YEAR_FILLED`
  - `BIRTHDAY_MONTH_FILLED`
  - `BIRTHDAY_DAY_FILLED`
  - `PROFILE_COMPLETION_SUBMIT_OK`
  - `PROFILE_COMPLETION_RESULT_UNKNOWN`

## 4. `reason`
- 类型：`string`
- 含义：外层更适合消费的失败/结果原因
- 来源：
  - 成功时通常等于 `state`
  - 失败时优先使用 adapter 的分类结果

## 5. `nextStage`
- 类型：`string`
- 含义：当前阶段成功后应推进到哪个阶段
- 当前阶段 4 成功时：
  - 通常为 `post-auth-ready`
- 失败时：
  - 为空字符串 `''`

## 6. `signalStrength`
- 类型：`string`
- 常见值：
  - `strong`
  - `weak`
  - `''`
- 含义：当前结果依据的信号强度

## 7. `settleStage`
- 类型：`string`
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `none`
- 含义：资料提交后结果是在第几层确认里收敛出来的

## 8. `detectionSource`
- 类型：`string`
- 常见值：
  - `selector`
  - `text`
  - `profile-input`
  - `snapshot`
  - `''`
- 含义：当前结果主要基于哪种检测来源得出的

## 9. `stateChanged`
- 类型：`boolean | null`
- 含义：资料填写或提交后页面是否发生了有意义变化

## 10. `retryCount`
- 类型：`number`
- 含义：阶段 4 内部已经发生了多少次轻量重试
- 注意：
  - 这是阶段 4 内部重试，不是 runner 全局重试

## 11. `detail`
- 类型：`object | null`
- 含义：阶段内部的详细上下文结果
- 当前常见内容建议：
  - `profileReady`
  - `birthdayFillPlan`
  - `yearFillResult`
  - `monthFillResult`
  - `dayFillResult`
  - `submitResult`
  - `confirmResult`
  - `classified`

---

# 五、成功与失败的最小判定口径

## 成功
满足以下任一高置信条件后，阶段 4 可判成功：
- 已确认资料填写完成
- 已确认进入 `post-auth-ready`
- 且返回：
  - `success = true`
  - `nextStage = 'post-auth-ready'`

## 失败
当以下情况发生时，阶段 4 应判失败：
- profile-completion 阶段不 ready
- 资料输入控件不可用
- 资料填写失败
- 提交后命中阶段 4 明确失败
- 提交后结果未知且未确认进入下一阶段

---

# 六、阶段边界

## 阶段 3 -> 阶段 4
阶段 3 的终点应该是：
- 已确认进入 `profile-completion`

阶段 4 的起点应该是：
- 开始确认 birthday / profile-completion ready
- 开始填写资料并提交

## 阶段 4 -> 阶段 5
阶段 4 的终点应该是：
- 确认进入 `post-auth-ready`

阶段 5 的起点应该是：
- 开始确认注册完成后的主页 ready
- 开始确认 session / 用户态稳定

---

# 七、一句话总结

`profile-completion-submit` 的稳定契约不是“整个注册已完成”，而是：
**只负责把资料补全这一段做完整、说明白，并把结果干净地交给 `post-auth-ready`。**
