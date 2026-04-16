# 第一阶段登录日志判读示例

这个文档是给 Dreamina 第一阶段登录排查用的。

目标很明确：
- 跑完一轮日志后
- 不用翻整份大日志
- 通过少量关键日志组合，快速判断当前最缺哪一块

> 这里讲的“第一阶段登录”只指：
> 从 Dreamina 首页 ready，到进入 email gate / 登录门为止。
> 不包含邮箱填写、验证码、生日、注册提交等后续业务。

---

# 一、怎么使用这个文档

先从真实日志里摘这几类：
- 首页 ready 日志
- overlay 日志
- 登录入口识别日志
- 登录入口点击日志
- login gate 确认日志
- 最终失败 reason

然后拿下面的示例对照。

---

# 示例 1：根本没找到登录入口

## 日志组合示例
```text
[INFO] dreamina.adapter.findDreaminaLoginEntry | 当前未找到 Dreamina 登录入口候选
[WARN] dreamina.adapter.openDreaminaLoginEntry | 未找到可用登录入口
[FAIL] DREAMINA_LOGIN_ENTRY_NOT_FOUND
```

## 这说明什么
说明当前首页已经至少走到登录入口识别阶段了，
但 adapter 里的候选入口没有命中真实页面上的入口。

## 当前最缺哪块
- 登录入口候选覆盖率
- 入口文本/selector/role 还不够全

## 优先排查方向
1. 页面上真实显示的入口文案是什么
2. 是 button、link、div 还是别的结构
3. 当前候选优先级里有没有漏掉这个入口

---

# 示例 2：找到了入口，但入口不可点击

## 日志组合示例
```text
[INFO] dreamina.adapter.findDreaminaLoginEntry | 命中登录入口文本候选: sign-in-text | text=Sign in
[WARN] dreamina.adapter.openDreaminaLoginEntry | 登录入口不可点击: sign-in-text
[FAIL] DREAMINA_LOGIN_ENTRY_NOT_CLICKABLE
```

## 这说明什么
说明入口识别本身成功了，
但当前 DOM 上这个入口虽然可见，不能正常点击。

## 当前最缺哪块
- overlay 清理精度
- 假入口排除
- 入口定位精度

## 优先排查方向
1. 页面上是否还有挡板/遮罩没清掉
2. 命中的入口是不是“看得见但不是实际可点控件”
3. 是否命中了错层按钮/假按钮

---

# 示例 3：点击入口成功，但页面没有状态变化

## 日志组合示例
```text
[INFO] dreamina.adapter.findDreaminaLoginEntry | 命中登录入口文本候选: sign-in-text | text=Sign in
[INFO] dreamina.adapter.waitAfterLoginEntryAction | 点击后保护性等待 700ms
[INFO] dreamina.adapter.openDreaminaLoginEntry | 已点击登录入口: sign-in-text | stateChanged=N
[FAIL] DREAMINA_LOGIN_ENTRY_CLICK_NO_STATE_CHANGE
```

## 这说明什么
说明：
- 按钮找到了
- 点击动作也执行了
- 但点击前后关键状态没变化

## 当前最缺哪块
- 入口质量不够
- 点击后状态变化判断需要继续校准
- 也可能需要补更细的点击后等待节奏

## 优先排查方向
1. 命中的入口是不是正确入口，而不是首页装饰按钮
2. 这个入口是否需要 hover / 聚焦 / 更稳定的 click 方式
3. 页面是否在 700ms 后仍会慢一拍变化

---

# 示例 4：已经进入中间层，但没到 email gate

## 日志组合示例
```text
[INFO] dreamina.adapter.openDreaminaLoginEntry | 已点击登录入口: sign-in-text | stateChanged=Y
[INFO] dreamina.adapter.confirmDreaminaLoginGate | 命中登录门外层信号: Continue with email
[INFO] dreamina.adapter.ensureDreaminaLoginGate | 当前只进入登录门外层，准备执行第二跳 Continue with email
[FAIL] DREAMINA_EMAIL_GATE_NOT_REACHED
```

## 这说明什么
说明当前流程已经证明：
- 首页入口点击是有效的
- 页面也进入了登录门外层
- 但第二跳后还是没有进入真正的 email input 层

## 当前最缺哪块
- Continue with email 第二跳路径
- 第二跳后的 gate 确认精度
- 第二跳后的等待节奏

## 优先排查方向
1. 第二跳命中的 Continue with email 是不是对的
2. 第二跳之后是否需要短等待
3. email gate 的确认信号是不是还不够细

