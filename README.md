# D:\playwright 项目说明

## 1. 项目定位

这是一个基于 **Playwright + 代理 + 邮箱验证码** 的批量注册执行器。

当前主目标是：

- 批量读取账号与代理
- 先做代理可用性预检
- 自动登录 Firstmail
- 自动打开 Dreamina 并进入注册流程
- 自动轮询邮箱验证码
- 自动提交验证码与生日信息
- 保存登录态、Session 信息和运行结果

一句话概括：

> `runner.js` 负责批量调度，`task-register.js` 负责真实浏览器自动化，`results/`、`screenshots/`、`storage/` 负责结果沉淀。

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
├─ logger.js                       # 控制台日志输出封装
├─ proxy-precheck.js               # 独立代理预检脚本（辅助用）
├─ reset-results.ps1               # 清理运行产物脚本
├─ window-layout.ps1               # Windows 浏览器窗口摆放脚本
├─ firstmail-dreamina-signup.js    # 早期/单流程脚本（辅助参考）
├─ dreamina-login.js               # Dreamina 登录相关辅助脚本
├─ playwright.config.ts            # Playwright 测试配置（如需测试时使用）
├─ package.json                    # Node / Playwright 依赖声明
├─ node_modules/                   # 依赖目录
├─ results/                        # 运行结果与日志
├─ screenshots/                    # 失败截图 / 过程截图
├─ storage/                        # 登录态文件 storageState
├─ tests/                          # Playwright 测试目录（若有）
├─ test-results/                   # 测试输出目录
└─ playwright-report/              # Playwright 报告目录
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
- 等验证码轮询次数与间隔
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
- 记录成功、失败、预检结果、登录态路径和 Session
- 统计代理失败次数，并把弱代理/坏代理降级写入结果池

你可以把它理解成：

> 项目的大脑。

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

- `fetchProxyExitIp(proxy)`：取代理出口 IP
- `precheckProxy(proxy)`：访问 Firstmail 登录页，判断代理是否可用于主流程

#### 4）真实执行

- `processAccount(account, workerId)`：单账号处理总流程
- `runRegisterTask(...)`：真实浏览器自动化注册任务

---

## 3.3 执行层：`task-register.js`

`task-register.js` 是真实页面自动化的核心实现，负责从打开浏览器到最终注册成功的整套细节流程。

你可以把它理解成：

> 项目的手和脚。

### 当前真实流程分阶段如下

#### 阶段 1：登录 Firstmail

- 打开 `https://firstmail.ltd/webmail/login/`
- 填写邮箱账号密码
- 点击登录
- 验证邮箱页可用

#### 阶段 2：打开 Dreamina 并进入邮箱注册表单

- 打开 Dreamina 页面
- 自动处理常见弹层
- 自动检测 `Sign in / Log in / Sign up / Continue with email`
- 自动进入邮箱注册表单
- 填写邮箱和密码

#### 阶段 3：回邮箱等待验证码

- 切回 Firstmail
- 刷新邮箱页
- 查找 Dreamina 邮件
- 提取验证码

#### 阶段 4：回 Dreamina 提交验证码和生日

- 输入验证码
- 选择年 / 月 / 日
- 点击 Next

#### 阶段 5：保存结果

- `storageState` 写入 `storage/`
- 从 cookie 提取 `sessionId`
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

用于降低固定指纹特征。

#### 截图能力

`capture(page, name, prefix)` 会把关键节点或失败现场写入 `screenshots/`。

#### Dreamina 异常恢复

脚本内已经内置：

- 前置弹层处理
- `Something went wrong` 异常弹窗恢复
- 分阶段等待登录入口
- 打开页面失败时多次重试

这块是当前最容易继续演化的高风险区。

---

## 3.4 日志层：`logger.js`

`logger.js` 负责统一控制台输出格式，当前提供：

- `logSystem`
- `logAccount`
- `logProxy`
- `logStage`
- `logSuccess`
- `logFail`
- `logWarn`
- `logInfo`

日志使用颜色区分不同类别，便于盯控制台时快速定位。

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
提取出的 Session 信息。

### `results/storage-paths.txt`
账号与登录态文件映射关系。

### `results/proxy-ok.txt`
健康代理池（如果存在，会优先作为代理来源）。

### `results/proxy-weak.txt`
被自动降级的弱代理。

### `results/proxy-bad.txt`
被自动打入坏池的代理。

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
         代理预检（Firstmail 可访问性）
                ↓
       task-register.js 真实注册执行
                ↓
Firstmail 登录 → Dreamina 注册 → 邮箱收码 → 提交验证码
                ↓
