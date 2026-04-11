# shared-proxy-precheck 包内统一入口

对应文件：
- `D:\playwright\shared-proxy-precheck\index.js`

这个文件的目标是：
**在包内部先提供一个最小可运行入口，用来读取 `local-proxies.txt`、选择代理、执行 Dreamina 代理预检。**

---

# 一、当前暴露的方法

## `selectLocalProxy(proxies = [], options = {})`
作用：
- 从本地代理数组里选出一个代理
- 当前第一版默认按 `preferredIndex` 取一个

## `runDreaminaProxyPrecheckFromLocal(options = {})`
作用：
- 读取 `local-proxies.txt`
- 选一个代理
- 调用 `runProxyPrecheckChain(...)`
- 注入 Dreamina proxy-precheck adapter
- 返回统一预检结果 + 当前选中的代理对象 + 代理脱敏摘要

---

# 二、当前输入

## `page`
- 类型：Playwright Page | null
- 含义：当前预检页面

## `runtime`
- 类型：object
- 含义：预检运行时参数

## `context`
- 类型：object
- 含义：附加上下文

## `preferredIndex`
- 类型：number
- 含义：优先取第几个本地代理

## `adapter`
- 类型：object
- 含义：当前站点 proxy-precheck adapter
- 默认：Dreamina adapter

---

# 三、当前输出

在 `runDreaminaProxyPrecheckFromLocal(...)` 返回值里，除了 `runProxyPrecheckChain(...)` 原有字段，还额外带：

## `proxy`
- 当前选中的原始代理对象

## `proxySummary`
- 当前选中代理的脱敏摘要

---

# 四、当前边界

这个入口当前只是包内联调入口。
它负责：
- 从包内本地代理源读取代理
- 选择一个代理
- 执行 Dreamina 预检

它不负责：
- 多代理轮询
- 自动重试下一个代理
- runner 层 bad 池治理
- 正式注册链调用
