# shared-verification

框架层 | S3 验证码提交阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 验证码提交阶段的入参校验、重试调度、耗时统计 | Dreamina 专属选择器与 Firstmail API 调用（→ Dreamina/0.0.3/S3-verification）|
| 将 adapter 返回值归一化为标准 StageResult | 邮件 API 轮询实现（→ shared-utils/firstmail-api.js）|
| 统一的日志格式化输出 | 其他阶段 |

## 目录结构

```
shared-verification/
├── README.md
└── verification-submit.js  ← 阶段调度主链（runVerificationSubmitStage）
```

## Dreamina 运行内容

Dreamina 专属的 adapter + profiles 已迁至：
```
Dreamina/0.0.3/S3-verification/
├── verification-adapter.js
└── profiles/
```

## 关系

```
Dreamina-register.js
  └─ runVerificationSubmitStage({ adapter: dreaminaVerificationAdapter, ... })
       └─ Dreamina/0.0.3/S3-verification/verification-adapter.js
            └─ shared-utils/firstmail-api.js（验证码拉取）
```