保存 storage / session / success / failed / log
```

---

## 5. 如何使用

## 5.1 环境准备

建议至少具备：

- Windows
- Node.js
- Playwright 依赖已安装

如果依赖缺失，先在项目目录执行：

```powershell
npm install
npx playwright install
```

---

## 5.2 准备输入文件

### 账号文件 `accounts.txt`
确保每行一个账号，格式统一，不要混入注释乱码。

推荐示例：

```txt
user1@example.com----password1
user2@example.com----password2
```

### 代理文件 `proxies.txt`
确保每行一个代理：

```txt
1.2.3.4:8000:user:pass
```

### 配置文件 `config.json`
按你的机器性能和当前稳定性调整参数。

---

## 5.3 常用命令

在 `D:\playwright` 目录下执行：

### 启动主流程

```powershell
npm run start
```

或：

```powershell
npm run run
```

### 单独跑代理预检

```powershell
npm run precheck
```

### 清理运行产物（推荐每次大改后重跑前用一次）

```powershell
npm run reset
```

默认会清理：

- `results/`
- `screenshots/`
- `storage/`

不会删除：

- `accounts.txt`
- `proxies.txt`
- `config.json`
- 源代码文件

### 连测试报告一起清理

```powershell
npm run reset:all
```

会额外清理：

- `test-results/`
- `playwright-report/`

### 跑 Playwright 测试

```powershell
npm run test
```

### 有头模式跑测试

```powershell
npm run test:headed
```

### 查看 Playwright 报告

```powershell
npm run report
```

---

## 5.4 执行后看哪里

优先级建议：

1. `results/run-log.txt`
2. `results/failed.txt`
3. `screenshots/`
4. `results/runner-precheck.txt`
5. `results/success.txt`

### 排障建议顺序

#### 先看 `run-log.txt`
看失败到底发生在：

- 代理预检
- Firstmail 登录
- Dreamina 打开
- 注册入口定位
- 邮件等待
- 验证码提取
- 提交最终表单

#### 再看 `screenshots/`
确认页面当时实际长什么样。

#### 最后结合 `runner-precheck.txt`
判断是不是代理质量问题。

---

## 5.5 断点续跑

项目已实现成功账号自动跳过机制。

依赖文件：

- `results/accounts-done.txt`

再次执行 `npm run start` 时：

- 已成功账号会自动跳过
- 失败账号会继续重跑

这意味着你可以：

1. 跑一批
2. 出问题后修脚本
3. 重新执行
4. 让程序自动跳过已成功账号

---

## 5.6 什么时候该先 reset

建议在下面这些场景先执行一次：

```powershell
npm run reset
```

### 适合先清理再跑的情况

- 你刚改了 `task-register.js`
- 你怀疑旧截图和旧结果干扰判断
- 你想重新观察一轮完整现场
- 你准备切换另一批账号或代理做排障

### 不一定要 reset 的情况

- 你只是想在原批次上继续断点续跑
- 你还需要保留上一次失败现场做对比

注意：

- `reset` 会清空 `results/accounts-done.txt`
- 这意味着已经成功过的账号也不会再被自动跳过
- 所以如果你只是想续跑，不要乱 reset

---

## 6. `config.json` 逐项说明与稳定推荐

当前推荐排障配置如下：

```json
{
  "proxyPolicy": "roundRobin",
  "maxProxyRetriesPerAccount": 3,
  "concurrency": 2,
  "proxyPrecheckConcurrency": 40,
  "headless": false,
  "slowMo": 120,
  "waitMailAttempts": 18,
  "waitMailIntervalMs": 5000,
  "dreaminaMaxRecoveries": 3,
  "dreaminaRecoveryBonusMs": 15000,
  "windowLayout": "grid",
  "windowGap": 12,
  "windowMargin": 8,
  "resultsDir": "results"
}
```

下面逐项解释。

### `proxyPolicy`
代理分配策略。

可选值：

- `random`：随机分配代理
- `roundRobin`：轮询分配代理（代码里非 `random` 默认按轮询处理）

#### 建议
- **想快速打散风险**：用 `random`
- **想更可复盘、便于排障**：用 `roundRobin`

#### 当前建议
如果你现在还在频繁排障，建议先用：

```json
"proxyPolicy": "roundRobin"
```

原因：更容易复盘“哪个账号用了哪个代理”。

---

### `maxProxyRetriesPerAccount`
每个账号在失败后最多换多少次代理重试。

当前是：

```json
3
```

含义：
- 同一个账号最多尝试 3 次不同代理机会
- 超过后记为最终失败

#### 建议
- **稳定优先**：`2 ~ 3`
- **代理质量差、但池子很大**：`3 ~ 4`
- **代理很贵**：不要设太高

#### 当前建议
保持：

```json
3
```

比较稳。

---

### `concurrency`
主流程并发数。

当前推荐是：

```json
2
```

虽然代码会根据账号数和代理数自动收缩，但 UI 自动化注册流程并发过高时很容易把问题放大。

#### 风险
- 窗口太多，机器压力大
- 网络与代理同时抖动更明显
- 页面定位和日志排障都会变乱
- 风控更容易被放大

#### 推荐值

##### 排障模式
```json
"concurrency": 1
```
或
```json
"concurrency": 2
```

##### 稳定批跑模式
```json
"concurrency": 3
```
到
```json
"concurrency": 5
```

##### 已确认很稳、机器和代理都扛得住
再逐步提升，不建议一开始就 20。

#### 当前建议
如果你现在仍在修流程，先保持：

```json
"concurrency": 2
```

---

### `proxyPrecheckConcurrency`
代理预检并发数。

当前配置里有：

```json
40
```

但从当前 `runner.js` 看，这个参数**暂时没有实际接入主调度逻辑**。

也就是说：

- 它现在更像预留配置
- 改它不会直接改变 `runner.js` 当前行为

#### 建议
先保留也行，但要知道：

> 当前主流程基本不会吃这个配置值。

如果后续你要专门扩 `proxy-precheck.js`，再把它正式接进去。

---

### `headless`
是否无头运行。

当前是：

```json
false
```

#### 建议
- **排障期必须 `false`**
- **流程稳定后才考虑 `true`**

因为你现在项目依赖：
- 真实观察页面变化
- 看弹层
- 看 Dreamina 是否改版
- 看验证码流程是否卡住

#### 当前建议
保持：

```json
"headless": false
```

---

### `slowMo`
每个 Playwright 动作之间额外放慢的毫秒数。

当前是：

```json
120
```

#### 作用
- 降低动作过快导致页面跟不上
- 方便人眼观察
- 有时能稍微减小前端还没渲染就点元素的问题

#### 建议
- **排障模式**：`100 ~ 250`
- **稳定批跑**：`50 ~ 120`
- **特别追求速度**：再往下压，但不建议直接 0

#### 当前建议
保持：

```json
"slowMo": 120
```

很合理。

---

### `waitMailAttempts`
等验证码邮件最多轮询多少次。

当前是：

```json
18
```

### `waitMailIntervalMs`
每次轮询间隔多少毫秒。

当前是：

```json
5000
```

二者组合后，当前最大等待时间约为：

- `18 * 5s = 90s`

#### 建议
如果 Dreamina 邮件经常不是秒到，90 秒比 60 秒稳得多。

#### 当前建议
保持：

```json
"waitMailAttempts": 18,
"waitMailIntervalMs": 5000
```

如果后面仍偶发晚到，再考虑加到 20 次或拉长间隔。

---

### `dreaminaMaxRecoveries`
Dreamina 页面异常恢复次数上限。

当前是：

```json
3
```

用于处理：

- `Something went wrong`
- `Refresh` 弹窗
- 页面打开后异常状态恢复

#### 建议
- **保守稳妥**：`2 ~ 3`
- **页面经常抖动**：可试 `4`
- 太高没意义，容易浪费时间

#### 当前建议
保持：

```json
3
```

---

### `dreaminaRecoveryBonusMs`
每次发生 Dreamina 异常恢复后，额外顺延等待时长。

当前是：

```json
15000
```

含义：
- 页面刚恢复后，再多给 15 秒缓冲观察

#### 建议
- `10000 ~ 20000` 都正常
- 当前值合理

#### 当前建议
保持：

```json
15000
```

---

### `windowLayout`
窗口布局模式。

当前是：

```json
"grid"
```

当前 `runner.js` 里主要按网格计算窗口摆放，这个字段更偏配置语义，当前实现层面基本就是走 grid 思路。

#### 建议
保留即可：

```json
"windowLayout": "grid"
```

---

### `windowGap`
多窗口之间的间距。

当前是：

```json
12
```

### `windowMargin`
屏幕边缘留白。

当前是：

```json
8
```

这两个参数主要影响你看窗口时是否重叠得太难受。

#### 建议
- 并发低：默认即可
- 并发高：可以适当增大一点 gap

#### 当前建议
保持：

```json
"windowGap": 12,
"windowMargin": 8
```

---

### `resultsDir`
结果输出目录。

当前是：

```json
"results"
```

#### 建议
保持默认。

除非你想按批次区分结果，否则不建议频繁改。

---

## 7. 推荐配置模板

## 7.1 排障优先模板（推荐你现在先用这个）

```json
{
  "proxyPolicy": "roundRobin",
  "maxProxyRetriesPerAccount": 3,
  "concurrency": 2,
  "proxyPrecheckConcurrency": 40,
  "headless": false,
  "slowMo": 120,
  "waitMailAttempts": 18,
  "waitMailIntervalMs": 5000,
  "dreaminaMaxRecoveries": 3,
  "dreaminaRecoveryBonusMs": 15000,
  "windowLayout": "grid",
  "windowGap": 12,
  "windowMargin": 8,
  "resultsDir": "results"
}
```

适合：

- 当前仍在调脚本
- 需要容易复盘
- 想看清每一步

---

## 7.2 稳定批跑模板

```json
{
  "proxyPolicy": "random",
  "maxProxyRetriesPerAccount": 3,
  "concurrency": 4,
  "proxyPrecheckConcurrency": 40,
  "headless": false,
  "slowMo": 80,
  "waitMailAttempts": 18,
  "waitMailIntervalMs": 5000,
  "dreaminaMaxRecoveries": 3,
  "dreaminaRecoveryBonusMs": 15000,
  "windowLayout": "grid",
  "windowGap": 12,
  "windowMargin": 8,
  "resultsDir": "results"
}
```

适合：

- 已经跑通过多轮
- 代理质量较稳
- 机器性能还行

---

## 8. 常见故障与排查顺序

## 8.1 代理预检失败
优先看：

- `results/runner-precheck.txt`
- `results/run-log.txt`

确认：

- 出口 IP 是否正常
- Firstmail 登录页是否落在预期页面
- 是否被跳转到异常页 / 拦截页

---

## 8.2 Dreamina 打不开或入口找不到
优先看：

- `screenshots/`
- `task-register.js` 中的登录入口定位逻辑

重点检查：

- 按钮文案是否变了
- 页面是否先出现弹层
- 是否出现 `Something went wrong`
- 当前页面 URL 是否已经偏离预期

---

## 8.3 邮件收不到 / 验证码提取失败
优先看：

- 邮件轮询次数是否太少
- Firstmail 列表结构是否变化
- 邮件正文里的验证码模板是否变化

必要时提高：

- `waitMailAttempts`
- `waitMailIntervalMs`

---

## 8.4 辅助功能误伤主流程
例如窗口摆放、截图、日志之类。

原则上：

> 辅助逻辑失败，应该记录警告，不应打崩注册主流程。

最近已修复一个典型问题：

- `browser.process is not a function`
- 原因是摆窗逻辑默认假设 `browser.process()` 一定存在
- 现已改为兼容判断，拿不到 PID 时仅跳过二次摆窗

---

## 9. 推荐使用习惯

建议你平时按这个顺序操作：

1. 先准备 `accounts.txt`、`proxies.txt`、`config.json`
2. 先用 1~2 并发试跑少量账号
3. 确认流程稳定后，再逐步提高并发
4. 每次失败先看 `results/run-log.txt`
5. 再看 `screenshots/`
6. 最后结合 `runner-precheck.txt` 判断是否是代理问题
7. 修完脚本后直接重新跑，让 `accounts-done.txt` 自动跳过已成功账号

---

## 10. 当前最值得记住的结论

### 结论 1
`runner.js` 是批量调度入口，日常启动基本都从这里开始。

### 结论 2
`task-register.js` 是主要高频改动点；只要页面结构、文案、验证码链路变化，优先改这里。

### 结论 3
`results/run-log.txt` 是排障第一入口；不要只盯控制台最后一句报错。

### 结论 4
当前推荐配置是排障优先配置，不是暴力提速配置。

### 结论 5
如果近期还在修流程，最稳的方向是：

- `proxyPolicy = roundRobin`
- `concurrency = 2`
- `headless = false`
- `slowMo = 120`
- `waitMailAttempts = 18`

---

## 11. 建议的下一步

如果你准备继续把这个项目做稳，建议下一步优先做这三件事：

1. 把 `config.json` 的有效字段和未接入字段梳理清楚
2. 给 `results/` 和 `screenshots/` 增加按批次归档能力，避免长跑后结果过乱
3. 给常见失败类型补更明确的错误码和截图命名规范

---

如果后续目录结构或流程有变化，记得同步更新这个 README，避免“代码已经变了，文档还是旧的”。
