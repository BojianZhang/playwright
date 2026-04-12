# shared-post-auth-ready

这个包负责：
**阶段 5：post-auth ready**。

也就是：
- 在页面已经离开 verification / profile-completion 上下文后
- 等待注册完成后的已登录页面或已登录工作台进入可判定状态
- 判断当前是否已经建立用户态 / session 可用态
- 收口注册主链的最终成功/失败/未知结果
- 成功时只确认进入最终阶段 `registration-complete`

---

# 当前实现状态（Dreamina）

当前 Dreamina 的第 5 阶段**仍处于 bridge / transition 模式**，还不是完全成熟的“真实 post-auth 已登录态确认层”。

现状说明：
- README / 边界文档定义的目标边界，是“离开 profile-completion 后，确认已登录态 / session / 用户态”。
- 但当前 Dreamina profile / adapter 里，仍保留了 birthday 面板相关的 bridge signals，作为第 4 阶段提交后向第 5 阶段过渡时的临时承接信号。
- 因此当前第 5 阶段更准确的理解应是：
  - **优先承担 bridge-only/transition-only 收口**
  - **逐步向真实 post-auth-ready 已登录态确认迁移**

这意味着：
- 当前第 5 阶段可以继续保留 bridge 信号，避免链路断裂。
- 但这些 bridge 信号不应被误认为最终成熟的 `post-auth-ready` 主定义。
- 后续应逐步替换为真实登录后页面 / 用户面板 / session / storage 的稳定信号。

---

# 边界

## 阶段输入
- `browser / context / page` 已创建
- 当前页面已经离开 profile-completion 上下文，或至少已出现 post-auth-ready / bridge-only 过渡线索
- 上一阶段（profile completion submit）已经成功，或至少已确认页面正在向 post-auth-ready 推进
- 账号信息与站点 runtime 已由上层准备好

## 负责什么
- post-auth-ready ready 判断
- 已登录面板 / 工作台 / 首页恢复态判断
- session / storage / 用户态是否已可用的站内确认
- 最终成功/失败/未知结果确认
- 各站点在阶段 5 的适配与配置
- 成功时输出 `nextStage=registration-complete`

## 不负责什么
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- birthday / profile completion
- browser/context 创建
- runner 层代理调度、重试、结果落盘
- 跨系统账户写库、外部消息通知

---

# 结构

- `stages/post-auth-ready.js`
  - 阶段 5 公共骨架
- `dreamina/post-auth-ready-adapter.js`
  - Dreamina 阶段 5 适配层
- `dreamina/profiles/*`
  - Dreamina 阶段 5 配置与文档
- `dreamina/log/*`
  - 阶段 5 日志模板与判读示例

---

# 设计原则

- 公共层只写阶段流程骨架
- 站点差异放 adapter
- 静态规则放 profile
- 日志判读单独文档化
- 第五阶段的成功定义不是“业务全都结束”，而是“注册主链已经确认建立可用用户态，并进入 registration-complete”
- Dreamina 当前仍允许 bridge-only 信号临时承接，但长期目标仍是“真实已登录态确认”，而不是长期依赖 birthday bridge

---

# 后续

当前先落 Dreamina bridge 模式。
后续如果接其他站点，继续沿用：
- 公共阶段模块
- 站点 adapter
- profile 三件套