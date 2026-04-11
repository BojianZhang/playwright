# shared-profile-completion 边界审计

这个文档只做一件事：
**把阶段 4（profile completion submit）哪些属于边界内、哪些不属于边界内、哪些只能迁一半，逐项审清楚。**

---

# 一、阶段边界一句话定义

`shared-profile-completion` 只负责：
- 从页面已经确认进入 birthday / profile-completion 阶段开始
- 到资料填写完成并确认推进到 `post-auth-ready`
- 或确认阶段 4 内失败为止

它不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- post-auth-ready 最终确认
- session / storage
- runner 调度与结果落盘

---

# 二、明确属于第四阶段的内容

## 1. profile-completion ready 判断
说明：
- 判断页面是否真的进入 birthday / profile-completion 阶段

结论：
- **属于第四阶段**

---

## 2. 资料填写计划生成
说明：
- 生成 birthday / profile 的填写计划，例如 year / month / day

结论：
- **属于第四阶段**

---

## 3. birthday / 基础资料项填写
说明：
- year
- month
- day
- 以及同层的基础资料项

结论：
- **属于第四阶段**

---

## 4. next / submit
说明：
- 在资料填写完成后触发提交

结论：
- **属于第四阶段**

---

## 5. 提交后结果确认
说明：
- 判断是否已经推进到 `post-auth-ready`
- 判断是否命中资料补全阶段失败

结论：
- **属于第四阶段**

---

# 三、只允许迁一部分的内容

## 6. post-auth-ready 可达性确认
说明：
- 第四阶段需要确认资料填写后，页面是否已经推进到下一阶段
- 这类“可达性确认”可以迁入第四阶段

允许迁入：
- post-auth-ready signals 是否命中
- 下一阶段 ready 结构信号是否出现

禁止迁入：
- post-auth-ready 阶段内真正的 ready 稳定确认
- session cookie 等待
- 最终用户态稳定确认

结论：
- **只允许迁可达性确认，不允许迁第五阶段动作**

---

# 四、明确不属于第四阶段的内容

## 7. 首页打开
结论：
- **不属于第四阶段**
- 属于第一阶段 `shared-entry`

## 8. 登录入口切换
结论：
- **不属于第四阶段**
- 属于第一阶段末尾 / 第二阶段前置

## 9. credential submit
结论：
- **不属于第四阶段**
- 属于第二阶段 `shared-credential`

## 10. verification submit
结论：
- **不属于第四阶段**
- 属于第三阶段 `shared-verification`

## 11. post-auth-ready 最终确认
结论：
- **不属于第四阶段**
- 属于第五阶段

## 12. session / storage
结论：
- **不属于第四阶段**
- 属于第六阶段

## 13. runner 调度
结论：
- **不属于第四阶段**
- 属于 runner / 外层 orchestrator

---

# 五、边界红线

第四阶段后续开发时，默认禁止做这些事：
- 重新回头处理验证码
- 等 session cookie
- 保存 storage
- 写 success/fail 结果文件
- 管代理惩罚/降级

只要开始做这些事，就说明第四阶段边界被破坏了。
