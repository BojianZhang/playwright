# shared-browser-runtime

框架层 | Playwright 浏览器实例创建

## 职责

| 负责 | 不负责 |
|------|--------|
| Browser + Context + Page 完整实例创建 | 窗口布局计算（→ shared-window-layout）|
| 浏览器指纹随机化（UA / viewport / locale / timezone） | 批次调度（→ shared-batch-orchestration）|
| 资源拦截策略（image / media / font） | 站点业务逻辑（→ Dreamina/0.0.3/Sn-*）|
| 窗口位置参数注入（消费 shared-window-layout 结果） |  |

## 目录结构

```
shared-browser-runtime/
├── index.js                    ← 统一导出入口
├── create-browser-runtime.js  ← 总装入口（createBrowserRuntime）
├── fingerprint.js             ← 指纹策略（UA池 / viewport池 / locale / timezone）
├── resource-policy.js         ← 资源拦截策略
└── window-runtime.js          ← 将 windowLayout 转换为 Chromium 启动参数
```

## 关系

```
shared-window-layout  →  computeWorkerWindowLayout()  →  windowLayout 对象
                                                              ↓
                                              shared-browser-runtime/create-browser-runtime.js
                                                              ↓
                                              browser + context + page
```
