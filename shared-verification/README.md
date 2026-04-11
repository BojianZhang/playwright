# shared-verification

这个包负责：
**阶段 3：verification submit**。

也就是：
- 在页面已经进入 verification 阶段上下文后
- 等待验证码阶段 ready
- 获取验证码
- 选择验证码输入目标
- 输入验证码
- 判断验证码提交后的即时结果
- 成功时只确认进入下一阶段 `profile-completion`

---

# 边界

## 阶段输入
- `browser / context / page` 已创建
- 当前页面已经进入 verification 所在上下文
- 上一阶段（credential submit）已经成功
- 账号信息与站点 runtime 已由上层准备好

## 负责什么
- verification stage ready 判断
- 获取验证码
- 选择验证码输入控件
- 输入验证码
- 验证码提交后成功/失败/下一阶段确认
- 各站点在阶段 3 的适配与配置
- 成功时输出 `nextStage=profile-completion`

## 不负责什么
- 首页打开
- 登录入口切换
- credential form ready / fill / submit
- birthday / profile completion
- post-auth ready
- session / storage 持久化
- browser/context 创建
- runner 层代理调度、重试、结果落盘

---

# 结构

- `stages/verification-submit.js`
  - 阶段 3 公共骨架
- `dreamina/verification-adapter.js`
  - Dreamina 阶段 3 适配层
- `dreamina/profiles/*`
  - Dreamina 阶段 3 配置与文档
- `dreamina/log/*`
  - 阶段 3 日志模板与判读示例

---

# 设计原则

- 公共层只写阶段流程骨架
- 站点差异放 adapter
- 静态规则放 profile
- 日志判读单独文档化
- 第三阶段的成功定义不是“注册成功”，而是“验证码通过并推进到 profile-completion”

---

# 后续

当前先落 Dreamina。
后续如果接 OpenAI / Claude 等站点，继续沿用：
- 公共阶段模块
- 站点 adapter
- profile 三件套
