# Dreamina-register 主链计划草案

对应文件：
- `D:\playwright\Dreamina\Dreamina-register.js`

这个文档只做一件事：
**把 Dreamina 注册主链当前真实的编排顺序、主路径和阶段状态钉清楚。**

---

# 一、主链目标

Dreamina 主链的目标是：
- 接住浏览器页面与账号上下文
- 串联 6 个共享阶段
- 在可疑站点异常下允许有限阶段桥接
- 如果所有阶段成功，输出统一的 Dreamina 注册成功结果

---

# 二、当前主链顺序

## 1. 运行 entry 阶段
- 调用 `shared-entry`
- 目标：站点首页 / 入口页达到健康可操作态
- 当前状态：已稳定

## 2. 运行 credential-submit 阶段
- 调用 `shared-credential`
- 目标：邮箱/密码提交完成，并推进到 verification
- 当前状态：已稳定，可识别 `ACCOUNT_ALREADY_EXISTS`

## 3. 运行 verification-submit 阶段
- 调用 `shared-verification`
- 目标：验证码通过，并推进到 profile-completion
- 当前主路径：`dreamina-direct-fill`
- 当前状态：已打通到 birthday / profile-completion 页面
- 当前不再推荐的旧路径：char-by-char / hidden-input / wrapper-keyboard / fallback-keyboard-type

## 4. 运行 profile-completion-submit 阶段
- 调用 `shared-profile-completion`
- 目标：生日/资料补全完成，并推进到 post-auth-ready
- 当前主路径：`fillDreaminaBirthdayContinuousFlow`
- 当前业务流：`Year -> Month -> Day -> Next`
- 当前状态：已进入 birthday 页面并按参考业务流执行，仍需继续收口结果确认

## 5. 运行 post-auth-ready 阶段
- 调用 `shared-post-auth-ready`
- 目标：确认已进入可用用户态，并推进到 registration-complete
- 当前状态：待继续验证与收口

## 6. 运行 account-delivery 阶段
- 调用 `shared-account-delivery`
- 目标：确认账号已整理成可交付对象，并推进到 delivery-complete
- 当前状态：待继续验证与收口

---

# 三、统一中断规则

## 默认规则
- 任一阶段 `success=false`：停止后续阶段

## 当前 Dreamina 特例
- verification 某些可疑失败，允许 `profile-completion` 继续 probe
- 是否真正进入 birthday 阶段，由 `shared-profile-completion` 判断

---

# 四、统一上下文规则

建议统一维护：

```js
stageResults = {
  entry,
  credential,
  verification,
  profileCompletion,
  postAuthReady,
  accountDelivery,
}
```

每个阶段都通过 `context.stageResults` 读取前序结果。

---

# 五、当前不再推荐作为默认主链的旧路径

## verification
- `dreamina-char-by-char`
- `dreamina-hidden-input`
- `dreamina-wrapper-keyboard`
- `fallback-keyboard-type`

## profile-completion
- Dreamina birthday 的 split-fill 强判定路径

这些路径当前仅保留作 fallback / diagnostics，不再作为默认主链。

---

# 六、当前排障与收口原则

1. 优先冻结 Dreamina 当前已跑通主路径
2. 旧 fallback 默认不自动参与主链
3. 文档必须及时追平代码
4. 阶段桥接只在 Dreamina 当前排障期内按需保留
5. birthday 规则固定为：随机 + 满 18 周岁
