# shared-verification ROADMAP

这个文件记录阶段 3（verification submit）的当前状态与后续推进方向。

---

# 当前阶段

Dreamina verification 已完成从“结构搭建期”进入“主路径冻结与收口期”。

当前已确认：
- verification ready 可稳定识别
- fetch code 可稳定工作
- `dreamina-direct-fill` 已可推进到 birthday / profile-completion
- birthday 页面信号可用于确认阶段成功
- resend 应以“当前验证码轮次优先”为基本原则

---

# 当前主路径

## Dreamina 默认主路径
1. 激活验证码输入框
2. 一次性 `direct-fill` 完整 6 位验证码
3. 优先检查页面是否已进入 birthday / profile-completion
4. 仅在明确 wrong-code / rate-limit 时再考虑 resend

## 当前不再推荐的默认路径
- `dreamina-char-by-char`
- `dreamina-hidden-input`
- `dreamina-wrapper-keyboard`
- `fallback-keyboard-type`

这些路径当前仅保留作 debug / diagnostics。

---

# 下一步

## 1. 把 legacy fallback 正式降级为 debug-only
- 关闭默认自动参与
- 通过 runtime 开关按需启用

## 2. 继续收紧 resend 规则
- 明确仅对 wrong-code / rate-limit 触发 resend
- 避免因为组件重绘作废当前验证码轮次

## 3. 继续补文档与 contract
- README / CONTRACT / PARAMS / FIELDS 继续追平代码

## 4. 验证更多验证码场景
- 错码
- 频率限制
- 已切 birthday 但输入框重绘
