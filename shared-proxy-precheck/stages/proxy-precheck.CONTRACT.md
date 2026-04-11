# 代理预检测速主链契约

对应文件：
- `D:\playwright\shared-proxy-precheck\stages\proxy-precheck.js`

这个文档只做一件事：
**把代理预检测速主链的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、定位

`proxy-precheck` 不是正式注册业务阶段，而是正式注册开始之前的独立网络预检测速链。

它的职责边界是：
- 从当前代理待检查开始
- 到确认进入 `proxy-precheck-complete`，或确认代理预检失败为止

---

# 二、统一输入

`runProxyPrecheckChain(options)` 当前输入：

## `proxy`
- 类型：object
- 含义：当前代理配置对象
- 常见字段：
  - `proxy.host`
  - `proxy.port`
  - `proxy.username`
  - `proxy.password`
  - `proxy.protocol`

## `adapter`
- 类型：object
- 含义：当前站点的代理预检适配器

## `runtime`
- 类型：object
- 含义：预检运行时参数

## `context`
- 类型：object
- 含义：附加上下文

---

# 三、统一输出

`runProxyPrecheckChain(...)` 应返回：

```js
{
  success,
  stage,
  state,
  reason,
  nextStage,
  proxyGrade,
  signalStrength,
  settleStage,
  detectionSource,
  stateChanged,
  retryCount,
  detail,
}
```

---

# 四、字段逐项说明

## `success`
- 类型：`boolean`
- 含义：代理预检测速链是否成功完成

## `stage`
- 类型：`string`
- 固定值：`proxy-precheck`

## `state`
- 类型：`string`
- 含义：代理预检测速主链最终原始状态码

## `reason`
- 类型：`string`
- 含义：外层更适合消费的最终原因

## `nextStage`
- 类型：`string`
- 成功时通常为：`proxy-precheck-complete`

## `proxyGrade`
- 类型：`string`
- 枚举：`OK` / `WEAK` / `BAD`
- 含义：给上层快速消费的代理质量分级

## `signalStrength`
- 类型：`string`
- 含义：当前结果依据的信号强度

## `settleStage`
- 类型：`string`
- 含义：最终结果在第几层确认里收敛

## `detectionSource`
- 类型：`string`
- 含义：最终结果主要基于哪类检测来源

## `stateChanged`
- 类型：`boolean | null`
- 含义：预检过程中状态是否发生了有意义变化

## `retryCount`
- 类型：`number`
- 含义：预检链内部轻量重试次数

## `detail`
- 类型：`object | null`
- 当前建议包含：
  - `connectivity`
  - `exitIp`
  - `primaryTarget`
  - `secondaryTarget`
  - `resultConfirmation`
  - `classified`
  - `proxySummary`
