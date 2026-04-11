# post-auth-ready 阶段计划草案

对应文件：
- `D:\playwright\shared-post-auth-ready\stages\post-auth-ready.js`

这个文档只做一件事：
**把第五阶段的公共流程顺序先钉清楚，后续代码按这个顺序落，不要一开始就把所有站点细节揉进来。**

---

# 一、目标

阶段 5 的目标是：
- 接住第四阶段已经推进出来的页面
- 判断是否进入 post-auth-ready
- 判断是否已建立登录后可用态
- 输出最终 success / failure / unknown

---

# 二、建议流程

## 1. 等待第五阶段入口 ready
调用：
- `adapter.waitForPostAuthReady(...)`

如果入口不 ready：
- 直接按阶段 5 失败收口

## 2. 检查 session / storage / cookie 可用态
调用：
- `adapter.inspectPostAuthSession(...)`

这一步的目标不是做复杂账户管理，而是判断：
- 有没有形成能支撑“注册完成”的用户态基础信号

## 3. 检查 UI 侧登录后信号
调用：
- `adapter.confirmPostAuthUi(...)`

例如：
- 用户头像
- 用户菜单
- 已登录工作台
- 控制台主页
- 登出按钮
- 个人欢迎区

## 4. 收口最终结果
调用：
- `adapter.confirmPostAuthResult(...)`

按 success / failure / unknown 收口，并决定：
- `nextStage = registration-complete`
- 或返回失败 / unknown

## 5. 失败时分类
调用：
- `adapter.classifyPostAuthFailure(...)`

输出站点语义下更适合运维和 runner 消费的 reason。

---

# 三、注意事项

- 第五阶段不要回头做前四阶段动作
- 第五阶段允许读取 cookie/storage 摘要，但不要开始做外部持久化
- 第五阶段允许确认“是否已经进入已登录态”，但不要把站点业务操作混进来
- 第五阶段的核心不是“再点什么按钮”，而是“最终收口是否可交付”
