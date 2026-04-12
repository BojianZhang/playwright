# Dreamina-register 收口清单

对应目录：
- `D:\playwright\Dreamina`

核心文件：
- `Dreamina-register.js`
- `Dreamina-register.CONTRACT.md`
- `Dreamina-register.PLAN.md`
- `Dreamina-register.FIELDS.md`

这个文档的目标是：

> 说明 Dreamina 主链编排层当前做到哪了、哪些已经接通、哪些主路径已经冻结、当前合理停点在哪里。

---

# 一、当前主链健康状态

- proxy-precheck：可用，当前主链已能稳定完成代理预检
- entry：可用，已能稳定进入 Dreamina 首页/入口可操作态
- credential-submit：可用，已能识别正常推进与 `ACCOUNT_ALREADY_EXISTS`
- verification-submit：当前主路径已冻结为 `dreamina-direct-fill`
- verification-submit：已验证可以从验证码页推进到 birthday / profile-completion
- profile-completion-submit：当前主路径已冻结为 `fillDreaminaBirthdayContinuousFlow`
- profile-completion-submit：birthday 当前按 `Year -> Month -> Day -> Next` 连续业务流执行
- post-auth-ready：尚未完全收口，仍需继续实测
- account-delivery：尚未完全收口，仍需继续实测

---

# 二、当前关键架构决策

1. Dreamina verification 默认主路径为 `dreamina-direct-fill`
2. `dreamina-char-by-char` / hidden-input / wrapper-keyboard / fallback-keyboard-type 逐步降级为 debug-only
3. Dreamina profile-completion 默认主路径为 `fillDreaminaBirthdayContinuousFlow`
4. birthday 阶段按参考脚本业务流执行：`Year -> Month -> Day -> Next`
5. birthday 阶段中间不再以字段级读取结果作为主成功判定
6. birthday 的 Next 当前由 `continuous-flow` 负责点击
7. Dreamina 当前允许有限阶段桥接，但 shared 阶段边界定义不因此改变

---

# 三、当前已完成能力

## 1. 统一阶段注册表
- 已完成
- 当前方法：`buildDreaminaStageRegistry()`

## 2. 统一主链上下文
- 已完成第一版
- 当前方法：`buildDreaminaRegisterContext(...)`

## 3. 统一单阶段执行入口
- 已完成第一版
- 当前方法：`runDreaminaStage(...)`

## 4. 统一主链结果规范化
- 已完成第一版
- 当前方法：`normalizeDreaminaRegisterResult(...)`

## 5. 完整 1~6 阶段顺序编排
- 已完成
- 当前方法：`runDreaminaRegisterFlow(...)`

---

# 四、当前剩余问题

- birthday 连续流后的 post-auth-ready 收口仍需继续验证
- 文档尚未完全追平代码（尤其 shared-verification / shared-profile-completion 契约）
- 部分 legacy fallback 仍保留在代码中，尚未全部 debug-only 化

---

# 五、当前合理停点

当前 `Dreamina-register.js` 可以视为：
- 第一版可用 orchestrator
- 已具备当前 Dreamina 主路径冻结后的整链编排能力
- 后续重点不再是继续扩写骨架，而是：
  1. 收口 verification / profile-completion 文档与契约
  2. 继续验证 post-auth-ready / account-delivery
  3. 清理 legacy fallback 的自动参与

---

# 六、一句话收口

> `Dreamina-register.js` 当前已完成 Dreamina 六阶段主链编排骨架闭环，并进入“主路径冻结 + 临时桥接收口 + 文档追平代码”的整改期；verification 已切 direct-fill，profile-completion 已切 continuous-flow，下一步重点应转向后半段结果确认和文档债收口。

# ????????????2026-04?

- Dreamina ?????????? birthday title/subtitle?Year/Month/Day?birthday Next????????? post-auth-ready bridge?????? `account-delivery`?????????????
- ????????? 5 ????? `POST_AUTH_READY_ONLY`?
- ????? session / storage / workspace UI ?????????? 5 ????? `REGISTRATION_COMPLETE`?
- `account-delivery` ??????????? `deliveryPayload.accountSummary.registrationState`??????????????????????? `POST_AUTH_READY_ONLY`??????????
