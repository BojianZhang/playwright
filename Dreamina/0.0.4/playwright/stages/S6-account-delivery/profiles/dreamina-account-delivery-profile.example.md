# Dreamina 阶段 6 profile 示例（草案）

```json
{
  "site": "dreamina",
  "stage": "account-delivery",
  "deliveryReady": {
    "selectors": [
      ".workspace-shell"
    ],
    "texts": [
      "Workspace",
      "Projects"
    ],
    "urlIncludes": [
      "/workspace"
    ]
  },
  "summarySignals": {
    "accountFields": [
      "email",
      "password"
    ],
    "sessionKeys": [
      "sessionid",
      "auth_token"
    ],
    "uiSignals": [
      "user-avatar",
      "workspace-shell"
    ]
  },
  "payloadRules": {
    "requiredFields": [
      "email"
    ],
    "optionalFields": [
      "password",
      "sessionSummary",
      "currentUrl"
    ]
  },
  "successSignals": {
    "selectors": [
      ".workspace-shell"
    ],
    "texts": [
      "My Projects"
    ]
  },
  "failureSignals": {
    "selectors": [
      ".error-page"
    ],
    "texts": [
      "Try again",
      "Something went wrong"
    ]
  }
}
```
