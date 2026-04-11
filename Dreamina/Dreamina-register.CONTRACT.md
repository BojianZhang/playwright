# Dreamina-register 主链契约

对应文件：
- `D:\playwright\Dreamina\Dreamina-register.js`

这个文档只做一件事：
**把 Dreamina 注册主链编排层的统一输入、统一输出、职责边界讲清楚。**

---

# 一、定位

`Dreamina-register.js` 不是某个单阶段 adapter，也不是旧 `task-register.js` 的重新复制。

它的职责是：
- 把 6 个共享阶段模块按顺序编排起来
- 把 Dreamina 站点 adapter 注入到各阶段
- 管理阶段间 context 传递
- 收口整条 Dreamina 注册主链结果

---

# 二、负责什么

- 串联以下 6 个阶段：
  1. `shared-entry`
  2. `shared-credential`
  3. `shared-verification`
  4. `shared-profile-completion`
  5. `shared-post-auth-ready`
  6. `shared-account-delivery`
- 组装 Dreamina 阶段注册表
- 构造统一主链 context
- 调用每个阶段公共 runner
- 维护 `stageResults`
- 某阶段失败时停止后续阶段
- 输出统一主链结果

---

# 三、不负责什么

- 不直接实现各阶段站点细节
- 不重新编写邮箱 / 验证码 / 生日 / session 逻辑
- 不负责 browser/context 创建（除非外层明确要求）
- 不负责代理切换 / bad 池治理
- 不负责外部数据库写入
- 不负责外部 API 推送
- 不负责消息通知

---

# 四、统一输入

`runDreaminaRegisterFlow(options)` 当前建议输入：

## `page`
- 类型：Playwright Page
- 含义：当前实际执行注册流程的页面对象

## `browser`
- 类型：Playwright Browser | undefined
- 含义：浏览器对象，可选
- 用途：在需要时给上下文或日志使用

## `context`
- 类型：Playwright BrowserContext | object | undefined
- 含义：浏览器上下文对象或外层上下文对象

## `account`
- 类型：object
- 常用字段：
  - `account.email`
  - `account.password`
- 含义：当前账号上下文

## `runtime`
- 类型：object
- 含义：主链运行时参数
- 用途：
  - 各阶段等待节奏
  - 阶段内部 budget
  - 主链级开关

## `logInfo`
- 类型：function | undefined
- 含义：日志函数
- 用途：
  - 记录主链日志
  - 下发给各阶段使用

---

# 五、统一输出

`runDreaminaRegisterFlow(...)` 应返回：

```js
{
  success,
  site,
  finalStage,
  finalState,
  finalReason,
  nextStage,
  account,
  deliveryPayload,
  stageResults,
  meta,
}
```

---

# 六、字段逐项说明

## `success`
- 类型：`boolean`
- 含义：Dreamina 整条注册主链是否成功完成

## `site`
- 类型：`string`
- 固定值：`dreamina`
- 含义：当前主链所属站点

## `finalStage`
- 类型：`string`
- 含义：整条主链最终停留的阶段
- 可能值示例：
  - `entry`
  - `credential-submit`
  - `verification-submit`
  - `profile-completion-submit`
  - `post-auth-ready`
  - `account-delivery`

## `finalState`
- 类型：`string`
- 含义：最终阶段返回的原始状态码

## `finalReason`
- 类型：`string`
- 含义：外层更适合消费的最终原因

## `nextStage`
- 类型：`string`
- 含义：如果成功或部分收敛，下一阶段建议值
- 失败时通常为空字符串 `''`

## `account`
- 类型：`object`
- 含义：当前账号基础上下文

## `deliveryPayload`
- 类型：`object | null`
- 含义：来自第六阶段的可交付对象草案

## `stageResults`
- 类型：`object`
- 含义：6 个阶段各自的结果汇总对象

## `meta`
- 类型：`object | null`
- 含义：主链级元信息
- 建议包含：
  - `startedAt`
  - `finishedAt`
  - `durationMs`
  - `successStageCount`

---

# 七、一句话总结

`Dreamina-register.js` 的稳定契约不是“自己重写一遍注册逻辑”，而是：
**把 6 个共享阶段模块按 Dreamina 站点顺序串起来，并输出一份统一、干净、可运维的主链结果。**
