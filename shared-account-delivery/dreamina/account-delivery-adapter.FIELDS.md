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
- 当前 `ACCOUNT_DELIVERY_READY` 可能来源：
  - 强 selector ready
  - account context 辅助 ready
  - text ready
  - url ready

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
- 当前第一轮补强后口径：
  - `account` = account 基础字段是当前摘要最主要支撑
  - `session` = sessionInspection 摘要是当前摘要最主要支撑
  - `ui` = uiConfirmation 摘要是当前摘要最主要支撑
  - `url` = 当前 URL 是唯一还能提供收敛价值的辅助线索

## `value`
- 类型：`string`
- 含义：当前摘要阶段最主要的命中值或辅助摘要
- 当前第一轮补强后口径：
  - `account` 时通常是第一条有值的 account field 名
  - `session` 时通常是 sessionInspection 的代表值
  - `ui` 时通常是 uiConfirmation 的代表值
  - `url` 时通常是当前页面 URL

## `strength`
- 类型：`string`
- 含义：当前摘要信号强度
- 当前第一轮补强后口径：
  - `medium` = 同时具备 account 基础字段与 session/ui/url 辅助线索
  - `weak` = 只具备单类摘要线索
  - `''` = 当前没有足够摘要可收口

## `accountSnapshot`
- 类型：`object | null`
- 含义：账号基础字段摘要
- 当前第一轮补强后：
  - 真实按 `summarySignals.accountFields` 从 account 上提取

## `sessionSnapshot`
- 类型：`object | null`
- 含义：session / storage 侧摘要
- 当前第一轮补强后：
  - 优先复用第五阶段传入的 `sessionInspection`
  - 当前包含：`expectedKeys / source / value / state / strength`

## `uiSnapshot`
- 类型：`object | null`
- 含义：登录后 UI 侧摘要
- 当前第一轮补强后：
  - 优先复用第五阶段传入的 `uiConfirmation`
  - 当前包含：`expectedSignals / source / value / state / strength / currentUrl / textPreview`

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
- 当前第一轮补强后口径：
  - `required-fields-ready` = requiredFields 已全部具备值
  - `required-fields-missing` = requiredFields 仍有缺口

## `strength`
- 类型：`string`
- 含义：payload 结果强度
- 当前第一轮补强后口径：
  - `strong` = requiredFields 全部具备值
  - `weak` = 至少已有部分 requiredFields
  - `''` = 当前一个 requiredField 都没具备

## `payload`
- 类型：`object | null`
- 含义：当前账号可交付对象草案
- 当前第一轮补强后通常包含：
  - requiredFields 对应字段
  - optionalFields 对应字段
  - `currentUrl`
  - `accountSummary`
  - `sessionSummary`
  - `uiSummary`

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

# 六、`detail` 内部字段压实说明

## `detail.deliveryReady`
- 类型：`object | null`
- 含义：第六阶段入口 ready 判断结果原文

### `detail.deliveryReady.ok`
- 类型：`boolean`
- 含义：第六阶段入口是否已确认可开始

### `detail.deliveryReady.state`
- 类型：`string`
- 含义：第六阶段入口判断的原始状态码

### `detail.deliveryReady.source`
- 类型：`string`
- 含义：入口 ready 信号来源

### `detail.deliveryReady.value`
- 类型：`string`
- 含义：命中的 ready selector / text / url / account fields 摘要

### `detail.deliveryReady.strength`
- 类型：`string`
- 含义：入口 ready 信号强度

### `detail.deliveryReady.waitStepMs`
- 类型：`number`
- 含义：入口 ready 在第几个等待步收敛

## `detail.accountSummary`
- 类型：`object | null`
- 含义：账号最终交付摘要原文

### `detail.accountSummary.ok`
- 类型：`boolean`
- 含义：是否已经整理出可用交付摘要

### `detail.accountSummary.state`
- 类型：`string`
- 含义：摘要整理原始状态码

### `detail.accountSummary.source`
- 类型：`string`
- 含义：摘要当前主要来源

