# profile-completion-adapter 字段说明

对应文件：
- `D:\playwright\shared-profile-completion\dreamina\profile-completion-adapter.js`

这个文档只做一件事：
**把第四阶段 adapter 里所有关键返回对象字段、重要中间对象字段讲清楚。**

---

# 一、`waitForDreaminaProfileCompletionReady(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否确认进入 profile-completion 阶段

## `state`
- 类型：`string`
- 常见值：
  - `PROFILE_COMPLETION_READY`
  - `PROFILE_COMPLETION_NOT_READY`

## `source`
- 类型：`string`
- 含义：当前 ready 信号来源

## `value`
- 类型：`string`
- 含义：命中的 selector 或 text

## `strength`
- 类型：`string`
- 含义：当前 ready 信号强度

## `waitStepMs`
- 类型：`number`
- 含义：本次 ready 判定是在第几个等待步命中的

---

# 二、`buildDreaminaProfileCompletionPlan(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否成功生成资料填写计划

## `state`
- 类型：`string`
- 常见值：
  - `PROFILE_COMPLETION_PLAN_READY`
  - `PROFILE_COMPLETION_PLAN_FAILED`

## `birthdayPlan`
- 类型：`object`
- 含义：本轮 birthday 填写计划

### `birthdayPlan.year`
- 类型：`string`
- 含义：本轮要填写的 year

### `birthdayPlan.month`
- 类型：`string`
- 含义：本轮要填写的 month

### `birthdayPlan.day`
- 类型：`string`
- 含义：本轮要填写的 day

---

# 三、填写类返回字段

适用于：
- `fillDreaminaBirthdayYear(...)`
- `fillDreaminaBirthdayMonth(...)`
- `fillDreaminaBirthdayDay(...)`

## `ok`
- 类型：`boolean`
- 含义：当前字段填写是否成功

## `state`
- 类型：`string`
- 含义：当前字段填写状态

## `source`
- 类型：`string`
- 含义：当前填写动作来源

## `value`
- 类型：`string`
- 含义：当前填写动作附带值或读回值

## `stateChanged`
- 类型：`boolean | null`
- 含义：填写后页面是否发生了可识别变化

---

# 四、`submitDreaminaProfileCompletion(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：提交动作是否成功执行

## `state`
- 类型：`string`
- 含义：提交动作状态

## `source`
- 类型：`string`
- 含义：提交入口来源

## `value`
- 类型：`string`
- 含义：命中的提交 selector/text 或辅助值

## `beforeSnapshot`
- 类型：`object | null`
- 含义：点击前的轻量页面快照

## `afterSnapshot`
- 类型：`object | null`
- 含义：点击后的轻量页面快照

## `stateChanged`
- 类型：`boolean | null`
- 含义：submit 前后页面是否发生了有意义变化

---

# 五、`confirmDreaminaProfileCompletionSubmitResult(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：资料提交后的结果是否判定为成功

## `state`
- 类型：`string`
- 含义：阶段 4 提交后的原始状态

## `nextStage`
- 类型：`string`
- 含义：成功时应推进到哪个阶段
- 当前成功时通常为：
  - `post-auth-ready`

## `source`
- 类型：`string`
- 含义：当前确认结果的主要来源

## `value`
- 类型：`string`
- 含义：命中的 selector / text / 辅助值

## `strength`
- 类型：`string`
- 含义：当前结果信号强度

## `settleStage`
- 类型：`string`
- 含义：当前结果是在第几层确认里收敛出来的

---

# 六、`classifyDreaminaProfileCompletionFailure(...)` 返回字段

## `reason`
- 类型：`string`
- 含义：原始 reason/state

## `siteReason`
- 类型：`string`
- 含义：Dreamina 专属失败语义

## `hardFailure`
- 类型：`boolean`
- 含义：该失败是否应视作强失败
