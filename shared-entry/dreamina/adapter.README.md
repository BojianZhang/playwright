# adapter.js 阅读文档

这个文档专门解释：
- `D:\playwright\shared-entry\dreamina\adapter.js` 的边界是什么
- 这个文件现在能干什么
- 这个文件不该干什么
- 当前文件里各类方法分别承担什么职责

---

# 一、这个文件的边界

## 这个文件负责什么
`dreamina/adapter.js` 负责的是：

### 1. Dreamina 首页入口阶段的专属适配
包括：
- 首页挡板/overlay 清理
- Dreamina 首页 ready 判定补充
- 首页失败分类
- 首页轻量恢复

### 2. Dreamina 第一阶段登录入口切换
也就是从：
- 首页 ready
进入到：
- 登录入口出现
- 登录入口可点击
- 登录入口被点击
- 登录门/登录前表单态出现

---

## 这个文件不负责什么
它不负责：
- browser/context 创建
- 代理池调度
- 外层 runner 调度
- 邮箱填写
- 获取验证码
- 填验证码
- 生日
- 注册提交
- 登录/注册成功后的业务流

一句话：
**这个文件负责“首页入口 + 登录入口切换”，不负责后续正式注册业务。**

---

# 二、这个文件当前能干什么

## 1. 处理首页挡板
相关方法：
- `preprocessOverlays(...)`
- `dismissOverlayBySafeTexts(...)`
- `dismissOverlayByCloseSelectors(...)`

### 能力说明
会保守地尝试点击：
- Accept
- Agree
- Got it
- Close
- Skip
等高置信挡板按钮。

目的不是乱点业务主按钮，而是尽量只清 cookie / tips / onboarding 挡板。

---

## 2. 判断首页是否 ready
相关方法：
- `waitForDreaminaReady(...)`
- `findVisibleReadyText(...)`
- `findVisibleReadySelector(...)`
- `findBodyPatternReady(...)`

### 能力说明
会优先看：
- Dreamina 强 selector 信号
- Dreamina 强文本信号
- profile 里的 selector/text
- body pattern 兜底

它的目标是：
**判断首页是不是已经活了，并且进入可操作状态。**

---

## 3. 分类首页失败
相关方法：
- `classifyDreaminaEntryFailure(...)`
- `collectFailureEvidence(...)`
- `hasFrontendLoadFailureEvidence(...)`
- `hasNetworkFailureEvidence(...)`
- `hasBlockedOrChallengeEvidence(...)`

### 能力说明
可以把首页失败继续细分成：
- `DREAMINA_WHITE_SCREEN_*`
- `DREAMINA_DEAD_PAGE_*`
- `DREAMINA_READY_MISSING_*`
- `DREAMINA_ENTRY_CHALLENGE`

也就是比公共层更贴近 Dreamina 自己的问题语义。

---

## 4. 做轻量恢复
相关方法：
- `recoverDreaminaEntry(...)`
- `isRecoverableDreaminaEntryFailure(...)`
- `waitBrieflyForRecovery(...)`

### 能力说明
目前只对“可恢复的 ready-missing 类问题”做轻量动作：
- 再清一次 overlay
- 再短等一下

不会做：
- reload
- page recreate
- browser/context 操作

因为这些仍然属于外层 orchestrator 的职责。

---

## 5. 第一阶段登录入口识别与点击骨架
相关方法：
- `findDreaminaLoginEntry(...)`
- `openDreaminaLoginEntry(...)`
- `confirmDreaminaLoginGate(...)`
- `classifyDreaminaLoginGateFailure(...)`

### 能力说明
这是当前新补的第一阶段登录入口骨架。

它负责：
- 在首页 ready 后找登录入口
- 尝试点击登录入口
- 确认是否进入登录门/登录前表单态
- 对这一段失败做专属分类

### 注意
现在这一块是“第一版骨架”，
边界重点是：
**只做到“进入登录门”这一层，不往后吃邮箱/验证码/注册业务。**

---

# 三、当前文件里方法怎么分组理解

## A. 通用基础小工具
这些是给别的方法复用的基础件：
- `isVisibleAndEnabled(...)`
- `tryClickLocator(...)`
- `filterStrongReadySelectors(...)`
- `findVisibleReadyText(...)`
- `findVisibleReadySelector(...)`
- `findBodyPatternReady(...)`

这些方法本身不是业务阶段，而是支撑业务阶段的工具。

---

## B. 首页入口阶段方法
这些方法负责首页从打开到 ready/fail：
- `preprocessOverlays(...)`
- `waitForDreaminaReady(...)`
- `classifyDreaminaEntryFailure(...)`
- `recoverDreaminaEntry(...)`

---

## C. 第一阶段登录入口方法
这些方法负责首页 ready 之后，进入登录门：
- `findDreaminaLoginEntry(...)`
- `openDreaminaLoginEntry(...)`
- `confirmDreaminaLoginGate(...)`
- `classifyDreaminaLoginGateFailure(...)`

---

# 四、你后续看这个文件时，最应该怎么理解

## 可以把它当成两段

### 第一段：首页入口适配
解决：
- 页面能不能活
- 挡板要不要清
- 首页是不是 ready
- 首页失败属于哪一类

### 第二段：登录入口切换适配
解决：
- 登录入口在哪
- 该点哪个
- 点完后是不是已经进入登录门

---

# 五、后续最可能继续往这里加什么

如果继续沿着这个边界扩展，后续更适合加的是：
- Dreamina 登录入口优先级细化
- 登录门确认信号细化
- 登录入口阶段失败分类细化
- Dreamina 特有挡板/提示层的更精准处理

不适合加的是：
- 邮箱验证码逻辑
- 注册表单提交
- 账号结果落库

---

# 六、一句话总结

`dreamina/adapter.js` 是：
**Dreamina 首页入口阶段 + 第一阶段登录入口切换阶段的站点专属适配层。**

它现在已经能做：
- 首页挡板处理
- 首页 ready 判定
- 首页失败分类
- 首页轻量恢复
- 登录入口识别/点击/确认骨架

但它的职责止步于“进入登录门”，不继续负责后续正式注册业务。
