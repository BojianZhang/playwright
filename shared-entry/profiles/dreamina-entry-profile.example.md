# dreamina-entry-profile.json 文档版示例（带字段说明）

> 这是“文档版示例”，不是程序直接读取的 JSON。
> 作用是让你后续配置时，不需要靠猜字段用途。

```jsonc
{
  // 站点名称。
  // 主要用于日志、错误信息、通用模块识别当前站点。
  "name": "Dreamina",

  // 首页入口 URL。
  // 首页打开主流程（goto / reload）都会以它为目标地址。
  "homeUrl": "https://dreamina.capcut.com/ai-tool/home/",

  "entry": {
    "navigation": {
      // run 模式下，单次 goto/reload 最长等待时间。
      // 控制正式运行时页面打开能等多久。
      "runTimeoutMs": 120000,

      // test 模式下，单次 goto/reload 最长等待时间。
      // test 可以比 run 更宽松，用于观察边界情况。
      "testTimeoutMs": 120000,

      // 首页打开最多重试几次。
      // 一般是第一次 goto，后面 reload/retry。
      "retryAttempts": 3
    },

    "firstLoad": {
      // run 模式下，首页刚打开后，在做深判断前额外等待多久。
      // 作用是给前端脚本、接口、组件渲染一点缓冲时间。
      "runGraceWaitMs": 4000,

      // test 模式下的额外等待时间。
      // 一般比 run 宽一点，便于观察慢页面。
      "testGraceWaitMs": 12000,

      // 死页判定时，body 文本过短的基础阈值。
      // 页面文本太少、没 ready signal、又伴随失败证据时，容易判 dead page。
      "deadPageBodyTextMinLength": 80
    },

    "readySignals": {
      "text": [
        // 文本级 ready 信号。
        // 页面上出现这些文本，说明首页已经“活了”。
        "Continue with email",
        "Sign in",
        "Log in",
        "Login",
        "Sign up",
        "Create realistic talk",
        "Start Creating With AI Agent",
        "AI Image",
        "Canvas"
      ],

      "selectors": [
        // selector 级 ready 信号。
        // 当文案不稳定时，可以靠稳定 DOM 元素来判定首页 ready。
        "input[role='textbox']",
        "button",
        "a",
        "[class*='credit-display-container']"
      ],

      "bodyPatterns": [
        // body 文本里的兜底正向模式。
        // 当 text/selectors 没命中时，仍可判断首页是否具有活性。
        "dreamina",
        "capcut",
        "continue with email",
        "sign in",
        "create realistic talk",
        "ai image"
      ]
    },

    "whiteScreen": {
      // 白屏判定时 body 文本最小阈值。
      // 页面文字少到这个程度以下，且没有正向信号时，更像白屏。
      "bodyTextMinLength": 20,

      // precheck 阶段疑似白屏时，要不要再给一次复查。
      // true = 降低误杀慢页面；false = 更快但更激进。
      "recheckOnSuspected": true,

      // 白屏疑似复查时的最小等待时间。
      "precheckRecheckWaitMinMs": 1200,

      // 白屏疑似复查时的最大等待时间。
      "precheckRecheckWaitMaxMs": 4000
    },

    "deadPage": {
      // 死页判定时 body 文本阈值。
      // 和 whiteScreen 不同，dead page 更偏“页面尝试加载了，但没进入正常 ready 状态”。
      "bodyTextMinLength": 80
    },

    "overlays": {
      // 是否启用首页入口阶段的弹层/遮罩处理。
      "enabled": true,

      "patterns": [
        // 常见入口弹层按钮文案。
        // 用来识别 Accept / Agree / Close / Skip 这类挡板按钮。
        "Accept",
        "Agree",
        "Got it",
        "Close",
        "Skip"
      ]
    }
  }
}
```

---

# 你后续配置时怎么理解最省事

## 打开节奏相关
改这些：
- `entry.navigation.runTimeoutMs`
- `entry.navigation.testTimeoutMs`
- `entry.navigation.retryAttempts`
- `entry.firstLoad.runGraceWaitMs`
- `entry.firstLoad.testGraceWaitMs`

## 页面判定口径相关
改这些：
- `entry.readySignals.text`
- `entry.readySignals.selectors`
- `entry.readySignals.bodyPatterns`
- `entry.whiteScreen.bodyTextMinLength`
- `entry.deadPage.bodyTextMinLength`

## 入口遮罩处理相关
改这些：
- `entry.overlays.enabled`
- `entry.overlays.patterns`

---

# 一句话总结

这个文档版示例的目的就是：
**让你以后配 Dreamina / OpenAI / Claude 时，可以直接照着改，不需要猜每个字段到底控制什么。**
