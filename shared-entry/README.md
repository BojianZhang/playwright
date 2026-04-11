# shared-entry

这个目录专门放“公共首页入口/页面就绪”相关的共享模块，避免继续把站点专属逻辑散落在各业务文件里。

## 计划放置内容

- `site-entry-health.js`
  - 通用首页加载与 ready 判断 orchestrator
  - 负责 goto / reload / retry / 白屏 / 死页 / ready signal / page recreate

- `profiles/`
  - 各站点入口 profile
  - 例如：Dreamina / OpenAI / Claude

- `adapters/`
  - 各站点特殊适配逻辑（可选）
  - 例如特殊 overlay、特殊 ready wait、特殊错误归类

## 边界

这个目录只负责“站点入口页打开到 ready 状态”的共享能力：
- 打开首页
- 检查白屏/死页
- 判断 ready 信号
- 处理入口页 retry / reload / page recreate

不负责：
- 浏览器 / context 创建
- 代理池选择与淘汰
- 注册后续业务（邮箱、验证码、生日、session）
- 站点登录后业务操作

## 当前迁移建议

第一步：先把 `dreamina-health.js` 的通用能力迁入这里，Dreamina 作为第一个站点 profile。
第二步：待 Dreamina 跑稳后，再扩 OpenAI / Claude 等站点。
