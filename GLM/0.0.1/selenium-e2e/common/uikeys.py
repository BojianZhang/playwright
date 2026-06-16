#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 跨平台 UI 输入原语(Win / macOS / Linux 一套,源头唯一)。
#
# 文件定位:Openrouter/0.0.1/selenium-e2e/common/uikeys.py
#
# 根治"Mac 上 Ctrl+A 是『光标移到行首』(Cocoa/Emacs 文本绑定)、不是全选 → 清空失效 → 重填时
#   旧值与新值拼成脏值(卡号 invalid card / 邮箱·密码脏 / 金额 1010)"。所有"清旧值再填"的地方都走本模块,
#   平台判断只在此一处 —— 改一处全平台生效(与 JS 侧 billing/card-fill/fill-primitive.js 的 Meta+a/Control+a 同范式)。
# ★Windows/Linux:Ctrl+A(与现状逐字节相同);macOS:Cmd+A。Keys 由调用方传入(本模块不引入 selenium 依赖)。
from .osnative import IS_MAC


def select_all_modifier(Keys):
    """该平台『全选』修饰键:macOS=Cmd(Keys.COMMAND);Windows/Linux=Ctrl(Keys.CONTROL)。"""
    return Keys.COMMAND if IS_MAC else Keys.CONTROL


def clear_input(el, Keys):
    """跨平台清空一个聚焦/可见输入框:平台正确的全选 → Delete。
    供注册/登录/卡号/CVC/金额/Key名 等所有"清旧值再填"处复用 —— 替换散落的 send_keys(Keys.CONTROL,'a')。"""
    el.send_keys(select_all_modifier(Keys), "a")
    el.send_keys(Keys.DELETE)


__all__ = ["select_all_modifier", "clear_input"]
