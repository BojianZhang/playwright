# profile-completion-submit.js 准备改动计划说明

对应文件：
- `D:\playwright\shared-profile-completion\stages\profile-completion-submit.js`

这个文档只解释一件事：
**接下来准备怎么搭 `profile-completion-submit.js`，每一刀改什么，为什么这么改。**

---

# 一、准备改动的目标

把阶段 4 公共骨架搭出来：

1. 等 profile-completion ready
2. 生成资料填写计划
3. 填写 year / month / day
4. 提交 profile-completion
5. 确认结果
6. 成功返回 `nextStage=post-auth-ready`
7. 失败时走站点分类

---

# 二、准备改动的每一刀

## 第一刀：接通 profile-completion ready
调用 adapter：
- `waitForDreaminaProfileCompletionReady(...)`
或未来统一版：
- `waitForProfileCompletionReady(...)`

## 第二刀：接通资料填写计划生成
调用 adapter：
- `buildDreaminaProfileCompletionPlan(...)`
或未来统一版：
- `buildProfileCompletionPlan(...)`

## 第三刀：接通 year / month / day 填写
调用 adapter：
- `fillDreaminaBirthdayYear(...)`
- `fillDreaminaBirthdayMonth(...)`
- `fillDreaminaBirthdayDay(...)`

## 第四刀：接通提交动作
调用 adapter：
- `submitDreaminaProfileCompletion(...)`

## 第五刀：接通结果确认
调用 adapter：
- `confirmDreaminaProfileCompletionSubmitResult(...)`

## 第六刀：接通失败分类
调用 adapter：
- `classifyDreaminaProfileCompletionFailure(...)`

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
- `retryCount`
- `detail`

---

# 三、这次不会做什么

为了控制边界，这轮不会做：
- 不接首页逻辑
- 不接 credential submit
- 不接 verification submit
- 不接 post-auth-ready 最终确认
- 不接 session/storage
- 不接 runner
