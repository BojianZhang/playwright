# Dreamina Entry Profile 说明

这个文档解释：
- `dreamina-entry-profile.json` 里每个字段管什么
- 哪些字段控制“打开节奏”
- 哪些字段控制“页面判定口径”
- 哪些字段控制“入口弹层处理”

> 这个 profile 的边界只负责 **首页入口页 ready 判断**。
> 不负责浏览器创建、代理池调度、验证码、生日、session 等后续业务。

---

# 1. 顶层字段

## `name`
### 作用
站点名称。

### 它控制什么
- 日志里显示当前站点名
- 失败 reason、调试输出里的站点名称
- 通用首页模块识别当前在跑哪个站点

### 你什么时候改它
- 接新站点时改
- Dreamina 自己一般不用动

---

## `homeUrl`
### 作用
首页入口 URL。

### 它控制什么
- `goto` 打开的目标地址
- retry / reload 主流程的入口页面

### 你什么时候改它
- 首页 URL 变了
- 你想把入口从 A 页换到 B 页

---

## `entry`
### 作用
首页入口阶段的总配置容器。

### 它控制什么
把首页阶段的所有规则收在一起：
- 导航超时
- 重试次数
- 白屏口径
- 死页口径
- ready 信号
- overlay 处理

---

# 2. `entry.navigation`

这一组字段控制：
**首页如何打开、允许打开多久、失败最多重试几次**。

## `entry.navigation.runTimeoutMs`
### 作用
run 模式下单次 `goto/reload` 的超时时间。

### 它控制什么
- 正式运行时页面打开最长等待多久
- 太短：慢页面容易被提前打死
- 太长：坏代理会拖慢整体流程

### 常见调优场景
- 如果页面偶尔慢，但最后能出来，可以适当加大
- 如果大量坏代理拖时间，不要无限增大

---

## `entry.navigation.testTimeoutMs`
### 作用
test 模式下单次 `goto/reload` 的超时时间。

### 它控制什么
- 测试阶段容忍页面更慢一些
- 便于观察边界代理/边界页面行为

### 常见调优场景
- test 想更宽松就调大
- run 不建议盲目跟着一起调

---

## `entry.navigation.retryAttempts`
### 作用
首页打开最多允许重试几次。

### 它控制什么
- 第一次通常 `goto`
- 后续通常 `reload`
- 超过次数后直接判定入口阶段失败

### 常见调优场景
- 页面经常第一次失败、第二次成功时保留 3 次
- 如果失败非常稳定，增加次数收益很低

---

# 3. `entry.firstLoad`

这一组字段控制：
**首页刚打开后，给页面一点“缓冲加载时间”，再去判断是不是死页**。

## `entry.firstLoad.runGraceWaitMs`
### 作用
run 模式下，首页打开后，在深判断之前额外等待多久。

### 它控制什么
- 给前端 JS、接口、组件渲染一点时间
- 避免页面刚到 domcontentloaded 就被过早判死

### 常见调优场景
- 页面不是白屏，但 ready signal 常常迟一点出现时

---

## `entry.firstLoad.testGraceWaitMs`
### 作用
test 模式下的首轮缓冲等待。

### 它控制什么
- test 时可以比 run 稍宽，观察慢页面

---

## `entry.firstLoad.deadPageBodyTextMinLength`
### 作用
死页判定时，body 文本长度的基础阈值。

### 它控制什么
- 页面文本太少，又没有 ready signal，又伴随错误证据时，更容易判死页

### 注意
这是“判定口径”字段，不建议频繁乱改。

---

# 4. `entry.readySignals`

这一组字段控制：
**什么叫这个首页真的 ready，可以进入下一步**。

这是整个 profile 里最核心的一组。

## `entry.readySignals.text`
### 作用
文本级 ready 信号。

### 它控制什么
- 页面上出现这些文案时，可以认为首页已经真正活了
- 比如：登录入口、Continue with email、Sign up 等

### 适合放什么
- 稳定、明确、站点入口页常见的文字

### 不适合放什么
- 太泛的词
- 容易在错误页/空页里也出现的词

---

## `entry.readySignals.selectors`
### 作用
DOM selector 级 ready 信号。

