# shared-console-stores — 控制台后端 store 工厂层

> **层级定位**：Web 控制台后端的「落盘 store」**逻辑**，工厂模式。**OR↔GLM 共享**（Dreamina/0.0.4 没有这些 store，不引用）。
> 把 13 个在 OR↔GLM 间复制粘贴的 `*-store.js` 收口为单一工厂实现，各项目原位置保留薄 shim **注入自己的 `dataDir`**（及分歧 schema）。

---

## 为什么是工厂、不是 Tier1 那种直接搬

store 要落盘到**项目本地** `data/`（含账密/卡池等，按各项目 .gitignore 排除）。直接搬到 shared 会让 `__dirname` 指向 shared 目录→读错库。所以每个 store 导出一个**工厂函数** `createXStore({ dataDir })`，由各项目 shim 注入自己的目录：

```js
// shared-console-stores/proxy-store.js
module.exports = function createProxyStore({ dataDir }) {
  const FILE = path.join(dataDir, 'proxies.json');
  /* …原 store 逻辑逐字不变… */
  return { list, add, /* … */ _FILE: FILE };
};
// Openrouter/0.0.1/web/proxy-store.js (shim)
module.exports = require('../../../shared-console-stores/proxy-store')({ dataDir: path.join(__dirname, '..', 'data') });
```
`require` 缓存 → 每项目工厂只构造一次（单例），与重构前语义一致；server.js 的 `const x = require('./x-store')` 命名空间调用**零改**。

## 准入边界

**✅ 准入**：控制台后端 store 逻辑，落盘路径**只经 `dataDir` 注入**（不出现 `__dirname/../data`）；可变状态（`let _list` 等）与 `FILE` **必须在工厂函数内**（每实例独立，绝不泄漏到模块级否则两项目串内存）；只依赖 node 内置 / `../shared-utils/*` / 注入的 schema。
**❌ 不准入**：产品分化的 store/schema（见下）、业务编排（server.js）、反检测核心。

## 模块清单（13 · 工厂入参）

| 工厂入参 | store |
|---|---|
| `{dataDir}` | proxy, address, adspower-endpoint, captcha, mailbox, schemes, setup(传 `config/`), usage, adspower |
| `{dataDir}` + 工厂内 require 共享 schema | selectors(`../shared-utils/selectors-schema`), strategies(`../shared-utils/strategy-schema`) |
| `{dataDir, engineSchema}` 注入分歧 schema | engine-config |
| `{dataDir, schema}` 注入分歧 schema | advanced |

> `usage`/`adspower` 收口时取 **OR 超集**（usage 的 CACHE-4 缓存清除、adspower 的 H4 `readJsonOr`+`.corrupt` 安全读）→ **GLM 经 shim 获得这两个此前缺失的修复**（复制税现形）。

## 绝不并（保留各项目，不进本包）

- `recovery-store` + `recovery-schema` —— OR 的恢复方案是**卡相关产品特性**，z.ai 不通用
- `engine-schema` —— 真产品分化（OR 四引擎 `[playwright,selenium,hybrid,split]` vs GLM 单引擎 `[selenium]`）；以**注入**方式喂给共享的 engine-config-store
- `advanced-schema` —— 品牌 env 前缀（`OPENROUTER_FAST` vs `GLM_FAST`）；同样**注入**
- `runs-store` —— 品牌 env 名 + OR 独有 `resumedSuccessRate`，暂缓（后续可用 env-name 入参统一）

## shim 契约 + 验证

- **改逻辑改本包工厂；绝不改 shim**。新增 store：① 本包加工厂 ② 各项目原位置改 shim 注入 `dataDir`(+schema) ③ 跑下方验证。
- 合并近似实现取**正确超集**，不丢任一 fork 的修复。
- 改完必跑（核心风险=读错 data 目录）：
  ```bash
  node --check shared-console-stores/*.js
  # 断言 require('<proj>/web/X-store')._FILE 指向 <proj>/data/X.json,且 OR≠GLM 不同实例(无串库)
  node --test <三项目 *.test.js>     # 保持 86/86
  ```
