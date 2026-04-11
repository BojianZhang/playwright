# Dreamina-register 字段说明

对应文件：
- `D:\playwright\Dreamina\Dreamina-register.js`

这个文档只做一件事：
**把 Dreamina 主链编排层里所有关键输入、输出、重要中间对象字段讲清楚。**

---

# 一、`buildDreaminaStageRegistry()` 返回字段

## `entry`
- 类型：`object`
- 含义：Dreamina 第 1 阶段注册表项

### `entry.stage`
- 类型：`string`
- 固定值：`entry`
- 含义：当前注册表项对应的阶段名

### `entry.run`
- 类型：`function`
- 含义：第 1 阶段的公共 runner

### `entry.adapter`
- 类型：`object | null`
- 含义：Dreamina 第 1 阶段适配配置或适配器对象

## `credential`
- 类型：`object`
- 含义：Dreamina 第 2 阶段注册表项

## `verification`
- 类型：`object`
- 含义：Dreamina 第 3 阶段注册表项

## `profileCompletion`
- 类型：`object`
- 含义：Dreamina 第 4 阶段注册表项

## `postAuthReady`
- 类型：`object`
- 含义：Dreamina 第 5 阶段注册表项

## `accountDelivery`
- 类型：`object`
- 含义：Dreamina 第 6 阶段注册表项

---

# 二、`buildDreaminaRegisterContext(...)` 返回字段

## `site`
- 类型：`string`
- 固定值：`dreamina`
- 含义：当前主链所属站点

## `browser`
- 类型：`object | null`
- 含义：浏览器对象

## `browserContext`
- 类型：`object | null`
- 含义：浏览器上下文对象

## `page`
- 类型：`object`
- 含义：当前主链运行页面对象

## `account`
- 类型：`object`
- 含义：当前账号上下文

## `runtime`
- 类型：`object`
- 含义：主链 runtime

## `logInfo`
- 类型：`function | null`
- 含义：日志函数

## `stageRegistry`
- 类型：`object`
- 含义：Dreamina 阶段注册表

## `stageResults`
- 类型：`object`
- 含义：主链阶段结果容器

### `stageResults.entry`
- 类型：`object | null`
- 含义：第 1 阶段结果

### `stageResults.credential`
- 类型：`object | null`
- 含义：第 2 阶段结果

### `stageResults.verification`
- 类型：`object | null`
- 含义：第 3 阶段结果

### `stageResults.profileCompletion`
- 类型：`object | null`
- 含义：第 4 阶段结果

### `stageResults.postAuthReady`
- 类型：`object | null`
- 含义：第 5 阶段结果

### `stageResults.accountDelivery`
- 类型：`object | null`
- 含义：第 6 阶段结果

## `meta`
- 类型：`object`
- 含义：主链元信息容器

### `meta.startedAt`
- 类型：`number`
- 含义：主链启动时间戳（毫秒）

---

# 三、`runDreaminaStage(...)` 返回字段

## `ok`
- 类型：`boolean`
- 含义：当前阶段是否执行成功并允许主链继续

## `stageKey`
- 类型：`string`
- 含义：当前阶段在 Dreamina 编排层里的阶段 key

## `result`
- 类型：`object | null`
- 含义：当前阶段公共 runner 返回的原始阶段结果

---

# 四、`normalizeDreaminaRegisterResult(...)` 返回字段

## `success`
- 类型：`boolean`
- 含义：Dreamina 主链是否成功完成

## `site`
- 类型：`string`
- 固定值：`dreamina`

## `finalStage`
- 类型：`string`
- 含义：最终停留的阶段名

## `finalState`
- 类型：`string`
- 含义：最终阶段返回的原始状态码

## `finalReason`
- 类型：`string`
- 含义：最终对外消费原因

## `nextStage`
- 类型：`string`
- 含义：下一阶段建议值

## `account`
- 类型：`object`
- 含义：账号基础上下文

## `deliveryPayload`
- 类型：`object | null`
- 含义：第 6 阶段产出的交付对象草案

## `stageResults`
- 类型：`object`
- 含义：全链阶段结果汇总

## `meta`
- 类型：`object | null`
- 含义：主链元信息

### `meta.startedAt`
- 类型：`number`
- 含义：主链开始时间戳

### `meta.finishedAt`
- 类型：`number`
- 含义：主链结束时间戳

### `meta.durationMs`
- 类型：`number`
- 含义：主链总耗时

### `meta.successStageCount`
- 类型：`number`
- 含义：成功完成的阶段数
