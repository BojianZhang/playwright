# Dreamina Staged Architecture 字段契约与按阶段落地映射表

## 1. 文档目的

本文档用于统一 Dreamina staged architecture 在 S0~S6 各阶段中的结果字段语义、阶段产物边界与落地顺序，避免后续继续依赖“读代码猜字段”的方式维护主链。

适用范围：

- `shared-proxy-precheck`
- `shared-entry`
- `shared-credential`
- `shared-verification`
- `shared-profile-completion`
- `shared-post-auth-ready`
- `shared-account-delivery`
- `Dreamina-batch-runner`

本文档关注的是：

- 各阶段最终结果对象应该稳定暴露什么字段
- 这些字段分别表达“事实态”“原因码”“证据来源”“调试细节”中的哪一种语义
- 哪些字段应该作为跨阶段统一契约长期保留
- 哪些字段只适合放在 `detail` / trace / debug 结构中

---

## 2. 跨阶段统一字段契约

以下字段应作为 S0~S6 的公共主字段骨架。

| 字段 | 类型 | 语义 | 落地规则 |
|---|---|---|---|
| `success` | `boolean` | 该阶段最终是否通过 | 所有阶段必带 |
| `stage` | `string` | 当前阶段稳定标识 | 使用稳定 stage key，不混显示名 |
| `state` | `string` | 当前阶段原始事实态 | 表达“发生了什么”，不替代原因分类 |
| `reason` | `string` | 稳定可聚合原因码 | 表达“为什么被判成这个结果”，统计与报表优先用它 |
| `nextStage` | `string` | 下一阶段路由 | 仅在 finalize 后输出 |
| `source` | `string` | 当前主结论的主证据来源 | 建议后续与 `detectionSource` 二选一统一 |
| `signalStrength` | `string` | 结论信号强度 | 建议统一为 `strong / medium / weak` |
| `durationMs` | `number` | 当前阶段总耗时 | 所有阶段必带 |
| `detail` | `object` | 附加细节 | 默认不直接无限制扩张，后续应区分 stable detail 与 debug detail |

### 2.1 字段职责边界

#### `state`

- 表示阶段原始事实态
- 应尽量贴近运行过程中的真实结论
- 示例：
  - `PROXY_PRECHECK_OK`
  - `ENTRY_READY`
  - `CREDENTIAL_SUBMIT_OK`
  - `VERIFICATION_SUBMIT_OK`
  - `PROFILE_COMPLETION_SUBMIT_OK`
  - `REGISTRATION_COMPLETE`
  - `DELIVERY_COMPLETE`

#### `reason`

- 表示稳定、可聚合、适合统计的原因码
- 当前很多成功态下 `reason` 与 `state` 一致，这是允许的
- 但从长期演进看，`reason` 应优先服务于结果归因，而不是步骤展示

#### `source`

- 表示当前结论最主要的采信来源
- 只保留“主证据”即可，不承担完整 trace 的职责
- 完整观察轨迹应进入 `detail` 或 trace 对象

#### `detail`

- 用于承接补充信息，但不应成为“随便塞任何东西”的兜底垃圾桶
- 后续建议逐步区分：
  - `stableDetail`，稳定、可依赖、可跨版本消费
  - `debugDetail`，用于排障、回放、临时审计

在正式分层之前，至少应在每个阶段文档里明确 `detail` 内允许出现哪些稳定子结构。

---

## 3. 按阶段落地的字段映射表

---

### S0 `proxyPrecheck`

