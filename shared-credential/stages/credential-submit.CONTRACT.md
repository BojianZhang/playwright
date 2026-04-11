# credential-submit 阶段契约

对应文件：
- `D:\playwright\shared-credential\stages\credential-submit.js`

这个文档只做一件事：
**把阶段 2（credential submit）的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、阶段定位

`credential-submit` 是注册主链里的**阶段 2**。

它的职责边界是：
- 从页面已经进入 login gate / credential form 上下文开始
- 到确认进入 `verification` 阶段，或确认 credential submit 级别即时失败为止

它不负责：
- 首页打开
- 登录入口切换
- 验证码获取与填写
- birthday / profile completion
- post-auth ready
- session / storage
- runner 层代理调度、结果落盘

---

# 二、统一输入

`runCredentialSubmitStage(options)` 当前输入：

## `page`
- 类型：Playwright Page
- 含义：当前真实执行动作的页面对象
- 要求：页面已经进入 login gate / credential form 所在上下文

## `account`
- 类型：object
- 常用字段：
  - `account.email`
  - `account.password`
- 含义：当前阶段要填写的 credential 数据

## `adapter`
- 类型：object
- 含义：当前站点的阶段 2 适配器
- 作用：承接站点专属的 form ready / fill / submit / confirm / classify 逻辑

## `runtime`
- 类型：object
- 含义：阶段运行时参数
- 当前常见用途：
  - form ready 等待节奏
  - submit settlement 等待节奏

## `context`
- 类型：object
- 含义：附加上下文
- 当前常见用途：
  - 日志函数
  - 阶段间共享结果

---

# 三、统一输出

`runCredentialSubmitStage(...)` 会返回统一结构：

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
- 含义：阶段 2 是否成功完成
- 口径：
  - `true` = 已确认进入下一阶段 `verification`
  - `false` = 阶段 2 失败，或当前结果不足以确认成功

---

## 2. `stage`
- 类型：`string`
- 固定值：`credential-submit`
- 含义：当前结果所属的阶段名
- 作用：给外层 orchestrator / 日志 / 对比工具统一识别阶段来源

---

## 3. `state`
- 类型：`string`
- 含义：阶段 2 的原始状态码 / 阶段内结果状态
- 示例：
  - `FORM_READY`
  - `CREDENTIAL_SUBMIT_OK`
  - `ACCOUNT_ALREADY_EXISTS`
  - `CREDENTIAL_SUBMIT_NO_STATE_CHANGE`
  - `CREDENTIAL_SUBMIT_RESULT_UNKNOWN`

### 设计原则
- `state` 尽量表达“阶段内真实发生了什么”
- 它优先服务阶段逻辑和调试，不一定直接暴露为站点专属最终语义

---

## 4. `reason`
- 类型：`string`
- 含义：外层更适合消费的失败/结果原因
- 来源：
  - 成功时通常等于 `state`
  - 失败时优先使用 adapter 的分类结果（例如 Dreamina 专属 reason）

### 示例
- `DREAMINA_ACCOUNT_ALREADY_EXISTS`
- `DREAMINA_CREDENTIAL_SUBMIT_NO_STATE_CHANGE`
- `CREDENTIAL_STAGE_ADAPTER_MISSING`

### 与 `state` 的区别
- `state` 更像阶段内原始状态
- `reason` 更像阶段对外输出的解释口径

---

## 5. `nextStage`
- 类型：`string`
- 含义：当前阶段成功后应推进到哪个阶段
- 当前阶段 2 成功时：
  - 通常为 `verification`
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

### 当前口径
- `strong`：高置信命中
  - 例如强 selector 命中验证码阶段 ready
  - 或 settlement 快检命中明确失败
- `weak`：弱一些的辅助信号
  - 例如文本命中
  - inline error
  - no-state-change 这类补充判断
- `''`：当前结果没有明确强弱等级

### 作用
- 便于后续拿新架构和旧主链做行为对比
- 也便于外层决定是否需要补观察/回退策略

---

## 7. `settleStage`
- 类型：`string`
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `no-result`
  - `inline-check`
  - `snapshot-check`
  - `none`
- 含义：submit 后结果是在第几层 settle / 补充检查里拿到的

### 作用
- 追踪 submit 后的状态确认是如何收敛出来的
- 判断问题是：
  - 第一层就命中
  - 第二层才命中
  - 还是两层都没结果，最后靠补充检查归类

---

## 8. `detectionSource`
- 类型：`string`
- 常见值：
  - `selector`
  - `text`
  - `bodyText`
  - `snapshot`
  - `''`
- 含义：当前结果主要是基于哪种检测来源得出的

### 示例
- 命中验证码输入框：`selector`
- 命中“Resend code”：`text`
- 命中 body 文本里的 inline error：`bodyText`
- 命中 submit 前后无状态变化：`snapshot`

---

## 9. `stateChanged`
- 类型：`boolean | null`
- 含义：submit 前后页面是否发生了有意义的状态变化

### 口径
- `true`：快照比较认为页面状态发生了足够明确变化
- `false`：点击 submit 后没有产生足够明确的状态变化
- `null`：当前结果没有可用的 submit 快照上下文

### 作用
- 用来区分：
  - submit 已推动页面变化
  - submit 可能没生效 / 没点上 / 页面没响应

---

## 10. `detail`
- 类型：`object | null`
- 含义：阶段内部的详细上下文结果
- 当前常见内容：
  - `formReady`
  - `emailResult`
  - `passwordResult`
  - `submitResult`
  - `confirmResult`
  - `classified`

### 作用
- 便于调试、日志分析、阶段对齐
- 不建议把 `detail` 直接当作跨阶段稳定契约使用
- 跨阶段真正稳定消费的还是顶层字段

---

# 五、成功与失败的最小判定口径

## 成功
满足以下任一高置信条件后，阶段 2 可判成功：
- 已确认进入验证码阶段
- 且返回：
  - `success = true`
  - `nextStage = 'verification'`

## 失败
当以下情况发生时，阶段 2 应判失败：
- form 不 ready
- email/password 填写失败
- submit 按钮不存在
- submit 后命中已知失败
- submit 后无状态变化
- submit 后结果未知但未确认进入 verification

---

# 六、阶段 2 与其他阶段的边界

## 阶段 1 -> 阶段 2
阶段 1 的终点应该是：
- 页面已进入 login gate / credential form 所在上下文

阶段 2 的起点应该是：
- 开始确认 form ready，开始填 credential

## 阶段 2 -> 阶段 3
阶段 2 的终点应该是：
- 确认已进入 `verification`

阶段 3 的起点应该是：
- 验证码阶段 ready 后，开始拉码、填码、验证码相关失败处理

---

# 七、一句话总结

`credential-submit` 的稳定契约不是“把注册继续做下去”，而是：
**只负责把 credential submit 这一段做完整、说明白，并把结果干净地交给 `verification`。**
