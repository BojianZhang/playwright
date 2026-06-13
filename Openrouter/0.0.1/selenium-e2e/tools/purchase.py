#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 纯 Selenium 充值：用已保存的卡充【最低 $5】，看能否扣费成功。实时打点 + 周期截图 + 充裕等待(5min)。
# ⚠ 真实扣费。防多扣：金额自动设不到 $5 就【不点 Purchase】，改提示你手动设 5 再点，脚本继续监测。
#   跑法： python selenium-e2e/purchase.py [envId] [amount=5]
import sys, os, json, time, re, urllib.request
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

API = os.environ.get("OPENROUTER_ADSPOWER_API", "http://127.0.0.1:50325")
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# AdsPower 鉴权令牌(本机一般无需→空则不加头;远程/带鉴权网关时设 OPENROUTER_ADSPOWER_TOKEN)。
_ADS_TOKEN = (os.environ.get("OPENROUTER_ADSPOWER_TOKEN", "") or "").strip()
_ADS_HDR = {(os.environ.get("OPENROUTER_ADSPOWER_AUTH_HEADER", "Authorization") or "Authorization"): os.environ.get("OPENROUTER_ADSPOWER_AUTH_PREFIX", "Bearer ") + _ADS_TOKEN} if _ADS_TOKEN else {}


def g(p, t=60, retries=5):
    last = None
    for i in range(retries):
        try:
            return json.loads(NOPROXY.open(urllib.request.Request(API + p, headers=_ADS_HDR), timeout=t).read())
        except Exception as e:
            last = e; time.sleep(3)
    raise SystemExit("AdsPower 不通: %s" % last)


def log(*a):
    print("[purchase]", *a, flush=True)


env = sys.argv[1] if len(sys.argv) > 1 else "k1dd0xih"
amount = sys.argv[2] if len(sys.argv) > 2 else "5"

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
from selenium.webdriver.common.keys import Keys

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
        a = ["--driver", "chromedriver"] + (["--browser-version", major] if major else [])
        dp = SeleniumManager().binary_paths(a).get("driver_path") or ""
    except Exception:
        dp = ""
opts = Options(); opts.add_experimental_option("debuggerAddress", "127.0.0.1:%s" % port)
time.sleep(3)
d = None
for i in range(4):
    try:
        d = webdriver.Chrome(service=Service(executable_path=dp), options=opts) if dp else webdriver.Chrome(options=opts)
        break
    except Exception as e:
        log("接管重试 %d/4: %s" % (i + 1, str(e)[:55])); time.sleep(3)
if d is None:
    try: g("/api/v1/browser/stop?user_id=%s" % env, 15, 1)
    except Exception: pass
    raise SystemExit("接管失败")
log("Selenium 已接管")


def shot(name):
    try:
        d.save_screenshot("selenium-e2e/%s" % name); log("已截图 %s" % name)
    except Exception:
        pass


def all_text():
    txt = []
    try:
        d.switch_to.default_content()
        for f in [None] + d.find_elements(By.TAG_NAME, "iframe"):
            try:
                if f is not None:
                    d.switch_to.frame(f)
                txt.append(d.find_element(By.TAG_NAME, "body").text or "")
            except Exception:
                pass
            finally:
                d.switch_to.default_content()
    except Exception:
        pass
    return "\n".join(txt)


