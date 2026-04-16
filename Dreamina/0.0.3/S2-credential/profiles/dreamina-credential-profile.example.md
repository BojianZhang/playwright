# dreamina-credential-profile.json 文档版示例（带字段说明）

> 这是文档版示例，不是程序直接读取的 JSON。

```jsonc
{
  // 配置名称，用于日志和阶段识别。
  "name": "DreaminaCredentialStage",

  "fields": {
    "email": {
      // email 是否必填。
      "required": true,

      // email 输入框候选 selector。
      // 用于表单 ready 判断和 email 填写。
      "selectors": [
        "input[role='textbox']",
        "input[type='email']"
      ]
    },

    "password": {
      // password 是否必填。
      "required": true,

      // password 输入框候选 selector。
      "selectors": [
        "input[type='password']"
      ]
    }
  },

  "submit": {
    // 提交按钮文本候选。
    "texts": [
      "Continue"
    ],

    // 提交按钮 selector 候选。
    "selectors": [
      "button"
    ]
  },

  "successSignals": {
    // 提交成功后下一阶段可能出现的文本。
    "texts": [
      "Resend code"
    ],

    // 提交成功后下一阶段可能出现的 selector。
    "selectors": [
      "input[maxlength='6']",
      "input[autocomplete='one-time-code']"
    ]
  },

  "failureSignals": {
    // 已存在账号提示。
    "existingAccount": [
      "An account with this email already exists",
      "Enter your password to sign in to your account"
    ],

    // 被拒绝/黑掉/稍后重试提示。
    "rejected": [
      "Couldn't sign up. Try again later.",
      "Try again later"
    ],

    // 限流提示。
    "rateLimited": [
      "Too many attempts",
      "Try again later"
    ],

    // 通用表单错误关键词。
    "inlineErrors": [
      "error",
      "warning"
    ]
  }
}
```

---

# 一句话总结

这个文档版示例的目的就是：
**让你以后给 Dreamina / OpenAI / Claude 配阶段 2 时，不需要猜每个字段控制什么。**
