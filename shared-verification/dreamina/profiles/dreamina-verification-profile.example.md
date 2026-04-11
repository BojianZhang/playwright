# dreamina-verification-profile 示例（带说明）

```json
{
  "name": "DreaminaVerificationStage",
  "verificationReady": {
    "texts": [
      "Resend code"
    ],
    "selectors": [
      "input[maxlength='6']",
      "input[autocomplete='one-time-code']"
    ]
  },
  "codeInput": {
    "selectors": [
      "input[maxlength='6'][autocomplete='one-time-code']",
      "input[autocomplete='one-time-code'][inputmode='numeric']",
      ".verification_code_input-wrapper input[maxlength='6']",
      ".verification_code_input-wrapper",
      "[class*='verification_code_input-wrapper']",
      ".verification_code_input-number-focus",
      "[class*='verification_code_input-number-focus']"
    ]
  },
  "successSignals": {
    "texts": [],
    "selectors": []
  },
  "failureSignals": {
    "wrongCode": [
      "Wrong verification code. Try again."
    ],
    "rateLimited": [
      "Too many attempts"
    ],
    "rejected": [
      "Couldn't sign up. Try again later.",
      "Try again later"
    ],
    "existingAccount": [
      "An account with this email already exists"
    ],
    "inlineErrors": [
      "error",
      "warning"
    ]
  },
  "nextStageSignals": {
    "profileCompletion": {
      "texts": [
        "Year",
        "Month",
        "Day"
      ],
      "selectors": [
        "button.lv_new_sign_in_panel_wide-birthday-next"
      ]
    }
  }
}
```

---

# 说明

- `verificationReady` 用于确认第三阶段开始
- `codeInput` 必须保持 Dreamina 专用白名单，不要放宽
- `nextStageSignals.profileCompletion` 用于确认第三阶段成功结束
