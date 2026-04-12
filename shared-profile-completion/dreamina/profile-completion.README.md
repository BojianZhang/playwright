# Dreamina profile-completion

对应文件：
- `profile-completion-adapter.js`

---

# 当前推荐实现

Dreamina birthday 当前推荐通过 `fillDreaminaBirthdayContinuousFlow(...)` 执行：
- 锁定 birthday dialog
- 输入 Year
- 选择 Month
- 选择 Day
- 点击 Next

中间不再依赖字段级强判定作为主路径成功条件。

---

# 当前设计原则

- 直接沿用已跑通的参考业务流程
- birthday 阶段按连续动作链处理
- 不再在 Month / Day 上做过度内耗式即时判定
- `continuous-flow` 当前承担 `Next` 点击责任

---

# Split fill 的新定位

`fillDreaminaBirthdayYear / Month / Day` 当前仅保留作 fallback / diagnostics，
不再作为 Dreamina 默认主路径。
