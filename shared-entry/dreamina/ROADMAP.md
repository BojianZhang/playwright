# Dreamina 包 ROADMAP

这个文件只做一件事：
**把 Dreamina 包后续还要承接的内容列清楚，避免结构继续散落在外面。**

---

# 一、当前状态

当前 Dreamina 包已经具备：
- `load-site-profile.js`：Dreamina profile 读取器
- `profiles/dreamina-entry-profile.json`：程序实际读取的入口配置
- `profiles/dreamina-entry-profile.md`：字段说明文档
- `profiles/dreamina-entry-profile.example.md`：带行内说明的模板示例
- `README.md`：Dreamina 包边界与结构说明

当前仍然在外层的东西：
- `shared-entry/site-entry-health.js`：通用首页入口 orchestrator
- Dreamina 首页打开的真实业务接线仍未完全迁到包结构

---

# 二、目标

把 Dreamina 首页入口阶段相关能力逐步收口到：
- `shared-entry/site-entry-health.js`（通用层）
- `shared-entry/dreamina/*`（站点包层）

最终形成：
- 通用首页加载骨架在公共层
- Dreamina 特有配置/适配/说明在 Dreamina 包内

---

# 三、下一阶段建议任务

## 1. 建立 Dreamina adapter
建议新增：
- `shared-entry/dreamina/adapter.js`

### 作用
承接 Dreamina 专属逻辑，例如：
- 特殊 overlay 处理
- 特殊 ready signal 等待
- Dreamina 首页特有恢复动作
- 特殊错误 reason 归类

### 为什么要做
因为这些逻辑如果继续堆在公共层，后面 OpenAI / Claude 接入时会越来越乱。

---

## 2. 接通 site-entry-health.js 与 Dreamina 包
### 当前问题
通用首页模块虽然已经有了，但和 Dreamina 包的接线还不自然。

### 建议目标
让公共层支持：
- 加载 Dreamina 包内 profile
- 调用 Dreamina adapter（如果存在）
- 返回统一首页 ready/fail 结果

---

## 3. 明确 Dreamina 首页 ready 的最终口径
### 当前需要继续收敛的点
- 哪些文本算真正 ready
- 哪些 selector 算真正 ready
- 哪些 body pattern 只是兜底，不应该作为强信号

### 目标
把 `dreamina-entry-profile.json` 里的 readySignals 逐步收敛成稳定版本。

---

## 4. 明确 Dreamina 白屏 / 死页口径
### 当前需要继续收敛的点
- 哪些情况属于白屏
- 哪些情况属于死页
- 哪些只是慢页，不该误杀

### 目标
让：
- `whiteScreen.bodyTextMinLength`
- `deadPage.bodyTextMinLength`
- 失败证据判断
形成稳定口径。

---

## 5. 收口 Dreamina 首页 overlay 处理
### 当前需要继续做的事
把 Dreamina 首页常见挡板、cookie banner、提示层处理收成站点包内能力。

### 目标
避免把这些按钮模式和处理细节继续散落在业务文件里。

---

## 6. 决定兼容入口何时移除
### 当前情况
外层仍保留：
- `shared-entry/load-site-profile.js`

### 目标
等所有调用都切到：
- `shared-entry/dreamina/load-site-profile.js`
之后，再删除兼容入口，避免长期双入口。

---

# 四、建议推进顺序

## 第一步
先补 Dreamina adapter 骨架。

## 第二步
让 `site-entry-health.js` 能显式接 Dreamina 包。

## 第三步
再把 Dreamina 首页特有逻辑从外围业务文件里逐步迁进包。

## 第四步
最后清理兼容入口和旧路径。

---

# 五、一句话总结

Dreamina 包当前已经完成“配置与说明收口”的第一步；
接下来最重要的是补 adapter，并让公共首页模块和 Dreamina 包真正接上线。
