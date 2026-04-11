# Dreamina 阶段 3（verification submit）说明

这个文件解释 Dreamina 在阶段 3 的边界。

---

# 阶段输入
- `page` 已存在且可操作
- 页面已经进入 Dreamina verification 上下文
- 当前阶段只处理验证码这一段，不再负责首页入口切换，也不再负责 credential submit

---

# 负责什么
- verification stage ready 判断
- 获取验证码
- 选择验证码输入控件
- 输入验证码
- 提交结果确认
- 提交失败分类
- 成功时确认进入 `profile-completion`

---

# 不负责什么
- 首页打开
- 登录入口切换
- credential submit
- birthday / profile completion
- session / storage
- runner 层调度、代理惩罚、结果落盘

---

# 文件关系
- `verification-adapter.js`
  - Dreamina 阶段 3 适配器
- `profiles/dreamina-verification-profile.json`
  - 程序读取的配置
- `profiles/dreamina-verification-profile.md`
  - 字段说明文档
- `profiles/dreamina-verification-profile.example.md`
  - 带注释模板
- `log/*`
  - 阶段 3 日志模板与示例
