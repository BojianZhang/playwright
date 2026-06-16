#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Selenium 填卡（经 AdsPower debuggerAddress 接管同一浏览器，switch_to.frame 进 Stripe 跨域 iframe）。
# 由 engines/selenium.js 经 child_process 调用。
#   stdin : {"debugPort":int,"number":str,"expiry":str,"cvc":str,"postal":str}
#   stdout: OR_RESULT:{"num":bool,"exp":bool,"cvc":bool,"zip":bool|null,"error":str?}
import sys
import json
import time
import os
import urllib.request

_IS_MAC = (sys.platform == "darwin")   # 跨平台全选:Mac=Cmd+A,Win/Linux=Ctrl+A(Mac Ctrl+A≠全选→卡号残值拼脏 invalid card)

NUM = ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput"]']
EXP = ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput"]']
CVC = ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput"]']
ZIP = ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput"]']


def digits(s):
    return ''.join(ch for ch in str(s if s is not None else '') if ch.isdigit())


def emit(out):
    sys.stdout.write("OR_RESULT:" + json.dumps(out) + "\n")
    sys.stdout.flush()


def main():
    out = {"num": False, "exp": False, "cvc": False, "zip": None}
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        out["error"] = "bad stdin: " + str(e)[:80]
        emit(out)
        return
    port = data.get("debugPort")

    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
    except Exception as e:
        out["error"] = "selenium 未安装: " + str(e)[:100]
        emit(out)
        return

    # chromedriver 必须匹配 AdsPower Chromium 的【主版本】。先经 debug 端口 /json/version 查浏览器精确版本，
    # 再用 Selenium Manager 按【主版本】取匹配 chromedriver（给完整 build 会被拒——CfT 目录里不一定有那个 patch）。
    # 可用 GLM_CHROMEDRIVER 显式指定 chromedriver(.exe) 路径覆盖自动匹配。
    driver_path = os.environ.get("GLM_CHROMEDRIVER") or ""
    if not driver_path:
        major = ""
        try:
            with urllib.request.urlopen("http://127.0.0.1:%s/json/version" % port, timeout=5) as resp:
                info = json.loads(resp.read().decode("utf-8"))
            b = info.get("Browser", "")  # 形如 "Chrome/138.0.7204.50"
            ver = b.split("/")[-1] if "/" in b else ""
            major = ver.split(".")[0] if ver else ""
        except Exception:
            major = ""
        try:
            from selenium.webdriver.common.selenium_manager import SeleniumManager
            args = ["--driver", "chromedriver"]
            if major:
                args += ["--browser-version", major]
            res = SeleniumManager().binary_paths(args)
            driver_path = res.get("driver_path") or ""
        except Exception:
            driver_path = ""

    opts = Options()
    opts.add_experimental_option("debuggerAddress", "127.0.0.1:%s" % port)
    try:
        if driver_path:
            from selenium.webdriver.chrome.service import Service
            driver = webdriver.Chrome(service=Service(executable_path=driver_path), options=opts)
        else:
            driver = webdriver.Chrome(options=opts)
    except Exception as e:
        out["error"] = "连接浏览器失败(chromedriver 版本不匹配?): " + str(e)[:140]
        emit(out)
        return

    def try_fill(sels, value):
        for s in sels:
            try:
                for el in driver.find_elements(By.CSS_SELECTOR, s):
                    if el.is_displayed():
                        el.click()
                        el.send_keys((Keys.COMMAND if _IS_MAC else Keys.CONTROL), 'a')
                        el.send_keys(Keys.DELETE)
                        el.send_keys(str(value))
                        time.sleep(0.2)
                        got = digits(el.get_attribute("value"))
                        if not digits(value) or len(got) >= len(digits(value)):
                            return True
            except Exception:
                continue
        return False

    def fill_in_frames(sels, value):
        if not value:
            return None
        driver.switch_to.default_content()
        if try_fill(sels, value):
            return True
        # Stripe 卡框常在 js.stripe.com iframe（可能再嵌一层）内 → 逐层下钻。
        for fr in driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(fr)
                if try_fill(sels, value):
                    return True
                for ifr in driver.find_elements(By.TAG_NAME, "iframe"):
                    try:
                        driver.switch_to.frame(ifr)
                        if try_fill(sels, value):
                            return True
                        driver.switch_to.parent_frame()
                    except Exception:
                        try:
                            driver.switch_to.parent_frame()
                        except Exception:
                            pass
            except Exception:
                continue
        driver.switch_to.default_content()
        return False

    try:
        out["num"] = bool(fill_in_frames(NUM, data.get("number")))
        out["exp"] = bool(fill_in_frames(EXP, data.get("expiry")))
        out["cvc"] = bool(fill_in_frames(CVC, data.get("cvc")))
        z = data.get("postal")
        out["zip"] = bool(fill_in_frames(ZIP, z)) if z else None
    except Exception as e:
        out["error"] = str(e)[:160]
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
    emit(out)


if __name__ == "__main__":
    main()
