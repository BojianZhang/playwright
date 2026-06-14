# 在 macOS 上运行(跨平台说明)

本系统原在 Windows 开发,核心栈(Node 控制台 / Python Selenium / Playwright / AdsPower 本地 API /
Fix C 原生 CDP 加卡)**跨平台**,在 macOS 上同样可跑。本页只列 Mac 相对 Windows 需要注意的差异。

## 1. 前置

- **Node.js 18+**、**Python 3.9+**、**AdsPower macOS 客户端**(装好并打开,本地 API 默认 `127.0.0.1:50325`)。
- Python 依赖:`python3 -m pip install -r Openrouter/0.0.1/selenium-e2e/requirements.txt`
  - chromedriver 由 Selenium Manager 按 AdsPower 内核版本自动下载;反检测 `chromedriver_stealth` 由
    `common/driver.py` 运行时生成。
  - **★Apple Silicon(M 系列)**:byte-patch 会使 chromedriver 原签名失效,arm64 内核会直接 SIGKILL 未签可执行档。
    `_patch_chromedriver` 已在 macOS 上自动 `codesign --force --sign -`(ad-hoc 重签名)再交给 Selenium;
    `codesign` 是 macOS 自带,无需手动装。万一重签失败会自动退回原版驱动(隐身退化但能跑,接管后的
    `STEALTH_JS` 运行时注入仍删 `webdriver`/`cdc_`)。也可 `STEALTH=0` 显式关掉二进制改名。
- Node 依赖:在 `Openrouter/0.0.1/web/` 下 `npm ci`(或 `npm install`),控制台 `node server.js`。

## 2. AdsPower 本地 API 用 `127.0.0.1`(不是 `local.adspower.net`)

已是默认(`OPENROUTER_ADSPOWER_API=http://127.0.0.1:50325`)。开了本地代理(Clash/VPN)时,
`local.adspower.net` 不在系统代理绕过名单会被转走 → 502;`127.0.0.1` + 强制不走代理已规避。

## 3. 辅助功能权限(仅 OS 级真键鼠兜底需要)

**生产加卡链路 Fix C(原生 CDP)不需要任何系统权限。** 只有【OS 级真键鼠兜底】才需要:
- `selenium-e2e/cardbind/fixb_bind.py`(Fix B)与 `billing/card-fill/engines/osinput.js`(osinput)
  在 macOS 用 `pyautogui` 真键鼠 + `osascript` 提前台,需在
  **系统设置 → 隐私与安全性 → 辅助功能** 给启动它们的程序(终端 / Python / Node)打勾,否则键发不出去。
- `osinput` 默认禁用,需显式 `OPENROUTER_OSINPUT_OK=1` 且确保浏览器在前台才发键(防卡号泄漏到错误窗口)。
- 这两个是单窗口前台兜底,**并行加卡请用 Fix C**(真并行、免前台、免权限)。

## 4. 窗口平铺

多窗口网格平铺的屏幕尺寸:Windows 走 `user32`,macOS 走 `osascript`(Finder 桌面 bounds,见
`common/osnative.py`)。取不到时回退 1920×1080;可用环境变量 `SCREEN_W` / `SCREEN_H` 显式覆盖。

**★多显示器 Mac**:Finder 桌面 bounds 返回的是【所有显示器的并集外接矩形】(不是单一主屏),平铺会按并集宽度铺、
且 AdsPower 指纹 `screen_resolution` 会拿到并集宽(异常值)。**多屏机请显式设 `SCREEN_W` / `SCREEN_H`** 为主屏分辨率;
若只想固定 AdsPower 指纹分辨率而不动窗口平铺,可单独设 `ENV_SCREEN_RES`(如 `1920x1080`)。
纯生产加卡(Fix C 原生 CDP)用视口 CSS 像素点击,与窗口位置无关,不受此影响。

## 5. 维护脚本

`npm run reset` / `npm run reset:all` 现走跨平台的 `node reset-results.js`(替代 `reset-results.ps1`,
后者保留供 Windows 用户直接调用)。

## 6. 已知边界

- `pygetwindow` 仅 Windows 有效,故未列为硬依赖;Mac 上其 import 失败已被 `try/except` 兜住,
  Fix B 的提前台改走 `osascript`。
- Fix B 的坐标在 Retina 上用【逻辑点】(pyautogui 在 macOS 用 points,不乘 devicePixelRatio);
  极少数缩放/多屏场景仍可能偏移,优先用 Fix C 规避。
