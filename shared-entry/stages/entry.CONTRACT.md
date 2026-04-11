# entry 阶段契约

对应文件：
- `D:\playwright\shared-entry\stages\entry.js`

这个文档只做一件事：
**把阶段 1（entry）的统一输入、统一输出、字段语义、边界讲清楚。**

---

# 一、阶段定位

`entry` 是注册主链里的**阶段 1**。

它的职责边界是：
- 从页面尚未进入登录业务阶段开始
- 到确认站点入口页已经健康可操作，并可推进到 `credential-submit` 为止

它不负责：
- credential submit
- verification submit
- profile completion
- post-auth-ready
- account-delivery
- 外部系统写入
- runner 层代理调度、结果落盘

---

# 二、统一输入

`runEntryStage(options)` 当前输入：

## `page`
- 类型：Playwright Page
- 含义：当前真实执行动作的页面对象
- 要求：页面已创建，但不要求已经进入登录业务上下文

## `account`
- 类型：object
- 含义：当前账号上下文
- 作用：
  - 阶段 1 本身通常不直接消费账号字段
  - 但为了主链统一接口，仍保留该输入

## `adapter`
- 类型：object | null
- 含义：当前站点的阶段 1 适配器
- 作用：承接站点专属的 open / ready / failure classify 逻辑

## `runtime`
- 类型：object
- 含义：阶段运行时参数
- 当前常见用途：
  - entry 打开等待节奏
  - reload / retry budget
  - 健康检查等待

## `context`
- 类型：object
- 含义：附加上下文
- 当前常见用途：
  - 日志函数
  - browser / context / page 辅助对象
  - 前序主链背景信息

---

# 三、统一输出

`runEntryStage(...)` 应返回统一结构：

```js
{
  success,
  stage,
  state,
  reason,
  nextStage,
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
- 含义：阶段 1 是否成功完成
- 口径：
  - `true` = 入口页已经健康可操作，并可推进到 `credential-submit`
  - `false` = 阶段 1 失败，或当前结果不足以确认入口 ready

## `stage`
- 类型：`string`
- 固定值：`entry`
- 含义：当前结果所属阶段名

## `state`
- 类型：`string`
- 含义：阶段 1 的原始状态码 / 阶段内结果状态
- 示例：
  - `ENTRY_READY`
  - `ENTRY_NOT_READY`
  - `ENTRY_HEALTH_FAILED`
  - `ENTRY_RESULT_UNKNOWN`

## `reason`
- 类型：`string`
- 含义：外层更适合消费的失败/结果原因

## `nextStage`
- 类型：`string`
- 含义：当前阶段成功后应推进到哪个阶段
- 当前阶段 1 成功时：
  - 通常为 `credential-submit`
- 失败时：
  - 为空字符串 `''`

## `signalStrength`
- 类型：`string`
- 常见值：
  - `strong`
  - `weak`
  - `''`
- 含义：当前结果依据的信号强度

## `settleStage`
- 类型：`string`
- 常见值：
  - `primary-success`
  - `primary-failure`
  - `secondary-success`
  - `secondary-failure`
  - `health-check`
  - `none`
- 含义：入口结果是在第几层确认里收敛出来的

## `detectionSource`
- 类型：`string`
- 常见值：
  - `selector`
  - `text`
  - `url`
  - `health-check`
  - `''`
- 含义：当前结果主要基于哪种检测来源得出的

## `stateChanged`
- 类型：`boolean | null`
- 含义：入口阶段检查前后页面是否发生了有意义变化

## `retryCount`
- 类型：`number`
- 含义：阶段 1 内部已经发生了多少次轻量重试

## `detail`
- 类型：`object | null`
- 含义：阶段内部的详细上下文结果
- 当前常见内容建议：
  - `entryOpenResult`
  - `entryReadyResult`
  - `classified`

---

# 五、一句话总结

`entry` 的稳定契约不是“打开了个页面”，而是：
**把站点入口页治理到健康可操作，并干净地交给 `credential-submit`。**
