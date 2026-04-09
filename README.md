# D:\playwright 项目说明

## 1. 项目定位

这是一个基于 **Playwright + 代理 + Firstmail API 验证码** 的批量注册执行器。

当前主目标是：

- 批量读取账号与代理
- 先做代理可用性预检（代码请求 Google / ipify）
- 自动打开 Dreamina 并进入注册流程
- 通过 Firstmail API `messages/latest` 自动轮询最后一封邮件
- 自动提交验证码与生日信息
- 保存登录态、账号 sessionId 和运行结果

一句话概括：

> `runner.js` 负责批量调度，`task-register.js` 负责真实浏览器自动化，`firstmail-api.js` 负责验证码 API 轮询，`results/`、`screenshots/`、`storage/` 负责结果沉淀。

---

## 2. 目录结构

```text
D:\playwright
├─ accounts.txt                    # 待注册账号列表
├─ proxies.txt                     # 原始代理列表
├─ config.json                     # 运行配置
├─ README.md                       # 项目说明文档
├─ runner.js                       # 批量任务总调度入口
├─ task-register.js                # 真实注册流程实现
├─ firstmail-api.js                # Firstmail API 拉码与验证码提取
├─ logger.js                       # 控制台日志输出封装
├─ proxy-precheck.js               # 独立代理联通性预检脚本（默认测 Google，可配置目标）
├─ reset-results.ps1               # 清理运行产物脚本
├─ window-layout.ps1               # Windows 浏览器窗口摆放脚本
├─ package.json                    # Node / Playwright 依赖声明
├─ results/                        # 运行结果与日志
├─ screenshots/                    # 失败截图 / 过程截图
├─ storage/                        # 登录态文件 storageState
└─ node_modules/                   # 依赖目录
```

---

## 3. 核心架构

## 3.1 输入层

程序启动前主要依赖三个输入文件：

### `accounts.txt`
账号列表。

支持两种格式：

```txt
aaa@example.com----123456
bbb@example.com:abcdef
```

程序会解析成：

- `email`
- `password`
- `raw`（原始行文本，用于去重和成功跳过）

### `proxies.txt`
代理列表。

格式：

```txt
host:port:username:password
```

程序会解析成：

- `host`
- `port`
- `username`
- `password`
- `server = http://host:port`

### `config.json`
运行行为配置，例如：

- 代理策略
- 每账号最大代理重试次数
- 并发数
- headless 开关
- slowMo
- Firstmail API 轮询次数与间隔
- Dreamina 异常恢复次数
- 窗口摆放参数
- 结果目录

---

## 3.2 调度层：`runner.js`

`runner.js` 是整个项目的主入口和总调度器，负责：

- 读取账号、代理、配置
- 创建结果目录
- 自动跳过已成功账号
- 计算实际并发数
- 为 worker 分配账号
- 为账号分配代理
- 执行代理预检
- 调用 `runRegisterTask(...)` 进入真实注册
- 记录成功、失败、预检结果、登录态路径和 session 结果文件
- 统计代理失败次数，并把弱代理/坏代理降级写入结果池
- 对 Dreamina 白屏、验证码后生日页不可达这类明确代理强失败场景，立即剔除当前代理并切换新代理

### `runner.js` 的关键职责分层

#### 1）账号与代理读取

- `readLines(filePath)`
- `parseAccount(line)`
- `parseProxy(line)`

#### 2）并发与状态管理

- `createMutex()`：互斥锁，避免并发写文件和状态错乱
- `acquireNextAccount()`：分发下一个待处理账号
- `acquireProxy()` / `releaseProxy()`：控制代理占用与释放
- `updateProxyFailure()`：记录代理连续失败次数

#### 3）代理预检

- `requestViaHttpProxy(...)`：通过 CONNECT + TLS 做代码请求
- `fetchProxyExitIp(proxy)`：通过代码请求 `api.ipify.org` 获取出口 IP
- `precheckProxy(proxy)`：通过代码请求 `https://www.google.com/` 判断主联通性

当前代理分层规则：

- `OK`：Google 通
- `WEAK`：Google 不通，但代码请求 ipify 能拿到有效出口 IP
- `BAD`：Google 不通，且 ipify 也失败 / 拿不到有效出口 IP

