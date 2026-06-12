#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Fix B 绑卡工具(躲 chromedriver 检测)— 按用户指定的【三步分阶段、每步重连读实时坐标】:
#   0) 启动+隐身接管+打开卡表单+【窗口最大化】(整张表单可见,坐标可靠)
#   1) 读 卡号/有效期/CVC/ZIP 坐标 → 脱离chromedriver → pyautogui OS真键鼠逐字段填
#   2) 等页面稳定(Link展开)→ 重连读 'Pay faster next time with Link' 复选框坐标 → 脱离 → OS点【取消勾选】
#   3) 取消后 → 重连读 'Save payment method' 坐标 → 脱离 → OS点保存
#   4) 你只需手动解验证框(I am human/图片)→ 重连核验是否绑成
# 每个 OS 动作(填/取消/保存)都在【零 CDP】下做;只在"读坐标"瞬间短暂重连(读完立刻脱离)。
# 用法: python cardbind/fixb_bind.py <env_id> <卡号> <MMYY> <CVC> <ZIP>
#   例: python cardbind/fixb_bind.py k1dfjybg 4111111111111111 1229 786 59601
import time, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # cardbind/ 下直接跑时让 import common 可解析
import common
from common import NUM, EXP, CVC, ZIP, CREDITS_URL
import pyautogui
from selenium.webdriver.common.by import By
try:
    import pygetwindow as gw
except Exception:
    gw = None


def humantype(s):
    for ch in s:
        pyautogui.typewrite(ch, interval=0)
        time.sleep(random.uniform(0.06, 0.16))


def force_foreground(title_substr="OpenRouter"):
    try:
        import ctypes
        u = ctypes.windll.user32
        hwnd = 0
        if gw:
            ws = [w for w in gw.getAllWindows() if title_substr in (w.title or "")]
            if ws:
                hwnd = ws[0]._hWnd
        if not hwnd:
            return False
        u.ShowWindow(hwnd, 9)
        u.keybd_event(0x12, 0, 0, 0); u.SetForegroundWindow(hwnd); u.keybd_event(0x12, 0, 2, 0)
        time.sleep(0.4)
        return True
    except Exception:
        return False


def _metrics(driver):
    return driver.execute_script(
        "return {dpr:window.devicePixelRatio,sx:window.screenX,sy:window.screenY,"
        "iw:window.innerWidth,ih:window.innerHeight,ow:window.outerWidth,oh:window.outerHeight,"
        "scw:screen.width,sch:screen.height};")


def _to_screen(m, vx, vy):
    border = (m["ow"] - m["iw"]) / 2.0
    topbar = (m["oh"] - m["ih"]) - border
    return int((m["sx"] + border + vx) * m["dpr"]), int((m["sy"] + topbar + vy) * m["dpr"])


def _vc(driver, el):
    return driver.execute_script("var b=arguments[0].getBoundingClientRect();return [b.left+b.width/2,b.top+b.height/2];", el)


def _coords_of(driver, sels, iframe_ok=True):
    """返回字段中心 viewport 坐标(卡字段在单层 iframe → 加 iframe 偏移)。"""
    driver.switch_to.default_content()
    for s in sels:
        for el in driver.find_elements(By.CSS_SELECTOR, s):
            if el.is_displayed():
                return _vc(driver, el)
    if iframe_ok:
        for ifr in driver.find_elements(By.TAG_NAME, "iframe"):
            try:
                ir = driver.execute_script("var b=arguments[0].getBoundingClientRect();return [b.left,b.top];", ifr)
                driver.switch_to.frame(ifr)
                for s in sels:
                    for el in driver.find_elements(By.CSS_SELECTOR, s):
                        if el.is_displayed():
                            c = _vc(driver, el)
                            driver.switch_to.default_content()
                            return [ir[0] + c[0], ir[1] + c[1]]
                driver.switch_to.default_content()
            except Exception:
                driver.switch_to.default_content()
    return None


