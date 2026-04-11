# post-auth-ready-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-post-auth-ready\dreamina\post-auth-ready-adapter.js`

这个文档只做一件事：
**把这个文件里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、文件边界

这个文件负责：
- Dreamina 阶段 5（post-auth-ready）的站点适配
- post-auth-ready ready 判断
- session / storage / cookie 可用态检查
- 登录后 UI 信号确认
- 最终成功/失败/未知结果确认
- 提交失败分类

这个文件不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- birthday / profile completion
- browser/context 创建
- runner 层代理调度、结果落盘

---

# 二、公共参数说明

## `page`
- 类型：Playwright Page
- 作用：当前浏览器页面对象
- 用途：
  - 查找 locator
  - 读取文本
  - 读取 URL
  - 读取 cookie / storage 摘要
  - 确认结果

## `account`
- 类型：object
- 作用：当前账号信息
- 常用字段：
  - `account.email`
  - `account.password`
- 用途：
  - 日志标识
  - 第五阶段失败分类辅助上下文

## `runtime`
- 类型：object
- 作用：阶段运行时上下文
- 当前建议用途：
  - post-auth ready 等待节奏
  - session-ready 检查等待
  - 最终结果确认等待

## `context`
- 类型：object
- 作用：附加上下文对象
- 当前常见字段：
  - `logInfo`
  - `postAuthReady`
  - `sessionInspection`
  - `uiConfirmation`
  - `resultConfirmation`

---

# 三、方法逐个说明

## 1. `loadDreaminaPostAuthReadyProfile(options = {})`
- 作用：读取 `dreamina-post-auth-ready-profile.json`
- 返回值：Dreamina 阶段 5 profile

## 2. `waitForPostAuthReady(page, runtime = {}, context = {})`
- 作用：等待并确认当前页面已经进入第五阶段上下文
- 当前建议分步骤：
  1. 查 post-auth selector ready
  2. 查 post-auth text ready
  3. 查登录后 URL/路由线索
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

## 3. `inspectPostAuthSession(page, runtime = {}, context = {})`
- 作用：读取 cookie / localStorage / sessionStorage 的轻量摘要，确认用户态基础信号是否建立
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
  stateChanged,
  cookieSummary,
  localStorageSummary,
  sessionStorageSummary,
}
```

## 4. `confirmPostAuthUi(page, runtime = {}, context = {})`
- 作用：确认登录后 UI 信号是否已经出现
- 当前建议检测：
  - 用户头像
  - 用户菜单
  - 工作台首页
  - 登出按钮
  - 登录后欢迎区
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
}
```

## 5. `confirmPostAuthResult(page, runtime = {}, context = {})`
- 作用：根据 ready / session / UI 三部分结果，收口第五阶段最终 success / failure / unknown
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

## 6. `classifyPostAuthFailure(input = {})`
- 作用：把第五阶段失败 reason 收敛成 Dreamina 专属语义
- 返回值示例：
```js
{
  reason,
  siteReason,
  hardFailure,
}
```
