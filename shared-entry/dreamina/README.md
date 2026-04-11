# Dreamina 包说明

这个目录是 `shared-entry` 下 Dreamina 站点的独立包。

它的目标是：
**把 Dreamina 首页入口阶段相关的配置、说明、加载能力逐步收口到一个独立目录里。**

---

# 一、这个包的边界

## 这个包负责什么
当前 Dreamina 包主要负责：
- 读取 Dreamina 的入口 profile
- 存放 Dreamina 的入口配置
- 存放 Dreamina 的字段说明文档
- 为后续 Dreamina 专属 adapter / helper 预留位置

## 这个包不负责什么
当前 Dreamina 包不负责：
- browser / context 创建
- 首页打开主 orchestrator（目前仍在 `shared-entry/site-entry-health.js`）
- 代理池选择与淘汰
- 注册后续业务（邮箱、验证码、生日、session）

---

# 二、当前目录结构

## `load-site-profile.js`
### 作用
Dreamina 包内的 profile 读取器。

### 它负责什么
- 根据站点名推导 profile 文件路径
- 读取 JSON 文件
- 去掉 UTF-8 BOM
- 解析 JSON
- 做最基础的结构校验
- 返回 profile 对象

### 它不负责什么
- 页面打开
- ready 判断
- 登录/注册业务流程

---

## `profiles/`
Dreamina 包内的入口配置与文档目录。

### `profiles/dreamina-entry-profile.json`
#### 作用
程序真正读取的 Dreamina 首页入口配置。

#### 主要内容
- 首页 URL
- 导航 timeout / retry
- 首屏等待
- ready signal
- white screen 规则
- dead page 规则
- overlay 规则

---

### `profiles/dreamina-entry-profile.md`
#### 作用
字段说明文档。

#### 用途
给维护者看：
- 每个字段管什么
- 什么时候该调
- 调大/调小会影响什么

---

### `profiles/dreamina-entry-profile.example.md`
#### 作用
带行内注释的文档版示例。

#### 用途
方便后续：
- 新人理解字段
- 新站点照着抄模板
- 配置时不用猜字段用途

---

# 三、当前调用关系

## 当前真实实现位置
Dreamina profile 的主读取实现位于：
- `shared-entry/dreamina/load-site-profile.js`

## 当前兼容入口
为了避免旧引用立即断开，外层还保留了一个兼容入口：
- `shared-entry/load-site-profile.js`

它当前只是转发到：
- `./dreamina/load-site-profile`

也就是说：
- 新结构已经落在 Dreamina 包内
- 旧路径暂时还能继续工作

---

# 四、后续建议演进方向

## 第一阶段（当前）
先把 Dreamina 的：
- profile JSON
- 字段说明文档
- profile loader
收进独立包。

## 第二阶段
继续补 Dreamina 的专属能力，例如：
- `adapters/`
- `helpers/`
- 特殊 overlay 处理
- Dreamina 专属 ready signal wait

## 第三阶段
再让通用首页模块更自然地接入站点包结构，例如：
- `shared-entry/site-entry-health.js` + `shared-entry/dreamina/*`

---

# 五、一句话总结

这个目录可以理解成：
**Dreamina 在 shared-entry 体系下的独立站点包。**

当前主要负责 Dreamina 首页入口阶段的配置与加载；
后续会继续承接 Dreamina 专属的 adapter / helper / profile 维护。
