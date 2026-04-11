# Dreamina 六阶段整链验证清单

对应目录：
- `D:\playwright\Dreamina`

这个文档只做一件事：
**把 Dreamina 从阶段 1 到阶段 6 的整链验证点、通过标准、失败观察点先列清楚。**

---

# 一、验证目标

验证 Dreamina 主链是否已经具备：
1. 六阶段顺序可执行
2. 任一阶段失败时可正确停止
3. 成功时可稳定推进到下一阶段
4. 最终可输出统一主链结果与 delivery payload

---

# 二、整链验证前置条件

在开始整链验证前，至少确认：
- 浏览器、context、page 可正常创建
- Dreamina 入口页可访问
- 账号基础字段可用（至少 email/password）
- 验证码依赖链可用（如有）
- 日志函数已接入

---

# 三、阶段级验证清单

## 阶段 1：entry

### 要验证什么
- 是否能打开/校正到 Dreamina 入口页
- 是否能完成健康检查
- 是否能输出 `ENTRY_READY` 或明确失败
- 成功后是否推进到 `credential-submit`

### 重点看哪些结果
- `stageResults.entry.success`
- `stageResults.entry.state`
- `stageResults.entry.reason`
- `stageResults.entry.detail.entryOpenResult`
- `stageResults.entry.detail.entryHealthResult`
- `stageResults.entry.detail.entryReadyResult`

### 通过标准
- `success=true`
- `nextStage='credential-submit'`

### 常见失败观察点
- `ENTRY_PAGE_OPEN_FAILED`
- `ENTRY_WHITE_SCREEN`
- `ENTRY_ERROR_PAGE`
- `ENTRY_NOT_READY`

---

## 阶段 2：credential-submit

### 要验证什么
- 邮箱/密码输入是否正常
- 是否能成功推进到 verification

### 重点看哪些结果
- `stageResults.credential.success`
- `stageResults.credential.state`
- `stageResults.credential.reason`

### 通过标准
- `success=true`
- `nextStage='verification'`

---

## 阶段 3：verification-submit

### 要验证什么
- 验证码获取/填写是否正常
- 是否能成功推进到 profile-completion

### 重点看哪些结果
- `stageResults.verification.success`
- `stageResults.verification.state`
- `stageResults.verification.reason`

### 通过标准
- `success=true`
- `nextStage='profile-completion'`

---

## 阶段 4：profile-completion-submit

### 要验证什么
- birthday/profile completion 是否正确填写与提交
- 是否能推进到 post-auth-ready

### 重点看哪些结果
- `stageResults.profileCompletion.success`
- `stageResults.profileCompletion.state`
- `stageResults.profileCompletion.reason`
- `stageResults.profileCompletion.detail.submitResult`
- `stageResults.profileCompletion.detail.confirmResult`

### 通过标准
- `success=true`
- `nextStage='post-auth-ready'`

---

## 阶段 5：post-auth-ready

### 要验证什么
- 是否建立了可用用户态
- 是否推进到 registration-complete

### 重点看哪些结果
- `stageResults.postAuthReady.success`
- `stageResults.postAuthReady.state`
- `stageResults.postAuthReady.reason`
- `stageResults.postAuthReady.detail.sessionInspection`
- `stageResults.postAuthReady.detail.uiConfirmation`
- `stageResults.postAuthReady.detail.resultConfirmation`

### 通过标准
- `success=true`
- `nextStage='registration-complete'`

### 常见失败观察点
- `POST_AUTH_NOT_READY`
- `SESSION_SIGNAL_NOT_FOUND`
- `POST_AUTH_UI_NOT_CONFIRMED`
- `POST_AUTH_RESULT_UNKNOWN`

---

## 阶段 6：account-delivery

### 要验证什么
- 是否能整理 account summary
- 是否能组装 delivery payload
- 是否能推进到 delivery-complete

### 重点看哪些结果
- `stageResults.accountDelivery.success`
- `stageResults.accountDelivery.state`
- `stageResults.accountDelivery.reason`
- `stageResults.accountDelivery.detail.accountSummary`
- `stageResults.accountDelivery.detail.deliveryPayload`
- `stageResults.accountDelivery.detail.resultConfirmation`
- `deliveryPayload`

### 通过标准
- `success=true`
- `nextStage='delivery-complete'`
- `deliveryPayload` 非空

### 常见失败观察点
- `ACCOUNT_SUMMARY_INCOMPLETE`
- `DELIVERY_PAYLOAD_INCOMPLETE`
- `ACCOUNT_DELIVERY_FAILED`
- `ACCOUNT_DELIVERY_RESULT_UNKNOWN`

---

# 四、整链验证通过标准

整条主链验证通过，至少应满足：
- 主链最终 `success=true`
- `finalStage='account-delivery'`
- `finalState` 合理收敛（通常为 `DELIVERY_COMPLETE` 或 `DELIVERY_PAYLOAD_READY`）
- `deliveryPayload` 非空
- `meta.successStageCount >= 6`

---

# 五、整链验证失败时怎么判断问题归属

## 如果停在阶段 1
优先看：
- 入口页问题
- 健康检查问题
- ready signal 不足

## 如果停在阶段 2/3/4
优先看：
- 业务流转问题
- 表单/验证码/资料填写问题

## 如果停在阶段 5
优先看：
- 用户态/session 建立问题
- post-auth signal 不足

## 如果停在阶段 6
优先看：
- account summary 不完整
- payload required fields 不完整
- delivery result 收敛不足

---

# 六、建议验证顺序

建议按以下顺序推进，而不是一上来就追整链成功：

1. 单独跑阶段 1
2. 跑 1 → 2
3. 跑 1 → 3
4. 跑 1 → 4
5. 跑 1 → 5
6. 跑完整 1 → 6

这样更容易定位问题到底卡在哪个阶段交界。

---

# 七、一句话收口

> Dreamina 整链验证的核心不是“看它有没有跑完”，而是“看 1~6 阶段是否都能各自收敛、相互衔接，并最终交出统一 delivery payload”。
