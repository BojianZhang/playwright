# 阶段 2（credential submit）日志判读示例

## 示例 1：form ready 没过
```text
FORM_READY_NOT_IMPLEMENTED
```
说明：当前 adapter 还没真正接通 form ready。

## 示例 2：账号已存在
```text
DREAMINA_ACCOUNT_ALREADY_EXISTS
```
说明：email/password 提交后命中了已存在账号提示。

## 示例 3：提交后进入验证码阶段
```text
CREDENTIAL_SUBMIT_OK | nextStage=verification
```
说明：阶段 2 成功，应该进入阶段 3。

## 示例 4：提交后无状态变化
```text
DREAMINA_CREDENTIAL_SUBMIT_NO_STATE_CHANGE
```
说明：按钮点了，但页面状态没推进。

## 示例 5：被拒绝/稍后重试
```text
DREAMINA_SIGNUP_REJECTED
```
说明：当前代理/IP/页面态可能被拒绝，不是普通表单问题。
