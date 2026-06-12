# OpenRouter 自动化 — 架构与边界总图

本目录(`Openrouter/0.0.1/`)是 OpenRouter 账号自动化(注册→登录→取Key→绑地址→绑卡→充值)的实现。按**三引擎 + 共享库 + 数据层**分层。改动前先读对应目录的 `README.md` 边界说明。

```
0.0.1/
├── playwright/        引擎① Node/Playwright 编排层(注册/登录/取key/绑地址 + 反检测/打码)
├── selenium-e2e/      引擎② Python/Selenium 层(加卡 Fix C + 混合编排 + 纯Selenium全流程)
├── web/               引擎③ Node Web 控制台(:4317,驱动引擎①批量跑)
├── billing/           共享库:卡池 / 多引擎填卡 / 账单台账 / 地址生成 / ZIP·参数  (① 与 ③ 共用)
├── browser-provider/  共享库:指纹浏览器环境/代理池抽象(adspower/bitbrowser/…)
├── automation-driver/ 共享库:自动化驱动抽象(playwright/puppeteer/selenium)
├── data/     数据层:卡池/账号/台账/策略 JSON + 其读写模块(★含卡号,gitignore)
├── data/batch-results/     数据层:跑批成功账号导出
├── config/config.json        非密配置(密钥占位空) / config/config.local.json(密钥,gitignore)
└── *.md               文档(本文 + 操作/部署手册)
```

## 三引擎职责与边界

| 引擎 | 目录 | 语言 | ✅ 负责 | ❌ 不负责 |
|---|---|---|---|---|
| **① Playwright 编排** | `playwright/` | Node | 注册/魔法链接登录/取Key/绑地址;Turnstile/hCaptcha 打码;反检测(stealth);失败分类路由 | 加卡躲检测(交引擎②Fix C);环境/代理建立(交 browser-provider);卡池数据(交 billing) |
| **② Selenium 加卡** | `selenium-e2e/` | Python | **Fix C 原生CDP绑卡**(脱chromedriver躲Stripe检测、可并发);混合编排(拉引擎①跑前置再自己加卡);纯Selenium全流程(run.py);充值 | — |
| **③ Web 控制台** | `web/` | Node | http 服务/SSE 进度/表单配置 → 调引擎① 批量跑;集群主从聚合 | 自身不做页面自动化(只编排引擎①) |

**共享库**(① 与 ③ 共用,故留根、不归任一引擎):`billing/`(卡池单一来源+填卡引擎+台账)、`browser-provider/`(环境/代理)、`automation-driver/`(驱动抽象)。
**数据层**:`data/`(运行态,敏感,gitignore)、`data/batch-results/`(导出)。

## 三种运行模式(各用哪些层)

| 模式 | 入口 | 链路 | 绑卡 | 并发 | 到付款? |
|---|---|---|---|---|---|
| **Web/纯Playwright** | `node web/server.js` (:4317) | ③ → ①`Openrouter-job-runner`→`Openrouter-register`→`stages` | Playwright 填卡(billing/card-fill 引擎;osinput躲检测但串行) | ✅ | ✅ billingAction=charge |
| **混合**(推荐批量) | `python selenium-e2e/hybrid_run.py` | ②编排:子进程拉 ①`playwright/hybrid-pw-stage.js`(注册/取key/绑地址)→断开→②Fix C加卡→充值 | **Fix C**(躲检测+并发) | ✅ `--concurrency` | ✅ `--do-purchase` |
| **纯 Selenium** | `python selenium-e2e/run.py` | ②`pipeline`:注册/取key/绑地址/加卡/充值 全 Selenium | **Fix C**(`fill_mode=cdp`) | ✅ `--concurrency` | ✅ `--do-purchase` |

> Fix C 是 Selenium 专属(脱 chromedriver、不开 Runtime 的干净会话);Playwright 架构上用不了 Fix C → 想"批量+躲检测+到付款"用**混合**或**纯Selenium**。

## 跨层契约(改动勿破坏)

1. **Node↔Python handoff**:混合模式 Python(`hybrid_run.py`)`subprocess` 拉 `playwright/hybrid-pw-stage.js`(`cwd=0.0.1/`)。约定:**stdout 只有末行 JSON**(结果),所有日志走 **stderr**;Python 解析末行 JSON。
2. **共享卡池**:`data/card-pool.json` 被 **Node `billing/card-pool.js`** 与 **Python `selenium-e2e/common.py:load_card/mark_card_result`** 同时读写 → **字段/状态语义必须两端一致**(`status='disabled'` 不是 `'declined'`、`cooldownUntil`/`declineCount` 等;见 billing/README)。
3. **key 抢救**:`stages.js` 抓到 key 当场 `console.error('[pw] APIKEY_CREATED <sk-or-...>')` → Python `_rescue_key` 即便 Node 超时被杀也能捞回已建 key,避免重建孤儿 key。
4. **配置**:`config.json`(非密)+ `config/config.local.json`(密钥)双读合并;密钥只在 local、gitignore。
5. **共享模块在仓库根**:`../../shared-batch-orchestration`、`../../shared-browser-runtime`、`../../shared-window-layout`(从引擎①文件看是 `../../../shared-*`,因其在 `playwright/` 下深一层)。

## 依赖方向(谁依赖谁,单向)
```
web/ ─┐
       ├─→ playwright/ ─→ billing/ ─┐
selenium-e2e/(子进程拉 playwright/hybrid-pw-stage.js)   ├─→ data/(数据)
                       └─→ browser-provider/ ──────────┘
                       └─→ automation-driver/
        (共享模块 shared-* 在仓库根)
```
billing/browser-provider/automation-driver 是**叶子共享库**,不反向依赖引擎;data 是纯数据+读写模块。
