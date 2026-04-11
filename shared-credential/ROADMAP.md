# shared-credential ROADMAP

这个文件记录阶段 2（credential submit）的后续推进方向。

---

# 当前状态

当前已准备搭建：
- 公共阶段骨架
- Dreamina 阶段 2 adapter
- Dreamina 阶段 2 profile 三件套
- 阶段 2 日志模板与判读文档

---

# 当前目标

先把 Dreamina 的阶段 2 结构搭起来，并明确边界：
- 进入 credential form
- 填 email / password
- 点击提交
- 确认进入下一阶段或失败

---

# 下一步

## 1. 完成 Dreamina adapter 第一版
补全：
- form ready
- fill email
- fill password
- submit
- confirm result
- classify failure

## 2. 接通公共阶段骨架
让 `stages/credential-submit.js` 真正调用 Dreamina adapter。

## 3. 再决定是否接入旧主链
旧 `task-register.js` 只做行为参考，不直接耦合。

## 4. 跑真实日志
根据日志再校准：
- success signals
- failure signals
- wait 节奏

## 5. 后续再扩 OpenAI / Claude
等 Dreamina 阶段 2 跑通后，再验证抽象层是否足够通用。
