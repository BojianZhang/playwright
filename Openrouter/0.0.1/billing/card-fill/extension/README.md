# OR Card Fill Helper（extension 填卡引擎用）

`cardFillEngine` 选 `extension` 时用。content script 注入 `js.stripe.com` 所有帧，收到自动化端发来的
`OR_FILL` 消息后，在 Stripe 帧源内用原生 value setter 填卡，结果写 `<html data-or-fill-result>`。

## 为什么要手动预装
我们用 Playwright `connectOverCDP` **接管 AdsPower 已运行的浏览器**——这种方式**无法** `--load-extension`
（AdsPower 控制浏览器启动，不是我们启动）。所以扩展必须**预先装进每个要用的 AdsPower 环境**。

## 安装步骤（每个 AdsPower 环境一次）
AdsPower 支持给环境配「扩展应用」：

1. AdsPower 客户端 →「扩展应用」/「Extensions」→ 添加本地扩展。
2. 选这个目录：`Openrouter/0.0.1/billing/card-fill/extension/`（含 `manifest.json` + `content.js`）。
3. 把该扩展【应用到目标环境】（或设为默认，给一批环境用）。
4. 启动该环境的浏览器，确认扩展已加载（`chrome://extensions` 里能看到 "OR Card Fill Helper"）。

> 也可手动：浏览器 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选本目录。
> 但 AdsPower 环境隔离，推荐走 AdsPower 的扩展应用管理，确保每次启动都带上。

## 验证装好没
跑 `cardFillEngine: 'extension'`（或链 `'extension,playwright'`）。日志若出现
`extension 引擎：content script 无响应(扩展未预装进该环境?)` 说明没装上 → 回到上面重装；
装好后到加卡弹窗会看到卡号被逐字符填入、`填卡: ... 引擎=extension` 三项 ✓。

## 安全
content script 只在 `js.stripe.com` 帧内、且只响应本机自动化发来的 `OR_FILL` 消息填卡，不外发任何数据。
卡数据由自动化端经 `postMessage` 传入，不写日志、不落盘。
