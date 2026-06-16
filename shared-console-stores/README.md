# shared-console-stores — 控制台后端 store 工厂层（边界契约）

> **层级定位**：Web 控制台后端的「落盘 store」**逻辑**，工厂模式。
> **消费方**：**仅 OR/0.0.1 ↔ GLM/0.0.1**（z.ai 移植，控制台同源）。**Dreamina/0.0.4 不用本包**——它是图像产品、有自己一套 store（card-store 等），语义不同。
> 把 13 个曾在 OR↔GLM 间复制粘贴的 `*-store.js` 收口为单一工厂实现，各项目原位置留薄 shim **注入自己的 `dataDir`**（及分歧 schema）。
> 注：各工厂头部 `// … — Openrouter / web / X.js` 是**历史出处**标签（收口前的来源），不代表现位置；现规范实现就在本包，顶部 `⟦共享规范实现(工厂)⟧` banner 为准。

---

## 跨包归属决策（新模块该放哪 —— 最容易混淆，先讲清）

| 模块特征 | 归属 | 例 |
|---|---|---|
| 无状态纯工具、**不落盘** | `shared-utils/` | json-safe, paginate, event-bus, proc-* |
| billing 域纯工具、不落盘 | `shared-billing/` | address-gen, taxfree-zips, card-fill 原语 |
| **带项目本地 `data/` 落盘**的控制台 store | **本包 `shared-console-stores/`**（工厂注入 dataDir） | 见下表 13 个 |
| 各产品**语义不同**（产品分化） | **留各项目，绝不并** | recovery-store, engine-schema, runs-store |
| 反检测/疑似验卡核心 | 不碰（只工程化，不硬化规避） | 指纹/验证码/Radar |

判别口诀：**「无状态→shared-utils/billing；有 data 落盘且 OR↔GLM 同语义→本包工厂；产品分化→留各项目」。**

## 为什么是工厂、不是直接搬

store 要落盘到**项目本地** `data/`（含账密/卡池等，按各项目 .gitignore 排除）。直接搬到 shared 会让 `__dirname` 指向 shared 目录→**读错库**。所以每个 store 导出**工厂函数**，由各项目 shim 注入自己的目录：

```js
// shared-console-stores/proxy-store.js  ← 规范实现，改这里
module.exports = function createProxyStore({ dataDir }) {
  const FILE = path.join(dataDir, 'proxies.json');
  /* …原 store 逻辑逐字不变… */  return { list, add, /* … */ _FILE: FILE };
};
// Openrouter/0.0.1/web/proxy-store.js  ← shim，勿改逻辑
module.exports = require('../../../shared-console-stores/proxy-store')({ dataDir: path.join(__dirname, '..', 'data') });
```
`require` 缓存 → 每项目工厂只构造一次（单例），与重构前语义一致；`server.js` 的 `const x = require('./x-store')` 命名空间调用**零改**。

## 准入边界（什么能进本包 / 什么不能）

**✅ 准入**
- 控制台后端 store 逻辑，落盘路径**只经 `dataDir` 注入**（源码里不出现 `__dirname/../data`）。
- **可变状态（`let _list/_cache/_seq`）与 `FILE` 必须在工厂函数体内**（每实例独立）。★铁律：绝不泄漏到模块级，否则 OR 与 GLM 两实例共享同一份内存缓存 = **串库**（`_FILE` 检查抓不到，必须人工守）。
- 只依赖 node 内置 / `../shared-utils/*` / **注入的 schema**。

**❌ 不准入**：产品分化的 store/schema（见「绝不并」）、业务编排（server.js/engine-runner）、反检测核心。

## 13 个 store（职责 · 落盘 · 边界）

