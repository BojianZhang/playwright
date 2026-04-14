# Dreamina Staged Architecture 代码对齐验收清单

## 1. 文档目的

这份清单用于回答一个很具体的问题：

> `stage-field-contract.md` 里定义的阶段字段契约，目前在代码里到底落了多少？

它不是新的设计文档，而是现状验收文档。

使用方式：

- 先看每个阶段的“已对齐 / 半对齐 / 待观察”
- 再结合真实 batch artifact 验证字段有没有实际落出来
- 后续补缺口时，优先改“半对齐”和“待观察”项，不再盲改

---

## 2. 总体结论

截至当前代码状态，Dreamina staged architecture 在 **S0~S6 的阶段结果契约层** 已基本进入“可验收”状态。

当前最核心的进展是：

- 各阶段顶层结果对象已基本统一到：
  - `success`
  - `stage`
  - `state`
  - `reason`
  - `nextStage`
  - `source`
  - `signalStrength`
  - `settleStage`
  - `detectionSource`
  - `stateChanged`
  - `retryCount`（部分阶段）
  - `detail`
- S2 / S3 / S4 / S5 / S6 的关键 detail 语义已经开始显式落对象，而不是只存在日志里
- 文档契约和代码结构已不再明显脱节

但注意：

- “代码里已对齐” 不等于 “真实运行 artifact 已稳定产出”
- 下一步仍需要 batch 验证来确认字段在成功 / 失败 / 长尾路径上都能真实落出

---

## 3. 分阶段验收

---

### S0 `proxyPrecheck`

**代码位置**

- `shared-proxy-precheck/stages/proxy-precheck.js`
- `shared-proxy-precheck/dreamina/proxy-precheck-adapter.js`

**已对齐**

- 顶层字段：
  - `success`
  - `stage`
  - `state`
  - `reason`
  - `nextStage`
  - `proxyGrade`
  - `source`
  - `signalStrength`
  - `settleStage`
  - `detectionSource`
  - `stateChanged`
  - `retryCount`
  - `detail`
- `detail` 已显式包含：
  - `exitIpCheck`
  - `primaryTargetCheck`
  - `secondaryTargetCheck`
- 代理结果确认链已经能区分：
  - `OK`
  - `WEAK`
  - `BAD`

**半对齐**

- `proxyGrade` 虽已稳定存在，但其长期枚举语义仍建议在 profile / docs 中写死
- `detail` 内仍同时保留老字段和新字段别名，后续可考虑逐步瘦身

**验收结论**

- **已对齐，可验收**

---

### S1 `entry`

**代码位置**

- `shared-entry/stages/entry.js`
- `shared-entry/dreamina/entry-adapter.js`

**已对齐**

- 顶层字段已统一到公共契约
- `detail` 已显式包含：
  - `entryHealth`
  - `recoveryTrace`
- `ENTRY_READY` / `ENTRY_NOT_READY` / recover 相关结果都已有稳定收口

**半对齐**

- `detail.entryHealth` 当前仍偏运行态结果对象，后续可进一步明确 stable 子字段
- `detail.recoveryTrace` 已有，但更像 recoveryResult，若后面需要完整恢复轨迹，仍可继续扩
- S1 的 timing 细粒度拆分还没正式对象化，当前仍主要靠日志看

**验收结论**

- **已对齐，可验收**
- **性能诊断字段仍待下一轮专门打点**

---

### S2 `credential`

**代码位置**

- `shared-credential/stages/credential-submit.js`
- `shared-credential/dreamina/credential-adapter.js`

**已对齐**

- stage runner 顶层字段已补齐 `source`
- adapter 层已经显式产出：
  - `formSignals`
  - `stateTrace`
  - `settleStage`
- stage runner 已把这些字段正式吸收入 `detail`
- 成功 / 失败 / exists-precheck / fallback signin 等路径都能带上更明确的结构

**半对齐**

- `stateTrace` 仍是阶段级语义轨迹，不是完整步骤 trace，这是合理的，但需要和调试日志区分清楚
- `formSignals` 目前已够用，但后续如需更强 schema，可再固定字段名边界

**验收结论**

- **已对齐，可验收**
- 这是本轮收口里最重要的一块，之前的真缺口已经补上

---

### S3 `verification`

**代码位置**

- `shared-verification/stages/verification-submit.js`
- `shared-verification/dreamina/verification-adapter.js`

**已对齐**

- 顶层字段已统一到公共契约
- `detail` 已显式包含：
  - `provider`
  - `matchMode`
  - `stateChanged`
  - `retrySummary`
- verification 内部重试语义已通过 `retryCount` + `retrySummary` 更清楚地暴露出来

**半对齐**

- `retrySummary` 当前已非常有价值，但仍偏运行摘要，后续若想做 schema 化，可再约束每轮对象字段
- `codeInputResolution` / `fetchCodeResult` / `fillResult` / `confirmResult` 仍属 rich detail，对外消费时要避免直接把内部实现绑死

**验收结论**

- **已对齐，可验收**
- S3 已具备“结果字段可看懂 + 长尾可分析”的基础能力

---

### S4 `profileCompletion`

**代码位置**

