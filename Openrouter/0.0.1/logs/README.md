# logs/ — 统一日志目录

所有运行日志 / 诊断输出 / 截图的**专门存放地**(替代以前散在根目录、selenium-e2e/、state/ 的 `_*.log`)。

## 约定
- **CLI 重定向**:跑批/诊断时把输出导到这里 —— `python selenium-e2e/hybrid_run.py ... > logs/hybrid-$(date +%H%M).log 2>&1`、`node web/server.js > logs/server.log 2>&1`。
- **代码写的日志**:默认落到本目录(如 `cards_watch.py`、诊断 `diag-utils.shot` 的截图 → `logs/screenshots/`)。
- **本目录全部内容 gitignore**(日志含邮箱/Key/卡尾号等敏感),只有本 README 入库。

## 子目录
- `logs/screenshots/` — `playwright/diag-utils.js shot()` 的诊断截图。
