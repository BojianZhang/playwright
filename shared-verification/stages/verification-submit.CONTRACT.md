# verification-submit 阶段契约

对应文件：
- `D:\playwright\shared-verification\stages\verification-submit.js`

这个文档只做一件事：
**把阶段 3（verification submit）的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、阶段定位

`verification-submit` 是注册主链里的**阶段 3**。

它的职责边界是：
- 从页面已经进入 verification 阶段上下文开始
- 到确认进入 `profile-completion` 阶段，或确认 verification 阶段内失败为止

它不负责：
- 首页打开
- 登录入口切换
- credential submit
- birthday / profile completion
- post-auth ready
- session / storage
- runner 层代理调度、结果落盘

---

# 二、统一输入

`runVerificationSubmitStage(options)` 当前输入：

## `page`
- 类型：Playwright Page
- 含义：当前真实执行动作的页面对象
- 要求：页面已经进入 verification 所在上下文

## `account`
- 类型：object
- 常用字段：
  - `account.email`
  - `account.password`
- 含义：当前账号上下文
- 作用：
  - 日志标识
  - 验证阶段失败分类辅助上下文

## `adapter`
- 类型：object
- 含义：当前站点的阶段 3 适配器
- 作用：承接站点专属的 ready / fetch / fill / confirm / classify 逻辑

## `runtime`
- 类型：object
- 含义：阶段运行时参数
- 当前常见用途：
  - verification ready 等待节奏
  - 拉码等待预算
  - verification 重试次数
  - 提交后结果确认等待

## `context`
- 类型：object
- 含义：附加上下文
- 当前常见用途：
  - 日志函数
  - 阶段间共享结果
  - 上一阶段传入的背景信息

---

# 三、统一输出

`runVerificationSubmitStage(...)` 应返回统一结构：

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
  detail,
}
```

---

# 四、字段逐项说明

## 1. `success`
- 类型：`boolean`
- 含义：阶段 3 是否成功完成
- 口径：
  - `true` = 验证码已成功通过，并确认推进到下一阶段 `profile-completion`
  - `false` = 阶段 3 失败，或当前结果不足以确认成功

---

## 2. `stage`
- 类型：`string`
- 固定值：`verification-submit`
- 含义：当前结果所属阶段名
- 作用：让外层统一识别这是第三阶段结果

---

## 3. `state`
- 类型：`string`
- 含义：阶段 3 的原始状态码 / 阶段内结果状态
- 示例：
  - `VERIFICATION_STAGE_READY`
  - `VERIFICATION_CODE_FETCHED`
  - `VERIFICATION_CODE_FILLED`
  - `VERIFICATION_SUBMIT_OK`
  - `WRONG_VERIFICATION_CODE`
  - `VERIFICATION_CODE_RATE_LIMITED`
  - `PROFILE_COMPLETION_READY`
  - `VERIFICATION_RESULT_UNKNOWN`

---

## 4. `reason`
- 类型：`string`
- 含义：外层更适合消费的失败/结果原因
- 来源：
  - 成功时通常等于 `state`
  - 失败时优先使用 adapter 的分类结果（例如 Dreamina 专属 reason）

---

## 5. `nextStage`
- 类型：`string`
- 含义：当前阶段成功后应推进到哪个阶段
- 当前阶段 3 成功时：
  - 通常为 `profile-completion`
- 失败时：
  - 为空字符串 `''`

---

## 6. `signalStrength`
- 类型：`string`
- 常见值：
  - `strong`
  - `weak`
  - `''`
- 含义：当前结果依据的信号强度

---

## 7. `settleStage`
- 类型：`string`
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `retry-success`
  - `retry-failure`
  - `no-result`
  - `inline-check`
  - `snapshot-check`
  - `none`
- 含义：验证码提交后结果是在第几层确认或第几轮重试里收敛出来的

---

## 8. `detectionSource`
- 类型：`string`
- 常见值：
  - `selector`
  - `text`
  - `bodyText`
  - `snapshot`
  - `verification-input`
  - `mail-provider`
  - `''`
- 含义：当前结果主要基于哪种检测来源得出的

---

## 9. `stateChanged`
- 类型：`boolean | null`
- 含义：验证码输入/提交前后页面是否发生了有意义变化

---

## 10. `detail`
- 类型：`object | null`
- 含义：阶段内部的详细上下文结果
- 当前常见内容建议：
  - `verificationReady`
  - `fetchCodeResult`
  - `codeInputResolution`
  - `fillResult`
  - `confirmResult`
  - `classified`
  - `retrySummary`

---

# 五、成功与失败的最小判定口径

## 成功
满足以下任一高置信条件后，阶段 3 可判成功：
- 已确认验证码通过
- 已确认进入 `profile-completion`
- 且返回：
  - `success = true`
  - `nextStage = 'profile-completion'`

## 失败
当以下情况发生时，阶段 3 应判失败：
- verification 阶段不 ready
- 无法拿到验证码
- 无法解析或选中验证码输入控件
- 验证码提交后命中 wrong code / rate limit / rejected / account exists
- 验证码提交后结果未知且未确认进入下一阶段

---

# 六、阶段边界

## 阶段 2 -> 阶段 3
阶段 2 的终点应该是：
- 已确认进入 `verification`

阶段 3 的起点应该是：
- 开始确认 verification ready
- 开始获取和提交验证码

## 阶段 3 -> 阶段 4
阶段 3 的终点应该是：
- 确认进入 `profile-completion`

阶段 4 的起点应该是：
- 开始确认 birthday / profile completion ready
- 开始填写资料并提交

---

# 七、一句话总结

`verification-submit` 的稳定契约不是“继续注册直到成功”，而是：
**只负责把验证码这一段做完整、说明白，并把结果干净地交给 `profile-completion`。**