#### 4）真实执行

- `processAccount(account, workerId)`：单账号处理总流程
- `runRegisterTask(...)`：真实浏览器自动化注册任务

---

## 3.3 执行层：`task-register.js`

`task-register.js` 是真实页面自动化的核心实现，负责从打开浏览器到最终注册成功的整套细节流程。

### 当前真实流程分阶段如下

#### 阶段 1：打开 Dreamina

- 打开 Dreamina 页面
- 自动处理常见弹层
- 自动检测 `Sign in / Log in / Sign up / Continue with email`
- 自动进入邮箱注册表单
- 若页面疑似白屏 / 空白加载，会返回明确失败原因并在调度层将当前代理直接判为强失败

#### 阶段 2：填写邮箱密码并提交

- 填写邮箱
- 填写密码
- 点击 Continue / Sign up 提交注册请求

#### 阶段 3：通过 Firstmail API 拉验证码

- 提交邮箱密码后，先等待验证码页出现类似 `Resend code in XXs` 的倒计时元素
- 只有检测到倒计时元素后，才启动 Firstmail API `messages/latest` 轮询
- 轮询最后一封邮件
- 接口返回 `404 No messages found` 时继续轮询，不直接失败
- 从 Dreamina 邮件文本 / 摘要 / 内容字段中提取验证码

#### 阶段 4：回填验证码和生日

- 输入验证码
- 等待生日输入区（Year / Month / Day）真正出现
- 选择年 / 月 / 日
- 点击 Next
- 若验证码提交后始终到不了生日页，会返回明确失败原因并在调度层将当前代理直接判为强失败

#### 阶段 5：保存登录态

- 出生年月日填写完并点击 `Next` 后，不会立刻保存登录态；会先等待 Dreamina 主页真正出现登录后就绪信号（如你截图中的底部订阅 / credits 区域、主页入口元素等）
- 检测到该主页就绪信号后，才额外写一份根目录 `user.json`
- 账号 session 提取以 `user.json` 内 cookies 中、cookie 名严格等于 `sessionid` 的条目为准
- 当前兼容匹配 `.capcut.com` / `dreamina.capcut.com` 相关域，不再回退混用 `msToken`、`sid_guard`、代理 `sessid` 等其他字段
- 同时仍保留 `storage/` 下分账号 `storageState` 文件用于排障
- 返回成功结果给 `runner.js`

### 执行层的重要辅助能力

#### 指纹随机化

`getRandomFingerprint()` 会随机生成：

- User-Agent
- viewport
- locale
- timezoneId
- colorScheme
- deviceScaleFactor

#### 截图能力

`capture(page, name, prefix)` 会把关键节点或失败现场写入 `screenshots/`。

#### Dreamina 异常恢复

脚本内已经内置：

- 前置弹层处理
- `Something went wrong` 异常弹窗恢复
- 分阶段等待登录入口
- 打开页面失败时多次重试

---

## 3.4 验证码 API 层：`firstmail-api.js`

负责：

- 调用 `POST /api/v1/email/messages/latest`
- 轮询最后一封邮件
- 当返回 `404 No messages found` 时继续轮询
- 打印每轮返回摘要（from / subject / snippet / noMessages）
- 从 Dreamina 最新邮件中提取验证码

---

## 3.5 结果层

默认结果目录由 `config.json` 的 `resultsDir` 决定，当前默认是 `results/`。

常见文件如下：

### `results/success.txt`
成功账号记录。

### `results/failed.txt`
失败账号记录及失败原因。

### `results/run-log.txt`
主运行日志，排障优先看这个。

### `results/runner-precheck.txt`
代理预检、出口 IP、预检落点记录。

### `results/accounts-done.txt`
已成功完成的账号原始记录。后续再次执行时会自动跳过。

### `results/sessions.txt`
只存账号真正的 sessionId：

```text
<账号sessionId>
```

### `results/sessions-with-country.txt`
只存国家代码前缀版本：

```text
<国家代码>-<账号sessionId>
```

### `results/storage-paths.txt`
账号与登录态文件映射关系。

