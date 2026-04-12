# Dreamina verification

对应文件：
- `verification-adapter.js`

---

# 当前推荐主路径

Dreamina 当前推荐验证码输入路径：
1. 激活验证码输入框
2. 一次性 `direct-fill` 完整 6 位验证码
3. 输入后优先检查页面是否已进入 birthday / profile-completion
4. 若页面已进入 birthday，则直接视为 verification 成功
5. 仅在明确 wrong-code / rate-limit 时再考虑 resend

---

# 当前设计原则

- 当前验证码轮次优先
- 输入框异常、组件重绘、焦点丢失，不足以直接证明当前验证码失效
- 成功判定优先以“是否进入 birthday 页面”为准，而不是继续盯验证码输入框内部状态

---

# Legacy fallback 定位

以下路径当前仅保留作 debug / diagnostics：
- char-by-char
- hidden-input
- wrapper-keyboard
- fallback-keyboard-type

默认主链不再自动启用这些路径。
