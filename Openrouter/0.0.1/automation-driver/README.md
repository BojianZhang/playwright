# 自动化驱动层

可切换的"自动化工具"层 —— **Playwright / Puppeteer / Selenium / playwright-python**,任意驱动接任意指纹浏览器。
与 `browser-provider/` 对偶:**provider 给一个 CDP 端点(ws/debugPort),driver 接管这个端点**。

## 原理（一个枢轴：CDP 端点）
```
browser-provider.start(envId) → { ws, debugPort }   // 任意指纹浏览器
        │
        ▼
automation-driver.attach('playwright'|'puppeteer', endpoint)  // Node：返回活 handle
automation-driver.run('selenium'|'playwright-python', endpoint, task)  // Python：子进程跑任务
```
- **Node 驱动**(playwright/puppeteer):`attach(endpoint)` → `{ driver, browser, page, detach() }`。
  配 `ops.js` 统一操作(goto/click/type/waitFor/evaluate/frames/title/screenshot)→ **一段代码两驱动通用**。
- **Python 驱动**(selenium/playwright-python):`run(endpoint, taskFile, input)` 子进程跑 Python 任务脚本
  (经 debuggerAddress / connect_over_cdp 接管),回 JSON 结果。换任务=复制 `py/*.py` 改。

## 跑示例（任意指纹浏览器 × 任意驱动）
```
node Openrouter/0.0.1/automation-driver/examples/demo.js adspower <envId> playwright
node …/demo.js adspower <envId> puppeteer            # 需 npm i puppeteer-core
node …/demo.js adspower <envId> selenium             # 需 pip install selenium
node …/demo.js adspower <envId> playwright-python     # 需 pip install playwright
```
把 `adspower` 换成 `bitbrowser`/`dolphin`/… 即"换指纹浏览器";把驱动换掉即"换自动化工具"。业务代码不变。

## 驱动 × 依赖
| 驱动 | 类型 | 依赖 | 接管方式 |
|---|---|---|---|
| **playwright** | Node | 已装(本项目) | `chromium.connectOverCDP(ws)` |
| **puppeteer** | Node | `npm i puppeteer-core` | `puppeteer.connect({browserWSEndpoint:ws})` |
| **selenium** | Python | `pip install selenium` + 匹配 chromedriver | `debuggerAddress=127.0.0.1:debugPort` |
| **playwright-python** | Python | `pip install playwright && playwright install` | `connect_over_cdp(ws)` |
> 缺依赖(未装 puppeteer/python/库)→ 该驱动 `attach`/`run` 优雅报错,不影响其它。Python 解释器经 `OPENROUTER_PYTHON` 可指定。

## 写你自己的自动化
- **Node(两驱动通用)**:
  ```js
  const bp = require('../browser-provider'); const ad = require('../automation-driver'); const { makeOps } = require('../automation-driver/ops');
  const ep = await bp.getProvider('adspower').start(envId);
  const h = await ad.attach('puppeteer', { ws: ep.ws });           // 或 'playwright'
  const ops = makeOps(h); await ops.goto('https://...'); await ops.type('#sel','val'); await h.detach();
  await bp.getProvider('adspower').stop(envId);
  ```
- **Python**:复制 `py/selenium_driver.py` 或 `py/pw_python_driver.py`,在里面写你的步骤(读 stdin 的端点,打印 `OR_RESULT:{...}`),
  Node 侧 `ad.run('selenium', ep, '你的脚本.py', {你的入参})`。

## ⚠ 主业务流程的边界（如实）
本项目的 **OpenRouter 注册/加卡主流程(`stages.js`)仍跑在 Playwright 上**——它有几千行 Playwright 专用调用,
整条换驱动 = 按驱动重写一遍、且零能力增益(都连同一个 CDP 浏览器)。所以本驱动层用于:
1. **写新的/可移植自动化**(用 `ops` 一段代码在 playwright/puppeteer 上都能跑);
2. **按步换驱动**——例如"填卡"那一步已能用 Selenium(见 `billing/card-fill/engines/selenium.js`)。

若将来确需主流程也可换驱动,正路是把 stages.js 里的页面操作抽到 `ops` 那样的统一接口上(大改造,按需再议)。
