# proxy-precheck-adapter.js 文档

**文件位置**：`Dreamina/0.0.3/S0-proxy-precheck/proxy-precheck-adapter.js`
**阶段**：S0 — 代理预检

---

## 一、公共入参

所有方法均接受以下三个参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `proxy` | `object` | 代理配置对象（来自 `local-proxy-loader.js`，含 host / port / username / password / countryCode 等）|
| `runtime` | `object` | 预检运行时参数（来自 batch-runner 注入，含各项超时时间，见下表）|
| `context` | `object` | 附加上下文（workerId / 各子阶段 probe 结果等，可为空对象）|

### runtime 关键字段

| 字段 | 类型 | 说明 | 默认兜底 |
|------|------|------|------|
| `proxyConnectivityTimeoutMs` | `number` | TCP 连通超时 | profile `exitIp.timeoutMs`（15000ms）|
| `proxyExitIpTimeoutMs` | `number` | 出口 IP 请求超时 | profile `exitIp.timeoutMs`（15000ms）|
| `proxyPrimaryTargetTimeoutMs` | `number` | 主目标请求超时 | profile `primary.timeoutMs`（15000ms）|
| `proxySecondaryTargetTimeoutMs` | `number` | 副目标请求超时 | profile `secondary.timeoutMs`（15000ms）|
| `proxyHomepageShellTimeoutMs` | `number` | 首页 Shell 请求超时 | profile `homepageShell.timeoutMs`（15000ms）|
| `proxyLoginAffordanceTimeoutMs` | `number` | 登录入口检测超时 | 同 homepageShell |
| `proxyBrowserSmokeTimeoutMs` | `number` | 浏览器 Smoke 检测 goto 超时 | 8000ms |
| `proxyBrowserSmokeSettleMs` | `number` | Smoke 检测页面稳定等待 | 3500ms |

---

## 二、方法与返回值

### `checkProxyConnectivity(proxy, runtime, context)`
验证代理 TCP 层是否可连通（使用出口 IP 目标 URL 做 CONNECT 探测）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 是否通过 |
| `state` | `string` | `PROXY_CONNECTIVITY_OK` / `PROXY_CONNECTIVITY_FAILED` |
| `source` | `string` | 固定值 `http-connect` |
| `strength` | `string` | ok=`medium`，fail=`strong`（连通失败是强失败信号）|
| `elapsedMs` | `number` | 耗时（ms）|

---

### `checkProxyExitIp(proxy, runtime, context)`
通过代理请求 `api.ipify.org`，确认出口 IP 可获取。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 请求成功且解析到 IP |
| `state` | `string` | `PROXY_EXIT_IP_OK` / `PROXY_EXIT_IP_FAILED` |
| `value` | `string` | 出口 IP 地址（失败时为错误原因）|
| `ip` | `string` | 解析到的出口 IP（`ok=false` 时为空字符串）|
| `elapsedMs` | `number` | 耗时（ms）|

---

### `checkDreaminaPrimaryTarget(proxy, runtime, context)`
通过代理访问 `dreamina.com`，验证 HTTP 可达性与状态码范围。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 状态码在 `[okMinStatus, okMaxStatus]` 范围内（默认 200-399）|
| `state` | `string` | `DREAMINA_PRIMARY_TARGET_OK` / `DREAMINA_PRIMARY_TARGET_FAILED` |
| `strength` | `string` | ok=`strong`（HTTP 可达是强信号）；fail=`medium`（可能是临时超时）|
| `elapsedMs` | `number` | 耗时（ms）|

---

### `checkDreaminaSecondaryTarget(proxy, runtime, context)`
通过代理访问 `capcut.com`，作为主目标的补充验证。
返回字段同 `checkDreaminaPrimaryTarget`，strength ok=`medium` / fail=`weak`（副目标权重更低）。

---

### `checkDreaminaHomepageShell(proxy, runtime, context)`
HTTP 拉取 Dreamina 首页，检测页面内容质量（HTML 内容级别，不只看状态码）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | 状态码 2xx-3xx + 正文长度 >= minBodyTextLength + 无 errorTexts + 有 titleHit 或 shellTextHit |
| `state` | `string` | `DREAMINA_HOMEPAGE_SHELL_OK` / `DREAMINA_HOMEPAGE_SHELL_FAILED` |
| `evidence.title` | `string` | 页面标题 |
| `evidence.titleHit` | `string` | 命中的 titlePattern（未命中为空字符串）|
| `evidence.shellTextHit` | `string` | 命中的 shellTexts 关键词 |
| `evidence.errorTextHit` | `string` | 命中的 errorTexts 关键词（命中即失败）|
| `evidence.bodyTextLength` | `number` | 去 HTML 标签后正文字符数 |
| `evidence.bodyPreview` | `string` | 正文前 240 字符（供调试）|

---

