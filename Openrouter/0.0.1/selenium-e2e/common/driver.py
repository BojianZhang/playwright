#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · chromedriver 版本匹配 + Selenium 接管 + 隐身(cdc_ 改名/删 webdriver)。
import os
import json
import time
import urllib.request

from .base import log

# 隐身脚本(Page.addScriptToEvaluateOnNewDocument 在页面脚本前注入,每次导航生效):
# 删 navigator.webdriver 属性(让 'webdriver' in navigator 为 False)+ 删残留 cdc_ 变量(二进制改名的双保险)。
STEALTH_JS = r"""
(function(){
  try { delete Navigator.prototype.webdriver; } catch(e){}
  try { delete navigator.webdriver; } catch(e){}
  try {
    var ks = Object.getOwnPropertyNames(window);
    for (var i=0;i<ks.length;i++){ if (ks[i].indexOf('cdc_')===0){ try{ delete window[ks[i]]; }catch(e){} } }
  } catch(e){}
})();
"""

_PATCHED_DRIVER = {}   # {原路径: 改好路径} 缓存,避免每次接管都改


def resolve_chromedriver(port):
    """chromedriver 必须匹配 AdsPower Chromium 主版本：查 /json/version → SeleniumManager 按主版本取。"""
    dp = os.environ.get("OPENROUTER_CHROMEDRIVER") or ""
    if dp:
        return dp
    major = ""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%s/json/version" % port, timeout=5) as resp:
            info = json.loads(resp.read().decode("utf-8"))
        ver = info.get("Browser", "").split("/")[-1]
        major = ver.split(".")[0] if ver else ""
    except Exception:
        major = ""
    try:
        from selenium.webdriver.common.selenium_manager import SeleniumManager
        args = ["--driver", "chromedriver"] + (["--browser-version", major] if major else [])
        return SeleniumManager().binary_paths(args).get("driver_path") or ""
    except Exception:
        return ""


def _port_ready(port, timeout=8):
    """轮询调试端口 /json/version,通了就返回(通常 <1s),取代盲 sleep。"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%s/json/version" % port, timeout=2) as r:
                if getattr(r, "status", 200) == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def _patch_chromedriver(orig_path):
    """二进制改 chromedriver:把 'cdc_adoQpoasnfa76pfcZLmcfl_' 这串 Selenium 招牌名整体替换成
       【同长度随机串】,让 hCaptcha 扫不到已知 cdc_ 特征(undetected-chromedriver 核心招)。
       返回改好的副本路径;失败/无此串则原样返回。STEALTH=0 时上层不调用。"""
    if not orig_path or not os.path.exists(orig_path):
        return orig_path
    if orig_path in _PATCHED_DRIVER and os.path.exists(_PATCHED_DRIVER[orig_path]):
        return _PATCHED_DRIVER[orig_path]
    try:
        data = open(orig_path, "rb").read()
        sig = b"cdc_adoQpoasnfa76pfcZLmcfl_"
        if sig not in data:
            _PATCHED_DRIVER[orig_path] = orig_path
            log("[stealth] chromedriver 里没找到 cdc_ 招牌串(可能已改/别版本)→ 用原版")
            return orig_path
        import random as _r, string as _s
        repl = ("".join(_r.choice(_s.ascii_lowercase) for _ in range(len(sig) - 1)) + b"_".decode()).encode()
        out = data.replace(sig, repl)
        base = orig_path[:-4] if orig_path.lower().endswith(".exe") else orig_path
        patched = base + "_stealth" + (".exe" if orig_path.lower().endswith(".exe") else "")
        with open(patched, "wb") as f:
            f.write(out)
        try:
            os.chmod(patched, 0o755)
        except Exception:
            pass
        _PATCHED_DRIVER[orig_path] = patched
        log("[stealth] chromedriver cdc_ 招牌名已替换 → %s" % os.path.basename(patched))
        return patched
    except Exception as e:
        log("[stealth] chromedriver 改写失败(忽略,用原版): %s" % str(e)[:60])
        _PATCHED_DRIVER[orig_path] = orig_path
        return orig_path


def attach_chrome(port, driver_path="", retries=8, delay=4):
    """经 debuggerAddress 接管 AdsPower 浏览器（刚启动可能没就绪 → 先轮询端口就绪,再重试接管）。
       STEALTH=1(默认)时:用改过 cdc_ 名的 chromedriver + 接管后注入隐身脚本(删 webdriver/cdc_),
       降低被 Stripe/hCaptcha 检测为自动化的概率(实测纯接管会泄漏 cdc_/webdriver)。"""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    stealth = os.environ.get("STEALTH", "1") != "0"
    if stealth and driver_path:
        driver_path = _patch_chromedriver(driver_path)
    opts = Options()
    opts.add_experimental_option("debuggerAddress", "127.0.0.1:%s" % port)
    if not _port_ready(port, 8):
        log("调试端口 %s 8s 内未就绪,仍尝试接管" % port)   # 取代固定 sleep(4):就绪即走,通常省 ~3s
    last = None
    for i in range(retries):
        try:
            d = (webdriver.Chrome(service=Service(executable_path=driver_path), options=opts)
                 if driver_path else webdriver.Chrome(options=opts))
            # ★ 全局超时:不设的话 d.get()/execute_script 遇到挂起导航或不响应的跨域 iframe 会【无限阻塞】
            #   ——没日志、没进展、永远卡死(取 Key 向导循环全靠 execute_script,正是高发区)。
            #   设了之后超时抛 TimeoutException,被各处 try/except 接住 → 循环继续推进/快速失败,绝不干挂。
            try:
                d.set_page_load_timeout(float(os.environ.get("SEL_PAGELOAD_TIMEOUT", "60")))
                d.set_script_timeout(float(os.environ.get("SEL_SCRIPT_TIMEOUT", "30")))
            except Exception as _te:
                log("[timeout] 设置全局超时失败(忽略): %s" % str(_te)[:50])
            log("Selenium 已接管(debuggerAddress 127.0.0.1:%s)%s" % (port, " [stealth]" if stealth else ""))
            if stealth:
                try:
                    d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": STEALTH_JS})
                except Exception as _e:
                    log("[stealth] 注入隐身脚本失败(忽略): %s" % str(_e)[:50])
            return d
        except Exception as e:
            last = e
            log("接管重试 %d/%d: %s" % (i + 1, retries, str(e)[:55]))
            time.sleep(delay)
    raise RuntimeError("接管失败: %s" % (str(last)[:100]))


__all__ = [
    "STEALTH_JS", "_PATCHED_DRIVER",
    "resolve_chromedriver", "_port_ready", "_patch_chromedriver", "attach_chrome",
]