def _link_checkbox_vc(driver):
    """找 'Pay faster next time with Link' 复选框中心 viewport 坐标(含 iframe 偏移)。"""
    js = r"""
      var cbs=document.querySelectorAll('input[type=checkbox]');
      for(var i=0;i<cbs.length;i++){var b=cbs[i].getBoundingClientRect();
        if(b.width>0&&b.height>0&&b.top>0) return [b.left+b.width/2,b.top+b.height/2];}
      var all=document.querySelectorAll('label,span,div,p');
      for(var j=0;j<all.length;j++){var t=(all[j].textContent||'');
        if(t.indexOf('Pay faster')>=0 && t.length<80){var r=all[j].getBoundingClientRect();
          if(r.width>0) return [r.left-12, r.top+r.height/2];}}
      return null;
    """
    driver.switch_to.default_content()
    r = driver.execute_script(js)
    if r:
        return r
    for ifr in driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            ir = driver.execute_script("var b=arguments[0].getBoundingClientRect();return [b.left,b.top];", ifr)
            driver.switch_to.frame(ifr)
            r = driver.execute_script(js)
            driver.switch_to.default_content()
            if r:
                return [ir[0] + r[0], ir[1] + r[1]]
        except Exception:
            driver.switch_to.default_content()
    return None


def _save_btn_vc(driver, scroll=False):
    driver.switch_to.default_content()
    for b in driver.find_elements(By.CSS_SELECTOR, "button"):
        try:
            if b.is_displayed() and "save" in (b.text or "").lower():
                if scroll:
                    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", b)
                    time.sleep(0.4)
                return _vc(driver, b)
        except Exception:
            pass
    return None


def _reattach(env):
    """不 force_stop,连到在跑的浏览器(短暂重连只为读坐标)。返回 driver。"""
    p = common.adspower_start(env)
    return common.attach_chrome(p, common.resolve_chromedriver(p))


def _detach(driver):
    try:
        driver.service.process.kill()
    except Exception:
        pass
    time.sleep(1)


