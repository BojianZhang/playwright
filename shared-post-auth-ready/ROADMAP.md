# shared-post-auth-ready ROADMAP

这个文件记录阶段 5（post-auth ready）的后续推进方向。

---

# 当前目标

先把 Dreamina 的阶段 5 结构搭起来，并明确边界：
- 等 post-auth-ready
- 判断是否已经进入已登录用户态
- 确认 session / storage / 用户面板是否达到可用态
- 收口注册主链最终成功/失败/未知结果

---

# 当前状态

当前已完成：
- 阶段 5 包结构与边界草案
- 第五阶段统一输入输出契约草案
- 第五阶段字段说明草案
- Dreamina 第五阶段 adapter 与 profile 的高注释骨架

前四阶段已经形成稳定的阶段链：
- 阶段 1：entry
- 阶段 2：credential submit
- 阶段 3：verification submit
- 阶段 4：profile completion submit

第五阶段当前目标不是继续复用旧主链实现，而是先把“最终已登录态确认”的责任与字段语义稳定下来。

---

# 下一步

## 1. 完成 Dreamina adapter 第一版
补全：
- post-auth ready 检测
- 登录态 / session 可用态确认
- 成功/失败/未知结果确认
- failure classify

## 2. 接通公共阶段骨架
让 `stages/post-auth-ready.js` 真正调用 Dreamina adapter。

## 3. 对齐旧主链行为口径
旧 `task-register.js` 只做行为参考，不直接耦合。

## 4. 跑真实日志
根据日志再校准：
- post-auth ready signals
- session-ready signals
- dashboard / user panel signals
- success / failure / unknown 收敛口径

## 5. 再决定是否扩更多站点
等 Dreamina 阶段 5 跑稳后，再验证抽象层是否足够通用。
