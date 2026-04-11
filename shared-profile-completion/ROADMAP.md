# shared-profile-completion ROADMAP

这个文件记录阶段 4（profile completion submit）的后续推进方向。

---

# 当前目标

先把 Dreamina 的阶段 4 结构搭起来，并明确边界：
- 等 profile-completion ready
- 生成 birthday / profile 填写计划
- 填写资料
- 提交后确认进入 post-auth-ready 或命中阶段 4 失败

---

# 当前状态

当前已完成：
- 阶段 4 架构与边界文档定义
- 第四阶段统一输入输出契约草案
- 第四阶段字段说明与 profile 草案

旧主链里已经存在可参考的阶段 4 真实能力：
- birthday 输入可达性判断
- birthday 随机生成
- birthday 填写
- next 提交
- post-auth-ready 前的阶段确认

---

# 下一步

## 1. 完成 Dreamina adapter 第一版
补全：
- profile-completion ready
- build fill plan
- fill year / month / day
- submit result confirm
- classify failure

## 2. 接通公共阶段骨架
让 `stages/profile-completion-submit.js` 真正调用 Dreamina adapter。

## 3. 对齐旧主链行为口径
旧 `task-register.js` 只做行为参考，不直接耦合。

## 4. 跑真实日志
根据日志再校准：
- ready signals
- birthday input selectors
- submit result signals
- post-auth-ready reachability

## 5. 再决定是否扩更多站点
等 Dreamina 阶段 4 跑通后，再验证抽象层是否足够通用。
