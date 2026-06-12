#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Fix C 单号烧卡 CLI（核逻辑在 fixc_core.py）：用【原生CDP的Input可信注入】填卡+点Save，全程零chromedriver。
# 用法: python cardbind/fixc_bind.py <env_id> [<卡号> <MMYY> <CVC> <ZIP>]   不给卡则自动从卡池挑一张干净卡。
import time, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # cardbind/ 下直接跑时让 import common / from cardbind 可解析
import common
from common import NUM, CREDITS_URL
from cardbind import fixc_core


def _pick_clean_card():
    """从卡池挑一张干净卡(active 且 successCount==0 且 usedCount==0)。返回 num,MMYY,cvc,zip,last4。"""
    import json
    d = json.load(open(common.POOL_FILE, encoding="utf-8"))
    if isinstance(d, list):
        cards = d
    elif isinstance(d, dict) and "cards" in d:
        c = d["cards"]; cards = c if isinstance(c, list) else list(c.values())
    elif isinstance(d, dict):
        cards = list(d.values())
    else:
        cards = []

    def _ok(c):
        return (c.get("status") == "active" and c.get("successCount", 0) == 0
                and c.get("usedCount", 0) == 0 and c.get("number"))
    pristine = [c for c in cards if _ok(c) and not c.get("firstUsedAt") and not c.get("lastResult")]
    pick = (pristine or [c for c in cards if _ok(c)])
    if not pick:
        raise RuntimeError("卡池里没有干净卡(active且零使用)")
    c = pick[0]
    exp = "%02d%s" % (int(c["expMonth"]), str(c["expYear"])[-2:])
    zipc = str(c.get("zip") or "59601")   # 多数卡没存zip;59601 是窗口同步实测通用能绑的
    return c["number"], exp, str(c["cvc"]), zipc, str(c.get("last4") or c["number"][-4:])


def bind_one(env, num, exp, cvc, zipc, wait=25, tag="", precheck=True):
    """对单个环境用 Fix C(原生CDP)绑一张卡。返回 {env,last4,bound,captcha,reason}。可被并行跑器多线程调用。"""
    last4 = num[-4:]

    def lg(m):
        print(("[%s] " % tag if tag else "") + m, flush=True)
    res = {"env": env, "last4": last4, "bound": False, "captcha": None, "reason": ""}
    try:
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
        if precheck:
            try:
                from steps import steps_billing as _sb
                if _sb._card_attached(page):
                    res["reason"] = "已有卡(跳过)"; lg("⚠ 已有卡,跳过")
                    try: driver.service.process.kill()
                    except Exception: pass
                    return res
            except Exception:
                pass
        page.click_text(["Add a Payment Method", "Add Payment Method"], 12); time.sleep(1.5)
        try:
            page.click_card_tab(6)
        except Exception:
            pass
        if not page.wait_field_present(NUM, 30, "卡号框"):
            res["reason"] = "卡表单没出来"; lg("✗ 卡表单没出来")
            try: driver.service.process.kill()
            except Exception: pass
            return res

        out = fixc_core.cdp_fill_and_save(driver, num, exp, cvc, zipc, log=lg)   # 内部已 kill driver
        res["captcha"] = out.get("captcha")
        lg("等 %ds 后重连核验..." % wait)
        time.sleep(wait)

        p2 = common.adspower_start(env)
        d2 = common.attach_chrome(p2, common.resolve_chromedriver(p2))
        from steps import steps_billing
        bound = steps_billing._card_attached(common.Page(d2))
        res["bound"] = bool(bound); res["reason"] = "已绑" if bound else "未绑"
        lg("★ 绑卡结果: 账户已挂卡 = %s" % bound)
        try: d2.service.process.kill()
        except Exception: pass
    except Exception as e:
        res["reason"] = "异常:" + str(e)[:60]; lg("异常: " + str(e)[:80])
    return res


def main():
    if len(sys.argv) >= 6:
        env, num, exp, cvc, zipc = sys.argv[1:6]
    elif len(sys.argv) == 2:
        env = sys.argv[1]
        num, exp, cvc, zipc, last4 = _pick_clean_card()
        print("自动选了干净卡 ••%s(zip=%s)" % (last4, zipc), flush=True)
    else:
        print("用法: python fixc_bind.py <env_id> [<卡号> <MMYY> <CVC> <ZIP>]"); return
    bind_one(env, num, exp, cvc, zipc, wait=25)


if __name__ == "__main__":
    main()
