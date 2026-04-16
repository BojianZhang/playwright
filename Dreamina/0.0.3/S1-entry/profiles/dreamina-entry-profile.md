# Dreamina 阶段 1 profile 说明

对应文件：
- `D:\playwright\shared-entry\dreamina\profiles\dreamina-entry-profile.json`

这个 profile 只做一件事：
**把 Dreamina 在阶段 1 可能会用到的静态入口规则先定义清楚。**

---

# 一、顶层字段

## `site`
- 固定值：`dreamina`
- 含义：当前 profile 所属站点

## `stage`
- 固定值：`entry`
- 含义：当前 profile 所属阶段

## `entryUrl`
- 类型：`string`
- 含义：Dreamina 阶段 1 默认入口 URL

---

# 二、`readySignals`

用于定义阶段 1 入口 ready 信号。

## `readySignals.selectors`
- 类型：`array<string>`
- 含义：进入 credential-submit 前可用的 selector 列表

## `readySignals.texts`
- 类型：`array<string>`
- 含义：进入 credential-submit 前可用的文本信号列表

## `readySignals.urlIncludes`
- 类型：`array<string>`
- 含义：可作为 entry ready 辅助信号的 URL 片段

---

# 三、`healthSignals`

用于定义阶段 1 健康检查规则。

## `healthSignals.errorTexts`
- 类型：`array<string>`
- 含义：常见错误页 / 失败页文本线索列表

## `healthSignals.whiteScreenMinTextLength`
- 类型：`number`
- 含义：用于判断页面是否接近白屏的最小文本长度阈值
