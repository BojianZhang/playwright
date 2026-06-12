#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 单账号编排：新建环境 → 接管 → 注册/登录 → 取Key → 加卡 → 充值 → 改密 → 删环境
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/pipeline.py
#
# 每账号【新建+删除】一个干净 AdsPower 环境(try/finally 保证删)，保证状态干净、不短路全流程。
# ═══════════════════════════════════════════════════════════════════════

import os
import time

import common
from services import adspower_env
from services import captcha
from services import cdp_fetch
from steps import steps_auth
from steps import steps_key
from steps import steps_billing
from services import firstmail
from common import log

# Fix C:加卡默认走【原生CDP Input】(脱 chromedriver 躲 Stripe 检测,实测能绑成);FIXC=0 回退旧 Selenium 填卡路。对齐 hybrid_run.py。
FIXC = os.environ.get("FIXC", "1") != "0"


def _acquire_browser(proxies, start_idx, group_id, name, max_try=5):
    """从 start_idx 起轮询代理池：建环境→启动。代理校验失败(Check Proxy Fail)就删环境换下一个。
    成功返回 (env_id, port, proxy)；连续 max_try 个都失败则抛错。"""
    n = len(proxies)
    tries = min(max_try, n)
    last = ""
    for k in range(tries):
        proxy = proxies[(start_idx + k) % n]
        env_id = None
        try:
            env_id = adspower_env.create_env(name, proxy, group_id)
            port = common.adspower_start(env_id)
            return env_id, port, proxy
        except Exception as e:
            last = str(e)
            log("代理 %s:%s 启动失败(%s)→换下一个代理" % (proxy.get("host"), proxy.get("port"), last[:60]))
            if env_id:                       # 删掉用坏代理建出来的环境，别留垃圾
                try:
                    common.adspower_stop(env_id)
                except Exception:
                    pass
                try:
                    adspower_env.delete_env(env_id)
                except Exception:
                    pass
            time.sleep(1.2)
    raise RuntimeError("连续 %d 个代理都启动失败，最后一个: %s" % (tries, last[:120]))


def _hcaptcha_solve_mode():
    """图片hcaptcha处理:FIXC_SOLVE_HCAPTCHA= on(必解) / off(换卡,原来) / random或不设(每号随机)。
    返回 True=本号遇图片hcaptcha就用 2captcha 当场解(并注 hcaptcha hook,★可能破坏免检会话);False=换卡(原策略)。"""
    import random
    m = (os.environ.get("FIXC_SOLVE_HCAPTCHA") or "random").strip().lower()
    if m in ("1", "on", "true", "yes", "solve"):
        return True
    if m in ("0", "off", "false", "no", "swap"):
        return False
    return random.random() < 0.5


