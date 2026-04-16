# shared-credential

框架层 | S2 凭据提交阶段调度器

## 职责

| 负责 | 不负责 |
|------|--------|
| 凭据提交阶段的入参校验、重试调度、耗时统计 | 具体的页面操作与选择器（→ Dreamina/0.0.3/S2-credential）|
| 将 adapter 返回值归一化为标准 StageResult | 账号管理与代理选取 |
| 统一的日志格式化输出 | 其他阶段（entry / verification / profile 等）|

## 目录结构

```
shared-credential/
├── README.md
└── credential-submit.js    ← 阶段调度主链（runCredentialSubmitStage）
```

## Dreamina 运行内容

Dreamina 专属的 adapter + profiles 已迁至：
```
Dreamina/0.0.3/S2-credential/
├── credential-adapter.js
└── profiles/
```

## 关系

```
Dreamina-register.js
  └─ runCredentialSubmitStage({ adapter: dreaminaCredentialAdapter, ... })
       └─ Dreamina/0.0.3/S2-credential/credential-adapter.js
```
