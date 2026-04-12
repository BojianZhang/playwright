# Dreamina-register 主链契约

对应文件：
- `D:\playwright\Dreamina\Dreamina-register.js`

这个文档只做一件事：
**把 Dreamina 注册主链编排层当前真实的统一输入、统一输出、职责边界和阶段桥接规则讲清楚。**

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
- 当前重点开关：
  - verification 节奏
  - profile-completion 节奏
  - `verificationAllowResend`
  - `verificationEnableLegacyFallbacks`

## `logInfo`
- 类型：function | undefined
- 含义：日志函数

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

# 六、当前阶段主路径状态

## verification-submit
- 当前默认主路径：`dreamina-direct-fill`
- 当前成功判定：验证码输入后，优先看页面是否进入 birthday / profile-completion
- 当前不再推荐自动参与主链的旧路径：
  - `dreamina-char-by-char`
  - `dreamina-hidden-input`
  - `dreamina-wrapper-keyboard`
  - `fallback-keyboard-type`
- 这些旧路径后续默认仅保留作 debug / diagnostics

## profile-completion-submit
- 当前默认主路径：`fillDreaminaBirthdayContinuousFlow`
- 当前业务流：`Year -> Month -> Day -> Next`
- 当前 birthday 阶段不再以 Month/Day 的字段即时读取作为主成功判定
- `continuous-flow` 当前承担 `Next` 点击责任

---

# 七、统一中断规则

## 基础规则
- 默认情况下，任一阶段 `success=false` 即停止后续阶段
- 停止后统一生成主链失败结果

## Dreamina 当前特例
- 对于部分 verification 可疑失败，主链当前允许 `profile-completion` 继续 probe / 接手判断
- 该桥接规则属于 Dreamina 当前排障与收口期的站点特例
- 该桥接不改变 shared 阶段的基础边界定义

---

# 八、阶段桥接与异常放行规则

## verification -> profile-completion

### 正常情况
- verification 成功
- 进入 `profile-completion`

### 当前 Dreamina 站点特例
- 如果 verification 阶段出现组件误判 / 输入框重绘 / 页面已切换但阶段判断不稳的情况
- 主链允许 `profile-completion` 继续 probe 当前页面
- 最终是否已进入 birthday 阶段，以 `shared-profile-completion` 的 ready 判断和生日业务流执行为准

### 设计目的
- 避免 Dreamina OTP 组件误判导致整链过早终止
- 不在 orchestration 层重新实现 birthday 业务逻辑

---

# 九、一句话总结

`Dreamina-register.js` 当前不是“纯线性静态编排器”，而是：
**以 6 个共享阶段为骨架、以 Dreamina 当前稳定主路径（verification direct-fill、profile-completion continuous-flow）为核心、允许有限站点特例桥接的第一版可用 orchestrator。**
