#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · chromedriver 版本匹配 + Selenium 接管 + 隐身(cdc_ 改名/删 webdriver)。
import os
import json
import time
import urllib.request

from .base import log
from .fingerprint_bridge import inject_shared_fingerprint
from .osnative import IS_MAC   # macOS 上 byte-patch 后须 ad-hoc 重签名,否则 Apple Silicon 拒绝执行

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


def _macos_adhoc_sign(path):
    """macOS:对【byte-patch 过】的 chromedriver 副本做 ad-hoc 重签名。
       原 chromedriver 带 Google 有效签名,改写字节后签名即失效 → Apple Silicon 内核 exec 时直接 SIGKILL
       ("code signature invalid")→ attach_chrome 必崩(chmod 0o755 救不了)。先移除失效签名,再
       `codesign --force --sign -`(ad-hoc 签名,内容匹配新字节 → 内核放行)。成功 True;codesign 缺失/失败 False。"""
    import subprocess
    try:
        subprocess.run(["codesign", "--remove-signature", path], capture_output=True, timeout=30)  # 可能本无签名段,失败无妨
        r = subprocess.run(["codesign", "--force", "--sign", "-", path], capture_output=True, timeout=30)
        if r.returncode != 0:
            # ★把 codesign stderr 暴露出来:原来静默吞掉 → arm64 上 chromedriver 被 SIGKILL 时无从定位是签名问题
            try:
                _err = (r.stderr.decode("utf-8", "ignore")[:160] if r.stderr else ("rc=%d" % r.returncode))
                log("[stealth] codesign ad-hoc 重签名失败(Apple Silicon 将 SIGKILL 改写过的 chromedriver):%s" % _err)
            except Exception:
                pass
        return r.returncode == 0
    except Exception:
        return False


def resolve_chromedriver(port):
    """chromedriver 必须匹配 AdsPower Chromium 主版本：查 /json/version → SeleniumManager 按主版本取。"""
    dp = os.environ.get("GLM_CHROMEDRIVER") or ""
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
        import threading as _th
        base = orig_path[:-4] if orig_path.lower().endswith(".exe") else orig_path
        suffix = ".exe" if orig_path.lower().endswith(".exe") else ""
        patched = base + "_stealth" + suffix
        # 写【pid+线程唯一】临时文件 → chmod →(mac)对临时文件重签名 → os.replace 原子替换到 patched。
        # 不就地覆盖 patched 的两个原因:① 并发(maxConcurrency/split 多进程各自空缓存)会同时截断同一个 _stealth →
        #   撕裂的半成品被另一个进程拿去启动;② macOS arm64 的 cs_invalid_page 内核缓存按 inode 记“签名失效”,
        #   就地覆盖复用同 inode 即便重签也可能仍被 SIGKILL(Apple FB8914243/FB8735191)。给 patched 换【新 inode】
        #   (temp→replace)同时解决这两点;os.replace 不改文件内容,签名随之保留有效。
        tmp = "%s_stealth.tmp.%d.%d%s" % (base, os.getpid(), _th.get_ident(), suffix)
        with open(tmp, "wb") as f:
            f.write(out)
        try:
            os.chmod(tmp, 0o755)
        except Exception:
            pass
        # ★macOS:改写字节使原签名失效,Apple Silicon 会拒绝执行未签/签名失效的可执行档 → 对【临时文件】ad-hoc 重签名;
        #   重签失败则【删临时文件、放弃 patch 退回原版驱动】保命(原版 Google 签名有效能跑;接管后的 STEALTH_JS 运行时
        #   注入仍删 webdriver/cdc_,隐身不全丢)。Intel Mac 不强校验,重签也无害。
        if IS_MAC and not _macos_adhoc_sign(tmp):
            log("[stealth] macOS ad-hoc 重签名失败 → 退回原版驱动(运行时 STEALTH_JS 仍生效)")
            try: os.remove(tmp)
            except Exception: pass
            _PATCHED_DRIVER[orig_path] = orig_path
            return orig_path
        try:
            os.replace(tmp, patched)   # 原子替换:patched 指向全新 inode,并发下各 worker 各写各 temp 不互撕
        except Exception:
            # 替换失败(如 Windows 上 patched 正被某个在跑的 driver 占用)→ 清理 temp,退回原版保命
            try: os.remove(tmp)
            except Exception: pass
            log("[stealth] 替换 _stealth 失败(可能被占用)→ 退回原版驱动")
            _PATCHED_DRIVER[orig_path] = orig_path
            return orig_path
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
            inject_shared_fingerprint(d, "glm:%s" % port)
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
