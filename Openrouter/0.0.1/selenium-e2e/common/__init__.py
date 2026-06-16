#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 纯 Python Selenium 流水线 — 共享 helper(单一来源)· 门面
#
# 文件定位:Openrouter/0.0.1/selenium-e2e/common/__init__.py
#
# 本包从原 1287 行的 common.py 拆出,按职责分模块,门面在此 re-export 全部公共符号 ——
# 所有调用方 `import common` + `common.X`、`from common import X` 一行不用改。
#   · paths    : HERE/ROOT + 全部 state/config/pool 文件路径(按包父目录锚定,逐字节等价旧 HERE)
#   · base     : 日志 / URL·选择器·判定正则 / 通用 HTTP / 原子写 / 跨进程文件锁
#   · adspower : AdsPower 本地 API + 启动/停止浏览器(节流/启动闸)
#   · driver   : chromedriver 版本匹配 + Selenium 接管 + 隐身(cdc_ 改名)
#   · ledger   : 代理/ZIP/BIN/卡池/hCaptcha/坏邮箱 六套状态账本
#   · layout   : 屏幕尺寸 + 多窗口网格 + 置窗
#   · page     : Page 跨 iframe 钻取(Stripe 跨域必需)
#   · config   : 配置读取 + 随机地址/名 + OpenRouter 封禁判定
# ═══════════════════════════════════════════════════════════════════════

# 按依赖顺序 re-export(paths/base 无包内依赖 → driver → adspower → 其余)。
from .paths import *       # noqa: F401,F403
from .base import *        # noqa: F401,F403
from .osnative import *    # noqa: F401,F403   (仅 stdlib;layout/fixb 的跨平台屏幕尺寸+提前台靠它)
from .uikeys import *      # noqa: F401,F403   (跨平台填表全选/清空原语;依赖 osnative.IS_MAC)
from .driver import *      # noqa: F401,F403
from .adspower import *    # noqa: F401,F403
from .ledger import *      # noqa: F401,F403
from .layout import *      # noqa: F401,F403
from .page import *        # noqa: F401,F403
from .config import *      # noqa: F401,F403
from .attribution import attribute_failure, classify_decline   # noqa: F401   (失败归因单一来源:pipeline + hybrid 共用;classify_decline=Stripe 拒付原因分类)
from . import recovery                        # noqa: F401   (失败恢复策略消费:run.py AUTO_RETRY 按 fail_stage 决定是否重试,common.recovery.should_retry)

# 外部代码事实上在用的【私有】符号(common._xxx) —— import * 默认带不出下划线名,
# 虽各子模块 __all__ 已列入,这里再显式导一遍做双保险(改 __all__ 时不至于悄悄断掉外部调用)。
#   common._atomic_write_json : block_bin / hybrid_run / reactivate_cards / test_helpers
#   common._file_lock         : test_helpers
#   common._port_ready        : fixb_bind / fixc_bind / fixc_probe / steps_billing
#   common._CARD_LOCK         : disable_cards / import_cards
#   common._read_bin_usage    : status / test_helpers
#   common._bin_today         : test_helpers
from .base import _atomic_write_json, _file_lock, _FileLock   # noqa: F401
from .driver import _port_ready                               # noqa: F401
from .ledger import _CARD_LOCK, _read_bin_usage, _bin_today   # noqa: F401