def run_account(acct, proxies, start_idx, group_id, opts, slot=0, slots_total=1):
    """acct={email,mailbox_pw}。proxies=代理池(list)，start_idx=本账号起始代理下标。
    slot/slots_total=并发窗口槽位/总数 → grid_rect 按并发数算每窗分辨率并平铺(默认0/1=单窗全屏)。返回结果 dict。"""
    email = acct["email"]
    mailbox_pw = acct["mailbox_pw"]
    op_pw = opts.get("unified_pw") or mailbox_pw    # OpenRouter 密码：统一密码优先，否则=邮箱密码
    cfg = opts["cfg"]
    res = {"email": email, "ok": False, "steps": {}}
    env_id = None
    driver = None
    patcher = None
    try:
        env_id, port, proxy = _acquire_browser(proxies, start_idx, group_id,
                                               "sel-" + email.split("@")[0][:18])
        res["env_id"] = env_id
        res["proxy"] = "%s:%s" % (proxy.get("host"), proxy.get("port"))
        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
        try:
            common.place_window(driver, common.grid_rect(slot, slots_total))   # 按并发数平铺:slot/总数→网格分辨率+位置
        except Exception:
            pass
        try:
            # 预授剪贴板权限 → 避免页面读剪贴板时弹 Chrome 权限框("…wants to see clipboard")把向导卡死
            driver.execute_cdp_cmd("Browser.grantPermissions", {"permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"]})
        except Exception:
            pass
        captcha.inject_hooks(driver)
        # 图片hcaptcha处理模式(每号一次性决定):FIXC_SOLVE_HCAPTCHA= on(必解)/off(换卡,原来)/random或不设(每号随机)。
        _solve_hcap = _hcaptcha_solve_mode()
        res["hcap_mode"] = "solve" if _solve_hcap else "swap"
        # Turnstile api.js 拦截(等价 Playwright route)：必须在导航到注册页前启动。
        # 仅当本号选了"自动解hcaptcha"才额外注 hcaptcha hook 进 Stripe iframe(★这是破坏免检会话的来源,默认/换卡号不注)。
        _extra = [(("hcaptcha", "api.js"), captcha.WRAPPER_HCAPTCHA)] if _solve_hcap else None
        _inits = [captcha.WRAPPER_HCAPTCHA] if _solve_hcap else None
        patcher = cdp_fetch.TurnstileApiPatcher(port, captcha.WRAPPER_TURNSTILE, log=log,
                                                extra_rules=_extra, init_scripts=_inits)
        patcher.start()
        page = common.Page(driver)
        page.goto(common.KEYS_URL, wait=2)

        auth = steps_auth.register_or_login(page, email, op_pw, mailbox_pw, cfg,
                                            registered=bool(acct.get("registered")))   # 已注册号(历史auth=ok)→直接登录,不再点注册
        res["steps"]["auth"] = auth
        if auth != "ok":
            return res

        if opts.get("do_key", True):
            k = steps_key.get_api_key(page, name=opts.get("key_name"),
                                      expiration=opts.get("key_expiration", "No expiration"))
            res["steps"]["key"] = bool(k.get("ok"))
            res["api_key"] = k.get("key")

        # 记录向导里所选的支付/积分方式(对比"哪种方式绑卡":wizard-address/later-skip · add-credits/skip)
        res["pay_method"] = getattr(page, "_pay_method", None)
        res["credit_method"] = getattr(page, "_credit_method", None)

        if opts.get("do_card"):
            addr = common.rand_address()
            # 【拒付→换卡(+自带新ZIP),不在同卡上换汤不换药】:declined 时禁该卡+排除其BIN,换【不同卡/不同BIN】重试;
            #   同卡换 ZIP 由 FixC 内部小幅兜底(ZIP_RETRY,默认调小),主力是这里换卡。最多换 CARD_SWAP_ON_DECLINE 张(默认3)。
            max_swaps = max(1, int(os.environ.get("CARD_SWAP_ON_DECLINE", "3")))
            tried_ids, tried_bins, r, card = set(), set(), None, None
            for _att in range(max_swaps):
                try:
                    card = common.load_card(email, exclude=tried_ids, exclude_bins=tried_bins,
                                            count_bin=(_att == 0))   # 换卡不重复占 BIN 当日额度
                except RuntimeError as _ce:
                    # load_card 卡池耗尽时是 raise RuntimeError(不是返回 None)→ 当作"无卡可换"break,
                    # 别让异常冒泡到外层 except 把整号(含后续 purchase/changepw/记账)中断。
                    log("[加卡] 无可换的新卡了(已试 %d 张): %s" % (len(tried_ids), str(_ce)[:80])); break
                if not card:
                    log("[加卡] 无可换的新卡了(已试 %d 张)" % len(tried_ids)); break
                r = steps_billing.add_card(page, card, addr, cfg, opts.get("manual_hcaptcha", True),
                                           fill_mode=("cdp" if FIXC else "selenium"),    # 默认 Fix C 原生CDP绑卡(FIXC=0回退旧路)
                                           patcher=patcher, proxy=proxy, solve_hcap=_solve_hcap)   # 图片hcaptcha:本号选解就当场2captcha解,否则换卡
                res["steps"]["card"] = r.get("result")
                res["card_last4"] = card.get("last4")
                res["card_id"] = card.get("id") or card.get("number")
                res["card_hcaptcha"] = bool(r.get("hcaptcha"))   # 标记：本号加卡弹过人机验证
                common.mark_card_result(card, r.get("result"))   # 回写卡池:declined→禁用,成功计数(容量统计)
                if r.get("result") == "declined" and _att + 1 < max_swaps:
                    tried_ids.add(card.get("id") or card.get("number"))
                    _bin = str(card.get("number") or "")[:6]
                    if _bin:
                        tried_bins.add(_bin)
                    log("[加卡] 卡 ••%s 被拒 → 换【不同卡+不同BIN(自带新ZIP)】重试 %d/%d" % (
                        str(card.get("last4") or "")[-4:], _att + 2, max_swaps))
                    continue
                break   # 绑成 / hcaptcha / 其它 → 不再换卡(各自后续逻辑处理)

        if opts.get("do_purchase"):
            r = steps_billing.purchase(page, opts.get("amount", 5), cfg, opts.get("manual_hcaptcha", True))
            res["steps"]["purchase"] = r.get("result")
            res["balance_after"] = r.get("balance_after")

        if opts.get("do_changepw") and opts.get("unified_pw"):
            ok = firstmail.change_mailbox_password(email, mailbox_pw, opts["unified_pw"],
                                                   cfg["mail_key"], cfg["mail_base"])
            res["steps"]["changepw"] = bool(ok)

        res["ok"] = res["steps"].get("auth") == "ok" and res["steps"].get("key", True) is not False
        return res
    except Exception as e:
        res["error"] = str(e)[:200]
        log("账号 %s 异常: %s" % (email, str(e)[:140]))
        return res
    finally:
        try:
            if patcher:
                patcher.stop()
        except Exception:
            pass
        try:
            if driver:
                driver.quit()
        except Exception:
            pass
        if env_id:
            common.adspower_stop(env_id)
            time.sleep(1.5)
            if opts.get("delete_env", True):
                adspower_env.delete_env(env_id)
            else:
                log("保留环境 %s（--no-delete-env）" % env_id)
