# entry 阶段计划草案

对应文件：
- `D:\playwright\shared-entry\stages\entry.js`

这个文档只做一件事：
**把阶段 1 的公共流程顺序先钉清楚，后续代码按这个顺序落。**

---

# 一、目标

阶段 1 的目标是：
- 打开或接住站点首页 / 入口页
- 做健康检查
- 确认入口页 ready
- 输出 success / failure / unknown

---

# 二、第一迁移包（最小落地版）

第一迁移包先只做 4 个最小片段，不一次迁太大：

1. **white-screen detect skeleton**
2. **dead-page detect skeleton**
3. **positive-ready detect skeleton**
4. **page-recreate helper**

这 4 个片段都属于：
- entry 健康治理
- entry ready 判断
- entry 异常恢复前的基础判断

当前不进入第一迁移包的内容：
- Continue with email 点击推进
- email/password form ready
- verification countdown ready
- post-register ready
- session ready

---

# 三、建议流程

## 1. 打开或校正入口页
调用：
- `adapter.openEntryPage(...)`
或未来统一的站点入口能力

## 2. 做入口健康检查
调用：
- `adapter.checkEntryHealth(...)`
或共享健康检查模块

目标：
- 白屏 / 死页 / 假 ready / 首屏失败识别

## 3. 必要时做入口页级 recover
调用：
- `adapter.recoverEntry(...)`

目标：
- 仅把页面恢复到“登录入口可操作”
- 不推进 credential / verification / post-auth 业务阶段

## 4. 确认入口 ready
调用：
- `adapter.waitForEntryReady(...)`

## 5. 失败时分类
调用：
- `adapter.classifyEntryFailure(...)`

---

# 四、shared / adapter / profile 分工

## shared：`site-entry-health.js`
负责：
- goto / reload / retry 基础编排
- white screen detect skeleton
- dead page detect skeleton
- positive ready detect skeleton
- shouldRecreatePage

## Dreamina adapter：`dreamina/entry-adapter.js`
负责：
- Dreamina overlay handling
- Dreamina error modal recovery
- Dreamina login-entry staged wait
- Dreamina 对 shared 健康骨架的接线

## Dreamina profile：`dreamina/profiles/*.json`
负责：
- validTexts / validSelectors / bodyPatterns
- overlay button patterns
- error modal texts
- login signal texts
- recovery / wait 默认值

---

# 五、注意事项

- 阶段 1 不要吞掉 credential submit
- 阶段 1 允许做 reload / retry / recreate / recover 等健康治理
- 阶段 1 的成功定义是“入口页可交给下一阶段”，不是“登录流程开始执行”
- 第一迁移包只增强 entry 阶段能力厚度，不改变 entry 阶段职责边界