# shared-profile-completion ROADMAP

这个文件记录阶段 4（profile completion submit）的当前状态与后续推进方向。

---

# 当前阶段

Dreamina profile-completion 已从“字段级拆分验证期”进入“continuous-flow 主路径冻结期”。

当前已确认：
- birthday 页面可识别
- birthday plan 可生成，满足随机且年满 18 周岁
- Year 可稳定输入
- 当前主路径已切换为 `Year -> Month -> Day -> Next`
- Next 点击责任已收口到 `continuous-flow`

---

# 当前主路径

## Dreamina 默认主路径
- `fillDreaminaBirthdayContinuousFlow(...)`
- 业务流：`Year -> Month -> Day -> Next`
- 当前中间不再依赖 Month/Day 的字段即时读取作为主成功判定

## 当前 split-fill 的定位
- `fillDreaminaBirthdayYear / Month / Day`
- 仅保留作 fallback / diagnostics
- 不再作为 Dreamina 默认主路径

---

# 下一步

## 1. 收口 post-auth-ready 前的确认逻辑
- 明确 stage 4 成功后的下一屏信号
- 降低 `PROFILE_COMPLETION_RESULT_UNKNOWN`

## 2. 继续补文档与 contract
- README / CONTRACT / PARAMS / FIELDS 继续追平代码

## 3. 继续验证更多 birthday 页面形态
- 不同语言
- 不同组件展开表现
- 不同默认值/预填态
