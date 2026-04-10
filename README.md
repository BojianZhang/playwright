# playwright

基于 **Playwright + 代理 + Firstmail API** 的 Dreamina 批量注册与自动化执行项目。

当前版本：**v1.0.1**

---

## 1. 项目简介

本项目用于按配置批量执行 Dreamina 注册流程，覆盖以下环节：

- 读取账号与代理列表
- 执行代理可用性预检
- 打开 Dreamina 注册页面
- 自动填写邮箱、密码、验证码与生日信息
- 通过 Firstmail API 轮询最新邮件并提取验证码
- 保存登录态、session 与运行结果
- 输出失败原因、截图、日志与代理质量分层结果

仓库当前包含两类能力：

1. **批量运行主流程**：用于真实任务执行
2. **Playwright 测试与调试脚本**：用于页面验证、选择器验证与单点排障

---

## 2. 当前版本

- 发布版本：`v1.0.1`
- package 版本：`1.0.1`
- 常用开发分支：`dev`

建议优先查看最新 tag 或 release。

---

## 3. 技术栈

- Node.js
- Playwright
- PowerShell（用于清理脚本与窗口辅助脚本）
- Firstmail API（用于验证码邮件轮询）
- HTTP / HTTPS CONNECT 代理请求

---

## 4. 核心能力

### 4.1 批量账号调度

主入口为 `runner.js`，负责：

- 读取账号、代理与配置
- 创建结果目录
- 跳过已完成账号
- 控制并发
- 分配代理
- 执行代理预检
- 调用真实注册任务
- 汇总执行结果与失败原因

### 4.2 Dreamina 自动注册

主执行逻辑位于 `task-register.js`，负责：

- 打开页面
- 处理弹层与异常提示
- 进入邮箱注册流程
- 提交邮箱与密码
- 等待验证码阶段
- 回填验证码
- 处理生日填写
- 保存登录态与 session 信息

### 4.3 Firstmail 验证码轮询

`firstmail-api.js` 负责：

- 调用 Firstmail API 获取最新邮件
- 在无邮件时持续轮询
- 从邮件内容中提取验证码
- 为主流程提供统一的拉码能力

### 4.4 代理预检与分层

`proxy-precheck.js` 及主流程中的预检逻辑负责：

- 测试代理对目标地址的可达性
- 获取出口 IP
- 将代理分层为 `OK / WEAK / BAD`
- 提升主流程的稳定性

### 4.5 调试与测试

仓库保留了 `tests/` 与 Playwright 测试配置，用于：

- 页面调试
- 登录流程验证
- 选择器验证
- 临时实验与回归测试

这部分不等同于批量主流程，但对开发与排障有直接价值。

---

## 5. 项目结构

当前仓库的主要结构如下：

```text
D:\playwright
├─ accounts.txt                      # 账号输入（本地敏感文件，默认不提交）
├─ proxies.txt                       # 代理输入（本地敏感文件，默认不提交）
├─ config.json                       # 运行配置
├─ package.json                      # 项目依赖与脚本
├─ package-lock.json                 # 依赖锁文件
├─ README.md                         # 项目说明
├─ runner.js                         # 批量任务主入口
├─ task-register.js                  # Dreamina 注册主流程
├─ firstmail-api.js                  # Firstmail 邮件轮询与验证码提取
├─ proxy-precheck.js                 # 代理预检脚本
├─ logger.js                         # 日志输出封装
├─ dreamina-login.js                 # 调试/辅助脚本
├─ firstmail-dreamina-signup.js      # 调试/辅助脚本
├─ playwright.config.ts              # Playwright 配置
├─ reset-results.ps1                 # 清理运行产物
├─ window-layout.ps1                 # 浏览器窗口布局辅助
├─ tests/                            # Playwright 测试与实验脚本
├─ results/                          # 主流程结果输出目录
├─ screenshots/                      # 截图输出目录
├─ storage/                          # 登录态与用户状态输出目录
├─ test-results/                     # Playwright 测试输出目录
└─ node_modules/                     # 依赖安装目录（安装后生成）
```

说明：

- `results/`、`screenshots/`、`storage/`、`test-results/` 为**运行产物目录**
- `node_modules/` 为**安装产物目录**
- 以上目录通常不应提交到 Git 仓库

---

## 6. 输入文件说明

### 6.1 `accounts.txt`

账号输入文件，支持类似格式：

```txt
aaa@example.com----123456
bbb@example.com:abcdef
```

程序会解析出：

