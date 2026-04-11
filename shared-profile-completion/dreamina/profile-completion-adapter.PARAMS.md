# profile-completion-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-profile-completion\dreamina\profile-completion-adapter.js`

这个文档只做一件事：
**把这个文件里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、文件边界

这个文件负责：
- Dreamina 阶段 4（profile completion submit）的站点适配
- profile-completion ready 判断
- 资料填写计划生成
- birthday / 基础资料填写
- 提交结果确认
- 提交失败分类

这个文件不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- post-auth-ready 最终确认
- session/storage

---

# 二、公共参数说明

## `page`
- 类型：Playwright Page
- 作用：当前浏览器页面对象
- 用途：
  - 查找 locator
  - 读取文本
  - 填写资料
  - 点击提交
  - 确认结果

## `account`
- 类型：object
- 作用：当前账号信息
- 常用字段：
  - `account.email`
  - `account.password`
- 用途：
  - 日志标识
  - 阶段 4 失败分类辅助上下文

## `runtime`
- 类型：object
- 作用：阶段运行时上下文
- 当前建议用途：
  - profile-completion ready 等待节奏
  - birthday 随机策略
  - 提交结果确认等待

## `context`
- 类型：object
- 作用：附加上下文对象
- 当前常见字段：
  - `logInfo`
  - `profileReady`
  - `birthdayFillPlan`
  - `submitResult`

---

# 三、方法逐个说明

## 1. `loadDreaminaProfileCompletionProfile()`
- 作用：读取 `dreamina-profile-completion-profile.json`
- 返回值：Dreamina 阶段 4 profile

## 2. `waitForDreaminaProfileCompletionReady(page, runtime = {}, context = {})`
- 作用：等待并确认当前页面已经进入 birthday / profile-completion 阶段
- 当前补强后会分步骤执行：
  1. 先查强 selector 信号
  2. 再查 birthday inputs 是否可达
  3. 最后查 Year / Month / Day 等文本信号
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

## 3. `buildDreaminaProfileCompletionPlan(page, account, runtime = {}, context = {})`
- 作用：生成本轮资料填写计划
- 当前补强后会分步骤执行：
  1. 规范化 birthday year 范围
  2. 获取 month 候选集合
  3. 在安全区间内生成 day
  4. 组装 birthdayPlan 并返回
- 返回值示例：
```js
{
  ok,
  state,
  birthdayPlan,
  source,
}
```

## 4. `fillDreaminaBirthdayYear(page, plan, runtime = {}, context = {})`
- 作用：填写 year
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  stateChanged,
}
```

## 5. `fillDreaminaBirthdayMonth(page, plan, runtime = {}, context = {})`
- 作用：填写 month
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  stateChanged,
}
```

## 6. `fillDreaminaBirthdayDay(page, plan, runtime = {}, context = {})`
- 作用：填写 day
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  stateChanged,
}
```

## 7. `submitDreaminaProfileCompletion(page, runtime = {}, context = {})`
- 作用：点击 next / submit
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  beforeSnapshot,
  afterSnapshot,
  stateChanged,
}
```

## 8. `confirmDreaminaProfileCompletionSubmitResult(page, runtime = {}, context = {})`
- 作用：确认提交后的结果
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
}
```

## 9. `classifyDreaminaProfileCompletionFailure(input = {})`
- 作用：将阶段 4 失败 reason 收敛成 Dreamina 专属语义
- 返回值示例：
```js
{
  reason,
  siteReason,
  hardFailure,
}
```
