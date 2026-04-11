# dreamina-entry-profile.json 字段说明

这个文件描述的是：
**Dreamina 首页从“打开”到“ready”的站点入口配置**。

它只服务于首页入口阶段，不负责：
- 浏览器启动
- 代理池调度
- 邮箱/验证码/生日等注册后续流程

---

## 顶层字段

### `name`
- **类型**：`string`
- **作用**：站点名称。
- **用途**：
  - 日志输出
  - 错误信息标识
  - 通用模块里区分当前站点
- **当前值**：`Dreamina`

### `homeUrl`
- **类型**：`string`
- **作用**：站点首页/入口页 URL。
- **用途**：
  - `site-entry-health.js` 打开页面时使用的目标地址
- **当前值**：`https://dreamina.capcut.com/ai-tool/home/`

### `entry`
- **类型**：`object`
- **作用**：首页入口阶段的全部运行规则。
- **用途**：
  - 把首页打开、白屏判断、死页判断、ready 信号判断等统一收口

---

# `entry` 下的字段

## 1. `entry.navigation`
控制首页打开阶段的导航与重试策略。

### `entry.navigation.runTimeoutMs`
- **类型**：`number`
- **作用**：正式运行（run 模式）时，单次 `goto/reload` 的超时时间。
- **建议**：
  - 站点偏重时可适度加大
  - 不要无限拉高，避免坏代理拖死流程

### `entry.navigation.testTimeoutMs`
- **类型**：`number`
- **作用**：测试（test 模式）时，单次 `goto/reload` 的超时时间。
- **建议**：
  - test 模式通常可以比 run 宽一点，方便观察边界行为

### `entry.navigation.retryAttempts`
- **类型**：`number`
- **作用**：首页打开最多允许重试几次。
- **说明**：
  - 第 1 次通常是 `goto`
  - 后续通常是 `reload` 或 page recreate 后重试

---

## 2. `entry.firstLoad`
控制首页首轮加载后的缓冲等待与死页判断基础阈值。

### `entry.firstLoad.runGraceWaitMs`
- **类型**：`number`
- **作用**：run 模式下，首页打开后，在做死页/ready 深判断前额外等待多久。
- **用途**：
  - 给前端脚本、接口返回、组件渲染一点缓冲时间

### `entry.firstLoad.testGraceWaitMs`
- **类型**：`number`
- **作用**：test 模式下的首轮加载缓冲等待。
- **用途**：
  - 用来观察“慢一点但可能能活”的边界页面

### `entry.firstLoad.deadPageBodyTextMinLength`
- **类型**：`number`
- **作用**：死页判定时，body 文本长度的基础阈值。
- **说明**：
  - 页面内容太少，又没有 ready signal，又伴随错误证据时，更容易判为 dead page

---

## 3. `entry.readySignals`
定义“这个首页已经准备好可以进入下一步”的正向信号。

### `entry.readySignals.text`
- **类型**：`string[]`
- **作用**：页面可见文本级 ready 信号。
- **用途**：
  - 如登录入口、Continue with email、站点核心 CTA 等
- **建议**：
  - 放真正稳定、站点入口页常出现的文本
  - 不要放太泛、太容易误判的词

### `entry.readySignals.selectors`
- **类型**：`string[]`
- **作用**：CSS selector 级 ready 信号。
- **用途**：
  - 用来识别页面主要交互元素是否已经出现
- **建议**：
  - 选稳定元素
  - 避免过于泛化的 selector 导致假阳性

### `entry.readySignals.bodyPatterns`
- **类型**：`string[]`
- **作用**：body 文本里的兜底正向模式。
- **用途**：
  - 在 text/selector 没命中时，仍可通过 body 中的关键文本判断首页活性
- **建议**：
  - 放站点名称、入口页特有文案、登录文案等

---

## 4. `entry.whiteScreen`
控制白屏判断规则。

### `entry.whiteScreen.bodyTextMinLength`
- **类型**：`number`
- **作用**：白屏判断时，body 文本最小长度阈值。
- **含义**：
  - 如果 body 文本太短，且没有 ready signal，就更像白屏

### `entry.whiteScreen.recheckOnSuspected`
- **类型**：`boolean`
- **作用**：在 precheck 阶段，如果只是“疑似白屏”，是否再给一次复查机会。
- **用途**：
  - 降低误杀慢页面的概率

### `entry.whiteScreen.precheckRecheckWaitMinMs`
- **类型**：`number`
- **作用**：precheck 阶段白屏疑似时，二次确认等待的最小值。

### `entry.whiteScreen.precheckRecheckWaitMaxMs`
- **类型**：`number`
- **作用**：precheck 阶段白屏疑似时，二次确认等待的最大值。
- **说明**：
  - 实际等待可由动态等待逻辑夹在 min/max 之间

---

## 5. `entry.deadPage`
控制死页判断规则。

### `entry.deadPage.bodyTextMinLength`
- **类型**：`number`
- **作用**：死页判定时，body 文本的最小阈值。
- **区别于 whiteScreen**：
  - whiteScreen 更偏“页面几乎没起来”
  - deadPage 更偏“页面已经尝试加载，但没有进入正常状态，且伴随失败证据”

---

## 6. `entry.overlays`
控制首页入口阶段的弹层/遮罩处理策略。

### `entry.overlays.enabled`
- **类型**：`boolean`
- **作用**：是否启用入口页 overlay 预处理。

### `entry.overlays.patterns`
- **类型**：`string[]`
- **作用**：常见入口弹层按钮/文字模式。
- **用途**：
  - 在首页 ready 之前先清掉阻挡交互的弹层
- **建议**：
  - 放常见的 Accept / Agree / Close / Skip / Got it 等
  - 真正复杂的 overlay 逻辑更适合后续放 adapter

---

# 配置时的原则

## 哪些字段你可以经常调
- `entry.navigation.runTimeoutMs`
- `entry.navigation.testTimeoutMs`
- `entry.navigation.retryAttempts`
- `entry.firstLoad.runGraceWaitMs`
- `entry.firstLoad.testGraceWaitMs`
- `entry.whiteScreen.precheckRecheckWaitMinMs`
- `entry.whiteScreen.precheckRecheckWaitMaxMs`

这些更偏运行策略调优。

## 哪些字段要谨慎调
- `entry.readySignals.text`
- `entry.readySignals.selectors`
- `entry.readySignals.bodyPatterns`
- `entry.whiteScreen.bodyTextMinLength`
- `entry.deadPage.bodyTextMinLength`

这些直接影响“什么叫首页 ready / 什么叫白屏 / 什么叫死页”。
如果改得太松，容易放入假阳性；改得太紧，容易误杀。

---

# 一句话总结

这个 profile 的作用就是：
**告诉通用首页模块，Dreamina 首页长什么样、什么算 ready、什么算白屏、什么算死页、以及首页打开该怎么等、怎么重试。**
