# shared-proxy-precheck ROADMAP

这个文件记录代理预检链的后续推进方向。

---

# 当前目标

先把代理预检链的结构搭起来，并明确边界：
- 检查代理是否能连通
- 检查代理基础网络健康
- 检查站点入口是否可达
- 检查站点是否达到业务首屏可用态
- 收口统一的代理预检结果

---

# 当前状态

当前已完成：
- 代理预检包结构与边界草案
- 统一输入输出契约草案
- 字段说明草案
- Dreamina 代理预检 adapter 与 profile 的高注释骨架

这个包的目标不是替代 runner 的代理调度，而是把“代理本身是否值得交给注册链使用”这件事结构化。

---

# 下一步

## 1. 完成 Dreamina adapter 第一版
补全：
- proxy connectivity
- network health
- entry reachability
- site ready
- business ready
- result confirm
- failure classify

## 2. 接通公共阶段骨架
让各阶段 `stages/*.js` 真正调用 Dreamina adapter。

## 3. 跑真实日志
根据日志再校准：
- 代理健康信号
- 入口可达信号
- 业务首屏可用信号
- success / failure / unknown 收敛口径
