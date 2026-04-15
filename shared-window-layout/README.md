# shared-window-layout

公共窗口布局规划层。

## 作用

负责：
- layout profile 读取
- layout preset 解析
- worker window layout 计算
- 与布局相关的并发策略（verificationBudget / proxyPolicy）

不负责：
- 浏览器启动
- 摆窗执行（`--window-position` / `--window-size`）
- 资源拦截
- 指纹
- 站点业务逻辑

## 当前布局

- `index.js`：统一导出入口
- `profile-loader.js`：profile 路径与 JSON 读取
- `planner.js`：preset / worker layout 规划
- `policy.js`：按并发读取 verification / proxy policy
- `window-layout-profile.json`：当前 canonical profile

## 关系

- 规划层：`shared-window-layout`
- 执行层：`shared-browser-runtime/window-runtime.js`
- 批量编排层：`shared-batch-orchestration`
