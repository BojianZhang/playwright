# shared-credential

这个包负责：
**阶段 2：credential submit**。

也就是：
- 等待 credential form ready
- 填写 email / password（如果该站点需要）
- 点击 Continue / Submit
- 判断提交后的即时结果

---

# 边界

## 负责什么
- credential form ready 判断
- credential 字段填写
- 提交按钮触发
- 提交后成功/失败/下一阶段确认
- 各站点在阶段 2 的适配与配置

## 不负责什么
- 首页打开
- 登录入口切换
- 验证码阶段
- birthday / profile completion
- post-auth ready
- session / storage 持久化
- browser/context 创建

---

# 结构

- `stages/credential-submit.js`
  - 阶段 2 公共骨架
- `dreamina/credential-adapter.js`
  - Dreamina 阶段 2 适配层
- `dreamina/profiles/*`
  - Dreamina 阶段 2 配置与文档
- `dreamina/log/*`
  - 阶段 2 日志模板与判读示例

---

# 设计原则

- 公共层只写阶段流程骨架
- 站点差异放 adapter
- 静态规则放 profile
- 日志判读单独文档化

---

# 后续

当前先落 Dreamina。
后续 OpenAI / Claude 接入时，继续沿用：
- 公共阶段模块
- 站点 adapter
- profile 三件套
