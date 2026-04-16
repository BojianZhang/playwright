# window-layout-profile.json 字段说明

> 文件定位：`shared-window-layout/window-layout-profile.json`
>
> 这是默认的窗口布局配置文件，由 `profile-loader.js` 读取，经 `planner.js` 计算后输出每个 Worker 的窗口坐标。
> JSON 本身无法写注释，本文件提供所有字段的完整含义说明。

---

## `display` — 屏幕环境配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `workspaceWidth` | number | 可用工作区总宽度（px），通常等于显示器分辨率宽度 |
| `workspaceHeight` | number | 可用工作区总高度（px），通常等于显示器分辨率高度 |
| `taskbarReservedPx` | number | 操作系统任务栏占用的高度（px），从底部扣除，不参与布局 |
| `gap` | number | 相邻窗口间的最小间距（px） |
| `outerMargin` | number | 布局区域距屏幕四边的外边距（px） |

---

## `defaults` — 布局默认值

| 字段 | 类型 | 说明 |
|------|------|------|
| `layoutMode` | string | 默认布局模式，可选 `focus` / `grid` / `compact` / `monitor` |
| `minWindowWidth` | number | 单个 Worker 窗口的最小宽度（px），防止窗口被压缩到不可操作 |
| `minWindowHeight` | number | 单个 Worker 窗口的最小高度（px） |
| `preferredAspectRatio` | number | 窗口期望宽高比（width/height），目前由 planner 参考，不强制约束 |
| `defaultScale` | number | 默认浏览器视口缩放比例（1.0 = 100%，< 1.0 表示缩放以增大内容密度）|
| `defaultUsageRatio` | number | 可用空间利用率（0~1），控制窗口铺满程度，留有边距用于视觉分隔 |
| `overflowPolicy` | string | Worker 数超过 presets 最大档位时的策略，`paginate` 表示按分页处理 |
| `maxAutoColumns` | number | 无匹配 preset 时，自动计算列数的上限 |

---

## `verificationBudgetByConcurrency` — 验证码预算策略（按并发量分档）

键为并发数字符串（如 `"4"` `"6"`），命中规则：取 `<= 当前并发数` 的最大档位，无匹配时用 `default`。

| 字段 | 类型 | 说明 |
|------|------|------|
| `firstmailApiMaxPollAttempts` | number | Firstmail API 最大轮询次数，越高并发越需要更多容忍度 |
| `waitMailIntervalMs` | number | 相邻两次轮询之间的基础等待时间（ms） |
| `verificationRetryMaxAttempts` | number | 验证码填写失败后的最大重试次数 |
| `verificationResendWaitMs` | number | 重新发送验证码后，开始拉取之前的等待时间（ms） |

---

## `proxyPolicyByConcurrency` — 代理探活策略（按并发量分档）

键规则同上（`<= 当前并发` 的最大档位）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `workerStartStaggerMs` | number | 多 Worker 启动时相邻 Worker 间的错开延迟（ms），降低并发启动冲突 |
| `connectivityTimeoutMs` | number | 代理基础 TCP 连通性探测超时（ms） |
| `primaryTargetTimeoutMs` | number | 主目标站点（如 Dreamina 首页）可达性探测超时（ms） |
| `secondaryTargetTimeoutMs` | number | 副目标站点可达性探测超时（ms） |
| `enableSecondaryTarget` | boolean | 是否启用副目标探测，false 时只检测主目标 |

---

## `modes` — 布局模式特性说明

| 模式 | 字段 | 说明 |
|------|------|------|
| `focus` | `prioritizeReadability` | 优先保证单窗口可读性，允许超出标准尺寸 |
| `focus` | `allowOversize` | 允许窗口尺寸超出格子限制 |
| `grid` | `prioritizeBalance` | 优先各窗口尺寸均衡，适合中等并发 |
| `compact` | `prioritizeDensity` | 优先塞入更多窗口，牺牲单窗口可读性 |
| `monitor` | `prioritizeVisibilityOverOperability` | 监控模式，只保证能看到状态，不保证可操作 |

---

## `presets` — 并发档位预设（键 = Worker 并发数）

每个 preset 键为字符串数字（如 `"6"`），当 `concurrency` 恰好匹配时直接使用；否则 planner 选取距离最近的档位。

| 字段 | 类型 | 说明 |
|------|------|------|
| `cols` | number | 列数，窗口横向排列的格子数 |
| `rows` | number | 行数，窗口纵向排列的格子数 |
| `scale` | number | 浏览器视口缩放比例（< 1.0 使视口内容更小，显示更多） |
| `mode` | string | 覆写该档位的布局模式（`focus` / `grid` / `compact` / `monitor`） |
| `usageRatio` | number | （可选）覆写该档位的空间利用率 |
| `gapOverride` | number | （可选）覆写该档位的窗口间距（px） |
| `outerMarginOverride` | number | （可选）覆写该档位的外边距（px） |