- `shared-profile-completion/stages/profile-completion-submit.js`
- `shared-profile-completion/dreamina/profile-completion-adapter.js`

**已对齐**

- 顶层字段已统一到公共契约
- `detail` 已显式包含：
  - `planSource`
  - `flowMode`
  - `ageQualified`
- continuous / split 两种路径的语义已经不再只靠代码推断

**半对齐**

- `stateTrace` 和 `detail.timing` 还没有像文档里那样完全正式化为统一稳定对象
- 但关键主语义已经具备，不影响当前验收

**验收结论**

- **已对齐，可验收**
- 若后续要继续细化，优先补 `stateTrace` / `timing`

---

### S5 `postAuthReady`

**代码位置**

- `shared-post-auth-ready/stages/post-auth-ready.js`
- `shared-post-auth-ready/dreamina/post-auth-ready-adapter.js`

**已对齐**

- 顶层字段已统一到公共契约
- `detail` 已显式包含并区分：
  - `initialSessionInspection`
  - `sessionObservationTrace`
  - `sessionInspection`
  - `uiConfirmation`
  - `resultConfirmation`
- 硬 session promotion 的收口链路已经明确

**半对齐**

- `sessionObservationTrace` 当前已可用，但仍偏观测日志对象，后续如果要更 schema 化，可再固定字段清单
- `source` / `detectionSource` / 内部 observation source 之间虽然已能共存，但还可以继续统一命名风格

**验收结论**

- **已对齐，可验收**
- 当前已经达到“session 相关字段能被正式消费”的程度

---

### S6 `accountDelivery`

**代码位置**

- `shared-account-delivery/stages/account-delivery.js`
- `shared-account-delivery/dreamina/account-delivery-adapter.js`

**已对齐**

- 顶层字段已统一到公共契约
- `detail` 已显式包含：
  - `accountSummary`
  - `deliveryPayload`
  - `sessionRecord`
- S6 已经能表达“人读摘要 / 机器载荷 / session 写回对象”三层边界

**半对齐**

- `sessionRecord` 现在是从 `deliveryPayload` / `accountSummary` 中兜底抽取，后续如果要更强一致性，可以在 adapter 层直接显式产出
- `accountSummary` / `deliveryPayload` 的 schema 边界虽然已经明确，但仍值得未来单独写 schema 文档

**验收结论**

- **已对齐，可验收**

---

## 4. 当前仍建议继续观察的点

这些不属于“字段契约没做完”，而属于“需要真实运行再确认是否稳定落地”。

### 4.1 S1 timing 细分

当前文档里提到的：

- `openEntryPage`
- URL stabilization
- first CTA visible
- first email gate visible
- overlay recovery

还没有正式进入结果对象，只在日志层较明显。

### 4.2 S3 长尾路径真实产出

虽然代码已补：

- `provider`
- `matchMode`
- `retrySummary`

但仍建议再用真实长尾 batch 看：

- fetch 超时失败路径
- resend 后成功路径
- wrong code 路径

是否都稳定落出了这些 detail 字段。

### 4.3 S6 `sessionRecord` 来源一致性

当前 S6 已对齐字段边界，但仍建议确认：

- `deliveryPayload.sessionRecord`
- `session-records/latest.jsonl`
- `session-records/latest.txt`

三者是否在真实 batch 中完全一致。

---

## 5. 推荐下一步验收动作

### 第一步：真实 batch 验证

建议重点盯这些字段是否实际落出：

- S2 `detail.stateTrace`
- S2 `detail.formSignals`
- S3 `detail.provider`
- S3 `detail.matchMode`
- S3 `detail.retrySummary`
- S4 `detail.flowMode`
- S4 `detail.ageQualified`
- S5 `detail.initialSessionInspection`
- S5 `detail.sessionObservationTrace`
- S5 `detail.sessionInspection`
- S6 `detail.accountSummary`
- S6 `detail.deliveryPayload`
- S6 `detail.sessionRecord`

### 第二步：只修真实落空项

如果 batch 验证后发现：

- 某字段文档有，但 artifact 里没有
- 某字段成功路径有，失败路径没有
- 某字段名字一致，但内部 shape 漂移明显

再针对性补，不再做大范围重构。

---

## 6. 当前验收结论（简版）

| 阶段 | 状态 | 结论 |
|---|---|---|
| S0 proxyPrecheck | 已对齐 | 可验收 |
| S1 entry | 已对齐 | 可验收，timing 细分待后续 |
| S2 credential | 已对齐 | 可验收 |
| S3 verification | 已对齐 | 可验收，建议再跑长尾验证 |
| S4 profileCompletion | 已对齐 | 可验收 |
| S5 postAuthReady | 已对齐 | 可验收 |
| S6 accountDelivery | 已对齐 | 可验收 |

---

## 7. 最终判断

这轮工作的阶段性目标已经不是“把字段想出来”，而是已经完成到了：

> 文档契约已落地为代码契约，接下来应转入真实 artifact 验收。

也就是说，下一步最值钱的动作不是继续写更多字段，而是用真实 batch 去验证：

- 字段有没有真正落出
- 各种成功 / 失败 / 长尾路径是否一致
- artifact 是否已经能支持后续诊断、统计和交付
