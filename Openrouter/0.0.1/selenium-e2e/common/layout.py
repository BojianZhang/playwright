#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 屏幕尺寸 + 多窗口网格平铺 + 置窗(多引擎共屏靠 GRID_TOTAL/GRID_SLOT_OFFSET 统一网格)。
import os

from .base import log


def screen_size():
    """屏幕分辨率(Windows 取真实值,失败回退 1920x1080;环境变量 SCREEN_W/SCREEN_H 可覆盖)。"""
    w = os.environ.get("SCREEN_W")
    h = os.environ.get("SCREEN_H")
    if w and h:
        return int(w), int(h)
    try:
        import ctypes
        u = ctypes.windll.user32
        u.SetProcessDPIAware()
        return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
    except Exception:
        return 1920, 1080


def grid_rect(slot, total, taskbar=48):
    """把 total 个窗口平铺成网格,返回第 slot 个窗口的 (x, y, w, h)。
    列数=ceil(sqrt(total)),尺寸=屏幕/网格——并发越多每个窗口越小,正好铺满屏。
    【多引擎共屏】GRID_TOTAL 覆盖总格数、GRID_SLOT_OFFSET 平移本引擎槽位 → 多个进程共用同一张网格不重叠
    (例:总10格,Selenium GRID_SLOT_OFFSET=0 占0-6,hybrid GRID_SLOT_OFFSET=7 占7-9,尺寸统一)。"""
    import math, os
    total = int(os.environ.get("GRID_TOTAL") or total)
    slot = int(slot) + int(os.environ.get("GRID_SLOT_OFFSET") or 0)
    sw, sh = screen_size()
    sh = max(360, sh - taskbar)
    total = max(1, int(total))
    # 宽屏感知:列数按屏幕宽高比放大(宽屏多列→每个窗口更【高】,卡表单 Save 按钮装得下,免"没取到Save坐标")
    # ★最小可用尺寸:窗口太小→向导Continue按钮被折叠到下方点不到、FixC坐标点挤变形→卡死(实测688×696可用、491×464崩)。
    #   并发再高也不缩到这以下:超出每屏容量的窗口靠下面 modulo 叠在一起(各自仍是可用大小,自动化按各自viewport驱动,不受叠放影响)。
    MIN_W = int(os.environ.get("GRID_MIN_W") or 600)
    MIN_H = int(os.environ.get("GRID_MIN_H") or 500)
    aspect = max(1.0, sw / float(max(1, sh)))
    cols = min(total, max(1, int(math.ceil(math.sqrt(total * aspect)))))
    rows = int(math.ceil(total / float(cols)))
    cols = max(1, min(cols, sw // MIN_W))         # 每排最多塞几个仍≥MIN_W
    rows = max(1, min(rows, sh // MIN_H))         # 每列最多塞几行仍≥MIN_H
    w = max(MIN_W, sw // cols)
    h = max(MIN_H, sh // rows)
    col = slot % cols
    row = (slot // cols) % rows
    return (col * w, row * h, w, h)


def place_window(driver, rect):
    """把 Selenium 接管的窗口移到/缩放到 rect=(x,y,w,h)。"""
    try:
        x, y, w, h = rect
        driver.set_window_rect(x=int(x), y=int(y), width=int(w), height=int(h))
        return True
    except Exception as e:
        log("置窗失败: %s" % str(e)[:60])
        return False


__all__ = ["screen_size", "grid_rect", "place_window"]
