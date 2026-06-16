# Dreamina 阶段 5 profile 说明

对应文件：
- `D:\playwright\shared-post-auth-ready\dreamina\profiles\dreamina-post-auth-ready-profile.json`

这个 profile 只做一件事：
**把 Dreamina 在第五阶段可能会用到的静态信号入口先定义清楚。**

---

# 一、顶层字段

## `site`
- 固定值：`dreamina`
- 含义：当前 profile 所属站点

## `stage`
- 固定值：`post-auth-ready`
- 含义：当前 profile 所属阶段

---

# 二、`postAuthReady`

用于定义第五阶段入口 ready 信号。

## `postAuthReady.selectors`
- 类型：`array<string>`
- 含义：进入第五阶段时优先匹配的 DOM selector 列表

## `postAuthReady.texts`
- 类型：`array<string>`
- 含义：进入第五阶段时可用的文本信号列表

## `postAuthReady.urlIncludes`
- 类型：`array<string>`
- 含义：可作为第五阶段 ready 辅助信号的 URL 片段
- 当前草案默认示例：
  - `/app`
  - `/workspace`
  - `/home`

---

# 三、`sessionSignals`

用于定义 session / storage 侧的关键键名规则。

## `sessionSignals.cookieKeys`
- 类型：`array<string>`
- 含义：关键 cookie 键名列表

## `sessionSignals.localStorageKeys`
- 类型：`array<string>`
- 含义：关键 localStorage 键名列表

## `sessionSignals.sessionStorageKeys`
- 类型：`array<string>`
- 含义：关键 sessionStorage 键名列表

---

# 四、`uiSignals`

用于定义登录后 UI 信号。

## `uiSignals.selectors`
- 类型：`array<string>`
- 含义：用户面板 / 工作台 / 控制台主页等关键 selector 列表

## `uiSignals.texts`
- 类型：`array<string>`
- 含义：登录后 UI 可用文本信号列表

---

# 五、`successSignals`

用于定义第五阶段最终成功信号。

## `successSignals.selectors`
- 类型：`array<string>`
- 含义：可以强确认 registration-complete 的 selector 列表

## `successSignals.texts`
- 类型：`array<string>`
- 含义：可以强确认 registration-complete 的文本信号列表

---

# 六、`failureSignals`

用于定义第五阶段明确失败信号。

## `failureSignals.selectors`
- 类型：`array<string>`
- 含义：登录后失败页 / 拦截页 / 阻断页的 selector 列表

## `failureSignals.texts`
- 类型：`array<string>`
- 含义：登录后失败态文本线索列表
