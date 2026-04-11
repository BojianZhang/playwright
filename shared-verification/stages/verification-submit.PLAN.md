# verification-submit.js 准备改动计划说明

对应文件：
- `D:\playwright\shared-verification\stages\verification-submit.js`

这个文档只解释一件事：
**接下来准备怎么搭 `verification-submit.js`，每一刀改什么，为什么这么改。**

---

# 一、准备改动的目标

把阶段 3 公共骨架搭出来：

1. 等 verification ready
2. 获取验证码
3. 选择验证码输入目标
4. 输入验证码
5. 确认结果
6. 成功返回 `nextStage=profile-completion`
7. 失败时走站点分类

---

# 二、准备改动的每一刀

## 第一刀：接通 verification ready
调用 adapter：
- `waitForDreaminaVerificationStageReady(...)`
或未来统一版：
- `waitForVerificationStageReady(...)`

## 第二刀：接通获取验证码
调用 adapter：
- `fetchDreaminaVerificationCode(...)`
或未来统一版：
- `fetchVerificationCode(...)`

## 第三刀：接通验证码输入目标解析
调用 adapter：
- `resolveDreaminaVerificationInput(...)`
或未来统一版：
- `resolveVerificationInput(...)`

## 第四刀：接通验证码输入动作
调用 adapter：
- `fillDreaminaVerificationCode(...)`
或未来统一版：
- `fillVerificationCode(...)`

## 第五刀：接通提交结果确认
调用 adapter：
- `confirmDreaminaVerificationSubmitResult(...)`

## 第六刀：接通失败分类
调用 adapter：
- `classifyDreaminaVerificationFailure(...)`

## 第七刀：统一返回结构
保证成功和失败都统一返回：
- `success`
- `stage`
- `state`
- `reason`
- `nextStage`
- `signalStrength`
- `settleStage`
- `detectionSource`
- `stateChanged`
- `detail`

---

# 三、这次不会做什么

为了控制边界，这轮不会做：
- 不接首页逻辑
- 不接 credential submit
- 不接 birthday
- 不接 post-auth ready
- 不接 session/storage
- 不接 runner
