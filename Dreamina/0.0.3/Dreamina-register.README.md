# Dreamina-register.README.md
# Dreamina/0.0.3 — 核心模块说明

> 文件定位：`Dreamina/0.0.3/Dreamina-register.js`
>
> Dreamina 注册流程的核心协调器（Register Orchestrator）。
> 它由 `Dreamina-batch-runner.js` 调用，每个 Worker 进程执行一次完整的 S0→S6 注册链。

---

## 模块职责

| 职责 | 说明 |
|------|------|
| **协调** | 按顺序调用 S0~S6 各阶段框架层函数，将 adapter 注入其中 |
| **状态管理** | 维护当前 Worker 的 stage / step 实时状态，驱动 worker-status-tracker |
| **结果收口** | 将各阶段结果归一化，最终输出 RegisterFlowResult 结构 |
| **数据文件** | 读写 local-accounts.json / proxy-health.json / bad-proxies.txt |

**不负责：**
- 具体页面操作 / DOM 选择器（由 Sn-*/adapter.js 负责）
- 并发调度（由 Dreamina-batch-runner.js 负责）
- 浏览器实例创建（由 shared-browser-runtime 负责）

---

## 主函数

### `runDreaminaRegisterFlow(options)`

单次完整注册流程入口。

| 参数字段 | 类型 | 说明 |
|---------|------|------|
| `account` | object | `{ email, password }` — 当前要注册的账号 |
| `proxy` | object | `{ server, username, password }` — 代理配置 |
| `workerId` | number | Worker 编号（1-based），用于日志标识 |
| `runtime` | object | 运行时可选配置（如 headed / slowMo / windowLayout 等）|
| `windowLayout` | object | 由 shared-window-layout 计算的窗口坐标 |

**返回值 `RegisterFlowResult`：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 整个注册流程是否成功（S6 交付阶段完成） |
| `stage` | string | 流程终止时所处的阶段（如 `credential-submit`） |
| `state` | string | 终止时的状态枚举码（如 `CREDENTIAL_SUBMIT_OK`） |
| `reason` | string | 失败原因码（成功时与 state 相同） |
| `nextStage` | string | 成功时下一阶段名称（通常为空，表示链路已完成） |
| `detail` | object | 各阶段详细结果对象（含 timingBreakdown 等） |

---

### `loadLocalAccounts(options)`

从 `local-accounts.json` 读取账号列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.filePath` | string | 可选，覆写默认路径（默认 `__dirname/local-accounts.json`）|

**返回：** `Array<{ email: string, password: string }>`

---

### `createDreaminaCliRuntime(config)`

根据 config.json 配置构建运行时参数对象。

| 参数字段 | 类型 | 说明 |
|---------|------|------|
| `headed` | boolean | 是否有头模式（true = 显示浏览器窗口）|
| `slowMo` | number | 每个操作延迟（ms），用于调试 |
| `blockedResourceTypes` | string[] | 要拦截的资源类型（默认 image/media/font）|

---

## 数据文件说明

| 文件 | 读/写 | 说明 |
|------|-------|------|
| `local-accounts.json` | 只读 | 本次批量运行的账号输入列表 |
| `registered-accounts.json` | 写 | 成功注册的账号持久化存档 |
| `proxy-health.json` | 读写 | 代理健康状态记录（由 proxy-health-store 管理）|
| `bad-proxies.txt` | 写 | 硬失败代理黑名单，批量启动时过滤 |
| `batch-results/` | 写 | 每次批量运行的结果汇总（JSONL + TXT）|
| `session-records/` | 写 | 每次批量运行的详细 Session 日志 |

---

## 注册阶段链路 (S0 → S6)

```
S0  proxy-precheck        代理可达性与目标站点探测
  ↓
S1  entry                 Dreamina 首页健康检查 + ready 确认
  ↓
S2  credential-submit     邮箱 + 密码填写并提交注册表单
  ↓
S3  verification-submit   拉取 Firstmail 验证码并提交
  ↓
S4  profile-completion    填写用户名 + 生日等资料
  ↓
S5  post-auth-ready       等待登录后首屏 ready 信号
  ↓
S6  account-delivery      将注册成功账号写入 registered-accounts.json
```
