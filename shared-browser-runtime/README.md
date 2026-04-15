# shared-browser-runtime

公共浏览器运行时层。

## 作用

负责：
- browser launch / context / page 创建
- 指纹与浏览器环境策略
- 资源拦截策略
- 摆窗执行（把 `windowLayout` 转成 launch args）

不负责：
- layout planner / profile
- batch queue / worker 编排
- 站点级 DOM 与业务流程
- stage retry / recovery 业务逻辑

## 当前布局

- `index.js`：统一导出入口
- `fingerprint.js`：随机指纹与 context 指纹参数
- `resource-policy.js`：资源拦截策略
- `window-runtime.js`：摆窗执行层
- `create-browser-runtime.js`：browser runtime 总装层

## 关系

- 规划层：`shared-window-layout`
- 执行层：`shared-browser-runtime`
- 业务入口层：`Dreamina-register.js`
