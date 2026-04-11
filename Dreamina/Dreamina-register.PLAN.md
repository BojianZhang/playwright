# Dreamina-register 主链计划草案

对应文件：
- `D:\playwright\Dreamina\Dreamina-register.js`

这个文档只做一件事：
**把 Dreamina 注册主链编排顺序先钉清楚，后续代码按这个顺序落。**

---

# 一、主链目标

Dreamina 主链的目标是：
- 接住浏览器页面与账号上下文
- 串联 6 个共享阶段
- 如果某阶段失败，立即收口并停止后续阶段
- 如果所有阶段成功，输出统一的 Dreamina 注册成功结果

---

# 二、建议主链顺序

## 1. 运行 entry 阶段
- 调用 `shared-entry` 的公共入口能力
- 目标：站点首页 / 入口页达到健康可操作态

## 2. 运行 credential-submit 阶段
- 调用 `shared-credential`
- 目标：邮箱/密码提交完成，并推进到 verification

## 3. 运行 verification-submit 阶段
- 调用 `shared-verification`
- 目标：验证码通过，并推进到 profile-completion

## 4. 运行 profile-completion-submit 阶段
- 调用 `shared-profile-completion`
- 目标：生日/资料补全完成，并推进到 post-auth-ready

## 5. 运行 post-auth-ready 阶段
- 调用 `shared-post-auth-ready`
- 目标：确认已进入可用用户态，并推进到 registration-complete

## 6. 运行 account-delivery 阶段
- 调用 `shared-account-delivery`
- 目标：确认账号已整理成可交付对象，并推进到 delivery-complete

---

# 三、统一中断规则

- 任一阶段 `success=false`：立即停止后续阶段
- 停止后统一生成主链失败结果
- 不允许在编排层回头重新实现前一阶段动作

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

# 五、注意事项

- 编排层只做 orchestration，不做站点细节
- 站点细节全部留在各阶段 Dreamina adapter
- 不在编排层混入 runner 层决策
- 不在编排层做外部系统写入
