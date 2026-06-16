# shared-web-ui — 前端「产品中立基础件」共享层（边界契约）

> **层级定位**：React 控制台里**产品无关、逐字相同、很少变**的 UI 原语 + 工具库。
> **消费方**：**仅 OR/0.0.1 ↔ GLM/0.0.1**（同源 React SPA）。**Dreamina/0.0.4 不用本包**（其 web 是 Node-only 简控制台，非这套 SPA）。
> **刻意收窄**：前端是两产品**最该各自演进**的层（pages/features/schema 已重度分化）。本包**只**收口稳定中立的基础件,**绝不**碰产品界面。

## 跨包归属决策（前端模块该放哪 —— 防共享层腐化）

| 模块特征 | 归属 |
|---|---|
| 产品无关 UI 原语 / 通用工具·hook,**逐字相同·无品牌·无产品知识** | **本包 `shared-web-ui/`** |
| 产品页面 / 功能区(`pages/`、`features/`) | 留各项目(产品界面,最该各自演进) |
| 含品牌串 / 产品文案(Sidebar、engineFlows…) | 留各项目(或参数化后再议) |
| 配置 schema(engine/recovery/advanced/selectors/strategy) | 留各项目(配置域多分歧;后端侧见 `shared-console-stores` 注入) |
| 后端 store / server 逻辑 | 不在前端层(见 `shared-console-stores`) |

判别口诀:**纯展示 / 纯工具 + 无品牌 + 无产品知识 → 本包;一旦含产品页面/文案/配置 → 留各项目。**

## 17 文件(diff=0 · 内部依赖自闭合 · 仅具名导出)— 逐模块职责 + 边界

**components(7)**

| 文件 | 职责 | 边界(不该做什么) |
|---|---|---|
| `DataTable` | 通用数据表(表头排序/搜索/下拉筛选/分页) | 纯展示;列定义与数据由调用方传,**不取数、不含业务** |
| `ErrorBoundary` | 错误边界(单页渲染抛错不拖垮整站) | 只兜渲染错误,不做业务处理 |
| `ImportModal` | 通用资源导入弹窗(上传 + 粘贴) | 只解析 + 回调;**不知道导入的是卡/号/代理** |
| `Kpi` | 统一 KPI 卡(报表区复用) | 纯展示 |
| `Modal` | 通用模态(overlay + Esc/点外关 + 动画) | 纯容器,内容由调用方传 |
| `RowMenu` | 操作列「⋯」溢出菜单 | 纯 UI;具体动作由调用方传 |
| `charts` | 零依赖手写 SVG 图(Donut/AreaLine/Bars/Gauge) | 纯展示;数据由调用方传 |

**lib(10)**

| 文件 | 职责 | 边界 |
|---|---|---|
| `api` | 带 token 的 fetch + 类型化 GET/POST | 通用 HTTP;**不含具体接口路径/业务** |
| `auth` | 客户端访问令牌存取 | 只管 token 读写,不做鉴权逻辑 |
| `batch` | 批量操作并发执行器 | 通用并发器;不知道跑的是什么操作 |
| `export` | 「表头 + 行」→ CSV 导出 | 纯数据 → 文件 |
| `icons` | 内联 SVG 图标库(feather 风格) | 纯图标 |
| `parse` | 上传/粘贴逐行解析 | 纯解析;不校验业务语义 |
| `sync` | 跨标签页同步(BroadcastChannel) | **单 origin**;频道名 `openrouter-sync` 现状无害(见末) |
| `theme` | 三态主题 system/light/dark | 纯主题状态 |
| `toast` | 轻量 Toast 通知(替代 alert/confirm) | 纯提示 UI |
| `usePersistedState` | 把**非凭证**配置持久化到 localStorage | ★**只存非凭证**,凭证绝不进 localStorage |

内部 import 全落在集合内(DataTable→icons/export、ImportModal→icons/toast/Modal、Kpi/Modal/RowMenu→icons、api→auth/sync、toast→icons)→ 17 个是自闭合集,可整体共享。

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
