# shared-window-layout

框架层 | 窗口布局计算与并发策略

## 职责

| 负责 | 不负责 |
|------|--------|
| 从 JSON Profile 加载布局配置 | 浏览器启动（→ shared-browser-runtime）|
| 按并发数计算每个 Worker 的窗口坐标（x/y/width/height） | 资源拦截 / 指纹 |
| Grid / Focus / Compact / Monitor 模式布局算法 | 站点业务逻辑 |
| 按并发量解析验证码预算策略（verificationBudget） |  |
| 按并发量解析代理超时策略（proxyPolicy） |  |

## 目录结构

```
shared-window-layout/
├── index.js                        ← 统一导出入口
├── profile-loader.js              ← JSON Profile 读取（I/O 层）
├── planner.js                     ← 布局计算算法（computeWorkerWindowLayout）
├── policy.js                      ← 按并发解析验证码/代理策略
└── window-layout-profile.json     ← 当前默认布局配置文件
```

## 关系

```
Dreamina-batch-runner.js
  └─ createWindowLayoutPlanner()       ← 此框架
       └─ planner.resolve(workerId, concurrency)
            └─ 返回 windowLayout 对象（x/y/width/height/viewport）
                   ↓
       shared-browser-runtime/create-browser-runtime.js
```
