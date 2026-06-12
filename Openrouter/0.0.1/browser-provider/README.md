# 指纹浏览器 Provider 层

让本系统**不绑死 AdsPower**，可切换/扩展任意指纹浏览器。业务流程(stages.js)完全不感知是哪家——
它只拿到一个被 Playwright 接管的 `{ browser, context, page }`。

## 原理
所有主流指纹浏览器(AdsPower / BitBrowser / Dolphin Anty / GoLogin / Hubstudio / MoreLogin / Multilogin / VMLogin)
都有**本地 API：启动一个环境 → 返回一个 CDP 端点(ws + debug port)**。差异只在"启动/停止/列表"的 HTTP 细节。
所以：

- 每家 = 一个 `providers/<name>.js`，只实现 `start/stop/list/isHealthy`(纯 HTTP/SDK)。
- `base.js` 统一用 `chromium.connectOverCDP(ws)` 接管 + 摆窗口 + 返回 runtime（**厂商无关，只此一份**）。
- `index.js` 注册表 + `createRuntime(name, envId)` 编排。

## 选用
- 网页控制台：「指纹浏览器」下拉选一家 + 在「环境ID池」填该家的环境 id（每账号分一个）。
- 程序内(_selftest 等)：`taskParams.browserProvider = 'adspower' | 'bitbrowser' | …` + `browserEnvIds: [...]`。
- 向后兼容：旧的 `useAdsPower:true` 自动映射成 `browserProvider:'adspower'`。

## 配置（API 基址 / token）
精度：内置默认 < `config.json` `browserProviders.<name>` < `config.local.json` 同段 < 环境变量。
- 基址：`OPENROUTER_<NAME>_API`（如 `OPENROUTER_BITBROWSER_API=http://127.0.0.1:54345`）。
- **token 等敏感项只走环境变量或 `config.local.json`(已 gitignore)，绝不写进 `config.json`**：
  `OPENROUTER_DOLPHIN_TOKEN` / `OPENROUTER_GOLOGIN_TOKEN` 等。

## 各家状态
| Provider | 状态 | 启动端点 → CDP | 备注 |
|---|---|---|---|
| **adspower** | ✅ 生产·已验证 | `GET /api/v1/browser/start` → `data.ws.puppeteer` + `data.debug_port` | 复用现有 openrouter-adspower.js |
| **bitbrowser** | ⚠ 按文档实现·待实测 | `POST /browser/open {id}` → `data.ws` + `data.http` | base 默认 `127.0.0.1:54345` |
| **dolphin** | ⚠ 按文档实现·待实测 | `.../v1.0/browser_profiles/{id}/start?automation=1` → `automation.port`+`wsEndpoint` | 先 `login-with-token`；免费版禁自动化 |
| **gologin** | ⚠ 按文档实现·待实测 | SDK `gl.start()` → wsUrl / REST | 需 `OPENROUTER_GOLOGIN_TOKEN`；SDK 可选(惰性 require) |
| **morelogin** | ⚠ 按文档实现·待实测 | `POST /api/env/start {envId}` → `data.debugPort`(http CDP) | base `127.0.0.1:40000`；需 `OPENROUTER_MORELOGIN_APPID/_SECRET` 签名 |
| **vmlogin** | ⚠ 按文档实现·待实测 | `GET /api/v1/profile/start?profileId=` → `value`(debuggerAddress) | base `127.0.0.1:35000`；客户端先开「浏览器自动化设置」端口 |
| **multilogin** | ⚠ 按文档实现·待实测 | `GET /api/v1/profile/start?automation=true&profileId=` → `value` | ML6 本地 `127.0.0.1:35000`；ML X 用 `launcher.mlx.yt:45001` + token |
| **hubstudio** | ⚠ 最佳努力·字段待核 | `POST /api/v1/browser/start {containerCode}` → debug 端口 | base `127.0.0.1:6873`；字段名请对照 HubStudio 文档 |

> 本仓库环境只装了 AdsPower，故只有 adspower 真跑过；其余 7 家按各家官方本地 API 文档实现，
> 客户端未运行时 `start()` 会优雅返回错误并落到原生 Playwright，**需你在装了对应客户端的机器上实测**(端点/字段可能随版本微调，照 template 调即可)。

## 新增一家 provider（4 步）
1. 复制 `providers/template.js` → `providers/<name>.js`，改 `NAME`，按注释实现 `start`(返回 `{ok,ws,debugPort}`)/`stop`/`list`/`isHealthy`。
2. `index.js` 的 `LOADERS` 加一行。
3. `config.js` 的 `BUILTIN` 加默认 `apiBase`（token 走 env）。
4. `web/server.js` 的 `browserProvider` 白名单数组 + `web/public/index.html` 的 `<select>` 各加一项。

## 自动化驱动（如实）
- **流程驱动固定用 Playwright**：各家 ws 都能 `connectOverCDP`。再做第二个流程驱动(Puppeteer/Selenium 重写 Playwright 深度耦合的 stages.js)= 大改写、零能力增益，**不做**。
- **按步骤换驱动已支持**：`billing/card-fill/` 填卡引擎能对"填卡"那一步改用 Selenium(经本层白送的 `debugPort`)。
- `puppeteer.connect(ws)` 是 connect 层的可选扩展点（在 base.js 旁边加一个 sibling 即可），目前仅注释、不实现。
