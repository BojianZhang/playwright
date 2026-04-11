# dreamina

这个目录是 Dreamina 在 `shared-entry` 下的独立包。

## 当前内容

- `load-site-profile.js`
  - Dreamina 侧 profile 读取逻辑

## 迁移说明

原来放在：
- `shared-entry/load-site-profile.js`

现在主实现迁到：
- `shared-entry/dreamina/load-site-profile.js`

同时保留了外层兼容入口：
- `shared-entry/load-site-profile.js`

这样旧引用暂时不会断，后续再逐步切换到 Dreamina 包路径。