### `checkDreaminaLoginAffordance(proxy, runtime, context)`
检测 Dreamina 首页是否存在可见的登录/注册入口。

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | `boolean` | `texts` + `selectorHints` 命中数 >= `minAffordanceCount` |
| `state` | `string` | `DREAMINA_LOGIN_AFFORDANCE_OK` / `DREAMINA_LOGIN_AFFORDANCE_MISSING` |
| `evidence.textHit` | `string` | 命中的可见文案 |
| `evidence.selectorHintHit` | `string` | 命中的 HTML class/属性片段 |
| `evidence.affordanceCount` | `number` | 总命中数量 |

---

### `confirmProxyPrecheckResult(proxy, runtime, context)`
综合所有 probe 结果输出代理最终质量分级。**`context` 需包含各子阶段结果**（connectivity / exitIp / primaryTarget / secondaryTarget / homepageShell / loginAffordance）。

| 字段 | 类型 | 枚举值 | 说明 |
|------|------|--------|------|
| `ok` | `boolean` | — | 预检整体是否通过（WEAK 也算通过）|
| `proxyGrade` | `string` | `OK` / `WEAK` / `BAD` | 代理质量等级 |
| `capabilityGrade` | `string` | `DEAD` / `TUNNEL_ONLY` / `HTTP_REACHABLE` / `HTTP_REACHABLE_BUT_BLANK` / `HOMEPAGE_USABLE` / `ENTRY_READY_CAPABLE` | 代理能力等级（越靠右越强）|
| `businessGrade` | `string` | `BAD` / `WEAK` / `OK` / `STRONG` | 基于 healthScore 的业务等级 |
| `healthScore` | `number` | 0-100 | 综合能力得分（各子检查贡献分之和）|
| `state` | `string` | — | 最终状态码 |
| `settleStage` | `string` | `connectivity` / `result-confirmation` | 在哪一层判定收口 |
| `retryCount` | `number` | — | 预检链内部重试次数（当前版本恒为 0）|
| `elapsedMs` | `number` | — | 本阶段总耗时（ms）|

---

### `classifyProxyPrecheckFailure(input)`
将预检失败的原始状态映射为 Dreamina 语义。

| 入参字段 | 说明 |
|---------|------|
| `input.reason` 或 `input.state` | 任意子阶段返回的 state 字符串 |

| 返回字段 | 类型 | 说明 |
|---------|------|------|
| `reason` | `string` | 输入侧原始状态码（转大写）|
| `siteReason` | `string` | Dreamina 语义下收敛后的原因码（用于健康评分写入）|
| `hardFailure` | `boolean` | 是否为硬失败（`true` 时 batch-runner 触发代理热剔除）|

---

### `browserSmokeCheckDreaminaHomepage(page, runtime, context)`
使用 Playwright page 实际访问 Dreamina 首页，通过 DOM 内容判断页面渲染质量。

> **注意**：此方法需要已启动的 Playwright Page 对象（有 browser context 开销），通常在 S1 之前由主流程调用，而非预检批量探测阶段。

| 入参 | 说明 |
|------|------|
| `page` | Playwright Page 对象；缺失时返回 `DREAMINA_BROWSER_SMOKE_UNAVAILABLE`，不抛异常 |

| 返回字段 | 类型 | 说明 |
|---------|------|------|
| `ok` | `boolean` | 页面渲染正常 |
| `state` | `string` | `DREAMINA_BROWSER_SMOKE_OK` / `DREAMINA_BROWSER_SMOKE_BLANK_PAGE` / `DREAMINA_BROWSER_SMOKE_FAILED` / `DREAMINA_BROWSER_SMOKE_UNAVAILABLE` |
| `evidence.bodyTextLength` | `number` | 页面正文字符数 |
| `evidence.blankLike` | `boolean` | 是否判定为空白页 |

---

## 三、profile 字段说明（`profiles/dreamina-proxy-precheck-profile.json`）

| 路径 | 类型 | 说明 |
|------|------|------|
| `site` | `string` | 站点标识（固定 `dreamina`）|
| `chain` | `string` | 阶段链标识（固定 `proxy-precheck`）|
| `targets.primary.url` | `string` | 主目标检测 URL |
| `targets.primary.okMinStatus` | `number` | 主目标 HTTP 状态码下限（含）|
| `targets.primary.okMaxStatus` | `number` | 主目标 HTTP 状态码上限（含）|
| `targets.primary.timeoutMs` | `number` | 主目标请求超时（ms）|
| `targets.secondary.*` | — | 副目标配置（同主目标结构）|
| `targets.exitIp.url` | `string` | 出口 IP 查询地址（当前 `api.ipify.org`）|
| `homepageShell.minBodyTextLength` | `number` | 正文最小长度（低于此判定为空白页）|
| `homepageShell.titlePatterns` | `string[]` | 有效页面标题关键词（任一匹配即可）|
| `homepageShell.shellTexts` | `string[]` | 页面 Shell 文案特征（任一匹配即可）|
| `homepageShell.errorTexts` | `string[]` | 错误页面特征文案（任一匹配即判失败）|
| `loginAffordance.texts` | `string[]` | 登录/注册入口可见文案 |
| `loginAffordance.selectorHints` | `string[]` | HTML 中登录相关 class/属性片段 |
| `loginAffordance.minAffordanceCount` | `number` | 命中数量门槛（建议 1）|

