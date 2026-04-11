# credential-submit.js 准备改动计划说明

对应文件：
- `D:\playwright\shared-credential\stages\credential-submit.js`

这个文档只解释一件事：
**接下来准备怎么改 `credential-submit.js`，每一刀改什么，为什么这么改。**

当前先是施工说明，不是代码实现本身。

---

# 一、当前文件现状

当前 `credential-submit.js` 里只有：
- `normalizeCredentialStageResult(...)`
- `runCredentialSubmitStage(...)`

其中：
- `normalizeCredentialStageResult(...)` 已经能统一返回结构
- `runCredentialSubmitStage(...)` 现在还是 scaffold only，只检查 adapter 是否存在，尚未接通真实阶段 2 流程

---

# 二、准备改动的目标

把 `runCredentialSubmitStage(...)` 从“脚手架”改成：

## 真正能跑阶段 2 的公共骨架
流程目标是：
1. 等 form ready
2. 填 email
3. 填 password（如果需要）
4. 点 submit
5. 确认结果
6. 成功返回 nextStage=verification
7. 失败时走站点分类

---

# 三、准备改动的每一刀

## 第一刀：接通 form ready
### 准备改哪里
- `runCredentialSubmitStage(...)`

### 要做什么
调用 adapter：
- `waitForDreaminaCredentialFormReady(...)`
或未来统一版：
- `waitForCredentialFormReady(...)`

### 目的
让公共层先确认当前页面是否真的进入了 credential form。

### 为什么这一步要先做
因为如果 form 都没 ready，后面 fill email / password 就没有意义。

---

## 第二刀：接通 email/password 填写
### 准备改哪里
- `runCredentialSubmitStage(...)`

### 要做什么
按顺序调用：
- `fillDreaminaCredentialEmail(...)`
- `fillDreaminaCredentialPassword(...)`

或者未来统一成：
- `fillCredentialEmail(...)`
- `fillCredentialPassword(...)`

### 目的
让公共层真正执行阶段 2 的字段填写。

### 为什么分成两步
因为：
- 有的站点两个字段都要
- 有的站点未来可能只有 email
- 保持拆开更利于扩 OpenAI / Claude

---

## 第三刀：接通 submit 动作
### 准备改哪里
- `runCredentialSubmitStage(...)`

### 要做什么
调用 adapter：
- `submitDreaminaCredentialForm(...)`

### 目的
让公共层负责阶段 2 的提交动作编排，而不是只停在填表单。

---

## 第四刀：接通提交结果确认
### 准备改哪里
- `runCredentialSubmitStage(...)`

### 要做什么
调用 adapter：
- `confirmDreaminaCredentialSubmitResult(...)`

### 目的
确认：
- 是否进入验证码阶段
- 是否命中 existing account / rejected / rate limited / inline error

### 为什么这一步关键
这是阶段 2 的成败判定核心。

---

## 第五刀：接通失败分类
### 准备改哪里
- `runCredentialSubmitStage(...)`

### 要做什么
如果阶段 2 失败，调用 adapter：
- `classifyDreaminaCredentialSubmitFailure(...)`

### 目的
把阶段 2 的失败 reason 收敛成站点专属语义。

---

## 第六刀：统一返回结构
### 准备改哪里
- `runCredentialSubmitStage(...)`
- `normalizeCredentialStageResult(...)`

### 要做什么
保证成功和失败都统一返回：
- `success`
- `stage`
- `state`
- `reason`
- `nextStage`
- `detail`

### 目的
让后续阶段 3、4、5、6 能继续按统一结果结构往下串。

---

# 四、准备改完后的目标执行链

改完后，`runCredentialSubmitStage(...)` 预期链路应是：

1. 检查 adapter 是否存在
2. `waitForDreaminaCredentialFormReady(...)`
3. `fillDreaminaCredentialEmail(...)`
4. `fillDreaminaCredentialPassword(...)`
5. `submitDreaminaCredentialForm(...)`
6. `confirmDreaminaCredentialSubmitResult(...)`
7. 如果失败，`classifyDreaminaCredentialSubmitFailure(...)`
8. 最后 `normalizeCredentialStageResult(...)`

---

# 五、这次改动不会做什么

为了控制边界，这轮改动不会做：
- 不接 `task-register.js`
- 不接验证码阶段
- 不接 birthday
- 不处理 session/storage
- 不做 OpenAI / Claude adapter
- 不做复杂 retry / polling

也就是说：
这次只把阶段 2 的公共骨架真正接通 Dreamina adapter。

---

# 六、一句话总结

接下来 `credential-submit.js` 的改法很明确：
**把它从“只会返回 scaffold only”的骨架，改成真正串起 Dreamina 阶段 2 adapter 的公共 orchestrator。**
