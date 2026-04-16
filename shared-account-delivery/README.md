# shared-account-delivery

框架层 | S6 账号交付阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 账号交付阶段的入参校验、重试调度、耗时统计 | Dreamina 专属交付逻辑（→ Dreamina/0.0.3/S6-account-delivery）|
| 将 adapter 返回值归一化为标准 StageResult | 文件 I/O 的具体路径与格式（由 adapter 决定）|
| 统一的日志格式化输出 |  |

## 目录结构

```
shared-account-delivery/
├── README.md
└── account-delivery.js     ← 阶段调度主链（runAccountDeliveryStage）
```

## Dreamina 运行内容

Dreamina 专属的 adapter + profiles 已迁至：
```
Dreamina/0.0.3/S6-account-delivery/
├── account-delivery-adapter.js
└── profiles/
```