# Dreamina 阶段 2（credential submit）说明

这个文件解释 Dreamina 在阶段 2 的边界。

---

# 负责什么
- credential form ready 判断
- email / password 填写
- Continue / Submit 点击
- 提交结果确认
- 提交失败分类

---

# 不负责什么
- 首页打开
- 登录入口切换
- 验证码
- birthday
- session / storage

---

# 文件关系
- `credential-adapter.js`
  - Dreamina 阶段 2 适配器
- `profiles/dreamina-credential-profile.json`
  - 程序读取的配置
- `profiles/dreamina-credential-profile.md`
  - 字段说明文档
- `profiles/dreamina-credential-profile.example.md`
  - 带注释模板
- `log/*`
  - 阶段 2 日志模板与示例
