# entry-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-entry\dreamina\entry-adapter.js`

这个文档只做一件事：
**把这个文件里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、文件边界

这个文件负责：
- Dreamina 阶段 1（entry）的站点适配
- 入口页打开 / 校正
- 入口健康检查
- 入口 ready 判断
- 阶段 1 失败分类

这个文件不负责：
- credential submit
- verification submit
- profile completion
- post-auth-ready
- account-delivery
- 外部系统写入
- runner 层代理调度、结果落盘

---

# 二、公共参数说明

## `page`
- 类型：Playwright Page
- 作用：当前浏览器页面对象
- 用途：
  - 打开 URL
  - 读取文本
  - 读取 URL
  - 判断入口页 ready

## `runtime`
- 类型：object
- 作用：阶段运行时上下文
- 当前建议用途：
  - entry 等待节奏
  - goto/reload budget
  - 健康检查等待

## `context`
- 类型：object
- 作用：附加上下文对象
- 当前常见字段：
  - `logInfo`
  - `browser`
  - `browserContext`
  - `page`

---

# 三、方法逐个说明

## 1. `loadDreaminaEntryProfile(options = {})`
- 作用：读取 `dreamina-entry-profile.json`
- 返回值：Dreamina 阶段 1 profile

## 2. `openEntryPage(page, runtime = {}, context = {})`
- 作用：打开或校正 Dreamina 入口页
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
  stateChanged,
}
```

## 3. `checkEntryHealth(page, runtime = {}, context = {})`
- 作用：检查 Dreamina 入口页是否存在白屏、死页、错误页等健康问题
- 返回值示例：
```js
{
  ok,
  state,
  source,
  value,
  strength,
  stateChanged,
}
```

## 4. `waitForEntryReady(page, runtime = {}, context = {})`
- 作用：等待并确认 Dreamina 入口页已经达到可推进到 credential-submit 的状态
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

## 5. `classifyEntryFailure(input = {})`
- 作用：把阶段 1 失败 reason 收敛成 Dreamina 专属语义
- 返回值示例：
```js
{
  reason,
  siteReason,
  hardFailure,
}
```
