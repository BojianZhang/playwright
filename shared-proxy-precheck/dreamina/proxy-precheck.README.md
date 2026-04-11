# Dreamina 代理预检测速链

对应文件：
- `D:\playwright\shared-proxy-precheck\dreamina\proxy-precheck-adapter.js`

这个目录承接 Dreamina 在代理预检测速链上的站点适配。

---

# 一、Dreamina 代理预检测速职责

Dreamina 代理预检测速负责：
- 代理基础连通性检查
- 代理出口 IP 检查
- Dreamina 主目标检查
- Dreamina 副目标检查
- 最终预检结果收口与分级

---

# 二、当前建议方法

- `loadDreaminaProxyPrecheckProfile(...)`
- `checkProxyConnectivity(...)`
- `checkProxyExitIp(...)`
- `checkDreaminaPrimaryTarget(...)`
- `checkDreaminaSecondaryTarget(...)`
- `confirmProxyPrecheckResult(...)`
- `classifyProxyPrecheckFailure(...)`
