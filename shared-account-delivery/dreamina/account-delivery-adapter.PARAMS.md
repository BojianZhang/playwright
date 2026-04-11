# account-delivery-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-account-delivery\dreamina\account-delivery-adapter.js`

这个文档只做一件事：
**把这个文件里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、文件边界

这个文件负责：
- Dreamina 阶段 6（account-delivery）的站点适配
- account-delivery ready 判断
- 账号最终交付摘要收集
- delivery payload 组装
- 最终 success / failure / unknown 结果确认
- 失败分类

这个文件不负责：
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

# 二、公共参数说明

## `page`
- 类型：Playwright Page
- 作用：当前浏览器页面对象
- 用途：
  - 查找 locator
  - 读取文本
  - 读取 URL
  - 读取 session / storage 摘要
  - 确认交付结果

## `account`
- 类型：object
- 作用：当前账号信息
- 常用字段：
  - `account.email`
  - `account.password`
- 用途：
  - 日志标识
  - delivery payload 基础字段来源
  - 第六阶段失败分类辅助上下文

## `runtime`
- 类型：object
- 作用：阶段运行时上下文
- 当前建议用途：
  - delivery ready 等待节奏
  - account summary 收集等待
  - 最终结果确认等待

## `context`
- 类型：object
- 作用：附加上下文对象
- 当前常见字段：
  - `logInfo`
  - `deliveryReady`
  - `accountSummary`
  - `deliveryPayload`
  - `resultConfirmation`

---

# 三、方法逐个说明

## 1. `loadDreaminaAccountDeliveryProfile(options = {})`
- 作用：读取 `dreamina-account-delivery-profile.json`
- 返回值：Dreamina 阶段 6 profile

## 2. `waitForAccountDeliveryReady(page, runtime = {}, context = {})`
- 作用：等待并确认当前页面已经进入第六阶段上下文
- 第一轮补强后当前分步骤：
  1. 查 delivery selector ready
  2. 查 account context 辅助 ready
  3. 查 delivery text ready
  4. 查最终 URL/路由线索
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
  waitStepMs,
}
```

## 3. `collectAccountDeliverySummary(page, account, runtime = {}, context = {})`
- 作用：整理账号最终交付摘要
- 当前建议收集：
  - 账号基础字段
  - session / storage 摘要
  - 当前 URL / UI 摘要
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
  accountSnapshot,
  sessionSnapshot,
  uiSnapshot,
}
```

## 4. `buildAccountDeliveryPayload(page, account, runtime = {}, context = {})`
- 作用：组装当前账号的最终交付对象草案
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
  payload,
}
```

## 5. `confirmAccountDeliveryResult(page, account, runtime = {}, context = {})`
- 作用：根据 ready / summary / payload 三部分结果，收口第六阶段最终 success / failure / unknown
- 返回值示例：
```js
{
  ok,
  state,
  nextStage,
  source,
  value,
  strength,
  settleStage,
  stateChanged,
  retryCount,
}
```

## 6. `classifyAccountDeliveryFailure(input = {})`
- 作用：把第六阶段失败 reason 收敛成 Dreamina 专属语义
- 返回值示例：
```js
{
  reason,
  siteReason,
  hardFailure,
}
```
