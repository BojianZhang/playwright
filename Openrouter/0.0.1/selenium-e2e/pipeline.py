#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 单账号编排：新建环境 → 接管 → 注册/登录 → 取Key → 加卡 → 充值 → 改密 → 删环境
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/pipeline.py
#
# 每账号【新建+删除】一个干净 AdsPower 环境(try/finally 保证删)，保证状态干净、不短路全流程。
# ═══════════════════════════════════════════════════════════════════════

import time

import common
import adspower_env
import captcha
import cdp_fetch
import steps_auth
import steps_key
import steps_billing
import firstmail
from common import log


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


def run_account(acct, proxies, start_idx, group_id, opts):
    """acct={email,mailbox_pw}。proxies=代理池(list)，start_idx=本账号起始代理下标。返回结果 dict。"""
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
        captcha.inject_hooks(driver)
        # Turnstile api.js 拦截(等价 Playwright route)：必须在导航到注册页前启动
        patcher = cdp_fetch.TurnstileApiPatcher(port, captcha.WRAPPER_TURNSTILE, log=log)
        patcher.start()
        page = common.Page(driver)
        page.goto(common.KEYS_URL, wait=2)

        auth = steps_auth.register_or_login(page, email, op_pw, mailbox_pw, cfg)
        res["steps"]["auth"] = auth
        if auth != "ok":
            return res

        if opts.get("do_key", True):
            k = steps_key.get_api_key(page, name=opts.get("key_name"),
                                      expiration=opts.get("key_expiration", "No expiration"))
            res["steps"]["key"] = bool(k.get("ok"))
            res["api_key"] = k.get("key")

        if opts.get("do_card"):
            card = common.load_card(email)        # 给本号分配专属卡(一号一卡,避开 velocity)
            addr = common.rand_address()
            r = steps_billing.add_card(page, card, addr, cfg, opts.get("manual_hcaptcha", True))
            res["steps"]["card"] = r.get("result")
            res["card_last4"] = card.get("last4")
            res["card_id"] = card.get("id") or card.get("number")
            res["card_hcaptcha"] = bool(r.get("hcaptcha"))   # 标记：本号加卡弹过人机验证
            common.mark_card_result(card, r.get("result"))   # 回写卡池:declined→禁用,成功计数(容量统计)

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
