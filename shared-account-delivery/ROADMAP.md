# shared-account-delivery ROADMAP

这个文件记录阶段 6（account delivery）的后续推进方向。

---

# 当前目标

先把 Dreamina 的阶段 6 结构搭起来，并明确边界：
- 等 account-delivery ready
- 整理账号最终交付字段
- 检查 session / storage / url / ui 摘要是否足够交付
- 收口最终 delivery success / failure / unknown

---

# 当前状态

当前已完成：
- 阶段 6 包结构与边界草案
- 第六阶段统一输入输出契约草案
- 第六阶段字段说明草案
- Dreamina 第六阶段 adapter 与 profile 的高注释骨架

前五阶段已经形成稳定的阶段链：
- 阶段 1：entry
- 阶段 2：credential submit
- 阶段 3：verification submit
- 阶段 4：profile completion submit
- 阶段 5：post-auth-ready

第六阶段当前目标不是直接对接外部交付系统，而是先把“可交付账号结构”这一层的责任与字段语义稳定下来。

---

# 下一步

## 1. 完成 Dreamina adapter 第一版
补全：
- account delivery ready 检测
- 账号最终交付摘要整理
- success / failure / unknown 结果确认
- failure classify

## 2. 接通公共阶段骨架
让 `stages/account-delivery.js` 真正调用 Dreamina adapter。

## 3. 对齐旧主链行为口径
旧 `task-register.js` 只做行为参考，不直接耦合。

## 4. 跑真实日志
根据日志再校准：
- delivery ready signals
- account summary fields
- session/url/ui delivery rules
- success / failure / unknown 收敛口径

## 5. 再决定是否扩更多站点
等 Dreamina 阶段 6 跑稳后，再验证抽象层是否足够通用。