阶段职责：确认当前代理具备进入 Dreamina 注册主链的最低可用性。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 代理预检是否通过 | 必带 |
| `stage` | `string` | stage finalize | 固定为 `proxyPrecheck` | 必带 |
| `state` | `string` | `shared-proxy-precheck/stages/proxy-precheck.js` | 当前原始结果态，如 `PROXY_PRECHECK_OK` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `proxyGrade` | `string` | precheck profile + target checks | 代理质量等级 | 建议固定枚举，如 `OK/WARN/BAD` |
| `source` | `string` | stage finalize | 主证据来源，如 `target-checks` | 必带 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `detail.exitIpCheck` | `object` | adapter | 出口 IP 检查结果 | 建议稳定为标准子对象 |
| `detail.primaryTargetCheck` | `object` | adapter | Dreamina 主目标检查结果 | 建议稳定为标准子对象 |
| `detail.secondaryTargetCheck` | `object` | adapter | Dreamina 副目标检查结果 | 建议稳定为标准子对象 |

#### S0 特别说明

- `proxyGrade` 不应只是日志展示字段，后续应成为可消费的稳定业务字段。
- `detail` 内三类 target check 应尽量保持同构，避免不同目标返回风格不一致。

---

### S1 `entry`

阶段职责：把页面推进到“可进入 credential 提交”的入口可用态。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 是否成功进入入口 ready | 必带 |
| `stage` | `string` | stage finalize | 固定为 `entry` | 必带 |
| `state` | `string` | `shared-entry/stages/entry.js` | 原始成功态，如 `ENTRY_READY` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `nextStage` | `string` | stage finalize | 下一阶段，应为 `credential-submit` | 必带 |
| `source` | `string` | entry adapter / stage finalize | 主证据来源，如 `EMAIL_GATE_READY` | 必带 |
| `signalStrength` | `string` | stage finalize | 入口 ready 信号强度 | 必带 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `detail.entryHealth` | `object` | entry adapter | 页面健康状态检查结果 | 建议作为稳定子对象 |
| `detail.recoveryTrace` | `object/array` | entry adapter | 恢复动作与恢复触发轨迹 | 建议先作为 debug 子结构 |

#### S1 特别说明

- `ENTRY_READY` 的含义必须固定为“已经具备进入 credential 阶段的条件”，而不是“页面打开成功”或“Dreamina 首页可访问”。
- `source=EMAIL_GATE_READY` 应解释为“邮箱 gate / auth gate 已进入可交互态”。
- 当前 S1 是固定时延瓶颈，后续若补打点，建议围绕以下节点扩展 `detail.timing`：
  - `openEntryPage`
  - first URL stabilization
  - first entry CTA visible
  - first continue-with-email visible
  - first email input visible
  - recovery / overlay cleanup

---

### S2 `credential`

阶段职责：完成邮箱、密码填写与 credential 表单提交。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 凭证提交是否成功 | 必带 |
| `stage` | `string` | stage finalize | 固定为 `credential` | 必带 |
| `state` | `string` | stage / adapter | 原始成功态，如 `CREDENTIAL_SUBMIT_OK` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `nextStage` | `string` | stage finalize | 下一阶段，应为 `verification` | 必带 |
| `source` | `string` | submit confirmation | 主确认来源，如 `selector` | 必带 |
| `signalStrength` | `string` | stage finalize | 提交成功信号强度 | 建议保留 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `detail.stateTrace` | `array` | runtime | 阶段内步骤轨迹，如 `FORM_READY -> EMAIL_FILLED -> PASSWORD_FILLED -> FORM_SUBMITTED` | 建议稳定化 |
| `detail.formSignals` | `object` | adapter | 表单、按钮、跳转确认信号 | 建议稳定化 |
| `detail.settleStage` | `string` | finalize | 结果在哪一步被最终确认 | 建议补成正式字段 |

#### S2 特别说明

- S2 后续不应把所有中间动作都平铺到顶层结果对象，建议统一收进 `detail.stateTrace` 或 `detail.formSignals`。
- `settleStage` 对复杂失败排障很有价值，建议后续补正式化，而不是只靠日志看流程停在哪一步。

---

### S3 `verification`

