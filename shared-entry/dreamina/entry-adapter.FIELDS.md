# entry-adapter 字段说明

对应文件：
- `D:\playwright\shared-entry\dreamina\entry-adapter.js`

这个文档只做一件事：
**把阶段 1 adapter 里所有关键返回对象字段、重要中间对象字段讲清楚。**

---

# 一、`openEntryPage(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：入口页打开或校正是否成功

## `state`
- 类型：`string`
- 常见值：
  - `ENTRY_PAGE_OPENED`
  - `ENTRY_PAGE_OPEN_FAILED`

## `source`
- 类型：`string`
- 含义：当前打开结果来源
- 常见值：
  - `goto`
  - `reload`
  - `url`

## `value`
- 类型：`string`
- 含义：当前打开动作的 URL 或辅助值

## `strength`
- 类型：`string`
- 含义：当前打开结果信号强度

## `stateChanged`
- 类型：`boolean | null`
- 含义：入口页打开后页面是否发生了有意义变化

---

# 二、`checkEntryHealth(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：入口页健康检查是否通过

## `state`
- 类型：`string`
- 常见值：
  - `ENTRY_HEALTH_OK`
  - `ENTRY_HEALTH_FAILED`
  - `ENTRY_WHITE_SCREEN`
  - `ENTRY_ERROR_PAGE`

## `source`
- 类型：`string`
- 含义：当前健康判断来源
- 常见值：
  - `health-check`
  - `text`
  - `selector`

## `value`
- 类型：`string`
- 含义：命中的健康线索值或辅助摘要

## `strength`
- 类型：`string`
- 含义：健康信号强度

## `stateChanged`
- 类型：`boolean | null`
- 含义：健康检查前后页面是否发生了有意义变化

---

# 三、`waitForEntryReady(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认入口页已经 ready

## `state`
- 类型：`string`
- 常见值：
  - `ENTRY_READY`
  - `ENTRY_NOT_READY`

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

# 四、`classifyEntryFailure(...)` 返回字段

## `reason`
- 类型：`string`
- 含义：输入侧原始失败状态

## `siteReason`
- 类型：`string`
- 含义：Dreamina 语义下收敛后的失败原因
- 示例：
  - `DREAMINA_ENTRY_PAGE_OPEN_FAILED`
  - `DREAMINA_ENTRY_WHITE_SCREEN`
  - `DREAMINA_ENTRY_NOT_READY`

## `hardFailure`
- 类型：`boolean`
- 含义：是否应视为强失败

---

# 五、同名字段统一口径补充

## `value`
- `openEntryPage.value`
  - 表示当前 goto/reload 的 URL 或辅助值
- `checkEntryHealth.value`
  - 表示命中的健康线索值
- `waitForEntryReady.value`
  - 表示命中的 ready selector / text / url 摘要

## `source`
- `goto` / `reload`
  - 表示入口页打开动作来源
- `selector` / `text`
  - 表示页面检测信号来源
- `url`
  - 表示基于 URL 的入口判断来源
- `health-check`
  - 表示基于整体健康检查流程得出的来源
