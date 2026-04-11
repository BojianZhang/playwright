# credential-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-credential\dreamina\credential-adapter.js`

这个文档只做一件事：
**把这个文件里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、文件边界

这个文件负责：
- Dreamina 阶段 2（credential submit）的站点适配
- 表单 ready 判断
- email/password 填写
- submit 点击
- 提交结果确认
- 提交失败分类

这个文件不负责：
- 首页打开
- 登录入口切换
- 验证码阶段
- birthday
- session/storage

---

# 二、公共参数说明

很多方法都会出现下面几个参数。

## `page`
- 类型：Playwright Page
- 作用：当前浏览器页面对象
- 用途：
  - 查找 locator
  - 读取文本
  - 填表单
  - 点击按钮
- 注意：
  - 这是阶段 2 发生动作的真实页面

## `account`
- 类型：object
- 作用：当前账号信息
- 常用字段：
  - `account.email`
  - `account.password`
- 用途：
  - email/password 填写

## `runtime`
- 类型：object
- 作用：阶段运行时上下文
- 当前用途：
  - form ready 等待节奏
  - submit 后 settlement 等待节奏
  - 预留给后续 run/test 差异
- 当前常见字段：
  - `credentialFormPrimaryWaitMs`
  - `credentialFormSecondaryWaitMs`
  - `credentialSubmitPrimaryWaitMs`
  - `credentialSubmitSecondaryWaitMs`
- 当前状态：
  - 已开始承接阶段 2 自身的轻量等待参数，但不越界到验证码阶段

## `context`
- 类型：object
- 作用：附加上下文对象
- 当前常见字段：
  - `logInfo`
  - `formReady`
- 用途：
  - 打日志
  - 在方法间传递已识别的 form ready 结果，避免重复扫描

---

# 三、方法逐个说明

## 1. `loadDreaminaCredentialProfile()`

### 参数
- 无

### 作用
读取：
- `dreamina-credential-profile.json`

### 它干什么
- 读取文件
- 去 BOM
- 解析 JSON
- 返回 profile 对象

### 返回值
- 类型：`object`
- 内容：Dreamina 阶段 2 profile

### 边界
- 只负责读取配置
- 不负责页面动作

---

## 2. `isVisible(locator)`

### 参数
#### `locator`
- 类型：Playwright Locator
- 作用：当前要判断是否可见的目标元素

### 它干什么
- 调 `locator.isVisible()`
- 出错时兜底返回 `false`

### 返回值
- 类型：`boolean`
- 含义：该 locator 当前是否可见

### 边界
- 只做可见性判断
- 不做点击/填写

---

## 3. `findFirstVisibleBySelectors(page, selectors = [])`

### 参数
#### `page`
- 当前页面对象

#### `selectors`
- 类型：`string[]`
- 作用：候选 selector 列表

### 它干什么
- 按顺序遍历 selector
- 找到第一个当前可见的 locator

### 返回值
```js
{
  ok: boolean,
  selector: string,
  locator: Locator | null
}
```

### 字段含义
- `ok`：是否命中
- `selector`：命中的 selector
- `locator`：命中的 locator

### 边界
- 只负责找第一个可见 selector
- 不做点击/填写

---

## 4. `findFirstVisibleByTexts(page, texts = [])`

### 参数
#### `page`
- 当前页面对象

#### `texts`
- 类型：`string[]`
- 作用：候选文本列表

### 它干什么
- 按顺序遍历文本
- 用 `page.getByText(...).first()` 检查可见性
- 返回第一个可见文本目标

### 返回值
```js
{
  ok: boolean,
  text: string,
  locator: Locator | null
}
```

### 边界
- 只做文本候选识别
- 不做点击/填写

---

## 5. `waitForDreaminaCredentialFormReady(page, runtime = {}, context = {})`

### 参数
#### `page`
- 当前页面对象
- 作用：在页面上查找 form 相关元素

#### `runtime`
- 当前运行时上下文
- 当前主要是预留参数位

#### `context`
- 附加上下文
- 当前主要用：
  - `context.logInfo`

### 它干什么
- 读取 profile
- 按轻量等待节奏检查 form
- 查找 email input
- 查找 password input
- 查找 submit button（先 selector，再 text）
- 判断当前 Dreamina credential form 是否 ready

