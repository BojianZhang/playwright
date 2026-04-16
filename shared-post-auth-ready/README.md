# shared-post-auth-ready

框架层 | S5 登录后就绪检测阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 登录后就绪检测的入参校验、重试调度、耗时统计 | Dreamina 专属 ready 信号检测（→ Dreamina/0.0.3/S5-post-auth-ready）|
| 将 adapter 返回值归一化为标准 StageResult | 其他阶段 |
| 统一的日志格式化输出 |  |

## 目录结构

```
shared-post-auth-ready/
├── README.md
└── post-auth-ready.js      ← 阶段调度主链（runPostAuthReadyStage）
```

## Dreamina 运行内容

Dreamina 专属的 adapter + profiles 已迁至：
```
Dreamina/0.0.3/S5-post-auth-ready/
├── post-auth-ready-adapter.js
└── profiles/
```