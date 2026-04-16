# D:\playwright\docs — 分析与备注索引

> 规范：**所有分析输出、架构备注、差距比对、设计决策记录**统一存放于此目录。
> 文件命名格式：`YYYY-MM-DD-<主题>.md`

---

## 文件清单

| 文件名 | 日期 | 内容摘要 |
|--------|------|---------|
| [project_analysis.md](./project_analysis.md) | 2026-04-15 | 项目整体分析：技术栈、模块结构、老架构能力概览 |
| [architecture_analysis.md](./architecture_analysis.md) | 2026-04-15 | 新旧架构对比：shared-* 新架构 vs runner.js 老架构的职责划分纠正 |
| [2026-04-16-arch-gap-analysis.md](./2026-04-16-arch-gap-analysis.md) | 2026-04-16 | 新架构（0.0.3）与老架构（v0.0.2）差距分析：缺失 config.json、代理互斥锁、热剔除、失败分类等 P0/P1 问题清单 |
| [2026-04-16-comprehensive-analysis.md](./2026-04-16-comprehensive-analysis.md) | 2026-04-16 | **全项目综合分析**：框架层 15 项能力缺口、评分矩阵、P0~P2 行动优先级 |

---

## 当前架构状态（2026-04-16）

```
D:\playwright\
├── shared-*/              ← 框架层（11个模块，S0~S6 调度骨架）
├── Dreamina/
│   ├── 0.0.3/             ← 新架构运行包（当前主力）
│   │   ├── Sn-*/          ← 各阶段业务 adapter + profiles
│   │   ├── Dreamina-register.js      ← 单次注册协调器
│   │   ├── Dreamina-batch-runner.js  ← 批量并发入口
│   │   ├── batch-results/            ← 批量结果归档
│   │   ├── session-records/          ← Session 详细日志
│   │   ├── local-accounts.json       ← 账号输入
│   │   ├── proxy-health.json         ← 代理健康状态
│   │   └── bad-proxies.txt           ← 代理黑名单
│   ├── Dreamina-batch-runner.js  ← 入口转发（→ 0.0.3/）
│   └── history/v0.0.2/           ← 老架构归档
└── docs/                  ← 本目录：分析 & 备注
```

## 已知差距（待处理）

参见 [2026-04-16-arch-gap-analysis.md](./2026-04-16-arch-gap-analysis.md) 完整清单。

**P0 优先级（直接影响生产运行）：**
- [ ] 补充 `config.json` 全局运行时配置
- [ ] 补充 `proxies.txt` 生产代理池
- [ ] 实现代理互斥锁（Proxy Mutex）
- [ ] 实现运行时代理热剔除

**P1 优先级（影响稳定性）：**
- [ ] 失败账号输出文件（failed.txt / existed.txt）
- [ ] accounts.txt 文本格式支持
- [ ] 失败类型分类（业务失败 vs 技术失败）
