# shared-verification ROADMAP

这个文件记录阶段 3（verification submit）的后续推进方向。

---

# 当前目标

先把 Dreamina 的阶段 3 结构搭起来，并明确边界：
- 等 verification ready
- 获取验证码
- 输入验证码
- 确认进入 profile-completion 或命中 verification 阶段失败

---

# 当前状态

当前已完成：
- 阶段 3 架构与边界文档定义
- 公共骨架与 Dreamina adapter 初版空实现
- Dreamina verification profile 初版

旧主链里已经存在可参考的阶段 3 真实能力：
- verification ready 等待
- 获取验证码
- 验证码输入控件候选
- 验证码输入策略
- 提交后失败分类
- birthday 阶段到达确认

---

# 下一步

## 1. 完成 Dreamina adapter 第一版
补全：
- verification ready
- fetch code
- resolve code input
- fill code
- confirm result
- classify failure

## 2. 接通公共阶段骨架
让 `stages/verification-submit.js` 真正调用 Dreamina adapter。

## 3. 对齐旧主链行为口径
旧 `task-register.js` 只做行为参考，不直接耦合。

## 4. 跑真实日志
根据日志再校准：
- verification ready signals
- wrong code signals
- rate limit signals
- profile-completion ready signals

## 5. 再决定是否扩更多站点
等 Dreamina 阶段 3 跑通后，再验证抽象层是否足够通用。
