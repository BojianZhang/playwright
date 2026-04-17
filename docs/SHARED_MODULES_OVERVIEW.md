# shared-* 模块职责总览

> **定位**：本文件是 `D:\playwright\shared-*` 11 个公共模块的职责索引。  
> 每个 shared-* 模块只提供**阶段骨架（stage orchestrator）**，不包含任何平台（Dreamina 等）代码。  
> 更新时间：2026-04-17

---

## 模块一览表

| 模块目录 | 对应阶段 | 核心职责 | 平台适配点 |
|----------|----------|---------|-----------|
| `shared-proxy-precheck/` | S0 | 代理连通性检测、出口 IP 获取、速度分级（FAST/NORMAL/SLOW） | `adapter.js` 提供目标 URL / 健康判定 |
| `shared-entry/` | S1 | 入口页打开、健康检查（白屏/超时/dead-page 识别）、登录入口定位 | `adapter.js` 提供页面信号 / 入口元素 / URL |
| `shared-credential/` | S2 | 邮箱+密码填写、表单提交、提交后状态等待 | `adapter.js` 提供 input 定位器 / submit 按钮 / 结果信号 |
| `shared-verification/` | S3 | 验证码等待获取（Firstmail API）、填写、超时重发（resend-on-timeout） | `adapter.js` 提供 code input 定位器 / resend 触发器 |
| `shared-profile-completion/` | S4 | 注册后资料补全（生日/用户名等）、跳过/完成检测 | `adapter.js` 提供各字段定位器 |
| `shared-post-auth-ready/` | S5 | 登录后应用就绪状态确认（API 握手/页面信号等待） | `adapter.js` 提供就绪信号判定 |
| `shared-account-delivery/` | S6 | 账号最终交付（Session 保存、Cookie 提取、结果包装） | `adapter.js` 提供 Session 存储方式 |
| `shared-batch-orchestration/` | 调度框架 | 并发 Worker 管理、任务队列、代理互斥锁、Worker 状态追踪 | 无 adapter，纯调度逻辑 |
| `shared-browser-runtime/` | 框架 | Playwright Browser + Context + Page 创建、用户代理/指纹配置 | 通过 options 注入代理/UA 等参数 |
| `shared-window-layout/` | 框架 | 多浏览器窗口并发布局计算（cols×rows / scale / gap）、JSON Profile 加载 | 无 adapter |
| `shared-utils/` | 工具层 | 日志、计时、配置读取/诊断、文件操作、Firstmail API、Playwright locator 工具 | 无 adapter，零平台依赖 |

---

## 依赖关系约束

```
shared-utils          ← 所有人可引用，但它本身不引用任何 shared-* 兄弟模块
shared-window-layout  ← 不依赖 shared-browser-runtime
shared-browser-runtime ← 可引用 shared-utils，不引用 Dreamina/
shared-batch-orchestration ← 可引用 shared-utils、shared-browser-runtime
shared-Sn-*/           ← 各阶段骨架可引用 shared-utils，不引用其他阶段骨架
Dreamina/0.0.3/        ← 可引用所有 shared-*
```

**禁止的引用方向**：
- `shared-*` 不得 `require('../../Dreamina/...')`
- `shared-utils` 不得 `require('../shared-browser-runtime/...')`
- 各阶段 `shared-*` 不得跨阶段直接 `require`（只能通过 batch-runner 串联）

---

## 扩展规则

新增 shared-* 模块时：
1. 在 `shared-xxx/` 下创建目录
2. 必须新建 `README.md`（包含：职责、负责/不负责表、export 清单）
3. 更新本文件（`docs/SHARED_MODULES_OVERVIEW.md`）中的一览表
4. 更新 `README.md`（根目录）中的目录结构说明

---

## 各模块文档链接

| 模块 | README |
|------|--------|
| `shared-utils` | [shared-utils/README.md](../shared-utils/README.md) |
| `shared-browser-runtime` | [shared-browser-runtime/README.md](../shared-browser-runtime/README.md) |
| `shared-window-layout` | [shared-window-layout/README.md](../shared-window-layout/README.md) |
| `shared-proxy-precheck` | [shared-proxy-precheck/README.md](../shared-proxy-precheck/README.md) |
| `shared-entry` | [shared-entry/README.md](../shared-entry/README.md) |
| `shared-credential` | [shared-credential/README.md](../shared-credential/README.md) |
| `shared-verification` | [shared-verification/README.md](../shared-verification/README.md) |
| `shared-profile-completion` | [shared-profile-completion/README.md](../shared-profile-completion/README.md) |
| `shared-post-auth-ready` | [shared-post-auth-ready/README.md](../shared-post-auth-ready/README.md) |
| `shared-account-delivery` | [shared-account-delivery/README.md](../shared-account-delivery/README.md) |
| `shared-batch-orchestration` | [shared-batch-orchestration/README.md](../shared-batch-orchestration/README.md) |
