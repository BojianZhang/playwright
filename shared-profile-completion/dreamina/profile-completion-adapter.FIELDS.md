# profile-completion-adapter 字段说明

对应文件：
- `D:\playwright\shared-profile-completion\dreamina\profile-completion-adapter.js`

这个文档只做一件事：
**把第四阶段 adapter 里所有关键返回对象字段、重要中间对象字段讲清楚。**

---

# 一、`waitForDreaminaProfileCompletionReady(...)` 返回字段

这个方法当前的执行步骤可以理解为：
1. 读取第四阶段 ready 规则
2. 先看强 selector ready
3. 再看 birthday inputs 是否真正可达
4. 最后看 Year / Month / Day 等文本 ready
5. 如果本轮没命中，就进入下一等待步
6. 所有等待步都没命中，才返回 not-ready

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
- 当前生成规则：
  - 来自规范化后的 `birthdayMinYear ~ birthdayMaxYear`

### `birthdayPlan.month`
- 类型：`string`
- 含义：本轮要填写的 month
- 当前生成规则：
  - 优先使用 `runtime.birthdayMonthCandidates`
  - 否则回退到默认英文月份集合

### `birthdayPlan.day`
- 类型：`string`
- 含义：本轮要填写的 day
- 当前生成规则：
  - 默认在 1~28 的安全范围内生成
  - 避免月长和闰年的复杂性

---

# 三、`readDreaminaBirthdayYearValue(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：当前是否成功读取到 year 输入控件与其值

## `selector`
- 类型：`string`
- 含义：命中的 year 输入 selector

## `value`
- 类型：`string`
- 含义：当前 year 输入框里的实际值

## `locator`
- 类型：`Locator | undefined`
- 含义：命中的 year 输入控件 locator

---

# 四、`readDreaminaBirthdayMonthValue(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：当前是否成功读取到 month 输入控件与其值

## `selector`
- 类型：`string`
- 含义：命中的 month 输入 selector

## `value`
- 类型：`string`
- 含义：当前 month 输入框里的实际值

## `locator`
- 类型：`Locator | undefined`
- 含义：命中的 month 输入控件 locator

---

# 五、填写类返回字段

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
- 常见值：
  - `profile-input`
  - `selector`
  - `text`

## `value`
- 类型：`string`
- 含义：当前填写动作附带值或读回值
- 常见语义：
  - 实际填写进去的值
  - 当前读回值
  - 失败时的辅助错误值

## `stateChanged`
- 类型：`boolean | null`
- 含义：填写后页面是否发生了可识别变化
- 口径：
  - `true` = 填写后页面或输入值出现了明显变化
  - `false` = 填写动作执行后没有看到明确变化
  - `null` = 当前没有足够上下文判断

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
- 第一版建议包含：
  - 当前 birthday 输入值摘要
  - 当前按钮可见性/可用性摘要

## `afterSnapshot`
- 类型：`object | null`
- 含义：点击后的轻量页面快照
- 第一版建议包含：
  - 点击后的 birthday 输入值摘要
  - 下一阶段信号摘要
  - 阶段 4 失败信号摘要

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
- 示例：
  - `DREAMINA_PROFILE_COMPLETION_NOT_READY`
  - `DREAMINA_BIRTHDAY_INPUT_NOT_FOUND`
  - `DREAMINA_PROFILE_COMPLETION_SUBMIT_FAILED`
  - `DREAMINA_PROFILE_COMPLETION_RESULT_UNKNOWN`

## `hardFailure`
- 类型：`boolean`
- 含义：该失败是否应视作强失败
- 作用：
  - 给外层后续策略提供更稳定的失败等级语义
