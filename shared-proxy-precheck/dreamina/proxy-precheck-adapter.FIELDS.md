# proxy-precheck-adapter 字段说明

对应文件：
- `D:\playwright\shared-proxy-precheck\dreamina\proxy-precheck-adapter.js`

这个文档只做一件事：
**把代理预检测速 adapter 里所有关键返回对象字段讲清楚。**

---

# 一、通用返回字段

适用于：
- `checkProxyConnectivity(...)`
- `checkProxyExitIp(...)`
- `checkDreaminaPrimaryTarget(...)`
- `checkDreaminaSecondaryTarget(...)`

## `ok`
- 类型：`boolean`
- 含义：当前子阶段是否通过

## `state`
- 类型：`string`
- 含义：当前子阶段原始状态码

## `source`
- 类型：`string`
- 含义：当前子阶段信号来源

## `value`
- 类型：`string`
- 含义：当前子阶段辅助值或命中值

## `strength`
- 类型：`string`
- 含义：当前子阶段信号强度

## `elapsedMs`
- 类型：`number | undefined`
- 含义：当前子阶段耗时

---

# 二、`confirmProxyPrecheckResult(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：代理预检测速主链是否确认成功

## `state`
- 类型：`string`
- 含义：预检测速主链最终状态码

## `nextStage`
- 类型：`string`
- 含义：成功后应推进到哪个最终阶段

## `proxyGrade`
- 类型：`string`
- 枚举：`OK` / `WEAK` / `BAD`
- 含义：当前代理质量分级

## `source`
- 类型：`string`
- 含义：最终结果主要来源

## `value`
- 类型：`string`
- 含义：最终结果辅助值

## `strength`
- 类型：`string`
- 含义：最终结果信号强度

## `settleStage`
- 类型：`string`
- 含义：最终结果是在第几层确认里收敛的

## `retryCount`
- 类型：`number`
- 含义：代理预检链内部轻量重试次数

---

# 三、`classifyProxyPrecheckFailure(...)` 返回字段

## `reason`
- 类型：`string`
- 含义：输入侧原始失败状态

## `siteReason`
- 类型：`string`
- 含义：Dreamina 语义下收敛后的失败原因

## `hardFailure`
- 类型：`boolean`
- 含义：是否应视为强失败
