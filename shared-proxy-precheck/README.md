# shared-proxy-precheck

框架层 | S0 代理预检阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 代理可达性预检的阶段调度、重试、耗时统计 | 具体的 HTTP/HTTPS/TLS 探测实现（→ Dreamina/0.0.3/S0-proxy-precheck）|
| 将 adapter 返回值归一化为标准 StageResult（ProxyGrade: OK/WEAK/BAD） | Playwright 页面操作（预检不打开浏览器）|
| 本地代理列表加载的快捷入口（index.js） | 代理池调度与轮换（→ Dreamina-batch-runner.js）|

## 目录结构

```
shared-proxy-precheck/
├── README.md
├── index.js                    ← 本地调试快捷入口（读取本地代理 → 一次预检）
└── proxy-precheck.js       ← 阶段调度主链（runProxyPrecheckChain）
```

## Dreamina 运行内容

Dreamina 专属内容已迁至：
```
Dreamina/0.0.3/S0-proxy-precheck/
├── proxy-precheck-adapter.js   ← 实际 TCP/HTTP/HTTPS/TLS 探测实现
├── local-proxy-loader.js       ← 本地 proxies.txt 解析器
├── local-proxies.txt           ← 本地调试代理列表
├── proxy-health-store.js       ← 代理健康状态存储
├── proxy-health-store.json     ← 代理健康状态持久化
└── profiles/
```

## 关系

```
Dreamina-batch-runner.js / Dreamina-register.js
  └─ runProxyPrecheckChain({ adapter: dreaminaProxyPrecheckAdapter, ... })
       └─ Dreamina/0.0.3/S0-proxy-precheck/proxy-precheck-adapter.js
```
