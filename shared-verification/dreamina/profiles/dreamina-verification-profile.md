# dreamina-verification-profile 字段说明

对应文件：
- `D:\playwright\shared-verification\dreamina\profiles\dreamina-verification-profile.json`

这个文件解释 Dreamina 阶段 3 profile 里每个字段的作用。

---

# 一、建议结构

```json
{
  "name": "DreaminaVerificationStage",
  "verificationReady": {
    "texts": [],
    "selectors": []
  },
  "codeInput": {
    "selectors": []
  },
  "successSignals": {
    "texts": [],
    "selectors": []
  },
  "failureSignals": {
    "wrongCode": [],
    "rateLimited": [],
    "rejected": [],
    "existingAccount": [],
    "inlineErrors": []
  },
  "nextStageSignals": {
    "profileCompletion": {
      "texts": [],
      "selectors": []
    }
  }
}
```

---

# 二、字段说明

## `name`
- 类型：`string`
- 含义：当前 profile 的名称
- 作用：日志和调试识别

---

## `verificationReady`
用于判断页面是否已经进入验证码阶段。

### `verificationReady.texts`
- 类型：`string[]`
- 含义：验证码阶段 ready 的文本信号

### `verificationReady.selectors`
- 类型：`string[]`
- 含义：验证码阶段 ready 的 selector 信号

---

## `codeInput`
用于定义验证码输入控件候选池。

### `codeInput.selectors`
- 类型：`string[]`
- 含义：验证码输入控件候选 selector
- 作用：adapter 应按顺序扫描这些候选
- 注意：保持 Dreamina 专用白名单，不要放宽到过泛输入控件

---

## `successSignals`
用于判断验证码阶段是否成功推进。

### `successSignals.texts`
- 类型：`string[]`
- 含义：验证码通过后进入下一阶段的文本信号

### `successSignals.selectors`
- 类型：`string[]`
- 含义：验证码通过后进入下一阶段的结构信号

---

## `failureSignals`
用于定义验证码阶段失败提示。

### `failureSignals.wrongCode`
- 类型：`string[]`
- 含义：验证码错误提示文本 / pattern

### `failureSignals.rateLimited`
- 类型：`string[]`
- 含义：验证码发送/校验频率受限提示

### `failureSignals.rejected`
- 类型：`string[]`
- 含义：注册被拒绝相关提示

### `failureSignals.existingAccount`
- 类型：`string[]`
- 含义：已存在账号相关提示

### `failureSignals.inlineErrors`
- 类型：`string[]`
- 含义：通用内联错误兜底词

---

## `nextStageSignals`
用于定义下一阶段（profile-completion）ready 信号。

### `nextStageSignals.profileCompletion.texts`
- 类型：`string[]`
- 含义：进入 birthday / profile-completion 的文本信号

### `nextStageSignals.profileCompletion.selectors`
- 类型：`string[]`
- 含义：进入 birthday / profile-completion 的结构信号