### 当前等待策略
这一步已经不再是纯即时探测，而是轻量两段式等待：
- 首次立即检查
- `credentialFormPrimaryWaitMs`
- `credentialFormSecondaryWaitMs`

设计目标是：
- 降低页面慢一拍时的误判
- 但不把阶段 2 扩成重轮询

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'FORM_READY',
  emailField,
  passwordField,
  submit,
  waitStepMs,
}
```

#### 失败时
```js
{
  ok: false,
  state: 'FORM_NOT_READY',
  emailField,
  passwordField,
  submit,
  waitStepMs,
}
```

### 返回字段说明
- `emailField`：email 输入框命中结果
- `passwordField`：password 输入框命中结果
- `submit`：提交按钮命中结果
- `waitStepMs`：本次 ready 判定是在第几个等待步命中的

### 边界
- 只确认 form 是否 ready
- 不填写，不点击

---

## 6. `fillDreaminaCredentialEmail(page, account, runtime = {}, context = {})`

### 参数
#### `page`
- 当前页面对象
- 作用：查找 email input 并填写

#### `account`
- 账号对象
- 当前主要使用：
  - `account.email`

#### `runtime`
- 运行时上下文
- 当前主要是预留参数位

#### `context`
- 附加上下文
- 当前会用：
  - `context.logInfo`
  - `context.formReady`

### 为什么有 `context.formReady`
因为前一步 `waitForDreaminaCredentialFormReady(...)` 已经可能找到 email field 了。
这里如果复用：
- 就不用重复扫一次 selector。

### 它干什么
- 优先用 `context.formReady.emailField`
- 否则再自己去 profile 里找 email selector
- 找到后执行 `fill(account.email)`

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'EMAIL_FILLED',
  selector,
  account
}
```

#### 失败时
```js
{
  ok: false,
  state: 'EMAIL_INPUT_NOT_FOUND',
  account
}
```

### 边界
- 只负责填 email
- 不负责 password
- 不负责 submit

---

## 7. `fillDreaminaCredentialPassword(page, account, runtime = {}, context = {})`

### 参数
#### `page`
- 当前页面对象

#### `account`
- 账号对象
- 当前主要使用：
  - `account.password`

#### `runtime`
- 运行时上下文
- 当前主要预留

#### `context`
- 附加上下文
- 当前会用：
  - `context.logInfo`
  - `context.formReady`

### 它干什么
- 优先用 `context.formReady.passwordField`
- 否则再自己去找 password selector
- 找到后执行 `fill(account.password)`

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'PASSWORD_FILLED',
  selector
}
```

#### 失败时
```js
{
  ok: false,
  state: 'PASSWORD_INPUT_NOT_FOUND'
}
```

### 边界
- 只负责填 password
- 不负责 submit

---

## 8. `submitDreaminaCredentialForm(page, runtime = {}, context = {})`

### 参数
#### `page`
- 当前页面对象
- 作用：定位 submit button 并点击

#### `runtime`
- 运行时上下文
- 当前主要预留

#### `context`
- 附加上下文
- 当前会用：
  - `context.logInfo`
  - `context.formReady`

### 它干什么
- 优先使用 `formReady.submit`
- 否则 fallback 到 profile 的 submit selectors/texts
- 点击 submit
- 点击后 wait 700ms

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'FORM_SUBMITTED',
  submit,
  beforeSnapshot,
  afterSnapshot,
  hasStateChange,
  settlementResult,
}
```

#### 失败时
```js
{
  ok: false,
  state: 'SUBMIT_BUTTON_NOT_FOUND'
}
```

### 返回字段说明
- `submit`：本次点击使用的提交入口标签
- `beforeSnapshot`：点击前的阶段 2 轻量页面快照
- `afterSnapshot`：点击后、settlement 跑完后的轻量页面快照
- `hasStateChange`：submit 前后是否发生了有意义的状态变化
- `settlementResult`：submit 后分层等待的收敛结果

### 边界
- 负责触发提交动作
- 负责采集 submit 前后快照
- 负责把 settlement 结果带给 confirm 层复用
- 不负责验证码阶段内后续动作

