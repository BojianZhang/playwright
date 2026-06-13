#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 纯 Selenium 端到端加卡（Playwright 完全不参与）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/addcard.py
#
# 目的：把"是不是 Playwright 的问题"这一格补上——整条加卡流程【只用 Selenium】驱动 AdsPower 浏览器：
#   AdsPower 启动环境 → Selenium 经 debuggerAddress 接管 → 进信用页 → 加卡入口 → 填账单地址 → 填卡
#   → 点 Save → hCaptcha 由你手动过(有头) → 判定结果(card-bound / 502 / declined)。
#
# 作用域(诚实)：
#   · 假设该环境【已登录】OpenRouter(我们的环境都有会话)。本脚本不做登录——登录要 Turnstile+收信，
#     那是另一套，且 502 不在登录这步。若未登录，脚本会提示先登录。
#   · hCaptcha 走【人工】(你在弹出的浏览器里点)，避免 2captcha 求解质量成为变量。
#   · 卡从 data/card-pool.json(已 gitignore，含完整卡号)读第一张可用卡 —— 脚本本身不含卡号。
#
# 跑法：  python selenium-e2e/addcard.py <envId>
#   例：  python selenium-e2e/addcard.py k1dd0xih
# 依赖：  selenium(已装) + AdsPower 本地 API 在线；chromedriver 自动按浏览器主版本匹配。
# ═══════════════════════════════════════════════════════════════════════

import sys
import os
import json
import time
import random
import urllib.request

# Windows 控制台默认 GBK，直接 print '••'/中文可能崩 → 强制 utf-8 输出(不可编码字符替换，绝不崩)。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 默认用 127.0.0.1（不是 local.adspower.net）：后者不在系统代理绕过名单里，若开了本地代理(VPN/clash)
# Python urllib 会把请求经代理 → 代理转不到本地 AdsPower → 回 502。127.0.0.1 默认绕过代理，直连。
API_BASE = os.environ.get("OPENROUTER_ADSPOWER_API", "http://127.0.0.1:50325")
# 再加一道保险：强制【不走任何系统代理】调 AdsPower(本地服务，经代理必 502)。
_NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
# AdsPower 鉴权令牌(本机网关一般无需→空则不加头;指向远程/带鉴权网关时设 OPENROUTER_ADSPOWER_TOKEN)。
_ADS_TOKEN = (os.environ.get("OPENROUTER_ADSPOWER_TOKEN", "") or "").strip()
_ADS_AUTH_HEADER = os.environ.get("OPENROUTER_ADSPOWER_AUTH_HEADER", "Authorization") or "Authorization"
_ADS_AUTH_PREFIX = os.environ.get("OPENROUTER_ADSPOWER_AUTH_PREFIX", "Bearer ")
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tools/→父目录 selenium-e2e(移动后锚定,与移动前同值)
POOL_FILE = os.path.join(HERE, "..", "data", "card-pool.json")
CREDITS_URL = "https://openrouter.ai/settings/credits"

NUM = ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput"]']
EXP = ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput"]']
CVC = ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput"]']
ZIP = ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput"]']


def log(*a):
    print("[sel-e2e]", *a, flush=True)


