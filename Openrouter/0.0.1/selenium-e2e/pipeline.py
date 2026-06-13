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


def _ck(checkpoint, email, stage, status, **prod):
    """把一个阶段写进 checkpoint 的 stages 子树(run.py.save_progress 识别 _stage)。
    stage∈register/login/key/address/card/charge/changepw;status="ok"=已完成可跳过;prod=该阶段产物(api_key/card_last4/amount...)。"""
    if not checkpoint:
        return
    try:
        obj = dict(status=status, at=time.strftime("%Y-%m-%d %H:%M:%S"))
        obj.update({k: v for k, v in prod.items() if v not in (None, "")})
        checkpoint(email, _stage=(stage, obj))
    except Exception:
        pass


def _prior_done(acct, stage):
    """续跑判定:该号 prior 进度里 stage 是否已 status==ok(可跳过/复用)。"""
    pst = ((acct.get("prior") or {}).get("stages") or {}).get(stage) or {}
    return pst.get("status") == "ok"


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


def run_account(acct, proxies, start_idx, group_id, opts, slot=0, slots_total=1, checkpoint=None):
    """acct={email,mailbox_pw}。proxies=代理池(list)，start_idx=本账号起始代理下标。
    slot/slots_total=并发窗口槽位/总数 → grid_rect 按并发数算每窗分辨率并平铺(默认0/1=单窗全屏)。返回结果 dict。
    checkpoint(email, **fields):可选增量存盘回调(run.py 传 save_progress)——一到里程碑(注册成功/拿到key)就落盘,
    中途被杀/异常也不丢"已注册"事实,下次直接登录不重注册。"""
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
        if auth == "ok" and checkpoint:
            # 注册/登录一成功就存盘:之后任何一步崩/被杀,重跑也知道这号已注册 → 直接登录,不再重注册(号已存在会卡 verify)。
            try:
                checkpoint(email, registered=True, env_id=env_id)
            except Exception:
                pass
            _ck(checkpoint, email, "login" if acct.get("registered") else "register", "ok")
        if auth != "ok":
            return res

        prior_key = acct.get("prior_key") or (acct.get("prior") or {}).get("api_key")
        if opts.get("do_key", True):
            # ★止血#1:已取到过 key(prior 有 api_key)→ 直接复用,绝不重新建 key。
            #   原来无条件 get_api_key() → 同邮箱在新版向导重复建 key(白跑+留孤儿key)。这是"第二次还创建KEY"的根因。
            #   【只看 prior_key 存在,不再 AND stages.key】:老 checkpoint 只有 api_key 没 stages 子树时,
            #   AND stages.key 会假阴性→落 else 重建第二把 key(与 hybrid_run.py 无条件复用对齐)。
            if prior_key:
                res["steps"]["key"] = True
                res["api_key"] = prior_key
                res["key_reused"] = True
                log("[续跑] %s 复用已有 key(跳过取key,不重复建)" % email)
            else:
                k = steps_key.get_api_key(page, name=opts.get("key_name"),
                                          expiration=opts.get("key_expiration", "No expiration"))
                res["steps"]["key"] = bool(k.get("ok"))
                res["api_key"] = k.get("key")
                if checkpoint and k.get("key"):
                    try:
                        checkpoint(email, registered=True, api_key=k.get("key"))
                    except Exception:
                        pass
                    _ck(checkpoint, email, "key", "ok", api_key=k.get("key"), key_name=k.get("name"))

        # 记录向导里所选的支付/积分方式(对比"哪种方式绑卡":wizard-address/later-skip · add-credits/skip)
        res["pay_method"] = getattr(page, "_pay_method", None)
        res["credit_method"] = getattr(page, "_credit_method", None)

        if opts.get("do_card") and _prior_done(acct, "card"):
            # ★已绑卡(prior stages.card=ok)→ 跳过加卡,省一整段绑卡(还避免冷却/换卡冲突)。
            res["steps"]["card"] = "card-bound"
            res["card_skipped"] = True
            log("[续跑] %s 已绑卡,跳过加卡" % email)
        elif opts.get("do_card"):
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
            # 绑成就 checkpoint(卡 + 地址)→ 续跑跳过加卡/绑地址,不重复劳动、不冷却冲突。
            if r and r.get("result") == "card-bound":
                _ck(checkpoint, email, "card", "ok", card_last4=(card.get("last4") if card else None), result="card-bound")
                _ck(checkpoint, email, "address", "ok", zip=addr.get("zip"))

        # ★止血#2 防重复扣款:两个独立信号判"已充过"——checkpoint 的 stages.charge(可能因写盘异常丢)
        #   + run.py 从 results.jsonl 还原的 acct["charged"](账号跑完才写,与 checkpoint 互补)。任一为真即跳过,
        #   绝不重复扣款(真金白银,不可回滚)。单靠 stages.charge 会假阴性 → 重复扣。
        if opts.get("do_purchase") and (_prior_done(acct, "charge") or acct.get("charged")):
            res["steps"]["purchase"] = "success"
            res["skipped_charge"] = True
            log("[续跑] %s 已充值,跳过(防重复扣款)" % email)
        elif opts.get("do_purchase"):
            r = steps_billing.purchase(page, opts.get("amount", 5), cfg, opts.get("manual_hcaptcha", True))
            res["steps"]["purchase"] = r.get("result")
            res["balance_after"] = r.get("balance_after")
            if r.get("result") == "success":
                _ck(checkpoint, email, "charge", "ok", amount=opts.get("amount", 5), balance_after=r.get("balance_after"))

        if opts.get("do_changepw") and opts.get("unified_pw") and _prior_done(acct, "changepw"):
            # ★止血#3:已改密(prior stages.changepw=ok)→ 跳过。旧邮箱密码已失效,再改必 fail。
            res["steps"]["changepw"] = True
            res["skipped_changepw"] = True
            log("[续跑] %s 已改密,跳过" % email)
        elif opts.get("do_changepw") and opts.get("unified_pw"):
            ok = firstmail.change_mailbox_password(email, mailbox_pw, opts["unified_pw"],
                                                   cfg["mail_key"], cfg["mail_base"])
            res["steps"]["changepw"] = bool(ok)
            if ok:
                _ck(checkpoint, email, "changepw", "ok")

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
            # 清理异常【不能】冒泡:原来 adspower_stop/delete_env 裸调,任一抛错会顶替已算好的返回值 →
            # run.py 收不到 res、整号结果不落盘(本该记的进度也丢)。各自 try 包住,清理失败只记日志。
            try:
                common.adspower_stop(env_id)
            except Exception:
                pass
            time.sleep(1.5)
            if opts.get("delete_env", True):
                try:
                    adspower_env.delete_env(env_id)
                except Exception as _e:
                    log("删环境失败(忽略): %s" % str(_e)[:60])
            else:
                log("保留环境 %s（--no-delete-env）" % env_id)
