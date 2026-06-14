#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 跨平台 OS 原语(Windows / macOS)—— 屏幕尺寸 + 把目标窗口提到前台。
#
# 文件定位:Openrouter/0.0.1/selenium-e2e/common/osnative.py
#
# 背景:Fix B(fixb_bind)/ osinput 这类【OS 级真键鼠】兜底需要"知道物理屏多大 + 把浏览器窗口提前台"。
#   Windows 走 ctypes user32(各调用方原地保留);macOS 没有 user32 → 走系统自带 AppleScript(osascript)。
#   只用 stdlib + osascript,不引入 pyobjc 等新依赖。所有函数失败必须吞掉返回 None/False,绝不抛
#   ——兜底链不能因平台差异崩;Linux 两者皆 False(无 OS 级输入实现,落链给上层)。
#
# ★macOS 注意:osascript 的 System Events / keystroke 需在「系统设置 → 隐私与安全性 → 辅助功能」里
#   给运行本脚本的程序(终端 / Python / 启动它的 Node)授权,否则静默失败。pyautogui 真键鼠同样依赖该权限。
import os
import platform
import subprocess

IS_WIN = (os.name == "nt")
IS_MAC = (platform.system() == "Darwin")
IS_LINUX = (not IS_WIN and not IS_MAC)


def _osascript(script, timeout=6):
    """跑一段 AppleScript,返回 stdout(strip);非零退出/异常/超时一律返回 None(绝不抛)。"""
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
        if r.returncode == 0:
            return (r.stdout or "").strip()
    except Exception:
        pass
    return None


def mac_screen_size():
    """macOS 桌面【逻辑】尺寸(points,与 pyautogui / Selenium set_window_rect 同坐标系)。失败返回 None。
       用 Finder 桌面窗口 bounds(形如 '0, 0, 1920, 1080'),无需 pyobjc。
       ★单屏=该屏分辨率;多屏=【所有显示器的并集外接矩形】(非单一主屏)→ 多屏机请用 SCREEN_W/SCREEN_H 显式覆盖,
         否则窗口平铺会按并集宽度铺、且 AdsPower 指纹 screen_resolution 会拿到并集宽(异常值)。"""
    out = _osascript('tell application "Finder" to get bounds of window of desktop')
    if out:
        try:
            parts = [int(x) for x in out.replace(",", " ").split()]
            if len(parts) == 4 and parts[2] > 0 and parts[3] > 0:
                return parts[2], parts[3]
        except Exception:
            pass
    return None


def mac_activate(title_substr="OpenRouter"):
    """把【窗口标题含 title_substr】的进程提到前台(macOS)。需辅助功能权限。返回 True/False。
       遍历可见进程的窗口,命中标题子串就 set frontmost —— 用于 Fix B 在发 OS 级键鼠前确保浏览器在前台。"""
    safe = str(title_substr).replace('"', '').replace('\\', '')
    script = (
        'tell application "System Events"\n'
        '  repeat with p in (every process whose background only is false)\n'
        '    repeat with w in (windows of p)\n'
        '      try\n'
        '        if (name of w) contains "%s" then\n'
        '          set frontmost of p to true\n'
        '          try\n'
        '            perform action "AXRaise" of w\n'      # 抬起【这个】窗口而非仅进程,贴近 Windows SetForegroundWindow(hwnd)
        '          end try\n'
        '          return "ok"\n'
        '        end if\n'
        '      end try\n'
        '    end repeat\n'
        '  end repeat\n'
        'end tell\n'
        'return "no"'
    ) % safe
    return _osascript(script) == "ok"


def linux_screen_size():
    """Linux 桌面分辨率:优先 xrandr 主屏,退而 xdpyinfo dimensions;无 X11/失败返回 None
       (上层回退 1920x1080;多屏/headless 建议显式设 SCREEN_W/SCREEN_H)。只用 stdlib + 系统命令,绝不抛。"""
    import re as _re
    try:
        r = subprocess.run(["xrandr", "--current"], capture_output=True, text=True, timeout=6)
        if r.returncode == 0 and r.stdout:
            # 优先 'connected primary 1920x1080',否则任一 'connected 1920x1080'
            m = (_re.search(r"\bconnected\s+primary\s+(\d+)x(\d+)", r.stdout)
                 or _re.search(r"\bconnected\s+(\d+)x(\d+)", r.stdout))
            if m:
                return int(m.group(1)), int(m.group(2))
    except Exception:
        pass
    try:
        r = subprocess.run(["xdpyinfo"], capture_output=True, text=True, timeout=6)
        if r.returncode == 0 and r.stdout:
            m = _re.search(r"dimensions:\s+(\d+)x(\d+)", r.stdout)
            if m:
                return int(m.group(1)), int(m.group(2))
    except Exception:
        pass
    return None


__all__ = ["IS_WIN", "IS_MAC", "IS_LINUX", "mac_screen_size", "linux_screen_size", "mac_activate"]
