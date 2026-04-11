# Dreamina 阶段 4（profile completion submit）说明

这个文件解释 Dreamina 在阶段 4 的边界。

---

# 阶段输入
- `page` 已存在且可操作
- 页面已经进入 Dreamina birthday / profile-completion 上下文
- 当前阶段只处理资料补全这一段，不再负责验证码阶段，也不再负责 post-auth-ready 最终确认

---

# 负责什么
- profile-completion ready 判断
- birthday / 基础资料填写计划生成
- year / month / day 等资料项填写
- next / submit 点击
- 提交结果确认
- 提交失败分类
- 成功时确认进入 `post-auth-ready`

---

# 不负责什么
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- post-auth-ready 最终确认
- session / storage
- runner 层调度、代理惩罚、结果落盘

---

# 文件关系
- `profile-completion-adapter.js`
  - Dreamina 阶段 4 适配器
- `profiles/dreamina-profile-completion-profile.json`
  - 程序读取的配置
- `profiles/dreamina-profile-completion-profile.md`
  - 字段说明文档
- `profiles/dreamina-profile-completion-profile.example.md`
  - 带注释模板
- `log/*`
  - 阶段 4 日志模板与示例