### `detail.accountSummary.value`
- 类型：`string`
- 含义：摘要当前主要代表值

### `detail.accountSummary.strength`
- 类型：`string`
- 含义：摘要信号强度

### `detail.accountSummary.accountSnapshot`
- 类型：`object | null`
- 含义：账号基础字段摘要对象

### `detail.accountSummary.sessionSnapshot`
- 类型：`object | null`
- 含义：session / storage 侧摘要对象

### `detail.accountSummary.uiSnapshot`
- 类型：`object | null`
- 含义：UI / URL / 文本预览侧摘要对象

## `detail.deliveryPayload`
- 类型：`object | null`
- 含义：交付对象草案原文

### `detail.deliveryPayload.ok`
- 类型：`boolean`
- 含义：是否成功组装出可交付对象草案

### `detail.deliveryPayload.state`
- 类型：`string`
- 含义：payload 组装原始状态码

### `detail.deliveryPayload.source`
- 类型：`string`
- 含义：payload 当前主要来源

### `detail.deliveryPayload.value`
- 类型：`string`
- 含义：payload 当前主要辅助值

### `detail.deliveryPayload.strength`
- 类型：`string`
- 含义：payload 信号强度

### `detail.deliveryPayload.payload`
- 类型：`object | null`
- 含义：当前账号可交付对象草案本体

## `detail.resultConfirmation`
- 类型：`object | null`
- 含义：第六阶段最终收口结果原文

### `detail.resultConfirmation.ok`
- 类型：`boolean`
- 含义：最终是否已经确认 delivery-complete

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
- 含义：最终结果确认过程中账号对象或页面是否发生了有意义变化

### `detail.resultConfirmation.retryCount`
- 类型：`number`
- 含义：第六阶段内部轻量重试次数

## `detail.classified`
- 类型：`object | null`
- 含义：第六阶段失败分类结果原文

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

# 七、state 字典（当前草案）

## `ACCOUNT_DELIVERY_READY`
- 含义：已确认页面进入第六阶段上下文

## `ACCOUNT_DELIVERY_NOT_READY`
- 含义：当前还未确认页面进入第六阶段上下文

## `ACCOUNT_SUMMARY_COLLECTED`
- 含义：已整理出当前账号的可用交付摘要

## `ACCOUNT_SUMMARY_INCOMPLETE`
- 含义：摘要已开始整理，但还不够支撑交付

## `ACCOUNT_SUMMARY_UNKNOWN`
- 含义：摘要整理当前没有足够信息收敛

## `DELIVERY_PAYLOAD_READY`
- 含义：已组装出满足最低要求的交付对象草案

## `DELIVERY_PAYLOAD_INCOMPLETE`
- 含义：交付对象草案已开始组装，但 required fields 仍不完整

## `DELIVERY_COMPLETE`
- 含义：已确认当前账号达到 delivery-complete

## `ACCOUNT_DELIVERY_FAILED`
- 含义：已命中第六阶段明确失败信号

## `ACCOUNT_DELIVERY_RESULT_UNKNOWN`
- 含义：当前尚未收敛到成功或明确失败

## `ACCOUNT_DELIVERY_ADAPTER_METHOD_MISSING`
- 含义：第六阶段必需 adapter 方法缺失，导致公共骨架无法继续

---

# 八、source 字典（当前草案）

## `selector`
- 含义：基于 DOM selector 直接命中的信号

## `text`
- 含义：基于页面文本直接命中的信号

## `url`
- 含义：基于页面 URL / 路由片段的信号

## `account`
- 含义：基于 account 基础字段得出的信号

## `session`
- 含义：基于 session / storage 摘要得出的信号

## `ui`
- 含义：基于页面 UI / 文本预览得出的信号

## `payload`
- 含义：基于交付对象结构本身得出的信号

## `''`
- 含义：当前没有足够信息确认主要来源

---

# 九、同名字段统一口径补充

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

---

# 十、`reason / siteReason / hardFailure` 关系说明

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
