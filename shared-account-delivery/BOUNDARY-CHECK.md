# account-delivery 边界检查

对应目录：
- `D:\playwright\shared-account-delivery`

这个文档只做一件事：
**把第六阶段该做什么、不该做什么、和第五阶段怎么交接、和最终外层交付怎么分层，先钉死。**

---

# 一、第六阶段是什么

第六阶段是：
- `account-delivery`

它的职责不是再判断注册是否成功，也不是去做外部系统写入。
它的职责是：

1. 接住第五阶段已经确认完成后的页面与账号上下文
2. 整理当前账号的最终交付字段
3. 判断当前账号信息是否已经达到“可交付给外层”的最低标准
4. 收口阶段 6 的成功 / 失败 / 未知结果

---

# 二、第六阶段负责什么

第六阶段负责：
- account-delivery ready 判断
- 账号最终交付字段整理
- session / storage / url / ui 侧摘要整合
- delivery success / failure / unknown 收口
- 第六阶段失败分类

---

# 三、第六阶段不负责什么

第六阶段不负责：
- 首页打开
- 登录入口切换
- credential submit
- verification submit
- birthday / profile completion
- post-auth-ready 最终确认
- 外部数据库写入
- 外部 API 推送
- 消息通知
- browser/context 创建
- runner 层代理切换、外层重试、结果落盘

---

# 四、第五阶段和第六阶段怎么切

## 第五阶段终点
第五阶段的成功定义是：
- 已确认进入 `registration-complete`
- 已确认当前账号处于可用用户态

第五阶段不应该继续做：
- 最终交付字段整理
- delivery-complete 判定
- 对外输出交付对象格式

## 第六阶段起点
第六阶段的起点是：
- 页面已经进入 `registration-complete` 所在上下文
- 或上层已经确认账号进入最终可交付态

第六阶段第一步应该是：
- 确认 delivery ready
- 再整理交付字段
- 最后确认 delivery-complete

---

# 五、什么算越界

以下行为如果放在第六阶段内部，通常不算越界：
- 读取 account / session / storage / url / ui 的摘要信息
- 组装交付对象草案
- 判断当前账号是否达到最低可交付标准

以下行为如果放在第六阶段内部，就属于越界或高风险：
- 回头做前五阶段动作
- 修改代理、替换浏览器、重建 page/context
- 直接写入外部数据库
- 调用第三方 API 做同步
- 对外发消息通知
- 直接做 runner 全局决策

---

# 六、第六阶段成功定义

第六阶段成功不是“所有外部系统都已经同步完成”，而是：

- 已确认当前账号的核心交付字段已整理完成
- 已确认当前账号已达到可交付最低标准
- 当前结果可以被外层认定为 `delivery-complete`

---

# 七、一句话总结

第六阶段只做一件关键事：
**把“这个账号已经整理成可交付对象”这件事确认干净，并把交付结果交给外层。**
