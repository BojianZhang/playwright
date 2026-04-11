# 代理预检测速主链计划草案

对应文件：
- `D:\playwright\shared-proxy-precheck\stages\proxy-precheck.js`

这个文档只做一件事：
**把代理预检测速主链流程顺序先钉清楚。**

---

# 一、建议阶段顺序

1. `proxy-connectivity`
2. `proxy-exit-ip`
3. `dreamina-primary-target-check`
4. `dreamina-secondary-target-check`
5. `proxy-precheck-result`

---

# 二、阶段目标

## 1. proxy-connectivity
- 代理是否能基本连通

## 2. proxy-exit-ip
- 代理出口 IP 是否可以获取

## 3. dreamina-primary-target-check
- 即梦主目标是否可达、响应是否正常

## 4. dreamina-secondary-target-check
- 即梦副目标是否可达、响应是否正常

## 5. proxy-precheck-result
- 收口整个代理预检测速链的 success / weak / failure / unknown