阶段职责：拉取验证码、定位输入框、完成验证码输入并确认提交成功。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 验证码阶段是否成功 | 必带 |
| `stage` | `string` | stage finalize | 固定为 `verification` | 必带 |
| `state` | `string` | `shared-verification/stages/verification-submit.js` | 原始成功态，如 `VERIFICATION_SUBMIT_OK` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `nextStage` | `string` | stage finalize | 下一阶段，应为 `profile-completion` | 必带 |
| `source` | `string` | stage finalize | 最终确认主来源 | 必带 |
| `signalStrength` | `string` | stage finalize | 提交确认强度 | 必带 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `retryCount` | `number` | runtime | 重试次数，不含首次尝试 | 建议固定为正式字段 |
| `detail.provider` | `string` | code fetch | 验证码来源，如 `firstmail` | 建议稳定化 |
| `detail.matchMode` | `string` | code fetch | 邮件匹配策略，如 `recent-primary` | 建议稳定化 |
| `detail.stateChanged` | `boolean` | input step | 输入动作是否真实改变 DOM 值 | 建议稳定化 |
| `detail.retrySummary` | `array/object` | runtime | 每轮拉码/输入/确认摘要 | 建议拆稳定摘要与调试轨迹 |

#### S3 特别说明

- `retryCount` 应明确为“不含首次尝试”的补充次数，避免不同代码路径对次数定义不一致。
- `provider`、`matchMode`、`stateChanged` 对验证码长尾治理有直接价值，建议不要只留在日志中。
- S3 当前是主要波动长尾阶段，`detail.retrySummary` 后续值得作为重点结构化对象保留。

---

### S4 `profileCompletion`

阶段职责：生成资料填写计划，完成 birthday 等资料补全，并确认提交成功。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 资料补全是否成功 | 必带 |
| `stage` | `string` | stage finalize | 固定为 `profileCompletion` | 必带 |
| `state` | `string` | `shared-profile-completion/stages/profile-completion-submit.js` | 原始成功态，如 `PROFILE_COMPLETION_SUBMIT_OK` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `nextStage` | `string` | stage finalize | 下一阶段，应为 `post-auth-ready` | 必带 |
| `source` | `string` | submit confirm | 提交确认来源 | 必带 |
| `signalStrength` | `string` | finalize | 信号强度 | 建议保留 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `detail.planSource` | `string` | planner | 计划来源，如 `runtime-random-plan` | 建议稳定化 |
| `detail.flowMode` | `string` | adapter/stage | 当前主路径模式，如 `continuous` | 建议稳定化 |
| `detail.ageQualified` | `boolean` | planner | 是否满足年龄约束 | 建议稳定化 |
| `detail.stateTrace` | `array` | runtime | 如 `READY -> PLAN_READY -> BIRTHDAY_CONTINUOUS_FLOW_OK -> SUBMIT_OK` | 建议稳定化 |
| `detail.timing` | `object` | runtime | 关键步骤耗时，如 birthday continuous flow | 建议稳定化 |

#### S4 特别说明

- Dreamina 当前真实主路径应固定解释为 `continuous-flow`，split-flow 仅作为 bridge/fallback 语境保留。
- `ageQualified=true` 是业务约束，不是调试信息，后续应明确归为稳定字段。

---

### S5 `postAuthReady`

阶段职责：确认账号已经真正进入注册完成后的可交付状态。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 登录后可用态是否确认成立 | 必带 |
| `stage` | `string` | stage finalize | 固定为 `postAuthReady` | 必带 |
| `state` | `string` | stage / adapter | 原始成功态，如 `REGISTRATION_COMPLETE` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `nextStage` | `string` | stage finalize | 下一阶段，应为 `account-delivery` | 必带 |
| `source` | `string` | inspection/finalize | 最终主证据来源，如 `text` / `cookie` / `selector` | 必带 |
| `signalStrength` | `string` | finalize | 当前结论强度 | 必带 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `detail.initialSessionInspection` | `object` | adapter | 初始 session/storage/cookie 检查快照 | 建议稳定化 |
| `detail.sessionObservationTrace` | `array/object` | runtime | 观察期间的 session 变化轨迹 | 建议作为 debug 子结构 |
| `detail.sessionInspection` | `object` | finalize | 最终采信后的 session 结论 | 建议稳定化 |

