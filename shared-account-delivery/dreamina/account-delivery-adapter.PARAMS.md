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
- 第一轮补强后当前分步骤：
  1. 提取 profile 规定的 account 基础字段
  2. 复用第五阶段 sessionInspection 摘要
  3. 复用第五阶段 uiConfirmation 摘要
  4. 读取当前 URL 与轻量文本预览
  5. 组合 account / session / ui / url 四类摘要并收口主要来源
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
- 第一轮补强后当前分步骤：
  1. 读取 payload 的 required / optional 规则
  2. 规范化 account 字段值
  3. 把 accountSummary / sessionSummary / uiSummary 挂入 payload
  4. 判断 requiredFields 是否完整
  5. 输出统一 payload 结果结构
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
- 第一轮补强后当前分步骤：
  1. 先查第六阶段明确成功信号
  2. 再看 summary + payload 是否联合成立
  3. 再查第六阶段明确失败信号
  4. 如果仍未收敛，再做一轮保护等待后复判
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
- 当前建议分步骤：
  1. 提取原始 `reason/state`
  2. 必要时结合 `source/value` 细化失败语义
  3. 生成更贴近 Dreamina 场景的 `siteReason`
  4. 对极少数非常明确的失败再考虑标记 `hardFailure`
- 返回值示例：
```js
{
  reason,
  siteReason,
  hardFailure,
}
```
