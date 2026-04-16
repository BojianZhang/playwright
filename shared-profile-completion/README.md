# shared-profile-completion

框架层 | S4 资料完善阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 资料完善阶段的入参校验、重试调度、耗时统计 | Dreamina 专属选择器与用户名/生日填写（→ Dreamina/0.0.3/S4-profile-completion）|
| 将 adapter 返回值归一化为标准 StageResult | 生日逻辑计算（→ shared-utils/birthday.js）|
| 统一的日志格式化输出 | 其他阶段 |

## 目录结构

```
shared-profile-completion/
├── README.md
└── profile-completion-submit.js  ← 阶段调度主链（runProfileCompletionSubmitStage）
```

## Dreamina 运行内容

Dreamina 专属的 adapter + profiles 已迁至：
```
Dreamina/0.0.3/S4-profile-completion/
├── profile-completion-adapter.js
└── profiles/
```