---

## 9. `confirmDreaminaCredentialSubmitResult(page, runtime = {}, context = {})`

### 参数
#### `page`
- 当前页面对象
- 作用：提交后检查页面状态

#### `runtime`
- 运行时上下文
- 当前主要预留

#### `context`
- 附加上下文
- 当前主要用：
  - `context.logInfo`

### 它干什么
按顺序判断：
1. 优先复用 submit 阶段已跑过的 settlement 结果
2. 如果 settlement 已命中验证码阶段，就直接判成功
3. 如果 settlement 已命中高价值失败，就直接复用失败
4. 如果 settlement 没结果，再看 inlineErrors
5. 再判断是否属于 no-state-change
6. 否则返回未知状态

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'CREDENTIAL_SUBMIT_OK',
  nextStage: 'verification',
  source,
  value,
  strength,
  settleStage,
}
```

#### 失败时示例
```js
{
  ok: false,
  state: 'ACCOUNT_ALREADY_EXISTS',
  nextStage: '',
  source: 'text',
  value: 'An account with this email already exists',
  strength: 'strong',
  settleStage: 'primary-failure',
}
```

### 常见 `state`
- `CREDENTIAL_SUBMIT_OK`
- `ACCOUNT_ALREADY_EXISTS`
- `SIGNUP_REJECTED`
- `RATE_LIMITED`
- `INLINE_ERROR_VISIBLE`
- `CREDENTIAL_SUBMIT_NO_STATE_CHANGE`
- `CREDENTIAL_SUBMIT_RESULT_UNKNOWN`

### 返回字段说明
- `source`：当前结果主要基于什么来源得出（selector / text / bodyText / snapshot）
- `value`：命中的具体 selector / text / 辅助值
- `strength`：当前信号强度（strong / weak / 空）
- `settleStage`：结果是在第几层 settlement / 补充检查里收敛出来的

### 边界
- 只负责判断提交结果
- 可以复用 submit 阶段已跑过的 settlement 结果
- 不负责进入验证码阶段后的动作

---

## 10. `classifyDreaminaCredentialSubmitFailure(input = {})`

### 参数
#### `input`
- 类型：`object`
- 作用：输入阶段 2 的失败结果
- 常见来源：
  - `confirmDreaminaCredentialSubmitResult(...)`
  - form ready / fill / submit 相关返回

### 它干什么
把通用/原始失败状态收敛成 Dreamina 专属 reason。

### 返回值
```js
{
  reason,
  siteReason,
  hardFailure
}
```

### 字段说明
- `reason`：原始 reason/state
- `siteReason`：Dreamina 专属 reason
- `hardFailure`：是否是硬失败

### 当前已映射示例
- `FORM_NOT_READY -> DREAMINA_CREDENTIAL_FORM_NOT_READY`
- `ACCOUNT_ALREADY_EXISTS -> DREAMINA_ACCOUNT_ALREADY_EXISTS`
- `SIGNUP_REJECTED -> DREAMINA_SIGNUP_REJECTED`
- `RATE_LIMITED -> DREAMINA_RATE_LIMITED`
- `CREDENTIAL_SUBMIT_RESULT_UNKNOWN -> DREAMINA_CREDENTIAL_SUBMIT_NO_STATE_CHANGE`

### 边界
- 只负责分类
- 不负责页面动作

---

# 四、当前这份 adapter 的执行链

按阶段 2 的正常顺序，它现在是这样串起来的：

1. `waitForDreaminaCredentialFormReady(...)`
2. `fillDreaminaCredentialEmail(...)`
3. `fillDreaminaCredentialPassword(...)`
4. `submitDreaminaCredentialForm(...)`
5. `confirmDreaminaCredentialSubmitResult(...)`
6. `classifyDreaminaCredentialSubmitFailure(...)`

---

# 五、一句话总结

这个文件当前的参数设计核心思想是：
- `page` 管页面动作
- `account` 管账号数据
- `runtime` 预留运行时差异
- `context` 管日志和阶段间共享结果

这样后续你继续扩 OpenAI / Claude 的阶段 2 adapter 时，参数习惯可以保持一致。
