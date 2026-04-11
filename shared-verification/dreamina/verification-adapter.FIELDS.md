# verification-adapter 字段说明

对应文件：
- `D:\playwright\shared-verification\dreamina\verification-adapter.js`

这个文档只做一件事：
**把第三阶段 adapter 里所有关键返回对象字段、重要中间对象字段讲清楚。**

---

# 一、`waitForDreaminaVerificationStageReady(...)` 返回字段

这个方法的执行步骤现在可以理解为：
1. 读取 verification ready 规则
2. 先看强 selector
3. 再看弱文本 / countdown
4. 如果本轮没命中，就进入下一等待步
5. 所有等待步都没命中，才返回 not-ready

## `ok`
- 类型：`boolean`
- 含义：是否确认进入 verification 阶段

## `state`
- 类型：`string`
- 常见值：
  - `VERIFICATION_STAGE_READY`
  - `VERIFICATION_STAGE_NOT_READY`

## `source`
- 类型：`string`
- 含义：当前 ready 信号来源
- 常见值：
  - `selector`
  - `text`

## `value`
- 类型：`string`
- 含义：命中的 selector 或 text

## `strength`
- 类型：`string`
- 含义：当前 ready 信号强度
- 常见值：
  - `strong`
  - `weak`
  - `''`

## `waitStepMs`
- 类型：`number`
- 含义：本次 ready 判定是在第几个等待步命中的

---

# 二、`fetchDreaminaVerificationCode(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否成功获取验证码

## `state`
- 类型：`string`
- 常见值：
  - `VERIFICATION_CODE_FETCHED`
  - `VERIFICATION_CODE_NOT_AVAILABLE`
  - `VERIFICATION_CODE_FETCH_FAILED`
  - `VERIFICATION_CODE_FETCH_FAILED`

## `code`
- 类型：`string`
- 含义：实际验证码

## `source`
- 类型：`string`
- 含义：验证码来源类型
- 常见值：
  - `mail-provider`

## `value`
- 类型：`string`
- 含义：辅助说明值

## `provider`
- 类型：`string`
- 含义：当前验证码提供方名称
- 例如：
  - `firstmail`

## `attempt`
- 类型：`number`
- 含义：本轮获取验证码时 provider 的尝试序号

## `messageTs`
- 类型：`string | number | undefined`
- 含义：命中验证码消息的时间戳

## `matchMode`
- 类型：`string | undefined`
- 含义：验证码命中的模式/提取方式

---

# 三、`resolveDreaminaVerificationInput(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：是否成功解析出验证码输入目标

## `state`
- 类型：`string`
- 常见值：
  - `VERIFICATION_INPUT_RESOLVED`
  - `VERIFICATION_INPUT_NOT_FOUND`

## `locator`
- 类型：`Locator | null`
- 含义：最终命中的输入目标

## `source`
- 类型：`string`
- 含义：解析来源
- 当前建议值：
  - `verification-input`

## `selector`
- 类型：`string`
- 含义：命中的 selector

## `inputMeta`
- 类型：`object | null`
- 含义：输入目标的元信息

### `inputMeta.tagName`
- 类型：`string`
- 含义：目标元素标签名

### `inputMeta.className`
- 类型：`string`
- 含义：目标元素 className

### `inputMeta.type`
- 类型：`string`
- 含义：目标元素 type 属性

### `inputMeta.maxLength`
- 类型：`string`
- 含义：目标元素 maxlength 属性

### `inputMeta.autocomplete`
- 类型：`string`
- 含义：目标元素 autocomplete 属性

## `strength`
- 类型：`string`
- 含义：命中强度

---

# 四、`fillDreaminaVerificationCode(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：验证码输入动作是否成功

## `state`
- 类型：`string`
- 常见值：
  - `VERIFICATION_CODE_FILLED`
  - `VERIFICATION_CODE_FILL_FAILED`

## `mode`
- 类型：`string`
- 含义：本次使用的输入策略
- 当前常见值：
  - `dreamina-hidden-input`
  - `dreamina-wrapper-keyboard`
  - `fallback-keyboard-type`

## `source`
- 类型：`string`
- 含义：当前输入动作来源

## `value`
- 类型：`string`
- 含义：输入后读取到的值，或失败说明值

## `stateChanged`
- 类型：`boolean | null`
- 含义：输入动作后页面或输入状态是否发生了可识别变化

---

# 五、`confirmDreaminaVerificationSubmitResult(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：验证码提交后的结果是否判定为成功

## `state`
- 类型：`string`
- 常见值：
  - `VERIFICATION_SUBMIT_OK`
  - `WRONG_VERIFICATION_CODE`
  - `VERIFICATION_CODE_RATE_LIMITED`
  - `SIGNUP_REJECTED`
  - `ACCOUNT_ALREADY_EXISTS`
  - `VERIFICATION_RESULT_UNKNOWN`

## `nextStage`
- 类型：`string`
- 含义：成功时应推进到哪个阶段
- 当前成功时通常为：
  - `profile-completion`

## `source`
- 类型：`string`
- 含义：当前确认结果的主要来源
- 常见值：
  - `selector`
  - `text`
  - `''`

## `value`
- 类型：`string`
- 含义：命中的 selector / text / 辅助值

## `strength`
- 类型：`string`
- 含义：当前结果信号强度

## `settleStage`
- 类型：`string`
- 含义：当前结果是在第几层确认里收敛出来的
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `none`

---

# 六、`classifyDreaminaVerificationFailure(...)` 返回字段

## `reason`
- 类型：`string`
- 含义：原始 reason/state

## `siteReason`
- 类型：`string`
- 含义：Dreamina 专属失败语义

## `hardFailure`
- 类型：`boolean`
- 含义：该失败是否应视作强失败
