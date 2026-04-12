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
- 处理入口页级别的 overlay / recover / login-entry wait（仅限把页面恢复到“登录入口可操作”）

不负责：
- 浏览器 / context 创建
- 代理池选择与淘汰
- credential submit
- verification submit
- profile completion
- post-auth-ready
- account-delivery
- 站点登录后业务操作

## 第一迁移包（最小落地版）

shared-entry 第一迁移包当前只建议先迁 4 个能力片段，不要一次搬大：

1. **白屏检测骨架**
   - 来源：`dreamina-health.js -> detectDreaminaWhiteScreen(...)`
   - shared 落点：`site-entry-health.js`
   - 目标：把“入口页是否接近白屏”沉淀成通用健康能力

2. **死页检测骨架**
   - 来源：`dreamina-health.js -> detectDreaminaFirstLoadDeadPage(...)`
   - shared 落点：`site-entry-health.js`
   - 目标：把“入口页是否命中强失败/假加载死页”沉淀成通用健康能力

3. **正向 ready signal 骨架**
   - 来源：`dreamina-health.js -> hasDreaminaHomePositiveSignals(...)`
   - shared 落点：`site-entry-health.js`
   - 目标：让 entry 阶段不是“没判死就算成功”，而是必须命中正向 ready signal

4. **page recreate 判断**
   - 来源：`dreamina-health.js -> shouldRecreateDreaminaPage(...)`
   - shared 落点：`site-entry-health.js`
   - 目标：统一判断 page/context 是否已损坏到必须重建

### 注意
第一迁移包只迁“健康治理能力”，不迁“业务推进责任”。
也就是说：
- 可以增强 entry 阶段的健康治理、恢复和 ready 判断
- 不能把 Continue with email、邮箱密码、验证码、生日、session 等后续阶段动作塞进 entry

## shared / adapter / profile 的职责拆分

### shared：`site-entry-health.js`
只放通用骨架：
- white screen detect skeleton
- dead page detect skeleton
- positive ready detect skeleton
- page recreate helper
- 基础 open/retry/health orchestration

### Dreamina adapter：`shared-entry/dreamina/entry-adapter.js`
只放站点专属行为：
- Dreamina overlay handling
- Dreamina error modal recover
- Dreamina login-entry signal wait
- Dreamina 对 shared health skeleton 的接线

### Dreamina profile：`shared-entry/dreamina/profiles/*.json`
只放静态规则：
- validTextSignals / validSelectors / bodyPatterns
- dead page thresholds
- overlay button patterns
- login signal texts / selectors
- recovery / wait 默认值

## 当前迁移建议

第一步：先把 `dreamina-health.js` 的 4 个最小健康治理能力迁入这里，Dreamina 作为第一个站点 profile。
第二步：待 Dreamina 跑稳后，再补 overlay recover / login-entry staged wait 等 Dreamina adapter 能力。
第三步：待 Dreamina entry 包跑稳后，再扩 OpenAI / Claude 等站点。