### `results/proxy-ok.txt`
健康代理池。

### `results/proxy-weak.txt`
弱代理池。

### `results/proxy-bad.txt`
坏代理池。

---

## 4. 运行流程

整体链路如下：

```text
accounts.txt / proxies.txt / config.json
                ↓
            runner.js
                ↓
      为每个账号分配 worker + proxy
                ↓
      代理预检（Google + ipify 代码请求）
                ↓
       task-register.js 真实注册执行
                ↓
打开 Dreamina → 提交邮箱密码 → Firstmail API latest 拉码 → 回填验证码和生日 → 保存登录态
                ↓
保存 storage / session / success / failed / log
```

---

## 5. 常用命令

在 `D:\playwright` 目录下执行：

### 启动主流程

```powershell
npm run start
```

### 单独跑代理预检

```powershell
npm run precheck
```

说明：

- 默认主预检目标：`https://www.google.com/`
- 默认出口 IP 目标：`https://api.ipify.org?format=json`
- 全部走代码请求，不再靠 Playwright 探测出口 IP

### 清理运行产物

```powershell
npm run reset
```

### 连测试报告一起清理

```powershell
npm run reset:all
```

---

## 6. `config.json` 当前推荐参数说明

当前建议配置：

```json
{
  "proxyPolicy": "roundRobin",
  "maxProxyRetriesPerAccount": 3,
  "concurrency": 2,
  "proxyPrecheckConcurrency": 40,
  "proxyPrecheckUrl": "https://www.google.com/",
  "proxyPrecheckMethod": "GET",
  "proxyPrecheckOkMinStatus": 200,
  "proxyPrecheckOkMaxStatus": 399,
  "proxyPrecheckWeakFallbackEnabled": true,
  "proxyPrecheckWeakFallbackUrl": "https://api.ipify.org/?format=json",
  "proxyPrecheckWeakFallbackMethod": "GET",
  "proxyExitIpUrl": "https://api.ipify.org?format=json",
  "proxyExitIpMethod": "GET",
  "proxyConnectivityTimeoutMs": 15000,
  "headless": false,
  "slowMo": 120,
  "dreaminaMaxRecoveries": 3,
  "dreaminaRecoveryBonusMs": 15000,
  "waitMailIntervalMs": 5000,
  "verificationCountdownWaitMs": 30000,
  "birthdayStageTimeoutMs": 20000,
  "firstmailApiBaseUrl": "https://firstmail.ltd",
  "firstmailApiKey": "",
  "firstmailApiTimeoutMs": 30000,
  "firstmailApiMaxPollAttempts": 18,
  "windowLayout": "grid",
  "windowGap": 12,
  "windowMargin": 8,
  "windowTopInset": 8,
  "windowBottomInset": 48,
  "resultsDir": "results"
}
```

### 核心参数说明

#### `proxyPolicy`
代理分配策略：

- `roundRobin`：轮询
- `random`：随机

#### `maxProxyRetriesPerAccount`
每个账号最多换多少次代理重试。

#### `concurrency`
主流程并发数。

#### `proxyPrecheckConcurrency`
独立预检脚本并发数。

#### `proxyPrecheckUrl` / `proxyPrecheckMethod`
代理主预检目标与方法，当前默认测 Google。

#### `proxyPrecheckOkMinStatus` / `proxyPrecheckOkMaxStatus`
主预检状态码通过区间，当前默认 `200~399`。

#### `proxyPrecheckWeakFallbackEnabled`
是否启用弱代理回退判定。

#### `proxyPrecheckWeakFallbackUrl` / `proxyPrecheckWeakFallbackMethod`
弱代理回退目标与方法，当前默认 `api.ipify.org`。

#### `proxyExitIpUrl` / `proxyExitIpMethod`
出口 IP 获取目标与方法，当前默认 `https://api.ipify.org?format=json`。

#### `proxyConnectivityTimeoutMs`
代理代码请求超时时间。

#### `headless`
是否无头运行。

#### `slowMo`
Playwright 每步额外放慢毫秒数。

#### `dreaminaMaxRecoveries`
Dreamina 页面异常恢复最大次数。