def api_get(path, timeout=60, retries=5):
    # AdsPower 本地网关在频繁 start/stop 后会回 502 / 连接重置(限频或浏览器管理层抖动)→ 退避重试。
    last = None
    _hdr = {_ADS_AUTH_HEADER: _ADS_AUTH_PREFIX + _ADS_TOKEN} if _ADS_TOKEN else {}
    for i in range(retries):
        try:
            with _NOPROXY.open(urllib.request.Request(API_BASE + path, headers=_hdr), timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            log("AdsPower API 抖动(%s)，%ss 后重试 %d/%d" % (str(e)[:50], 3 + i * 2, i + 1, retries))
            time.sleep(3 + i * 2)
    raise last


def adspower_start(env_id):
    # 先尝试关一次（清残留），再启动。stop 是 best-effort：不重试(失败就算了，别白等)。
    try:
        api_get("/api/v1/browser/stop?user_id=%s" % env_id, 10, retries=1)
    except Exception:
        pass
    j = api_get("/api/v1/browser/start?user_id=%s&headless=0&open_tabs=1" % env_id, 90)
    if not j or j.get("code") != 0:
        raise RuntimeError("AdsPower 启动失败: %s" % (j.get("msg") if j else "无响应"))
    port = (j.get("data") or {}).get("debug_port")
    if not port:
        raise RuntimeError("AdsPower 未返回 debug_port")
    log("AdsPower 环境 %s 已启动 (debug_port=%s)" % (env_id, port))
    return str(port)


def adspower_stop(env_id):
    try:
        api_get("/api/v1/browser/stop?user_id=%s" % env_id, 15)
    except Exception:
        pass


def resolve_chromedriver(port):
    """chromedriver 必须匹配 AdsPower Chromium 主版本：查 /json/version → SeleniumManager 按主版本取。"""
    driver_path = os.environ.get("OPENROUTER_CHROMEDRIVER") or ""
    if driver_path:
        return driver_path
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
        args = ["--driver", "chromedriver"]
        if major:
            args += ["--browser-version", major]
        return SeleniumManager().binary_paths(args).get("driver_path") or ""
    except Exception:
        return ""


def load_card():
    with open(POOL_FILE, "r", encoding="utf-8") as f:
        pool = json.load(f)
    for c in pool if isinstance(pool, list) else []:
        if c.get("status") == "active" and (c.get("usedCount", 0) < c.get("maxUses", 1)):
            return c
    raise RuntimeError("卡池无可用卡(data/card-pool.json 里没有 active 且有余次的卡)")


def rand_address():
    first = random.choice(["Mark", "Karen", "Thomas", "Laura", "Brian", "Nancy", "Kevin", "Susan"])
    last = random.choice(["Lopez", "Robinson", "Flores", "Bennett", "Sanders", "Hughes", "Coleman"])
    # 免税州 + 【该州真实城市 + 配套邮编】—— city/state/zip 必须成套，错配本身会被 Radar 加风险分。
    state, city, zc = random.choice([
        ("Montana", "Billings", "59101"), ("Montana", "Helena", "59601"),
        ("Oregon", "Salem", "97301"), ("Oregon", "Portland", "97201"),
        ("New Hampshire", "Nashua", "03063"), ("New Hampshire", "Concord", "03301"),
        ("Delaware", "Dover", "19901"), ("Delaware", "Wilmington", "19801"),
    ])
    return {
        "name": "%s %s" % (first, last),
        "line1": "%d %s" % (random.randint(100, 9000), random.choice(["E 5th Ave", "Birch Ter", "S Cedar Way", "Pine St", "Oak Dr", "Maple Ln"])),
        "city": city,
        "country": "United States",
        "state": state,
        "zip": zc,
    }


def digits(s):
    return "".join(ch for ch in str(s if s is not None else "") if ch.isdigit())


def main():
    if len(sys.argv) < 2:
        log("用法: python selenium-e2e/addcard.py <envId>")
        sys.exit(2)
    env_id = sys.argv[1]

    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support.ui import Select
    except Exception as e:
        log("selenium 未安装:", str(e)[:120]); sys.exit(1)

    card = load_card()
    addr = rand_address()
    log("用卡 ••%s  地址 %s / %s, %s %s" % (card.get("last4"), addr["name"], addr["city"], addr["state"], addr["zip"]))

    port = adspower_start(env_id)
    driver_path = resolve_chromedriver(port)
    opts = Options()
    opts.add_experimental_option("debuggerAddress", "127.0.0.1:%s" % port)
    try:
        driver = webdriver.Chrome(service=Service(executable_path=driver_path), options=opts) if driver_path \
            else webdriver.Chrome(options=opts)
    except Exception as e:
        log("接管浏览器失败(chromedriver?):", str(e)[:160]); adspower_stop(env_id); sys.exit(1)
    log("Selenium 已接管(debuggerAddress 127.0.0.1:%s)" % port)

    def all_frames_text():
        txt = []
        try:
            driver.switch_to.default_content()
            for f in [None] + driver.find_elements(By.TAG_NAME, "iframe"):
                try:
                    if f is not None:
                        driver.switch_to.frame(f)
                    txt.append(driver.find_element(By.TAG_NAME, "body").text or "")
                except Exception:
                    pass
                finally:
                    driver.switch_to.default_content()
        except Exception:
            pass
        return "\n".join(txt)

    def click_text(labels, timeout=8):
        end = time.time() + timeout
        while time.time() < end:
            for lab in labels:
                try:
                    els = driver.find_elements(By.XPATH, "//button[contains(normalize-space(.), '%s')] | //*[@role='button'][contains(normalize-space(.), '%s')]" % (lab, lab))
                    for el in els:
                        if el.is_displayed() and el.is_enabled():
                            el.click()
                            return True
                except Exception:
                    pass
            time.sleep(0.6)
        return False

    def fill_in_frames(sels, value):
        if not value:
            return None
        want = digits(value)
        for _ in range(2):
            driver.switch_to.default_content()
            if _try_fill(driver, By, Keys, sels, value, want):
                return True
            for fr in driver.find_elements(By.TAG_NAME, "iframe"):
                try:
                    driver.switch_to.default_content(); driver.switch_to.frame(fr)
                    if _try_fill(driver, By, Keys, sels, value, want):
                        return True
                    for ifr in driver.find_elements(By.TAG_NAME, "iframe"):
                        try:
                            driver.switch_to.frame(ifr)
                            if _try_fill(driver, By, Keys, sels, value, want):
                                return True
                            driver.switch_to.parent_frame()
                        except Exception:
                            try: driver.switch_to.parent_frame()
                            except Exception: pass
                except Exception:
                    continue
            time.sleep(0.5)
        driver.switch_to.default_content()
        return False

    def select_in_frames(sels, label):
        driver.switch_to.default_content()
        for f in [None] + driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                if f is not None:
                    driver.switch_to.frame(f)
                for s in sels:
                    for el in driver.find_elements(By.CSS_SELECTOR, s):
                        try:
                            Select(el).select_by_visible_text(label); driver.switch_to.default_content(); return True
                        except Exception:
                            pass
            except Exception:
                pass
            finally:
                driver.switch_to.default_content()
        return False

    # ── 显式等待：绝不抢在表单加载完成前填 ──
    def wait_page_loaded(timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if driver.execute_script("return document.readyState") == "complete":
                    return True
            except Exception:
                pass
            time.sleep(0.5)
        return False

    def field_present(sels):
        # 跨帧只读探测：有没有【可见】的匹配字段(不填)
        driver.switch_to.default_content()
        try:
            for fr in [None] + driver.find_elements(By.TAG_NAME, "iframe"):
                try:
                    if fr is not None:
                        driver.switch_to.frame(fr)
                    for s in sels:
                        for el in driver.find_elements(By.CSS_SELECTOR, s):
                            if el.is_displayed():
                                return True
                except Exception:
                    pass
                finally:
                    driver.switch_to.default_content()
        except Exception:
            pass
        return False

    def wait_field_present(sels, timeout=30, label="字段"):
        end = time.time() + timeout
        while time.time() < end:
            if field_present(sels):
                return True
            time.sleep(0.6)
        log("  ✗ 等【%s】出现超时(%ss)" % (label, timeout))
        return False

    def wait_and_fill(sels, value, timeout=15, label="字段"):
        # 等字段【出现且可见】再填，填不上就重试到超时——保证每一行都在加载好之后才填、且确实填上。
        if value is None or value == "":
            return None
        end = time.time() + timeout
        while time.time() < end:
            if field_present(sels) and fill_in_frames(sels, value):
                log("  ✓ %s 已填" % label)
                return True
            time.sleep(0.6)
        log("  ✗ %s 超时未填上(字段没出现/没加载好)" % label)
        return False

    def wait_and_select(sels, label_text, timeout=12, label="下拉"):
        end = time.time() + timeout
        while time.time() < end:
            if field_present(sels) and select_in_frames(sels, label_text):
                log("  ✓ %s 已选(%s)" % (label, label_text))
                return True
            time.sleep(0.6)
        log("  ✗ %s 超时未选上" % label)
        return False

    try:
        driver.get(CREDITS_URL)
        wait_page_loaded(20)
        time.sleep(2)
        if "/sign-in" in driver.current_url or "/sign-up" in driver.current_url:
            log("✗ 该环境未登录 OpenRouter。本脚本只跑【已登录】环境的加卡部分——请先用主流程登录该环境再来。")
            return

        log("点「Add a Payment Method」…")
        click_text(["Add a Payment Method", "Add Payment Method"], 12)

        ADDR_NAME = ['input[name="name"]', 'input[autocomplete="name"]', 'input[placeholder*="Full name" i]']
        # 等弹窗里【地址表单 或 卡表单】任一就绪，再决定填哪个(最多 30s；绝不抢在加载完成前填)
        log("等弹窗表单加载…")
        wait_field_present(ADDR_NAME + NUM, 30, "地址或卡表单")

        # 有地址表单 → 逐字段【等到出现再填】，每一行都确认填上(✓/✗ 逐行打印)
        if field_present(ADDR_NAME):
            log("填账单地址(逐字段等待)…")
            wait_and_fill(ADDR_NAME, addr["name"], 12, "姓名")
            wait_and_select(['select[name="country"]', 'select[autocomplete="country"]'], addr["country"], 10, "国家")
            wait_and_fill(['input[name="addressLine1"]', 'input[name="line1"]', 'input[autocomplete="address-line1"]'], addr["line1"], 12, "地址行1")
            wait_and_fill(['input[name="locality"]', 'input[name="city"]', 'input[autocomplete="address-level2"]'], addr["city"], 12, "城市")
            wait_and_select(['select[name="administrativeArea"]', 'select[autocomplete="address-level1"]'], addr["state"], 10, "州")
            wait_and_fill(['input[name="postalCode"]', 'input[autocomplete="postal-code"]'], addr["zip"], 12, "邮编")
            time.sleep(0.5)
            click_text(["Update Address", "Save address", "Add address", "Continue"], 6)
        else:
            log("无地址表单(地址已存)，跳过地址步")

        # 等卡表单【卡号框出现且可见】再逐字段填
        log("等卡表单…")
        ready = wait_field_present(NUM, 30, "卡号框")
        log("卡表单就绪 = %s" % ready)
        if not ready:
            log("✗ 没等到卡表单(账号状态/弹窗布局变了)"); return

        log("Selenium 逐字段填卡(等到出现再填)…")
        n = wait_and_fill(NUM, card["number"], 15, "卡号")
        e = wait_and_fill(EXP, "%s%s" % (card["expMonth"], card["expYear"]), 12, "有效期")
        c = wait_and_fill(CVC, card["cvc"], 12, "CVC")
        z = wait_and_fill(ZIP, card.get("zip") or addr["zip"], 12, "卡邮编")
        log("填卡结果: 卡号=%s 有效期=%s CVC=%s 邮编=%s" % (bool(n), bool(e), bool(c), bool(z)))
        if not (n and e and c):
            log("⚠ 有字段没填上(等待超时)，仍试 Save")

        # 取消勾选「Save my information with Link」—— 它在 Stripe 的 iframe 里(可能再嵌一层)，必须【跨帧下钻】去取消，
        # 否则 Link 勾着会要求填 Mobile number → Error 400「Please provide a mobile phone number」→ 卡根本存不上。
        def _uncheck_here():
            cnt = 0
            for cb in driver.find_elements(By.CSS_SELECTOR, "input[type=checkbox]"):
                try:
                    if cb.is_selected():
                        try:
                            cb.click()
                        except Exception:
                            driver.execute_script("arguments[0].click()", cb)
                        cnt += 1
                except Exception:
                    pass
            return cnt
        nu = 0
        driver.switch_to.default_content()
        nu += _uncheck_here()
        for fr in driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                driver.switch_to.default_content(); driver.switch_to.frame(fr)
                nu += _uncheck_here()
                for ifr in driver.find_elements(By.TAG_NAME, "iframe"):
                    try:
                        driver.switch_to.frame(ifr); nu += _uncheck_here(); driver.switch_to.parent_frame()
                    except Exception:
                        try: driver.switch_to.parent_frame()
                        except Exception: pass
            except Exception:
                pass
        driver.switch_to.default_content()
        log("取消勾选 %d 个(含 Link「保存信息」)" % nu)
        time.sleep(1.5)  # 取消 Link 后 Email/Mobile 字段会消失，等一下再 Save

        log("点 Save…")
        click_text(["Save payment method", "Save"], 8)

        # hCaptcha 人工：若出现，提示你在浏览器里手动过
        time.sleep(3)
        if "hcaptcha" in (driver.page_source or "").lower():
            log("⚠ 检测到 hCaptcha —— 请在弹出的浏览器里【手动完成验证】，完成后脚本会自动判定（最多等 180s）。")

        # 判定：轮询页面文案
        log("等待结果(轮询 502 / declined / 成功)…")
        import re
        RE_502 = re.compile(r"error\s*5\d\d|unable to authenticate|bad gateway", re.I)
        RE_DECL = re.compile(r"card was declined|insufficient funds|incorrect|declined|expired", re.I)
        RE_OK = re.compile(r"payment is processing|credits will be added|check back shortly|payment method added", re.I)
        RE_NEEDPHONE = re.compile(r"provide a mobile phone|provide a phone number", re.I)
        outcome = "unknown"
        end = time.time() + 180
        while time.time() < end:
            t = all_frames_text()
            if RE_502.search(t): outcome = "server-error(502)"; break
            if RE_NEEDPHONE.search(t): outcome = "Error400-还要手机号(Link没取消干净) → 卡没存上"; break
            if RE_DECL.search(t): outcome = "declined"; break
            if RE_OK.search(t): outcome = "success/card-bound"; break
            # 真·存上的判定(修掉之前的误报)：卡号框【在 iframe 里】真的消失 且 弹窗标题/标签都没了。
            if (not field_present(NUM)) and ("Add a Payment Method" not in t) and ("Card number" not in t):
                outcome = "card-bound(弹窗关闭·卡表单消失)"; break
            time.sleep(2)
        log("═══════════════════════════════")
        log("结果: %s" % outcome)
        log("═══════════════════════════════")
    except Exception as e:
        log("✗ 异常:", str(e)[:200])
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
        adspower_stop(env_id)
        log("结束（已关闭环境，未扣费）。")


def _try_fill(driver, By, Keys, sels, value, want):
    for s in sels:
        try:
            for el in driver.find_elements(By.CSS_SELECTOR, s):
                if el.is_displayed():
                    el.click()
                    el.send_keys(Keys.CONTROL, "a"); el.send_keys(Keys.DELETE)
                    el.send_keys(str(value))
                    time.sleep(0.2)
                    got = digits(el.get_attribute("value"))
                    if not want or len(got) >= len(want):
                        return True
        except Exception:
            continue
    return False


if __name__ == "__main__":
    main()