def click_text(labels, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        for lab in labels:
            try:
                for el in d.find_elements(By.XPATH, "//button[contains(normalize-space(.), '%s')] | //*[@role='button'][contains(normalize-space(.), '%s')]" % (lab, lab)):
                    if el.is_displayed() and el.is_enabled():
                        el.click(); return True
            except Exception:
                pass
        time.sleep(0.6)
    return False


def balance_now():
    m = re.search(r"\$\s*([\d][\d,]*\.?\d*)", all_text())
    return m.group(1).replace(",", "") if m else ""


try:
    d.get("https://openrouter.ai/settings/credits")
    time.sleep(8)
    bal_before = balance_now()
    log("充值前余额 ~ $%s" % (bal_before or "?"))

    log("点 Add Credits…")
    click_text(["Add Credits", "Buy Credits"], 12)
    time.sleep(5)
    shot("_pur_modal.png")
    if "3724" in all_text():
        log("✓ 购买弹窗里看到已保存卡 ••3724")
    else:
        log("⚠ 没看到 ••3724(卡可能没默认选上)")

    # 设金额 = amount(只在主文档找：金额框在 OpenRouter 弹窗，不在 Stripe iframe)
    log("设置充值金额 = $%s …" % amount)
    d.switch_to.default_content()
    set_ok = False
    for inp in d.find_elements(By.CSS_SELECTOR, "input[type='number'], input[inputmode='numeric'], input[type='text']"):
        try:
            if not inp.is_displayed():
                continue
            v = (inp.get_attribute("value") or "").strip()
            if re.fullmatch(r"\d+(\.\d+)?", v):  # 当前值是纯数字(如 10)= 金额框
                inp.click()
                inp.send_keys(Keys.CONTROL, "a"); inp.send_keys(Keys.DELETE)
                inp.send_keys(str(amount))
                time.sleep(0.6)
                nv = (inp.get_attribute("value") or "").strip()
                if nv == str(amount) or nv.startswith(str(amount)):
                    set_ok = True; break
        except Exception:
            continue
    log("金额设置成功 = %s" % set_ok)
    shot("_pur_amount.png")

    if set_ok:
        log("点 Purchase($%s)…" % amount)
        click_text(["Purchase", "Pay now", "Confirm"], 10)
    else:
        log("⚠ 金额没能自动设成 $%s —— 防多扣，我【不点 Purchase】。请你在弹窗里手动把金额改成 %s、再点 Purchase；我继续实时监测结果。" % (amount, amount))

    time.sleep(4)
    if "hcaptcha" in (d.page_source or "").lower():
        log("⚠ 出现 hCaptcha —— 请在浏览器里手动完成验证。")
    log("⚠ 若弹出银行 3D Secure(短信/密码验证)，也请手动完成。")

    log("════ 实时监测充值结果(最多 5 分钟，每 30s 截图+心跳) ════")
    RE_OK = re.compile(r"payment is processing|credits will be added|check back shortly|succeeded|payment successful|purchase complete|thank you", re.I)
    RE_502 = re.compile(r"error\s*5\d\d|unable to authenticate|bad gateway", re.I)
    RE_DECL = re.compile(r"card was declined|insufficient funds|declined|payment failed|could not complete|do not honor", re.I)
    outcome = "unknown(超时)"
    start = time.time(); end = start + 300; last = 0
    while time.time() < end:
        t = all_text()
        if RE_OK.search(t):
            outcome = "✅ 充值成功(成功文案)"; break
        if RE_502.search(t):
            outcome = "❌ 502/网关(环境或卡被风控)"; break
        if RE_DECL.search(t):
            outcome = "❌ 卡被拒/支付失败"; break
        bn = balance_now()
        if bn and bal_before is not None and bn != bal_before:
            try:
                if float(bn) > float(bal_before or 0):
                    outcome = "✅ 充值成功(余额 $%s → $%s)" % (bal_before, bn); break
            except Exception:
                pass
        if time.time() - last > 30:
            last = time.time(); log("…监测中(已等 %ds)，余额迹象 $%s" % (int(time.time() - start), bn or "?")); shot("_pur_wait.png")
        time.sleep(3)
    shot("_pur_final.png")
    log("═══════════════════════════════")
    log("充值结果: %s" % outcome)
    d.get("https://openrouter.ai/settings/credits"); time.sleep(6)
    log("复核充值后余额: $%s" % (balance_now() or "?"))
    shot("_pur_balance.png")
    log("═══════════════════════════════")
    log("浏览器留开 75s，你也看一眼…")
    time.sleep(75)
except Exception as e:
    log("✗ 异常:", str(e)[:200])
finally:
    try:
        g("/api/v1/browser/stop?user_id=%s" % env, 15, 1)
    except Exception:
        pass
    log("已关环境")
