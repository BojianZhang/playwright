# Dreamina 阶段 5：post-auth-ready

**文件位置**：`Dreamina/0.0.3/S5-post-auth-ready/`
**阶段标识**：`S5`
**阶段名称**：登录后就绪确认（Post-Auth Ready）

对应文件：
- `Dreamina/0.0.3/S5-post-auth-ready/post-auth-ready-adapter.js`
- `post-auth-ready-adapter.PARAMS.md`（入参与方法签名说明）
- `post-auth-ready-adapter.FIELDS.md`（返回字段说明）
- `profiles/dreamina-post-auth-ready-profile.json`（程序读取）

这个目录承接 Dreamina 在第五阶段的站点适配。

---

# 一、Dreamina 阶段 5 的职责

Dreamina 阶段 5 负责：
- 等待 profile-completion 之后的页面进入登录后可用态
- 判断 Dreamina 是否已经建立用户态
- 判断 session / storage / 登录后 UI 是否达到可交付标准
- 最终收口 `registration-complete`

---

# 二、Dreamina 阶段 5 不负责

- 回头填写生日
- 回头重新拉验证码
- 再次处理 credential submit
- 外部系统持久化
- runner 决策

---

# 三、Dreamina 阶段 5 当前建议方法

- `loadDreaminaPostAuthReadyProfile(...)`
- `waitForPostAuthReady(...)`
- `inspectPostAuthSession(...)`
- `confirmPostAuthUi(...)`
- `confirmPostAuthResult(...)`
- `classifyPostAuthFailure(...)`

---

# 四、当前落地策略

当前先做高注释骨架与字段语义文档，不急着直接写重逻辑。
先把：
- 边界
- 字段
- 返回结构
- 站点信号类型

先钉死，后续再根据真实运行日志逐步把 Dreamina 第五阶段做实。
