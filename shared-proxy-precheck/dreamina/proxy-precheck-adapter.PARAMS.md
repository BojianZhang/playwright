# proxy-precheck-adapter.js 参数与方法说明

对应文件：
- `D:\playwright\shared-proxy-precheck\dreamina\proxy-precheck-adapter.js`

这个文档只做一件事：
**把代理预检 adapter 里每个方法的参数、参数作用、返回值、职责边界讲清楚。**

---

# 一、公共参数说明

## `page`
- 类型：Playwright Page | null
- 含义：当前可用于预检的页面对象

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

## `checkProxyConnectivity(page, proxy, runtime = {}, context = {})`
- 作用：检查代理是否具备最基本连通性

## `checkProxyNetworkHealth(page, proxy, runtime = {}, context = {})`
- 作用：检查代理基础网络健康

## `checkProxyEntryReachability(page, proxy, runtime = {}, context = {})`
- 作用：检查目标站点入口是否可达

## `checkProxySiteReady(page, proxy, runtime = {}, context = {})`
- 作用：检查站点首屏是否达到 ready

## `checkProxyBusinessReady(page, proxy, runtime = {}, context = {})`
- 作用：检查业务首屏是否达到可用态

## `confirmProxyPrecheckResult(page, proxy, runtime = {}, context = {})`
- 作用：收口代理预检链最终 success / failure / unknown

## `classifyProxyPrecheckFailure(input = {})`
- 作用：把代理预检失败收敛成 Dreamina 专属语义
