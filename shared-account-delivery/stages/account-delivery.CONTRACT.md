# account-delivery 阶段契约

对应文件：
- `D:\playwright\shared-account-delivery\stages\account-delivery.js`

这个文档只做一件事：
**把阶段 6（account delivery）的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、阶段定位

`account-delivery` 是注册主链里的**阶段 6**。

它的职责边界是：
- 从页面已经进入 `registration-complete` 阶段上下文开始
- 到确认进入 `delivery-complete`，或确认阶段 6 内失败为止

它不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- birthday / profile completion
- post-auth-ready
- browser/context 创建
- runner 层代理调度、结果落盘
- 外部系统写入

---

# 二、统一输入

`runAccountDeliveryStage(options)` 当前输入：

## `page`
- 类型：Playwright Page
- 含义：当前真实执行动作的页面对象
- 要求：页面已经进入 registration-complete 所在上下文，或至少已经具备交付态信号

## `account`
- 类型：object
- 常用字段：
  - `account.email`
  - `account.password`
- 含义：当前账号上下文
- 作用：
  - 日志标识
  - 阶段 6 失败分类辅助上下文
  - 交付对象组装基础来源

## `adapter`
- 类型：object
- 含义：当前站点的阶段 6 适配器
- 作用：承接站点专属的 ready / collect / confirm / classify 逻辑

## `runtime`
- 类型：object
- 含义：阶段运行时参数
- 当前常见用途：
  - delivery ready 等待节奏
  - 账号摘要收集等待
  - 最终 delivery 结果确认等待

## `context`
- 类型：object
- 含义：附加上下文
- 当前常见用途：
  - 日志函数
  - 阶段间共享结果
  - 第五阶段传入的背景信息
  - page/context/browser 辅助对象

---

# 三、统一输出

`runAccountDeliveryStage(...)` 应返回统一结构：

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
- 含义：阶段 6 是否成功完成
- 口径：
  - `true` = 已确认账号整理成可交付对象，并可推进到 `delivery-complete`
  - `false` = 阶段 6 失败，或当前结果不足以确认交付完成

## 2. `stage`
- 类型：`string`
- 固定值：`account-delivery`
- 含义：当前结果所属阶段名

## 3. `state`
- 类型：`string`
- 含义：阶段 6 的原始状态码 / 阶段内结果状态
- 示例：
  - `ACCOUNT_DELIVERY_READY`
  - `ACCOUNT_SUMMARY_COLLECTED`
  - `DELIVERY_PAYLOAD_READY`
  - `DELIVERY_COMPLETE`
  - `ACCOUNT_DELIVERY_RESULT_UNKNOWN`

## 4. `reason`
- 类型：`string`
- 含义：外层更适合消费的失败/结果原因
- 来源：
  - 成功时通常等于 `state`
  - 失败时优先使用 adapter 的分类结果

## 5. `nextStage`
- 类型：`string`
- 含义：当前阶段成功后应推进到哪个最终阶段
- 当前阶段 6 成功时：
  - 通常为 `delivery-complete`
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

## 7. `settleStage`
- 类型：`string`
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `collect-check`
  - `payload-check`
  - `none`
- 含义：最终结果是在第几层确认里收敛出来的

## 8. `detectionSource`
- 类型：`string`
- 常见值：
  - `account`
  - `cookie`
  - `local-storage`
  - `session-storage`
  - `url`
  - `ui`
  - `payload`
  - `''`
- 含义：当前结果主要基于哪种检测来源得出的

## 9. `stateChanged`
- 类型：`boolean | null`
- 含义：第六阶段整理或确认过程中，账号交付对象或页面是否发生了有意义变化

## 10. `retryCount`
- 类型：`number`
- 含义：阶段 6 内部已经发生了多少次轻量重试

## 11. `detail`
- 类型：`object | null`
- 含义：阶段内部的详细上下文结果
- 当前常见内容建议：
  - `deliveryReady`
  - `accountSummary`
  - `deliveryPayload`
  - `resultConfirmation`
  - `classified`

### `detail.deliveryReady`
- 类型：`object | null`
- 含义：第六阶段入口 ready 判断结果

### `detail.accountSummary`
- 类型：`object | null`
- 含义：账号最终交付摘要结果

### `detail.deliveryPayload`
- 类型：`object | null`
- 含义：交付对象草案

### `detail.resultConfirmation`
- 类型：`object | null`
- 含义：最终 delivery success / failure / unknown 收口结果

### `detail.classified`
- 类型：`object | null`
- 含义：adapter 对失败原因的站点语义分类结果

---

# 五、成功与失败的最小判定口径

## 成功
满足以下任一高置信条件后，阶段 6 可判成功：
- 已确认账号交付对象的核心字段完整
- 已确认当前账号达到最低可交付标准
- 且返回：
  - `success = true`
  - `nextStage = 'delivery-complete'`

## 失败
当以下情况发生时，阶段 6 应判失败：
- account-delivery 阶段不 ready
- 核心账号交付字段缺失
- 交付对象无法组装
- 命中站点明确的 delivery 失败语义
- 最终结果未知且未确认进入 delivery-complete

---

# 六、阶段边界

## 阶段 5 -> 阶段 6
阶段 5 的终点应该是：
- 已确认进入 `registration-complete`

阶段 6 的起点应该是：
- 开始整理账号交付字段
- 开始确认是否已达到 delivery-complete

## 阶段 6 -> delivery-complete
阶段 6 的终点应该是：
- 确认当前账号交付对象已完成
- 确认可以把结果交给外层作为最终交付完成态

---

# 七、一句话总结

`account-delivery` 的稳定契约不是“我已经帮你写进外部系统”，而是：
**把“当前账号已经整理成可靠的交付对象”这件事确认干净，并把最终交付结果交给外层。**

## ??Dreamina ??????

- ? Dreamina ????? 6 ?????? `POST_AUTH_READY_ONLY`??????? 5 ???? `REGISTRATION_COMPLETE`?
- `POST_AUTH_READY_ONLY` ??????????????????????????????????? session/workspace ?????
- ?? 6 ????????? 5 ????? `sessionInspection`?`uiConfirmation`?`resultConfirmation`??????? `sessionSummary`?`uiSummary` ? `accountSummary.registrationState`?
