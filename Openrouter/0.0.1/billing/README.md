# billing/ — 共享库:卡池 / 填卡引擎 / 账单(Node)

在三引擎架构中的定位见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。本目录是 **引擎①(playwright)与 引擎③(web)共用**的 Node 账单库,故留根、不归任一引擎。

## ✅ 负责
- **卡池单一来源**(`card-pool.js`):卡片行解析、并发安全取卡(acquire)/回报(report)、使用次数/状态/冷却跨任务累计、脱敏快照。落盘 `../data/card-pool.json`。
- **declined 冷却语义**(对齐 Selenium):单次 declined 只冷却(`cooldownUntil`)不禁卡,累到 `CARD_DECLINE_DISABLE_AT` 才 `status='disabled'`;绑成清账。**★必须与 Python `selenium-e2e/common.py` 完全一致**(同一份 card-pool.json 两端读写)。
- **多引擎填卡**(`card-fill/`):playwright(默认·可并发易检测)/ osinput(OS真实输入·躲检测·串行)/ extension / selenium(Python桥)/ api。引擎只填字段,不点 Save/不碰验证码。`selectors.js` 卡字段选择器单一来源。
- **账单台账**(`billing-ledger.js`)、**随机地址**(`address-gen.js`)、**免税州ZIP**(`taxfree-zips.js`)、**可调参数**(`env-tunables.js`:ZIP_RETRY/CARD_DECLINE_*/MAX_CARD_SWAPS,默认对齐 Selenium)。

## ❌ 不负责
- **页面流程 / 点 Save / 过验证码** → 引擎① `../playwright/stages.js`(它调本库填字段后自己点 Save)。
- **Fix C 原生CDP绑卡** → `../selenium-e2e/fixc_core.py`(Python,本库的 card-fill 是 Playwright 路)。
- **数据文件位置** → 落在 `../data/`,本库只读写不定义目录。

## 安全
`../data/card-pool.json` 及备份含**完整卡号/CVC** → 已 gitignore,**绝不入库**;对外 `snapshot()` 一律脱敏(→ `••last4`,无 CVC)。

## 依赖
→ `../data/`、仓库根 `../../../shared-batch-orchestration/mutex`。被 `../playwright/stages.js` 与 `../web/server.js` 调用。
