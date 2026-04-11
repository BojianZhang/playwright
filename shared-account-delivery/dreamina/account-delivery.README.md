# Dreamina 阶段 6：account-delivery

对应文件：
- `D:\playwright\shared-account-delivery\dreamina\account-delivery-adapter.js`

这个目录承接 Dreamina 在第六阶段的站点适配。

---

# 一、Dreamina 阶段 6 的职责

Dreamina 阶段 6 负责：
- 等待 registration-complete 之后的页面进入可交付态
- 整理 Dreamina 账号最终交付字段
- 判断当前账号是否达到最小可交付标准
- 最终收口 `delivery-complete`

---

# 二、Dreamina 阶段 6 不负责

- 回头重新处理前五阶段
- 外部系统持久化
- runner 决策
- 消息通知

---

# 三、Dreamina 阶段 6 当前建议方法

- `loadDreaminaAccountDeliveryProfile(...)`
- `waitForAccountDeliveryReady(...)`
- `collectAccountDeliverySummary(...)`
- `buildAccountDeliveryPayload(...)`
- `confirmAccountDeliveryResult(...)`
- `classifyAccountDeliveryFailure(...)`

---

# 四、当前落地策略

当前先做高注释骨架与字段语义文档，不急着直接写重逻辑。
先把：
- 边界
- 字段
- 返回结构
- 站点信号类型

先钉死，后续再根据真实运行日志逐步把 Dreamina 第六阶段做实。
