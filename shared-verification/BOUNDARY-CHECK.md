# shared-verification 边界审计

这个文档只做一件事：
**把阶段 3（verification submit）哪些属于边界内、哪些不属于边界内、哪些只能迁一半，逐项审清楚。**

---

# 一、阶段边界一句话定义

`shared-verification` 只负责：
- 从页面已经确认进入 verification 阶段开始
- 到验证码被成功提交并确认推进到 `profile-completion`
- 或确认 verification 阶段内失败为止

它不负责：
- 首页打开
- 登录入口切换
- credential submit
- birthday / profile completion 实际填写
- post-auth ready
- session / storage
- runner 调度与结果落盘

---

# 二、明确属于第三阶段的内容

## 1. verification ready 判断
说明：
- 判断页面是否真的进入验证码阶段
- 例如 countdown / one-time-code input / verification wrapper visible

结论：
- **属于第三阶段**

---

## 2. 获取验证码
说明：
- 通过邮件/provider 拉取当前验证码

结论：
- **属于第三阶段**

---

## 3. 解析验证码输入目标
说明：
- 从 Dreamina 专用候选池中选出正确输入控件

结论：
- **属于第三阶段**

---

## 4. 输入验证码
说明：
- hidden input 注入
- wrapper keyboard 输入
- fallback keyboard 输入

结论：
- **属于第三阶段**

---

## 5. 提交后结果确认
说明：
- wrong code
- rate limited
- rejected
- existing account
- 已进入 profile-completion

结论：
- **属于第三阶段**

---

## 6. verification 阶段内有限重试
说明：
- wrong code 后重新拉取 latest
- usedCodes 去重
- retry max attempts

结论：
- **属于第三阶段**
- 但必须是 verification 阶段内部有限重试，不能扩成外层全局重试

---

# 三、只允许迁一部分的内容

## 7. birthday / profile completion 可达性确认
说明：
- 第三阶段需要确认：验证码通过后，页面是否已经推进到下一阶段
- 这类“可达性确认”可以迁入第三阶段

允许迁入：
- birthday inputs 是否出现
- profile-completion ready signals 是否命中

禁止迁入：
- birthday 年/月/日实际填写
- next / submit 点击

结论：
- **只允许迁可达性确认，不允许迁填写动作**

---

# 四、明确不属于第三阶段的内容

## 8. 首页打开
说明：
- 首页打开、白屏/死页、entry ready

结论：
- **不属于第三阶段**
- 属于第一阶段 `shared-entry`

---

## 9. 登录入口切换
说明：
- Sign in / Continue with email / login gate

结论：
- **不属于第三阶段**
- 属于第一阶段末尾 / 第二阶段前置

---

## 10. credential submit
说明：
- email/password fill
- Continue click
- Continue 后第一批安全检查

结论：
- **不属于第三阶段**
- 属于第二阶段 `shared-credential`

---

## 11. post-auth ready
说明：
- 注册完成后首页 ready
- session cookie ready

结论：
- **不属于第三阶段**
- 属于第五阶段

---

## 12. session / storage
说明：
- storage state 导出
- sessionid 提取

结论：
- **不属于第三阶段**
- 属于第六阶段

---

## 13. runner 调度
说明：
- 代理池
- worker 并发
- 结果落盘
- 代理惩罚

结论：
- **不属于第三阶段**
- 属于 runner / 外层 orchestrator

---

# 五、旧主链函数归属审计

## `waitForVerificationCountdown(...)`
- 归属：第三阶段
- 备注：可迁

## `getVerificationInputCandidates(...)`
- 归属：第三阶段
- 备注：可迁，且必须保持 Dreamina 白名单

## `enterVerificationCode(...)`
- 归属：第三阶段
- 备注：可迁

## `fetchVerificationCodeViaApi(...)`
- 归属：第三阶段
- 备注：可迁

## `detectPostVerificationFailure(...)`
- 归属：第三阶段
- 备注：可迁

## `ensureBirthdayInputsReachable(...)`
- 归属：第三阶段 / 第四阶段交界
- 备注：只迁“可达性确认”，不迁填写动作

## `ensureDreaminaEmailLoginForm(...)`
- 归属：非第三阶段
- 备注：禁止迁入

## `waitForDreaminaPostRegisterReady(...)`
- 归属：非第三阶段
- 备注：禁止迁入

## `waitForSessionIdCookie(...)`
- 归属：非第三阶段
- 备注：禁止迁入

---

# 六、边界红线

第三阶段后续开发时，默认禁止做这些事：
- 直接点击 Continue
- 修改 email/password 提交逻辑
- 填 birthday
- 保存 storage
- 写 success/fail 结果文件
- 管代理惩罚/降级

只要开始做这些事，就说明第三阶段边界被破坏了。
