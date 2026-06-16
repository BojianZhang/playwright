#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 关键元素选择器:页面可维护 + 内置默认回落 — common/selectors.py
#
# OpenRouter 改版导致「元素找不到」时,在 web「元素维护」页改对应步骤的覆盖值(多个用 || 分隔),
# 经 engine-runner.buildEnv 注成 ORSEL_<ID> 环境变量;这里读取覆盖、否则用调用方传入的内置默认。
# 两个引擎(纯Selenium / 混合)可共用同一份注册表 —— 改一处,两边都生效,不用两处返工。
# 【不碰反检测注入】:只外置「怎么定位元素」,Fix C 的 CDP 可信注入/求解逻辑一律不动。
# ═══════════════════════════════════════════════════════════════════════
import os


def sel(key, *defaults):
    """返回某步骤的选择器列表(按序尝试)。
    覆盖:环境变量 ORSEL_<KEY 大写>,多个用 '||' 分隔;留空/未设 → 用 defaults(代码内置默认)。
    用法:
      for css in sel('signup_email', '#emailAddress-field'): ...  # css 类:逐个 find_elements
      pats = sel('wizard_individual', 'Build side projects', ...)  # text 类:当作文本/正则候选
    """
    raw = os.environ.get("ORSEL_" + str(key).upper(), "")
    if raw and raw.strip():
        ov = [s.strip() for s in raw.split("||") if s.strip()]
        if ov:
            return ov
    return [d for d in defaults if d]


def sel_csv(key, *defaults):
    """同 sel,但返回【逗号拼接】的字符串 —— 给 querySelectorAll / 一次性多选择器用。"""
    return ", ".join(sel(key, *defaults))


def sel_re(key, *defaults):
    """同 sel,但返回【正则 alternation】(| 拼接,各项已转义)—— 给按文本匹配的 new RegExp / re.search 用。"""
    import re as _re
    return "|".join(_re.escape(s) for s in sel(key, *defaults))


__all__ = ["sel", "sel_csv", "sel_re"]