#### S5 特别说明

- `initialSessionInspection`、`sessionObservationTrace`、`sessionInspection` 三者的边界需要明确：
  - `initialSessionInspection` = 进入阶段时的初始检查
  - `sessionObservationTrace` = 观察窗口内的变化轨迹
  - `sessionInspection` = 最终采信并用于推进下一阶段的正式结果
- 当前已确认“首次命中 hard session 即可提前收口”的优化方向有效，后续不应再默认保留冗余 observation tail。

---

### S6 `accountDelivery`

阶段职责：收口成最终交付对象，并写入批次/账号/session 相关产物。

| 字段 | 类型 | 来源 | 语义 | 落地建议 |
|---|---|---|---|---|
| `success` | `boolean` | stage finalize | 最终交付是否完成 | 必带 |
| `stage` | `string` | stage finalize | 固定为 `accountDelivery` | 必带 |
| `state` | `string` | `shared-account-delivery/stages/account-delivery.js` | 原始成功态，如 `DELIVERY_COMPLETE` | 必带 |
| `reason` | `string` | stage finalize | 稳定原因码 | 必带 |
| `nextStage` | `string` | stage finalize | 下一阶段，应为 `delivery-complete` | 必带 |
| `source` | `string` | finalize | 最终交付结论来源，如 `account` / `text` | 必带 |
| `signalStrength` | `string` | finalize | 结论强度 | 建议保留 |
| `durationMs` | `number` | stage timer | 阶段总耗时 | 必带 |
| `detail.accountSummary` | `object` | delivery stage | 面向人读的账号摘要 | 建议定义为稳定展示对象 |
| `detail.deliveryPayload` | `object` | delivery stage | 面向系统写出/归档的结构化载荷 | 建议定义为稳定机器对象 |
| `detail.sessionRecord` | `object` | batch runner writeback | session-records/latest 与归档写回基础对象 | 建议与 session archive schema 对齐 |

#### S6 特别说明

- `accountSummary` 与 `deliveryPayload` 不应混为一谈：
  - `accountSummary` 更偏展示、摘要、面向人读
  - `deliveryPayload` 更偏结构化写出、归档、下游消费
- 当前 `session-records/latest.*` 已被重新定为“当前批次累计视图”，S6 写回逻辑后续应继续遵循该语义，不要再把 latest 当永久总账。

---

## 4. 建议落地顺序

| 批次 | 目标 | 优先级 |
|---|---|---|
| Batch A | 统一跨阶段公共字段契约：`success/state/reason/nextStage/source/signalStrength/durationMs` | P0 |
| Batch B | 补齐 S1 / S5 / S6 契约定义，明确 `ENTRY_READY`、session inspection 分层、`accountSummary vs deliveryPayload` | P0 |
| Batch C | 补齐 S0 `proxyGrade/detail` 与 S4 `flowMode/ageQualified` 的稳定字段说明 | P1 |
| Batch D | 补齐 S2 / S3 的 `settleStage/retryCount/stateChanged/retrySummary` 契约 | P1 |
| Batch E | 推进 `detail` 分层，逐步形成 stable detail / debug detail 的边界 | P2 |

---

## 5. 当前阶段结论

截至本文档落地时，Dreamina staged architecture 的代码运行能力已经明显领先于字段契约文档能力。当前最值得优先收口的，不是再发明新字段，而是先把：

- 公共主字段
- 各阶段主结果边界
- `detail` 的稳定/调试边界
- S1 / S5 / S6 的关键语义

正式写死。

后续若继续扩展日志、trace、调试信息，默认应优先追加到受控子结构中，而不是污染顶层结果对象。
