# shared-entry

框架层 | S1 入口页健康检查阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 入口页健康检查的阶段调度、重试、耗时统计 | Dreamina 专属选择器与交互（→ Dreamina/0.0.3/S1-entry）|
| 通用白屏检测 / 死页检测 / 页面重建骨架（site-entry-health.js） | 其他阶段（credential / verification 等）|
| 将 adapter 返回值归一化为标准 StageResult | 代理管理与账号管理 |

## 目录结构

```
shared-entry/
├── README.md
├── site-entry-health.js        ← 通用入口页健康检查骨架（白屏/死页/重建）
└── entry.js                ← 阶段调度主链（runEntryStage）
```

## Dreamina 运行内容

Dreamina 专属的 adapter + profiles 已迁至：
```
Dreamina/0.0.3/S1-entry/
├── adapter.js              ← 入口页覆层检测 adapter
├── entry-adapter.js        ← 入口页时间线信号 adapter
├── load-site-profile.js
└── profiles/
```

## 关系

```
Dreamina-register.js
  └─ runEntryStage({ adapter: dreaminaEntrySiteAdapter, ... })
       └─ Dreamina/0.0.3/S1-entry/adapter.js
       └─ Dreamina/0.0.3/S1-entry/entry-adapter.js
```