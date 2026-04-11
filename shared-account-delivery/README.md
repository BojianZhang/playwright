# shared-account-delivery

这个包负责：
**阶段 6：account delivery**。

也就是：
- 在注册主链已经确认 `registration-complete` 之后
- 整理当前账号的最终交付信息
- 收口账号、会话、页面状态、环境摘要是否已经达到可交付标准
- 输出最终的账号交付结果结构
- 成功时只确认进入最终阶段 `delivery-complete`

---

# 边界

## 阶段输入
- `browser / context / page` 已创建
- 当前页面已经完成注册主链，或已经确认进入 `registration-complete`
- 上一阶段（post-auth-ready）已经成功
- 账号信息与站点 runtime 已由上层准备好

## 负责什么
- account delivery ready 判断
- 最终账号交付字段整理
- session / storage / url / ui 摘要整合
- 最终可交付结果确认
- 各站点在阶段 6 的适配与配置
- 成功时输出 `nextStage=delivery-complete`

## 不负责什么
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- birthday / profile completion
- post-auth ready
- browser/context 创建
- runner 层代理调度、结果落盘
- 外部系统写库、消息通知、跨系统同步

---

# 结构

- `stages/account-delivery.js`
  - 阶段 6 公共骨架
- `dreamina/account-delivery-adapter.js`
  - Dreamina 阶段 6 适配层
- `dreamina/profiles/*`
  - Dreamina 阶段 6 配置与文档
- `dreamina/log/*`
  - 阶段 6 日志模板与判读示例

---

# 设计原则

- 公共层只写阶段流程骨架
- 站点差异放 adapter
- 静态规则放 profile
- 日志判读单独文档化
- 第六阶段的成功定义不是“外部系统也已经写入”，而是“当前账号已经整理成可交付结构，并进入 delivery-complete”

---

# 后续

当前先落 Dreamina 草案。
后续如果接其他站点，继续沿用：
- 公共阶段模块
- 站点 adapter
- profile 三件套
