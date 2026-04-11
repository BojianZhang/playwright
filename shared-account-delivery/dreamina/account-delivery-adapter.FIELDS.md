# account-delivery-adapter 字段说明

对应文件：
- `D:\playwright\shared-account-delivery\dreamina\account-delivery-adapter.js`

这个文档只做一件事：
**把第六阶段 adapter 里所有关键返回对象字段、重要中间对象字段讲清楚。**

---

# 一、`waitForAccountDeliveryReady(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认页面已进入第六阶段上下文

## `state`
- 类型：`string`
- 常见值：
  - `ACCOUNT_DELIVERY_READY`
  - `ACCOUNT_DELIVERY_NOT_READY`

## `source`
- 类型：`string`
- 含义：当前 ready 信号来源
- 常见值：
  - `selector`
  - `text`
  - `url`
  - `account`
- 口径：
  - `account` 只表示“当前账号上下文已具备进入第六阶段整理的辅助条件”，不代表最终 delivery-complete

## `value`
- 类型：`string`
- 含义：命中的 selector / text / url 摘要
- 当 `source=account` 时，这里记录的是当前已有值的关键 account fields 摘要

## `strength`
- 类型：`string`
- 含义：当前 ready 信号强度
- 当前 ready 层口径：
  - `strong` = 结构性 selector 命中
  - `medium` = account context 辅助命中且关键字段较完整
  - `weak` = text / url 辅助命中，或 account context 仅弱成立

## `waitStepMs`
- 类型：`number`
- 含义：本次 ready 判定是在第几个等待步命中的

---

# 二、`collectAccountDeliverySummary(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否成功整理出账号最终交付摘要

## `state`
- 类型：`string`
- 常见值：
  - `ACCOUNT_SUMMARY_COLLECTED`
  - `ACCOUNT_SUMMARY_INCOMPLETE`
  - `ACCOUNT_SUMMARY_UNKNOWN`

## `source`
- 类型：`string`
- 含义：当前摘要主要依据的来源
- 常见值：
  - `account`
  - `session`
  - `ui`
  - `url`

## `value`
- 类型：`string`
- 含义：当前摘要阶段最主要的命中值或辅助摘要

## `strength`
- 类型：`string`
- 含义：当前摘要信号强度

## `accountSnapshot`
- 类型：`object | null`
- 含义：账号基础字段摘要

## `sessionSnapshot`
- 类型：`object | null`
- 含义：session / storage 侧摘要

## `uiSnapshot`
- 类型：`object | null`
- 含义：登录后 UI 侧摘要

---

# 三、`buildAccountDeliveryPayload(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否成功组装出 delivery payload

## `state`
- 类型：`string`
- 常见值：
  - `DELIVERY_PAYLOAD_READY`
  - `DELIVERY_PAYLOAD_INCOMPLETE`

## `source`
- 类型：`string`
- 含义：当前 payload 最主要的来源
- 常见值：
  - `account`
  - `payload`

## `value`
- 类型：`string`
- 含义：payload 侧最主要的辅助值

## `strength`
- 类型：`string`
- 含义：payload 结果强度

## `payload`
- 类型：`object | null`
- 含义：当前账号可交付对象草案

---

# 四、`confirmAccountDeliveryResult(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认第六阶段已经成功完成

## `state`
- 类型：`string`
- 常见值：
  - `DELIVERY_COMPLETE`
  - `DELIVERY_PAYLOAD_READY`
  - `ACCOUNT_DELIVERY_RESULT_UNKNOWN`
  - `ACCOUNT_DELIVERY_FAILED`

## `nextStage`
- 类型：`string`
- 含义：第六阶段成功后应推进到哪个最终阶段
- 当前成功时通常为：
  - `delivery-complete`

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
- 含义：第六阶段确认过程中账号对象或页面是否发生了有意义变化

## `retryCount`
- 类型：`number`
- 含义：第六阶段内部轻量重试次数

---

# 五、`classifyAccountDeliveryFailure(...)` 返回字段

## `reason`
- 类型：`string`
- 含义：输入侧原始失败状态

## `siteReason`
- 类型：`string`
- 含义：Dreamina 语义下收敛后的失败原因
- 示例：
  - `DREAMINA_ACCOUNT_DELIVERY_NOT_READY`
  - `DREAMINA_ACCOUNT_SUMMARY_INCOMPLETE`
  - `DREAMINA_DELIVERY_PAYLOAD_INCOMPLETE`
  - `DREAMINA_ACCOUNT_DELIVERY_RESULT_UNKNOWN`

## `hardFailure`
- 类型：`boolean`
- 含义：是否应视为强失败

---

# 六、同名字段统一口径补充

## `value`
- `waitForAccountDeliveryReady.value`
  - 表示命中的 ready selector / text / url 摘要
- `collectAccountDeliverySummary.value`
  - 表示当前摘要阶段最主要的命中值或辅助摘要
- `buildAccountDeliveryPayload.value`
  - 表示 payload 侧最主要的辅助值
- `confirmAccountDeliveryResult.value`
  - 表示最终结果命中的成功/失败信号值或辅助摘要

## `source`
- `selector` / `text`
  - 表示基于 DOM 或文本命中的信号
- `url`
  - 表示基于 URL / 路由的信号
- `account`
  - 表示基于账号基础字段的信号
- `session`
  - 表示基于 session / storage 的信号
- `ui`
  - 表示基于页面 UI 的信号
- `payload`
  - 表示基于交付对象结构本身的信号

## `strength`
- `strong`
  - 高置信可交付信号
- `medium`
  - 强辅助信号
- `weak`
  - 辅助判断信号
- `''`
  - 当前没有明确强度
