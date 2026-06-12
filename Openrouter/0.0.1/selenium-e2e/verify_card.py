#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 只读校验：打开某环境 → 进信用页 → 看是否真有已保存的付款方式(卡)。不加卡、不扣费。
# 浏览器留开 ~45s 给人肉眼确认。  跑法： python selenium-e2e/verify_card.py [envId]
import sys, os, json, time, re, urllib.request
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

API = os.environ.get("OPENROUTER_ADSPOWER_API", "http://127.0.0.1:50325")
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def g(p, t=60, retries=5):
    last = None
    for i in range(retries):
        try:
            return json.loads(NOPROXY.open(API + p, timeout=t).read())
        except Exception as e:
            last = e; time.sleep(3)
    raise SystemExit("AdsPower 不通: %s" % last)


def log(*a):
    print("[verify]", *a, flush=True)


env = sys.argv[1] if len(sys.argv) > 1 else "k1dd0xih"
try:
    g("/api/v1/browser/stop?user_id=%s" % env, 10, 1)
except Exception:
    pass
j = g("/api/v1/browser/start?user_id=%s&headless=0&open_tabs=1" % env, 90)
port = str((j.get("data") or {}).get("debug_port"))
log("环境 %s 已启动 (debug_port=%s)" % (env, port))

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By

major = ""
try:
    info = json.loads(urllib.request.urlopen("http://127.0.0.1:%s/json/version" % port, timeout=5).read())
    major = info.get("Browser", "").split("/")[-1].split(".")[0]
except Exception:
    pass
dp = os.environ.get("OPENROUTER_CHROMEDRIVER") or ""
if not dp:
    try:
        from selenium.webdriver.common.selenium_manager import SeleniumManager
        args = ["--driver", "chromedriver"] + (["--browser-version", major] if major else [])
        dp = SeleniumManager().binary_paths(args).get("driver_path") or ""
    except Exception:
        dp = ""
opts = Options(); opts.add_experimental_option("debuggerAddress", "127.0.0.1:%s" % port)
time.sleep(6)  # 等浏览器起好再接管
d = None
for i in range(8):
    try:
        d = webdriver.Chrome(service=Service(executable_path=dp), options=opts) if dp else webdriver.Chrome(options=opts)
        break
    except Exception as e:
        log("接管重试 %d/8: %s" % (i + 1, str(e)[:55])); time.sleep(4)
if d is None:
    try: g("/api/v1/browser/stop?user_id=%s" % env, 15, 1)
    except Exception: pass
    raise SystemExit("接管失败(browser not reachable)")
log("Selenium 已接管")

try:
    d.get("https://openrouter.ai/settings/credits")
    time.sleep(10)
    try:
        _bm = re.search(r"\$\s*([\d][\d,]*\.?\d*)", d.find_element(By.TAG_NAME, "body").text or "")
        log("★ 当前余额: $%s" % (_bm.group(1) if _bm else "?"))
    except Exception:
        pass
    # 已保存的卡只在「Add Credits」购买弹窗里显示，不在信用页主面 → 点开它再看。
    log("点「Add Credits」看购买弹窗里的已保存卡…")
    for lab in ["Add Credits", "Buy Credits"]:
        try:
            done = False
            for el in d.find_elements(By.XPATH, "//button[contains(normalize-space(.), '%s')]" % lab):
                if el.is_displayed() and el.is_enabled():
                    el.click(); done = True; break
            if done:
                break
        except Exception:
            pass
    time.sleep(6)
    try:
        d.save_screenshot("selenium-e2e/_credits.png")
        log("已截图(购买弹窗) selenium-e2e/_credits.png")
    except Exception as e:
        log("截图失败:", str(e)[:60])
    body = ""
    try:
        body = d.find_element(By.TAG_NAME, "body").text or ""
    except Exception:
        pass
    has3724 = "3724" in body
    hasMC = bool(re.search(r"mastercard|visa|•{2,}|ending in|\*{2,}\d{4}", body, re.I))
    hasAddBtn = "Add a Payment Method" in body
    log("含「3724」: %s" % has3724)
    log("含 卡片特征(Mastercard/••••/ending): %s" % hasMC)
    log("还显示「Add a Payment Method」按钮: %s" % hasAddBtn)
    log("── 付款方式相关行 ──")
    hit = False
    for line in body.splitlines():
        if re.search(r"3724|mastercard|visa|payment method|•{2,}|ending in|card", line, re.I):
            log("  >>", line.strip()[:90]); hit = True
    if not hit:
        log("  (页面上没匹配到卡/付款方式字样)")
    log("═══════════════════════════════")
    if has3724:
        log("结论: ✅ 看到 ••3724 —— 卡确实保存上了")
    elif hasMC and not hasAddBtn:
        log("结论: 🟡 有卡片特征但没看到 3724(可能脱敏不同/或别的卡)")
    else:
        log("结论: ❌ 没看到已保存的卡(多半没真正存上)")
    log("═══════════════════════════════")
    log("浏览器留开 90s，你自己也看一眼信用页(有没有已保存的卡)…")
    time.sleep(90)
except Exception as e:
    log("✗ 异常:", str(e)[:200])
finally:
    try:
        g("/api/v1/browser/stop?user_id=%s" % env, 15, 1)
    except Exception:
        pass
    log("已关环境")
