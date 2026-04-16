# S1-entry — 阶段说明

**文件位置**：`Dreamina/0.0.3/S1-entry/`
**阶段标识**：`S1`
**阶段名称**：首页入口（Entry）

---

## 一、职责边界（BOUNDARY）

| | 说明 |
|---|---|
| ✅ 负责 | 打开 / 校正 Dreamina 入口页，完成页面 ready 判断 |
| ✅ 负责 | 入口页健康检查（白屏 / 错误页 / 登录信号检测）|
| ✅ 负责 | staged wait：等待登录入口可点击状态 |
| ✅ 负责 | 点击首页 Sign in / Continue with email 按钮，完成入口切换 |
| ✅ 负责 | 阶段 1 失败分类（`classifyEntryFailure`）|
| ✅ 负责 | Dreamina 入口 overlay 预处理 |
| ❌ 不负责 | credential submit / verification / profile completion / post-auth |
| ❌ 不负责 | browser / context 创建，代理池调度 |
| ❌ 不负责 | runner 层调度与结果落盘 |

---

## 二、目录结构

```
S1-entry/
├── profiles/                         ← Dreamina 入口阶段静态配置
│   ├── dreamina-entry-profile.json   ← 程序读取的 profile（URL / 超时 / 信号 / overlay 规则）
│   ├── dreamina-entry-profile.md     ← 字段说明文档（维护者参考）
│   └── dreamina-entry-profile.example.md  ← 带行内注释的配置模板示例
│
├── log/                              ← 阶段日志模板与示例（供维护参考）
│   └── first-stage-login-log-examples.md
│
├── adapter.js                        ← S1 Dreamina 站点适配器（供 shared-entry 框架注入）
│                                       通过 shared-entry/site-entry-health.js 调用
│
├── entry-adapter.js                  ← S1 timeline adapter（完整入口流程实现）
│                                       通过 Dreamina-register.js 直接调用
│
├── README.md                         ← 本文件：S1 阶段说明
└── entry-adapter.md                  ← entry-adapter.js 的入参、方法签名与返回字段说明
```

---

## 三、核心文件说明

### `adapter.js`
Dreamina 站点适配层，实现 `shared-entry` 框架的 adapter 协议。

被调用方：`shared-entry/site-entry-health.js`（通过参数注入）以及 `Dreamina-register.js`。

主要职责：
- 首页 overlay 预处理（`preprocessOverlays`）
- 首页 ready 等待（`waitForDreaminaReady`）
- 入口页健康检查与失败分类（`classifyDreaminaEntryFailure`）
- 轻量恢复动作（`recoverDreaminaEntry`）

### `entry-adapter.js`
S1 完整入口流程实现（timeline adapter），由 `Dreamina-register.js` 直接调用。

主要职责：
- `openEntryPage`：打开并校正 Dreamina 入口页
- `checkEntryHealth`：入口页健康检查
- `runDreaminaEntryFlow`：主路径完整流程（打开 → overlay → 等待 sign-in → 点击 → 确认 gate）
- `waitForDreaminaLoginEntryReady`：legacy staged wait 路径（向下兼容保留）
- `classifyEntryFailure`：失败分类

### `profiles/dreamina-entry-profile.json`
程序读取的 Dreamina 入口配置。主要包含：
- 首页 URL（`entryUrl`）
- 导航超时与重试配置
- 页面 ready 信号（selector / text / url）
- overlay 规则（buttonNames / buttonNamePattern）
- 登录信号 staged wait 配置（`loginSignalStages`）
- 白屏 / 错误页 / dead page 识别规则

---

## 四、调用关系

```
Dreamina-register.js
  ├── require('./S1-entry/adapter')       → shared-entry/site-entry-health.js 框架层注入
  └── require('./S1-entry/entry-adapter') → runDreaminaEntryFlow 主路径直接调用

shared-entry/site-entry-health.js
  └── require('../Dreamina/0.0.3/S1-entry/adapter') → 站点 adapter 注入
```

---

## 五、一句话总结

S1-entry 是 Dreamina 注册流程的**首页入口阶段**：
打开 Dreamina 首页 → overlay 清理 → 等待 Sign in 可见 → 点击进入登录 gate → 确认进入 credential-submit 状态。
