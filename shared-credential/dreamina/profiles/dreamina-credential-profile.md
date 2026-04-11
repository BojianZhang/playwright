# dreamina-credential-profile.json 字段说明

这个文件描述的是 Dreamina 在阶段 2（credential submit）的静态规则。

---

# 顶层字段

## `name`
- 类型：`string`
- 作用：配置名称，用于日志和识别当前阶段 profile。

## `fields`
- 类型：`object`
- 作用：定义 credential 表单字段。

## `submit`
- 类型：`object`
- 作用：定义提交动作相关按钮文本和 selector。

## `successSignals`
- 类型：`object`
- 作用：定义阶段 2 提交成功后，进入下一阶段的确认信号。

## `failureSignals`
- 类型：`object`
- 作用：定义阶段 2 提交失败时的文本/模式。

---

# `fields.email`

## `required`
- 类型：`boolean`
- 作用：该字段是否必填。

## `selectors`
- 类型：`string[]`
- 作用：email 输入框候选 selector。
- 控制：
  - form ready 判断
  - email 填写目标

---

# `fields.password`

## `required`
- 类型：`boolean`
- 作用：该字段是否必填。

## `selectors`
- 类型：`string[]`
- 作用：password 输入框候选 selector。
- 控制：
  - form ready 判断
  - password 填写目标

---

# `submit`

## `texts`
- 类型：`string[]`
- 作用：提交按钮文本候选。

## `selectors`
- 类型：`string[]`
- 作用：提交按钮 selector 候选。

---

# `successSignals`

## `texts`
- 类型：`string[]`
- 作用：提交成功后下一阶段可能出现的文本信号。

## `selectors`
- 类型：`string[]`
- 作用：提交成功后下一阶段可能出现的 selector 信号。

---

# `failureSignals`

## `existingAccount`
- 类型：`string[]`
- 作用：已存在账号提示文本。

## `rejected`
- 类型：`string[]`
- 作用：注册/提交被拒绝的提示文本。

## `rateLimited`
- 类型：`string[]`
- 作用：限流/频率过高提示文本。

## `inlineErrors`
- 类型：`string[]`
- 作用：表单页通用错误提示关键词。

---

# 一句话总结

这个 profile 的作用是：
**告诉阶段 2 公共骨架，Dreamina 的 credential form 长什么样、点哪里提交、什么算成功、什么算失败。**
