# proxy-precheck-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-proxy-precheck\dreamina\proxy-precheck-adapter.js`

这个文档只做一件事：
**把代理预检测速 adapter 里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、公共参数说明

## `proxy`
- 类型：object
- 含义：当前代理配置对象

## `runtime`
- 类型：object
- 含义：预检运行时参数

## `context`
- 类型：object
- 含义：附加上下文对象

---

# 二、方法逐个说明

## `checkProxyConnectivity(proxy, runtime = {}, context = {})`
- 作用：检查代理是否具备最基本连通性

## `checkProxyExitIp(proxy, runtime = {}, context = {})`
- 作用：检查代理出口 IP 是否可获取

## `checkDreaminaPrimaryTarget(proxy, runtime = {}, context = {})`
- 作用：检查 Dreamina 主目标是否可达、状态码与耗时是否合理

## `checkDreaminaSecondaryTarget(proxy, runtime = {}, context = {})`
- 作用：检查 Dreamina 副目标是否可达、状态码与耗时是否合理

## `confirmProxyPrecheckResult(proxy, runtime = {}, context = {})`
- 作用：收口代理预检测速链最终 success / weak / failure / unknown

## `classifyProxyPrecheckFailure(input = {})`
- 作用：把代理预检测速失败收敛成 Dreamina 专属语义
