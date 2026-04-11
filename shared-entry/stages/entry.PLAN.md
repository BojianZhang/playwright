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

# 二、建议流程

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

## 3. 确认入口 ready
调用：
- `adapter.waitForEntryReady(...)`

## 4. 失败时分类
调用：
- `adapter.classifyEntryFailure(...)`

---

# 三、注意事项

- 阶段 1 不要吞掉 credential submit
- 阶段 1 允许做 reload / retry / recreate 等健康治理
- 阶段 1 的成功定义是“入口页可交给下一阶段”，不是“登录流程开始执行”