#### `dreaminaRecoveryBonusMs`
每次恢复后的额外等待时长。

#### `waitMailIntervalMs`
验证码轮询间隔毫秒数。

#### `verificationCountdownWaitMs`
提交邮箱密码后，等待验证码页倒计时元素出现的最长毫秒数；只有倒计时元素出现后才会启动 Firstmail API 轮询。

#### `birthdayStageTimeoutMs`
验证码提交后，等待生日输入区真正出现的最长毫秒数；若超时仍不可达，会判定为 `DREAMINA_BIRTHDAY_STAGE_UNREACHABLE` 并触发代理强失败处理。

#### `firstmailApiBaseUrl`
Firstmail API 基础地址。

#### `firstmailApiKey`
Firstmail API Key。

> 建议本地调试可写入；提交仓库前清空或改走环境变量。

#### `firstmailApiTimeoutMs`
Firstmail API 单次请求超时。

#### `firstmailApiMaxPollAttempts`
通过 `messages/latest` 轮询最后一封邮件的最大次数。

> 接口返回 `404 No messages found` 时不会直接失败，而是继续轮询，直到达到这个次数上限。

#### `windowLayout`
窗口布局模式。当前默认仍写作 `grid`，但实现已升级为“按并发分档布局优先，普通网格兜底”：

- 1 并发：单窗口
- 2 并发：左右双列
- 3 并发：上 1 下 2
- 4 并发：2×2
- 5 并发：上 3 下 2
- 6 并发：3×2
- 更高并发：回退普通网格

#### `windowGap`
多窗口间距。

#### `windowMargin`
屏幕左右边缘留白。

#### `windowTopInset`
窗口布局顶部预留。

#### `windowBottomInset`
窗口布局底部预留，避免任务栏或系统边界挤压。

#### `resultsDir`
结果目录。

---

## 7. 排障优先建议

当前最值得优先调整的参数是：

```json
"concurrency": 2,
"firstmailApiMaxPollAttempts": 18,
"waitMailIntervalMs": 5000,
"proxyConnectivityTimeoutMs": 15000
```

如果验证码邮件偏慢，可优先提高：

```json
"firstmailApiMaxPollAttempts": 30
```

---

## 8. 排障顺序

优先看：

1. `results/run-log.txt`
2. `results/failed.txt`
3. `results/runner-precheck.txt`
4. `results/proxy-precheck-log.txt`
5. `screenshots/`
6. `results/sessions.txt`
7. `results/sessions-with-country.txt`

### 先看 `run-log.txt`
看失败到底发生在：

- 代理预检
- 打开 Dreamina
- 邮箱密码提交
- Firstmail API latest 拉验证码
- 回填验证码和生日
- 保存登录态

---

## 9. Git 工作流与提交规范

你当前仓库建议：

- `main`：稳定主线
- `dev`：日常开发线

版本更迭建议：

- `commit` 记录细节变化
- `tag` 标记阶段版本
- `branch` 承载并行开发

推荐提交前缀：

- `feat:` 新增功能
- `fix:` 修 bug
- `refactor:` 重构
- `docs:` 文档
- `chore:` 配置/脚本/整理
- `test:` 测试

---

## 10. 当前最重要的结论

1. 真实注册逻辑只有 5 阶段：
   - 打开 Dreamina
   - 填写邮箱密码并提交
   - Firstmail API latest 拉验证码
   - 回填验证码和生日
   - 保存登录态
2. 代理预检与出口 IP 探测都已统一走代码请求，不再混用 Playwright 探测 IP。
3. `sessions.txt` 与 `sessions-with-country.txt` 只存最终结果，不混代理 sessid，账号 session 只认 `dreamina.capcut.com` 下 cookie 名 `sessionid`。
4. `messages/latest` 返回 `404 No messages found` 时不会直接失败，而是继续轮询。
5. Firstmail API 拉码时机会与验证码页倒计时联动，默认先等 `Resend code in XXs` 再启动轮询。
6. Dreamina 白屏和验证码后生日页不可达都属于代理强失败，调度层会立即剔除当前代理并换新代理。

---

如果后续代码或流程继续变化，记得同步更新这个 README，避免文档和实现再次脱节。