- 邮箱
- 密码
- 原始行内容（用于跳过已完成账号）

### 6.2 `proxies.txt`

代理输入文件，常见格式：

```txt
host:port:username:password
```

### 6.3 `config.json`

运行配置文件，主要控制：

- 并发数
- 代理策略
- 代理预检目标
- 超时参数
- Firstmail API 参数
- 浏览器行为
- 输出目录
- 窗口布局

---

## 7. 主流程

整体执行链路如下：

```text
accounts.txt / proxies.txt / config.json
                ↓
            runner.js
                ↓
      为每个账号分配 worker + proxy
                ↓
         代理预检（目标连通性 + 出口 IP）
                ↓
         task-register.js 执行真实注册
                ↓
打开 Dreamina → 提交邮箱密码 → 拉取验证码 → 回填验证码和生日 → 等待登录完成
                ↓
保存 storage / session / 成功记录 / 失败记录 / 截图 / 日志
```

---

## 8. 安装

在项目目录下执行：

```powershell
npm install
```

首次使用 Playwright 时，可按需安装浏览器依赖：

```powershell
npx playwright install
```

---

## 9. 常用命令

### 9.1 启动主流程

```powershell
npm run start
```

或：

```powershell
npm run run
```

### 9.2 单独执行代理预检

```powershell
npm run precheck
```

### 9.3 清理运行产物

```powershell
npm run reset
```

### 9.4 清理运行产物与测试报告

```powershell
npm run reset:all
```

### 9.5 执行 Playwright 测试

```powershell
npm run test
```

### 9.6 以可视模式执行测试

```powershell
npm run test:headed
```

### 9.7 查看 Playwright 报告

```powershell
npm run report
```

---

## 10. 输出目录说明

### `results/`

用于保存主流程结果，例如：

- 成功账号
- 失败账号
- 运行日志
- 代理预检结果
- session 输出
- storage 文件映射

### `screenshots/`

用于保存失败现场截图、关键流程截图与异常恢复截图。

### `storage/`

用于保存账号级登录态与用户状态文件，便于：

- session 提取
- 登录态复用
- 故障复盘

### `test-results/`

用于保存 Playwright 测试输出结果。

---

## 11. 配置建议

建议重点关注以下参数：

- `concurrency`
- `maxProxyRetriesPerAccount`
- `proxyConnectivityTimeoutMs`
- `waitMailIntervalMs`
- `firstmailApiMaxPollAttempts`
- `verificationCountdownWaitMs`
- `birthdayStageTimeoutMs`
- `headless`
- `slowMo`

如果验证码到达较慢，优先调整：

- `firstmailApiMaxPollAttempts`
- `waitMailIntervalMs`

如果代理质量不稳定，优先调整：

- `proxyConnectivityTimeoutMs`
- 代理预检目标
- 并发数

---

## 12. 排障建议

建议按以下顺序排查：

1. `results/run-log.txt`
2. `results/failed.txt`
3. `results/runner-precheck.txt`
4. `screenshots/`
5. `storage/`
6. `results/sessions.txt`
7. `results/sessions-with-country.txt`

优先确认失败发生在哪个阶段：

- 代理预检失败
- 页面打开失败
- 注册入口未命中
- 验证码页未正常出现
- Firstmail 未取到邮件
- 验证码输入后无法进入生日页
- 登录完成但 session 未成功落地

---

## 13. 安全与仓库管理

以下内容通常属于本地敏感数据，**不应直接公开提交**：

- `accounts.txt`
- `proxies.txt`
- `user.json`
- 各类真实账号 session / storage 文件
- API Key、代理口令、账号密码

当前仓库已通过 `.gitignore` 忽略部分敏感文件与运行产物，但提交前仍建议手动检查：

```powershell
git status
```

---

## 14. Git 工作流建议

建议分支策略：

- `main`：稳定主线
- `dev`：日常开发线

建议提交前缀：

- `feat:` 新功能
- `fix:` 问题修复
- `refactor:` 重构
- `docs:` 文档更新
- `chore:` 配置、脚本与整理
- `test:` 测试相关

版本发布建议：

- 提交代码后更新版本号
- 打 tag，例如 `v1.0.1`
- 按需创建 GitHub Release

---

## 15. 维护说明

本 README 主要用于：

1. 快速说明仓库用途与核心入口
2. 为后续维护提供配置、运行与排障索引

如果主流程、目录结构或测试体系发生变化，建议同步更新本文件，避免文档与实现脱节。
