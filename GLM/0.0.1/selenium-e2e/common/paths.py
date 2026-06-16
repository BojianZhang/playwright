#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 路径常量(单一来源)
#
# ★为什么单独一个模块、且按【包目录的父目录】锚定 HERE:
#   本模块在 common/ 包里,__file__ = .../selenium-e2e/common/paths.py。
#   若沿用旧 common.py 的 HERE=dirname(__file__) 会得到 .../selenium-e2e/common(多一层),
#   所有 state 文件路径(proxy-stats/zip-stats/bin-usage/card-assign)与卡池路径全部错位 →
#   等于丢历史战绩/卡池/分配。所以这里取【包父目录】,逐字节等价旧 common.py 的 HERE/ROOT。
import os

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))          # .../selenium-e2e/common
HERE = os.path.dirname(_PKG_DIR)                                # .../selenium-e2e   ← 等价旧 HERE
ROOT = os.path.normpath(os.path.join(HERE, ".."))              # .../0.0.1          ← 等价旧 ROOT

POOL_FILE = os.path.join(ROOT, "data", "card-pool.json")
CONFIG_LOCAL = os.path.join(ROOT, "config", "config.local.json")
CONFIG_JSON = os.path.join(ROOT, "config", "config.json")

# state 文件(挂 selenium-e2e/state/):{h:p:{...}} / {zip:{...}} / {日期:{BIN:...}} / {邮箱:卡id}
PROXY_STATS_FILE = os.path.join(HERE, "state", "proxy-stats.json")
ZIP_STATS_FILE = os.path.join(HERE, "state", "zip-stats.json")
CARD_ASSIGN_FILE = os.path.join(HERE, "state", "card-assign.json")
BIN_USAGE_FILE = os.path.join(HERE, "state", "bin-usage.json")   # 控同 BIN velocity

__all__ = [
    "HERE", "ROOT", "POOL_FILE", "CONFIG_LOCAL", "CONFIG_JSON",
    "PROXY_STATS_FILE", "ZIP_STATS_FILE", "CARD_ASSIGN_FILE", "BIN_USAGE_FILE",
]
