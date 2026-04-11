# 代理预检主链计划草案

对应文件：
- `D:\playwright\shared-proxy-precheck\stages\proxy-precheck.js`

这个文档只做一件事：
**把代理预检主链流程顺序先钉清楚。**

---

# 一、建议阶段顺序

1. `proxy-connectivity`
2. `proxy-network-health`
3. `proxy-entry-reachability`
4. `proxy-site-ready`
5. `proxy-business-ready`
6. `proxy-precheck-result`

---

# 二、阶段目标

## 1. proxy-connectivity
- 代理是否能基本连通

## 2. proxy-network-health
- 代理是否具备基本网络健康度

## 3. proxy-entry-reachability
- 目标站点入口是否可达

## 4. proxy-site-ready
- 站点首屏是否能达到 ready

## 5. proxy-business-ready
- 站点业务首屏是否达到可使用态

## 6. proxy-precheck-result
- 收口整个代理预检链 success / failure / unknown
