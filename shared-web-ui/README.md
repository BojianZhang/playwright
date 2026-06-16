# shared-web-ui — 前端「产品中立基础件」共享层（边界契约）

> **层级定位**：React 控制台里**产品无关、逐字相同、很少变**的 UI 原语 + 工具库。
> **消费方**：**仅 OR/0.0.1 ↔ GLM/0.0.1**（同源 React SPA）。**Dreamina/0.0.4 不用本包**（其 web 是 Node-only 简控制台，非这套 SPA）。
> **刻意收窄**：前端是两产品**最该各自演进**的层（pages/features/schema 已重度分化）。本包**只**收口稳定中立的基础件,**绝不**碰产品界面。

## 17 文件(diff=0 · 产品无关 · 内部依赖自闭合)

- **components(7)**：`DataTable ErrorBoundary ImportModal Kpi Modal RowMenu charts`
- **lib(10)**：`api auth batch export icons parse theme toast usePersistedState sync`

内部 import 全落在集合内(DataTable→icons/export、ImportModal→icons/toast/Modal、api→auth/sync、toast→icons)。全员仅具名导出。

## 抽取机制(前端版 shim + vite/tsc alias)

1. 规范文件放本包 `components/`、`lib/`(镜像目录,使内部 `../lib/icons`、`./Modal` 在包内自洽)。
2. 各项目原位置 `web/src/{components,lib}/X` → 一行 re-export shim:`export * from '@shared/components/X'`。所有 importer 的 `import { X } from '../components/X'` 零改。
3. 各项目接通 `@shared` 别名(指向仓库根 `shared-web-ui/`):
   - `web/vite.config.ts`:`resolve.alias['@shared']` + `server.fs.allow` 加仓库根(dev 可读 sibling;build 经 rollup 解析,从**消费项目**的 node_modules 解析 react 等)。
   - `web/tsconfig.json`:`paths` 加 `"@shared/*"`。
4. ★**跨项目 tsc 解析坑**:shared 文件在两项目 node_modules 之外 → `import 'react'` 解析不到。修=tsconfig `paths` 把 `react`/`react/*` 映射到 `./node_modules/@types/react`(type-check 只需类型;运行时 react 由 vite 从消费项目解析)。**新增 import 别的 npm 包时,若该包不在 src 已用集合内,需同法补 paths。**

## 准入边界

**✅ 准入**：产品无关、逐字相同、内部依赖闭合、**无品牌串**的 UI 原语/工具。
**❌ 不准入(留各项目,产品界面/分化层)**：`pages/`、`features/`、`Sidebar`(品牌)、`engineFlows`(产品流程)、`*Schema.ts`(配置域多分歧)、`types.ts`/`useJobStream`(分歧)、`labels.ts`。

## 验证(离线)

```bash
# 每个项目 web/:
node_modules/.bin/tsc -p tsconfig.json --noEmit   # @shared + react→@types 解析,类型 0 错
node_modules/.bin/vite build                       # 打包成功,产物→ public/
```
- 改本包后**两项目都要 tsc + vite build 重出 public/**(产物入库,源↔产物一致)。
- `sync.ts` 的 `BroadcastChannel('openrouter-sync')`:identical 现状,按 origin 隔离,GLM 用此名无害(零行为变更);如需洁癖后续参数化。
