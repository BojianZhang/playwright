# Dreamina 代理预检链

对应文件：
- `D:\playwright\shared-proxy-precheck\dreamina\proxy-precheck-adapter.js`

这个目录承接 Dreamina 在代理预检链上的站点适配。

---

# 一、Dreamina 代理预检职责

Dreamina 代理预检负责：
- 代理连通性
- 代理网络健康
- Dreamina 入口可达
- Dreamina 首屏 ready
- Dreamina 业务首屏可用态
- 最终预检结果收口

---

# 二、当前建议方法

- `loadDreaminaProxyPrecheckProfile(...)`
- `checkProxyConnectivity(...)`
- `checkProxyNetworkHealth(...)`
- `checkProxyEntryReachability(...)`
- `checkProxySiteReady(...)`
- `checkProxyBusinessReady(...)`
- `confirmProxyPrecheckResult(...)`
- `classifyProxyPrecheckFailure(...)`
