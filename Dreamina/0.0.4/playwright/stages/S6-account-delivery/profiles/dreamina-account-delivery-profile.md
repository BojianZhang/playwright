# Dreamina 阶段 6 profile 说明

对应文件：
- `D:\playwright\shared-account-delivery\dreamina\profiles\dreamina-account-delivery-profile.json`

这个 profile 只做一件事：
**把 Dreamina 在第六阶段可能会用到的静态交付规则入口先定义清楚。**

---

# 一、顶层字段

## `site`
- 固定值：`dreamina`
- 含义：当前 profile 所属站点

## `stage`
- 固定值：`account-delivery`
- 含义：当前 profile 所属阶段

---

# 二、`deliveryReady`

用于定义第六阶段入口 ready 信号。

## `deliveryReady.selectors`
- 类型：`array<string>`
- 含义：进入第六阶段时优先匹配的 DOM selector 列表

## `deliveryReady.texts`
- 类型：`array<string>`
- 含义：进入第六阶段时可用的文本信号列表

## `deliveryReady.urlIncludes`
- 类型：`array<string>`
- 含义：可作为第六阶段 ready 辅助信号的 URL 片段

---

# 三、`summarySignals`

用于定义第六阶段账号摘要整理的关键规则。

## `summarySignals.accountFields`
- 类型：`array<string>`
- 含义：账号交付摘要中应优先存在的基础字段名

## `summarySignals.sessionKeys`
- 类型：`array<string>`
- 含义：可作为交付摘要辅助的 session / storage 关键键名

## `summarySignals.uiSignals`
- 类型：`array<string>`
- 含义：可作为交付摘要辅助的 UI 信号名或标签

---

# 四、`payloadRules`

用于定义交付对象字段规则。

## `payloadRules.requiredFields`
- 类型：`array<string>`
- 含义：当前 delivery payload 最少必须具备的字段

## `payloadRules.optionalFields`
- 类型：`array<string>`
- 含义：可选但建议保留的交付字段

---

# 五、`successSignals`

用于定义第六阶段最终成功信号。

## `successSignals.selectors`
- 类型：`array<string>`
- 含义：可以辅助确认 delivery-complete 的 selector 列表

## `successSignals.texts`
- 类型：`array<string>`
- 含义：可以辅助确认 delivery-complete 的文本信号列表

---

# 六、`failureSignals`

用于定义第六阶段明确失败信号。

## `failureSignals.selectors`
- 类型：`array<string>`
- 含义：delivery 失败态 selector 列表

## `failureSignals.texts`
- 类型：`array<string>`
- 含义：delivery 失败态文本线索列表
