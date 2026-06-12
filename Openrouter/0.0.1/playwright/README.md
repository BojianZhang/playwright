# playwright/ — 引擎① Node/Playwright 编排层

在三引擎架构中的定位见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。本层用 Playwright 驱动指纹浏览器跑 OpenRouter 账号前置流程。

## ✅ 负责
- 账号生命周期编排:注册 → 魔法链接登录 → 取 API Key → 绑账单地址(`Openrouter-job-runner.js` 编排,`Openrouter-register.js` 阶段注册表,`stages.js` 各阶段实现)。
- 新版 onboarding 向导 / 老版 dashboard 双轨取 key(按页面内容判,见 `stages.js handleOnboardingWizard`)。
- 反检测 / 打码:Turnstile(`openrouter-turnstile.js`)、hCaptcha(`openrouter-hcaptcha.js` + `captcha-solver.js` 2Captcha)、stealth 指纹(`openrouter-stealth.js`)、AdsPower 接管(`openrouter-adspower.js`)。
- Playwright 侧绑卡(billingAction=card/charge)+ declined 自救(ZIP重试/冷却,逻辑在 `stages.js`,数据/引擎在 `../billing/`)。
- 失败 → 恢复动作路由(`failure-policy.js`)、错误台账(`error-log.js`)、结果导出模板(`export-templates.js`)、跨机聚合(`aggregate-results.js`)。
- 混合模式被 Python 拉起的子进程入口(`hybrid-pw-stage.js`:只跑注册/取key/绑地址,断开留浏览器给 Selenium 加卡)。

## ❌ 不负责
- **加卡躲检测的 Fix C** → 是 `../selenium-e2e/`(Selenium 专属,Playwright 架构用不了)。
- **环境/代理建立** → `../browser-provider/`。
- **卡池数据 / 填卡引擎实现 / 账单台账** → `../billing/`(本层只调用)。
- **数据持久化文件** → `../data/`。
- **http 服务 / 批量调度 UI** → `../web/`(由 web 调本层)。

## 关键文件
- `Openrouter-job-runner.js` — 批量编排 + 重试/换环境/换代理路由(env-rotate 认 `last.reason`)。
- `Openrouter-register.js` — 阶段注册表(register/magicLinkLogin/apiKey/billing/export)。
- `stages.js` — 各阶段实现(注册/登录/取key/绑地址/绑卡)+ declined ZIP自救 + Link弹窗。**最大文件,改动先读其顶部 BOUNDARY。**
- `hybrid-pw-stage.js` — 混合 handoff 入口(`node playwright/hybrid-pw-stage.js <cdp> <email> ...`,stdout 仅末行 JSON,日志走 stderr)。
- `failure-policy.js` — 纯函数错误码→动作表(可单测)。

## 依赖
→ `../billing/`、`../browser-provider/`、`../data/`、`../config/*.json`、仓库根 `../../../shared-*`。被 `../web/server.js` 与 `../selenium-e2e/hybrid_run.py`(子进程)调用。
