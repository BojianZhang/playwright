# scratch/ — 开发期探针（非流程依赖）

这里放**一次性诊断脚本 / 手工标定探针**，全部以 `_` 开头。它们不是流水线的一部分——
被正式代码 import 的数量为 **0**，删掉不影响任何入口（`run.py` / `pipeline.py` / `hybrid_run.py` / `hyb_loop.py`）。

## 为什么单独放这

之前这些 `_*.py` 和正式入口、运营工具平铺在 `selenium-e2e/` 根目录，读代码时噪声大。归到这里只为降熵，**不改任何业务逻辑**。

## 注意

- 这些脚本含**真实卡号 / 账号 / 实测交互数据**，已由 `.gitignore` 的 `selenium-e2e/scratch/_*.py` 规则忽略，**绝不入库**（只有本 README 入库）。
- 每个脚本顶部都加了一行 **scratch shim**，把父目录 `selenium-e2e/` 插进 `sys.path`，所以移到这里后照样能 `import common` / `from cdp_raw import ...`，且 `HERE` 锚回 `selenium-e2e/`，原有数据文件路径不变。
- 在仓库根的 `selenium-e2e/` 目录下直接跑即可：`python scratch/_coord_test.py`。

## 清单

| 脚本 | 用途 |
|------|------|
| `_analyze_v7.py` | 读 `_v7run.log` + `hybrid_results.jsonl` + 卡池，量化核对某轮各修复是否生效 |
| `_cardloop.py` | 持续给未绑卡的号循环加卡（每轮换 IP/指纹、退避 Radar），直到全绑上 |
| `_coord_test.py` | 屏幕物理坐标标定（卡号/ZIP/Save 落点），校准 CSS px → 物理像素 |
| `_fixb_test.py` | Fix B 早期试验：pyautogui OS 级真键盘填卡，验证能否避开 hCaptcha 行为检测 |
| `_fptest.py` | 验证 `create_env_full` 随机指纹：建 2 个环境对比指纹是否不同 |
| `_import_newcards.py` | 一次性把某批新卡导入卡池（含真实账单地址/ZIP）并禁用烧穿 BIN |
| `_probe_click.py` | 对比 hcaptcha iframe 里 Runtime.evaluate vs DOM.querySelector 找 #checkbox |