def main():
    if len(sys.argv) < 6:
        print("用法: python fixb_bind.py <env_id> <卡号> <MMYY> <CVC> <ZIP>"); return
    env, num, exp, cvc, zipc = sys.argv[1:6]
    pyautogui.PAUSE = 0.12

    # ===== 0) 启动 + 隐身接管 + 打开卡表单 + 最大化 =====
    print("0) 启动 + Fix A 隐身接管 %s ..." % env, flush=True)
    port = common.adspower_start(env, force_stop=True)
    for _ in range(25):
        if common._port_ready(port, 2):
            break
        time.sleep(1)
    driver = common.attach_chrome(port, common.resolve_chromedriver(port))
    page = common.Page(driver)
    page.goto(CREDITS_URL, wait=3)
    try:
        from steps import steps_key; steps_key.dismiss_onboarding(page)
    except Exception:
        pass
    page.click_text(["Add a Payment Method", "Add Payment Method"], 12); time.sleep(1.5)
    try:
        page.click_card_tab(6)
    except Exception:
        pass
    if not page.wait_field_present(NUM, 30, "卡号框"):
        print("✗ 卡表单没出来,放弃", flush=True); return

    try:
        driver.maximize_window(); time.sleep(1.2)
        print("   ✓ 窗口已最大化", flush=True)
    except Exception as e:
        print("   ⚠ 最大化失败:", str(e)[:50], flush=True)
    mm = _metrics(driver)
    warn = "  ⚠窗口比指纹屏宽(指纹自相矛盾!)" if mm["iw"] > mm["scw"] else "  ✓窗口装得进指纹屏"
    print("   指纹屏 %sx%s | 视口 %sx%s%s" % (mm["scw"], mm["sch"], mm["iw"], mm["ih"], warn), flush=True)

    # ===== 1) 读 卡号/有效期/CVC/ZIP 坐标 → 脱离 → OS 逐字段填 =====
    print("1) 读 卡号/有效期/CVC/ZIP 坐标...", flush=True)
    m = _metrics(driver)
    card_vc = _coords_of(driver, NUM); exp_vc = _coords_of(driver, EXP)
    cvc_vc = _coords_of(driver, CVC); zip_vc = _coords_of(driver, ZIP)
    if not (card_vc and zip_vc):
        print("✗ 卡号/ZIP 坐标没拿到 card=%s zip=%s" % (bool(card_vc), bool(zip_vc)), flush=True); return
    card_xy = _to_screen(m, card_vc[0], card_vc[1]); zip_xy = _to_screen(m, zip_vc[0], zip_vc[1])
    exp_xy = _to_screen(m, exp_vc[0], exp_vc[1]) if exp_vc else None
    cvc_xy = _to_screen(m, cvc_vc[0], cvc_vc[1]) if cvc_vc else None
    print("   卡号%s 有效期%s CVC%s ZIP%s" % (card_xy, exp_xy, cvc_xy, zip_xy), flush=True)

    print("   脱离 chromedriver(零CDP)→ OS 真键鼠逐字段填...", flush=True)
    _detach(driver)
    force_foreground()
    pyautogui.moveTo(card_xy[0], card_xy[1], duration=0.6); pyautogui.click(); time.sleep(0.4)
    humantype(num); time.sleep(0.7)
    if exp_xy:
        pyautogui.moveTo(exp_xy[0], exp_xy[1], duration=0.4); pyautogui.click(); time.sleep(0.3)
    humantype(exp); time.sleep(0.6)
    if cvc_xy:
        pyautogui.moveTo(cvc_xy[0], cvc_xy[1], duration=0.4); pyautogui.click(); time.sleep(0.3)
    humantype(cvc); time.sleep(0.6)
    pyautogui.moveTo(zip_xy[0], zip_xy[1], duration=0.5); pyautogui.click(); time.sleep(0.3)
    humantype(zipc); time.sleep(0.6)
    print("   ✓ 4 字段填完", flush=True)

    # ===== 2) 等稳定 → 重连读 Link 复选框 → 脱离 → OS 点取消勾选 =====
    print("2) 等页面稳定(Link展开),重连读 Link 复选框坐标...", flush=True)
    time.sleep(2.2)
    d2 = _reattach(env)
    cb_vc = _link_checkbox_vc(d2); m2 = _metrics(d2)
    _detach(d2)
    if cb_vc:
        cb_xy = _to_screen(m2, cb_vc[0], cb_vc[1])
        print("   Link 复选框 %s → OS 点取消勾选" % (cb_xy,), flush=True)
        force_foreground()
        pyautogui.moveTo(cb_xy[0], cb_xy[1], duration=0.5); pyautogui.click(); time.sleep(1.3)
    else:
        print("   ⚠ 没找到 Link 复选框(也许没勾),跳过", flush=True)

    # ===== 3) 重连读 Save 坐标 → 脱离 → OS 点保存 =====
    print("3) 重连读 Save payment method 坐标(取消Link后布局稳)...", flush=True)
    time.sleep(0.8)
    d3 = _reattach(env)
    sv_vc = _save_btn_vc(d3, scroll=True); m3 = _metrics(d3)
    _detach(d3)
    if not sv_vc:
        print("✗ Save 坐标没拿到,放弃", flush=True); return
    sv_xy = _to_screen(m3, sv_vc[0], sv_vc[1])
    print("   Save %s → OS 点保存" % (sv_xy,), flush=True)
    force_foreground()
    pyautogui.moveTo(sv_xy[0], sv_xy[1], duration=0.5); pyautogui.click(); time.sleep(1.5)

    # ===== 4) 人工解验证框 → 重连核验 =====
    print("4) 👉👉 现在【请手动解验证框 I am human / 图片挑战】。我等 130 秒后重连查结果。", flush=True)
    time.sleep(130)
    print("5) 重连查账户是否真挂上卡...", flush=True)
    try:
        d4 = _reattach(env)
        from steps import steps_billing
        bound = steps_billing._card_attached(common.Page(d4))
        print("★★ 绑卡结果: 账户已挂卡 = %s" % bound, flush=True)
    except Exception as e:
        print("重连查结果异常:", str(e)[:80], flush=True)


if __name__ == "__main__":
    main()