### 它控制什么
- 页面结构元素出现时，也可以认为首页 ready
- 对一些文案不稳定但结构稳定的页面很有用

### 适合放什么
- 稳定输入框
- 稳定按钮
- 稳定入口容器

### 不适合放什么
- 太泛化 selector，例如页面上任何地方都有的通用元素

---

## `entry.readySignals.bodyPatterns`
### 作用
body 文本里的兜底 ready pattern。

### 它控制什么
- 当 text/selector 没命中时，仍然可以通过 body 中的关键词判断首页活性

### 适合放什么
- 站点名
- 登录文案
- 站点特有 CTA

### 注意
这更适合兜底，不建议作为最主要 ready 判断来源。

---

# 5. `entry.whiteScreen`

这一组字段控制：
**什么叫白屏，以及 precheck 阶段疑似白屏要不要复查。**

## `entry.whiteScreen.bodyTextMinLength`
### 作用
白屏判定时 body 文本最小阈值。

### 它控制什么
- body 文本太短且没有 ready signal 时，会更像白屏

### 注意
改太松会放进假阳性，改太紧会误杀边界页面。

---

## `entry.whiteScreen.recheckOnSuspected`
### 作用
precheck 阶段疑似白屏时，是否再给一次复查。

### 它控制什么
- `true`：降低误杀慢页面概率
- `false`：更快，但更激进

---

## `entry.whiteScreen.precheckRecheckWaitMinMs`
### 作用
白屏疑似复查时的最小等待时间。

### 它控制什么
- 保证不是“马上又判一次”，给页面一个最基本的缓冲

---

## `entry.whiteScreen.precheckRecheckWaitMaxMs`
### 作用
白屏疑似复查时的最大等待时间。

### 它控制什么
- 限制复查成本，防止一个代理把预检拖太久

---

# 6. `entry.deadPage`

这一组字段控制：
**什么叫死页**。

## `entry.deadPage.bodyTextMinLength`
### 作用
死页判定时，body 文本长度阈值。

### 它控制什么
- 页面不是立刻白屏，但长时间没 ready signal，又伴随失败证据时，更容易被判死页

### 和 whiteScreen 的区别
- `whiteScreen`：更像页面几乎没起来
- `deadPage`：页面尝试起来了，但最终没有进入正常 ready 状态

---

# 7. `entry.overlays`

这一组字段控制：
**首页入口阶段是否处理遮罩/弹层，以及如何识别它们**。

## `entry.overlays.enabled`
### 作用
是否启用入口页 overlay 处理。

### 它控制什么
- 开：会尝试清理入口页挡板
- 关：完全不处理 overlay

---

## `entry.overlays.patterns`
### 作用
常见 overlay 按钮/文案模式。

### 它控制什么
- 让通用模块知道哪些文案可能是“关闭挡板”的按钮
- 如：Accept / Agree / Got it / Close / Skip

### 注意
如果这里配得太泛，可能误点正常按钮。

---

# 8. 调整时的建议

## 可以经常调的字段（运行策略）
- `entry.navigation.runTimeoutMs`
- `entry.navigation.testTimeoutMs`
- `entry.navigation.retryAttempts`
- `entry.firstLoad.runGraceWaitMs`
- `entry.firstLoad.testGraceWaitMs`
- `entry.whiteScreen.precheckRecheckWaitMinMs`
- `entry.whiteScreen.precheckRecheckWaitMaxMs`

这些更偏“节奏”和“容忍度”。

## 要谨慎调的字段（判定口径）
- `entry.readySignals.text`
- `entry.readySignals.selectors`
- `entry.readySignals.bodyPatterns`
- `entry.whiteScreen.bodyTextMinLength`
- `entry.deadPage.bodyTextMinLength`

这些更偏“什么叫 ready / 什么叫白屏 / 什么叫死页”。
如果改错，容易放进假阳性或误杀真可用页面。

---

# 9. 一句话总结

这个 profile 本质上回答四个问题：
1. 打开哪个首页
2. 最多等多久
3. 什么算首页 ready
4. 什么算首页坏了（白屏 / 死页）
