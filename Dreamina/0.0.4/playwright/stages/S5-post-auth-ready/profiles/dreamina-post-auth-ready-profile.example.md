# Dreamina 阶段 5 profile 示例（草案）

```json
{
  "site": "dreamina",
  "stage": "post-auth-ready",
  "postAuthReady": {
    "selectors": [
      "[data-testid='user-menu']",
      ".workspace-shell"
    ],
    "texts": [
      "Workspace",
      "My Projects"
    ],
    "urlIncludes": [
      "/app",
      "/workspace"
    ]
  },
  "sessionSignals": {
    "cookieKeys": [
      "sessionid",
      "auth_token"
    ],
    "localStorageKeys": [
      "userInfo",
      "authState"
    ],
    "sessionStorageKeys": [
      "workspaceState"
    ]
  },
  "uiSignals": {
    "selectors": [
      ".user-avatar",
      ".workspace-nav"
    ],
    "texts": [
      "Logout",
      "My Account"
    ]
  },
  "successSignals": {
    "selectors": [
      ".workspace-shell"
    ],
    "texts": [
      "Create",
      "Projects"
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