| store | 职责 | 落盘 | 边界（不该做什么） | 工厂入参 |
|---|---|---|---|---|
| proxy | 出口代理池(host:port:user:pass)增删改+连通性测试 | `data/proxies.json` | 只管出口代理(非 AdsPower 环境);`list()` 脱敏不回明文 pass | `{dataDir}` |
| address | 账单地址池 | `data/addresses.json` | 只存/取;**生成**地址在 `shared-billing/address-gen` | `{dataDir}` |
| adspower-endpoint | AdsPower 端点(网关地址+token)池 | `data/adspower-endpoints.json` | 脱敏不回明文 token | `{dataDir}` |
| captcha | 验证码服务 key 池(2captcha 等) | `data/captcha-keys.json` | 只管 key,不解题;脱敏 | `{dataDir}` |
| mailbox | 邮箱服务 key 池(firstmail 等) | `data/mailbox-keys.json` | 只管 key+地址,不收信;脱敏 | `{dataDir}` |
| schemes | 执行方案预设(怎么跑) | `data/schemes.json` | **只存怎么跑,绝不存凭证** | `{dataDir}` |
| setup | 首次部署引导完成/忽略标志 | **`config/setup-state.json`**(注意在 config) | 只存引导状态标志 | `{dataDir}`(传 config 目录) |
| selectors | 元素选择器**用户覆盖值** | `data/ui-selectors.json` | 默认值在 `shared-utils/selectors-schema`;本 store 只存覆盖 | `{dataDir}`(工厂 require 共享 schema) |
| strategies | 环节命名策略预设 | `data/strategies.json` | schema 在 `shared-utils/strategy-schema`(改一处同步两处) | `{dataDir}`(工厂 require 共享 schema) |
| engine-config | 每引擎「怎么跑」命名预设 | `data/engine-configs.json` | schema **分歧**(各项目自有)→由 shim **注入** | `{dataDir, engineSchema}` |
| advanced | 全局高级参数(提速/并发等) | `data/advanced-params.json` | schema **品牌分歧**→由 shim **注入** | `{dataDir, schema}` |
| usage | 资源使用记录(append-only) | `data/usage.jsonl` | 只追加记录,**不做分析**(分析在 failure-analytics) | `{dataDir}` |
| adspower | AdsPower 环境编号(envId)池 | `data/adspower.json` | 只管 envId 池;H4 安全读(损坏备份 .corrupt 不丢) | `{dataDir}` |

> `usage`/`adspower` 收口时取 **OR 超集**（usage 的 CACHE-4 缓存清除、adspower 的 H4 `readJsonOr`）→ **GLM 经 shim 补上此前缺失的修复**（复制税现形）。

## 绝不并（产品分化，保留各项目，不进本包）

| 留各项目 | 为什么 |
|---|---|
| `recovery-store` + `recovery-schema` | OR 的恢复方案是**卡相关产品特性**(zipRetry/cardStrategy/swapOnHcaptcha),z.ai 不通用 |
| `engine-schema` | 真产品分化:OR 四引擎 `[playwright,selenium,hybrid,split]` vs GLM 单引擎 `[selenium]`(以**注入**喂给共享 engine-config-store) |
| `advanced-schema` | 品牌 env 前缀 `OPENROUTER_FAST` vs `GLM_FAST`(以**注入**喂给共享 advanced-store) |
| `runs-store` | 品牌 env 名 + OR 独有 `resumedSuccessRate`(恢复战绩);暂缓,后续可用 env-name 入参统一 |

## shim 契约 + 验证

- **改逻辑改本包工厂；绝不改 shim**。新增 store：① 本包加工厂(状态/FILE 在工厂内) ② 各项目原位置改 shim 注入 `dataDir`(+schema) ③ 跑下方验证。
- 合并近似实现取**正确超集**,不丢任一 fork 的修复。
- 改完必跑（核心风险=读错 data 目录 / 串库）：
  ```bash
  node --check shared-console-stores/*.js
  # 断言 require('<proj>/web/X-store')._FILE 指向 <proj>/data/X.json,且 OR≠GLM 不同实例(无串库)
  node --test <三项目 *.test.js>          # 保持 86/86
  # 人工守:工厂模块级前导只有无状态 require,任何 let/可变 const 必须在工厂函数体内
  ```