---

# 示例 5：已经进入 email gate

## 日志组合示例
```text
[INFO] dreamina.adapter.detectDreaminaEmailGateReady | 当前已在邮箱登录门: input[type="email"]
[INFO] dreamina.adapter.confirmDreaminaLoginGate | 命中邮箱登录门信号: input[type="email"]
[SUCCESS] LOGIN_GATE_READY
```

## 这说明什么
说明第一阶段登录已经成功。

## 当前最缺哪块
这一层基本不缺了。
不要再盯 adapter 的第一阶段登录入口，
该去排后面的邮箱填写/验证码等阶段。

## 优先排查方向
- 转去后续业务链

---

# 示例 6：被 Dreamina 专属错误弹窗卡住

## 日志组合示例
```text
[INFO] dreamina.adapter.detectDreaminaErrorModal | 命中 Dreamina 错误弹窗信号: Something went wrong
[INFO] dreamina.adapter.confirmDreaminaLoginGate | state=ERROR_MODAL_VISIBLE
[FAIL] DREAMINA_LOGIN_GATE_ERROR_MODAL_VISIBLE
```

## 这说明什么
说明当前问题不在：
- 入口候选
- gate 确认
- 第二跳

而是在 Dreamina 页面自己进入了异常态。

## 当前最缺哪块
- Dreamina error modal 的恢复策略

## 优先排查方向
1. 这类异常出现频率高不高
2. 是否值得补“点 Refresh / reload”的自动恢复
3. 代理/页面资源错误是否与这个异常共现

---

# 示例 7：overlay 一直没有命中，但页面明显有挡板

## 日志组合示例
```text
[INFO] dreamina.adapter.preprocessOverlays | 开始执行第一版 overlay 清理
[INFO] dreamina.adapter.preprocessOverlays | 未发现可安全处理的 overlay
[WARN] DREAMINA_LOGIN_ENTRY_NOT_CLICKABLE
```

## 这说明什么
说明当前挡板很可能存在，
但 adapter 现有 overlay 候选没有命中。

## 当前最缺哪块
- overlay 候选覆盖率
- close selector / safe text 还不够

## 优先排查方向
1. 真实挡板按钮文案是什么
2. 是否是 icon-only close 按钮
3. 是否需要补更具体 selector

---

# 示例 8：首页其实都没 ready，别急着看第一阶段登录

## 日志组合示例
```text
[WARN] WHITE_SCREEN
[WARN] DEAD_PAGE
[FAIL] DREAMINA_READY_MISSING_ASSET_FAILURE
```

## 这说明什么
说明问题还停留在：首页入口层，
根本还没到第一阶段登录入口这一步。

## 当前最缺哪块
- 首页 ready / 白屏 / dead page / 资源失败排查

## 优先排查方向
- 不要先调 adapter 的登录入口
- 先看首页入口健康检查链

---

# 二、快速对照表

## 看到这个最终 reason
### `DREAMINA_LOGIN_ENTRY_NOT_FOUND`
优先怀疑：
- 入口候选不够

### `DREAMINA_LOGIN_ENTRY_NOT_CLICKABLE`
优先怀疑：
- overlay 没清干净
- 假入口

### `DREAMINA_LOGIN_ENTRY_CLICK_FAILED`
优先怀疑：
- locator 不稳
- DOM 变化快

### `DREAMINA_LOGIN_ENTRY_CLICK_NO_STATE_CHANGE`
优先怀疑：
- 入口点到了但不是对入口
- 点击后等待不足
- 状态变化判断还要调

### `DREAMINA_EMAIL_GATE_NOT_REACHED`
优先怀疑：
- 第二跳 Continue with email
- email gate 确认信号不够

### `DREAMINA_LOGIN_GATE_NOT_CONFIRMED`
优先怀疑：
- gate 确认精度
- 入口切换未完成

### `DREAMINA_LOGIN_GATE_ERROR_MODAL_VISIBLE`
优先怀疑：
- Dreamina 页面异常态
- 需要 error modal 恢复策略

---

# 三、一句话总结

如果你跑完一轮只想最快判断当前缺哪块：

1. 先看有没有找到登录入口
2. 再看点完后有没有状态变化
3. 再看有没有进入 Continue with email 中间层
4. 再看有没有进入 email gate
5. 最后看是不是被 Dreamina error modal 卡住

这样基本就能判断，下一刀该补哪里。
