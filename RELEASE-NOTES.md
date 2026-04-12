# Release Notes

## v1.0.2 — Dreamina shared architecture checkpoint

### 概要
这一版是 Dreamina 注册链路的阶段性封板版本。核心目标不是继续扩逻辑，而是把已验证跑通的主路径、后半段语义、交付摘要链路正式收口。

### 本版完成内容

#### 1. Dreamina 主链稳定跑通
当前已验证整条链可稳定完成：
- proxy-precheck
- entry
- credential-submit
- verification-submit
- profile-completion-submit
- post-auth-ready
- account-delivery

最终可稳定到达：
- `finalStage = account-delivery`
- `finalState = DELIVERY_PAYLOAD_READY`

#### 2. verification 主路径冻结
Dreamina verification 当前主路径正式冻结为：
- `dreamina-direct-fill`

当前规则：
- 验证成功优先通过 post-verification UI 进入 birthday / profile-completion 判断
- legacy fallback 仅保留作 debug / diagnostics
- resend 只在明确错误状态下允许触发，不再泛化重试

#### 3. profile-completion 主路径冻结
Dreamina birthday / profile-completion 当前主路径正式冻结为：
- `fillDreaminaBirthdayContinuousFlow(...)`

当前规则：
- 生日按 `Year -> Month -> Day -> Next` 连续业务流执行
- `continuous-flow` 负责 `Next` 点击
- 不再以字段级即时回读作为主成功判定

#### 4. post-auth-ready richer summary 打通
Dreamina stage 5 现已支持输出更丰富的确认摘要：
- `matchedSelectors`
- `matchedTexts`

并已真实透传到：
- `uiConfirmation`
- `resultConfirmation`

#### 5. account-delivery richer payload 打通
stage 6 当前已能消费 stage 5 透传下来的 richer summary，并整理进最终交付对象：
- `deliveryPayload.accountSummary.registrationState`
- `deliveryPayload.sessionSummary`
- `deliveryPayload.uiSummary`

当前 payload 已可稳定带出：
- 上游注册状态
- session 检查结果摘要
- UI 命中 selectors / texts
- 当前页面 URL 与 textPreview

#### 6. post-auth-ready 语义正式收紧
过去：
- birthday bridge signals 容易被宽泛认成 `REGISTRATION_COMPLETE`

现在：
- 生日桥接信号只收口为 `POST_AUTH_READY_ONLY`
- 只有更强的 session / workspace / UI 联合证据，才应提升为 `REGISTRATION_COMPLETE`

当前行为：
- `POST_AUTH_READY_ONLY` → `nextStage = account-delivery`
- `REGISTRATION_COMPLETE` → `nextStage = registration-complete`

同时这个语义已经透传进：
- `deliveryPayload.accountSummary.registrationState`

避免最终交付结果误报“已完全完成”。

### 文档与契约更新
本版同步更新了部分 closeout / contract / README 文档，用于追平当前代码事实，重点包括：
- Dreamina 主链当前真实状态
- post-auth-ready 与 account-delivery 的新语义边界
- bridge-ready 与 true-complete 的区分
- delivery 侧对上游 richer summary 的承接方式

### 当前已知状态
本版封板时的合理停点是：
- 工程链路：已闭环
- 交付摘要：已可用
- 后半段语义：已从宽泛成功收紧为 bridge-ready vs true-complete

当前默认停点应理解为：
- Dreamina 后半段已稳定到 `POST_AUTH_READY_ONLY -> account-delivery -> DELIVERY_PAYLOAD_READY`
- `REGISTRATION_COMPLETE` 仍保留给未来更强 session/workspace 完成证据

### 后续建议
本版之后，优先级最高的改进方向不再是继续打通主链，而是：
1. 把 `dreamina-post-auth-ready-profile.json` 继续拆成 `bridgeSignals` 与 `successSignals`
2. 继续追平 `shared-account-delivery` / `shared-post-auth-ready` 文档边界
3. 清理关键文件中的乱码注释与编码污染
4. 继续把 Dreamina 特例从 adapter 硬编码迁到 profile 配置

### Tag
- `v1.0.2`

### Commit
- `61a0edc`
