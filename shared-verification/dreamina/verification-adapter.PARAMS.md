# verification-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-verification\dreamina\verification-adapter.js`

这个文档只做一件事：
**把这个文件里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、文件边界

这个文件负责：
- Dreamina 阶段 3（verification submit）的站点适配
- verification stage ready 判断
- 获取验证码
- 选择验证码输入控件
- 输入验证码
- 提交结果确认
- 提交失败分类

这个文件不负责：
- 首页打开
- 登录入口切换
- credential submit
- birthday / profile completion
- session/storage

---

# 二、公共参数说明

## `page`
- 类型：Playwright Page
- 作用：当前浏览器页面对象
- 用途：
  - 查找 locator
  - 读取文本
  - 输入验证码
  - 确认结果

## `account`
- 类型：object
- 作用：当前账号信息
- 常用字段：
  - `account.email`
  - `account.password`
- 用途：
  - 日志标识
  - 验证阶段失败分类辅助上下文

## `runtime`
- 类型：object
- 作用：阶段运行时上下文
- 当前建议用途：
  - verification ready 等待节奏
  - 拉码等待预算
  - verification 重试次数
  - 提交结果确认等待

## `context`
- 类型：object
- 作用：附加上下文对象
- 当前常见字段：
  - `logInfo`
  - `verificationReady`
  - `fetchCodeResult`
  - `codeInputResolution`

---

# 三、方法逐个说明

## 1. `loadDreaminaVerificationProfile()`

### 参数
- 无

### 作用
读取：
- `dreamina-verification-profile.json`

### 返回值
- 类型：`object`
- 内容：Dreamina 阶段 3 profile

### 边界
- 只负责读取配置
- 不负责页面动作

---

## 2. `waitForDreaminaVerificationStageReady(page, runtime = {}, context = {})`

### 作用
- 等待并确认当前页面已经进入验证码阶段
- 这是阶段 3 的起点判断

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'VERIFICATION_STAGE_READY',
  source,
  value,
  strength,
  waitStepMs,
}
```

#### 失败时
```js
{
  ok: false,
  state: 'VERIFICATION_STAGE_NOT_READY',
  source: '',
  value: '',
  strength: '',
  waitStepMs,
}
```

---

## 3. `fetchDreaminaVerificationCode(page, account, runtime = {}, context = {})`

### 作用
- 从验证码提供方拉取当前验证码
- 当前第一版已接入现有 Firstmail provider 真实能力
- adapter 只负责把 provider 返回值压平到第三阶段统一结构

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'VERIFICATION_CODE_FETCHED',
  code,
  source,
  value,
  provider,
  attempt,
  messageTs,
  matchMode,
}
```

#### 失败时
```js
{
  ok: false,
  state: 'VERIFICATION_CODE_NOT_AVAILABLE' | 'VERIFICATION_CODE_FETCH_FAILED',
  code: '',
  source,
  value,
  provider,
  attempt,
  messageTs,
  matchMode,
}
```

---

## 4. `resolveDreaminaVerificationInput(page, runtime = {}, context = {})`

### 作用
- 从候选池中选出正确验证码输入目标

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'VERIFICATION_INPUT_RESOLVED',
  locator,
  source,
  selector,
  inputMeta,
  strength,
}
```

#### 失败时
```js
{
  ok: false,
  state: 'VERIFICATION_INPUT_NOT_FOUND',
  locator: null,
  source: '',
  selector: '',
  inputMeta: null,
  strength: '',
}
```

---

## 5. `fillDreaminaVerificationCode(page, code, runtime = {}, context = {})`

### 作用
- 执行验证码输入

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'VERIFICATION_CODE_FILLED',
  mode,
  source,
  value,
  stateChanged,
}
```

#### 失败时
```js
{
  ok: false,
  state: 'VERIFICATION_CODE_FILL_FAILED',
  mode,
  source,
  value,
  stateChanged,
}
```

---

## 6. `confirmDreaminaVerificationSubmitResult(page, runtime = {}, context = {})`

### 作用
- 确认验证码提交后的结果

### 成功时应重点判断
- 是否进入 birthday / profile-completion

### 失败时应重点判断
- wrong verification code
- verification rate limited
- signup rejected
- account already exists
- verification result unknown

### 返回值
#### 成功时
```js
{
  ok: true,
  state: 'VERIFICATION_SUBMIT_OK',
  nextStage: 'profile-completion',
  source,
  value,
  strength,
  settleStage,
}
```

#### 失败时
```js
{
  ok: false,
  state,
  nextStage: '',
  source,
  value,
  strength,
  settleStage,
}
```

---

## 7. `classifyDreaminaVerificationFailure(input = {})`

### 作用
- 将阶段 3 的失败 reason 收敛成 Dreamina 专属语义

### 返回值
```js
{
  reason,
  siteReason,
  hardFailure,
}
```

---

# 四、当前这份 adapter 的执行链

按阶段 3 的正常顺序，它应是这样串起来的：

1. `waitForDreaminaVerificationStageReady(...)`
2. `fetchDreaminaVerificationCode(...)`
3. `resolveDreaminaVerificationInput(...)`
4. `fillDreaminaVerificationCode(...)`
5. `confirmDreaminaVerificationSubmitResult(...)`
6. `classifyDreaminaVerificationFailure(...)`
