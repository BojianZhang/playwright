# shared-profile-completion

这个包负责：
**阶段 4：profile completion submit**。

也就是：
- 在页面已经进入 birthday / profile-completion 上下文后
- 等待资料补全面板 ready
- 生成资料填写计划
- 填写 birthday / 基础资料项
- 点击 next / submit
- 判断提交后的即时结果
- 成功时只确认进入下一阶段 `post-auth-ready`

---

# 边界

## 阶段输入
- `browser / context / page` 已创建
- 当前页面已经进入 birthday / profile-completion 所在上下文
- 上一阶段（verification submit）已经成功
- 账号信息与站点 runtime 已由上层准备好

## 负责什么
- profile-completion ready 判断
- 资料填写计划生成
- birthday / 基础资料项填写
- next / submit 触发
- 提交后成功/失败/下一阶段确认
- 各站点在阶段 4 的适配与配置
- 成功时输出 `nextStage=post-auth-ready`

## 不负责什么
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- post-auth-ready 最终确认
- session / storage 持久化
- browser/context 创建
- runner 层代理调度、重试、结果落盘

---

# 结构

- `stages/profile-completion-submit.js`
  - 阶段 4 公共骨架
- `dreamina/profile-completion-adapter.js`
  - Dreamina 阶段 4 适配层
- `dreamina/profiles/*`
  - Dreamina 阶段 4 配置与文档
- `dreamina/log/*`
  - 阶段 4 日志模板与判读示例

---

# 设计原则

- 公共层只写阶段流程骨架
- 站点差异放 adapter
- 静态规则放 profile
- 日志判读单独文档化
- 第四阶段的成功定义不是“整个注册完成”，而是“资料补全完成并推进到 post-auth-ready”

---

# 后续

当前先落 Dreamina。
后续如果接其他站点，继续沿用：
- 公共阶段模块
- 站点 adapter
- profile 三件套
