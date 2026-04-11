# account-delivery 阶段计划草案

对应文件：
- `D:\playwright\shared-account-delivery\stages\account-delivery.js`

这个文档只做一件事：
**把第六阶段的公共流程顺序先钉清楚，后续代码按这个顺序落，不要一开始就把所有站点细节揉进来。**

---

# 一、目标

阶段 6 的目标是：
- 接住第五阶段已经确认完成的账号与页面
- 判断是否进入 account-delivery
- 收集最终交付摘要
- 组装 delivery payload
- 输出最终 success / failure / unknown

---

# 二、建议流程

## 1. 等待第六阶段入口 ready
调用：
- `adapter.waitForAccountDeliveryReady(...)`

如果入口不 ready：
- 直接按阶段 6 失败收口

## 2. 收集账号最终摘要
调用：
- `adapter.collectAccountDeliverySummary(...)`

这一步的目标是整理：
- 账号基础字段
- session / storage / url / ui 摘要
- 当前页面 / 账号的最终交付上下文

## 3. 组装 delivery payload
调用：
- `adapter.buildAccountDeliveryPayload(...)`

这一步只负责生成“可交付对象草案”，不负责写外部系统。

## 4. 收口最终结果
调用：
- `adapter.confirmAccountDeliveryResult(...)`

按 success / failure / unknown 收口，并决定：
- `nextStage = delivery-complete`

## 5. 失败时分类
调用：
- `adapter.classifyAccountDeliveryFailure(...)`

输出站点语义下更适合运维和 runner 消费的 reason。

---

# 三、注意事项

- 第六阶段不要回头做前五阶段动作
- 第六阶段允许读取 session/storage/url/ui 摘要，但不要开始写外部系统
- 第六阶段允许组装交付对象，但不要在这个阶段做跨系统同步
- 第六阶段的核心不是“再判断注册是否成功”，而是“最终交付对象是否可成立”
