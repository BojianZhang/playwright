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
from common import log, log_stage

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
    成功返回 (env_id, port, proxy)；连续 max_try 个都失败则抛错。
    ★代理评分接入(对齐 hybrid,纯Sel 批此前完全没接):① 优先跳过【已退役】代理(连败≥阈值,评分已死→跳过省时);
      ② 启动失败回写 mark_proxy_result(dead) 让纯Sel 批的故障也累计进【共享 proxy 评分】(连败到阈值自动退役;
         card-bound 会清零,故单次 AdsPower 打嗝不会误退好代理);③ 候选全退役(小池)→放宽忽略退役兜底,防"无代理可建"卡死整批。"""
    n = len(proxies)
    last = [""]

    def _try(proxy):
        env_id = None
        try:
            env_id = adspower_env.create_env(name, proxy, group_id)
            port = common.adspower_start(env_id)
            return (env_id, port, proxy)
        except Exception as e:
            last[0] = str(e)
            try:
                common.mark_proxy_result(proxy, "dead")   # 启动失败=该IP不可用,累计进共享 fail_streak(到阈值自动退役)
            except Exception:
                pass
            log("代理 %s:%s 启动失败(%s)→换下一个代理" % (proxy.get("host"), proxy.get("port"), last[0][:60]))
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
            return None

    # ① 优先在【未退役】代理里建环境(退役=评分已死,直接跳过省时);真尝试上限 max_try。
    tried = 0
    scanned = 0
    k = 0
    while tried < min(max_try, n) and scanned < n:
        proxy = proxies[(start_idx + k) % n]
        k += 1
        scanned += 1
        try:
            if common.proxy_retired(proxy):
                continue
        except Exception:
            pass
        tried += 1
        got = _try(proxy)
        if got:
            return got
    # ② 兜底:一个未退役的都没真试过(小池全退役)→ 放宽忽略退役,再试 max_try 个,防整批因"无代理可建"卡死。
    if tried == 0 and n:
        log("[代理] 候选全部已退役 → 放宽忽略退役兜底选取(小池保命)")
        for k in range(min(max_try, n)):
            got = _try(proxies[(start_idx + k) % n])
            if got:
                return got
    raise RuntimeError("连续尝试代理都失败(真试 %d,扫描 %d/%d)，最后一个: %s" % (tried, scanned, n, last[0][:120]))


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
    # password=当前 OpenRouter 登录密码:设了统一密码就＝统一密码,否则＝原邮箱密码(与 Playwright loginPassword=unified||original 对齐)。
    # 不写这个字段 → web 回退成原密码,导致「设了统一密码/改密成功后 当前密码仍显示原密码」。
    res = {"email": email, "ok": False, "steps": {}, "password": op_pw}
    env_id = None
    driver = None
    patcher = None
    try:
        log_stage(slot, email, "env")
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
        steps_key.inject_key_capture(driver)   # 一劳永逸:goto 前注入 key 网络抓取钩子(后端返回明文 sk-or- 即存 sessionStorage,取key UI 无关)
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

        log_stage(slot, email, "auth")
        auth = steps_auth.register_or_login(page, email, op_pw, mailbox_pw, cfg,
                                            registered=bool(acct.get("registered")))   # 已注册号(历史auth=ok)→直接登录,不再点注册
        res["steps"]["auth"] = auth
        if auth != "ok" and common.is_banned_reason(auth):
            res["not_allowed"] = True   # ★显式拉黑标记(覆盖 NOT_ALLOWED/access denied/not permitted 等所有变体,口径同混合)
            # → run.py 永久跳过(不再靠脆弱的 endswith)+ Node engine-runner 桥接据此进黑名单
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
            log_stage(slot, email, "key")
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
                # ★防二次扣款(审计 RESUME-01/02):向导【抓到 key 那一刻】(收尾推进/充值之前)就落 checkpoint;
                #   向导内 add-credits 真实扣款【那一刻】就登记 charge 去重。否则 key/charge 只在 get_api_key
                #   return 后才落盘,而收尾循环在 return 前可能已扣款,被杀就丢信号→重跑整个向导→二次扣 + 再陷浮层。
                def _on_key(_k):
                    if checkpoint and _k:
                        try:
                            checkpoint(email, registered=True, api_key=_k)
                        except Exception:
                            pass
                        _ck(checkpoint, email, "key", "ok", api_key=_k, key_name="onboarding")
                def _on_charge():
                    try:
                        _ck(checkpoint, email, "charge", "ok", amount=10, via="wizard-credits")
                    except Exception as _ce:
                        # ★不可逆扣款的去重凭证落盘失败必须可观测(原静默 pass)→ 否则被杀/写盘失败时丢信号→续跑二次扣款
                        try: log("[checkpoint] ⚠ 向导充值 charge 落盘失败,续跑可能重扣: %s" % str(_ce)[:80])
                        except Exception: pass
                    acct["charged"] = True   # 本轮 do_purchase 段据此跳过,防同号"向导充值+billing充值"双扣
                    res["charged"] = 10      # ★第二个【独立】去重信号:写进结果行→results.jsonl→run.py 还原 acct["charged"](与 checkpoint 物理独立),并让账号页回显向导充值额
                k = steps_key.get_api_key(page, name=opts.get("key_name"),
                                          expiration=opts.get("key_expiration", "No expiration"),
                                          on_key=_on_key, on_charge=_on_charge)
                res["steps"]["key"] = bool(k.get("ok"))
                res["api_key"] = k.get("key")
                # ★可审计:取key路径(wizard=向导内抓到 / newkey=落工作台绕New Key建)→ 量化"绕路率"优化空间。
                if k.get("key_path"):
                    res["key_path"] = k.get("key_path")
                # ★只读诊断:绕New Key 的号,网络钩子看到的 key-ish 传输/URL(定位 create-key 明文走哪条路、为啥没抓到)。
                if k.get("key_capture_diag"):
                    res["key_capture_diag"] = k.get("key_capture_diag")
                # ★可审计:取key失败时落盘原因(WIZARD_KEY_NOT_CAPTURED=新版向导没抓到明文key→走split/混合;
                #   NEWKEY_DIALOG_NOT_OPENED / NEWKEY_NOT_CREATED=老号New Key流程失败)。原来只记 key:false 不记因,
                #   日志无法区分"新页面硬失败 vs 老路异常",修复方向无从判断。默认不影响成功路径。
                # ★MP-01 修(回归止血#1):key checkpoint 必须在【成功路径无条件落盘】。原来误把落盘放进 if not ok(失败)
                #   分支 → 失败时落了个 null key(无用),而 newkey/capture-fallback 成功路径(不调 on_key)【根本不落 key】
                #   → 续跑取不到 prior_key → 重建第二把 key + credits 模式重跑向导二次扣款。改:成功(ok 且有 key)就落
                #   checkpoint + _ck(wizard 路径 on_key 已落=幂等无害);失败只记 key_reason/diag,绝不落 null key。
                if k.get("ok") and k.get("key"):
                    if checkpoint:
                        try:
                            checkpoint(email, registered=True, api_key=k.get("key"))
                        except Exception:
                            pass
                        _ck(checkpoint, email, "key", "ok", api_key=k.get("key"), key_name=k.get("name"))
                else:
                    res["key_reason"] = k.get("reason") or k.get("name")
                    if k.get("key_diag"):
                        res["key_diag"] = k.get("key_diag")   # 子诊断:向导停在哪屏/key是否掩码出现过(判修Sel vs转split)

        # 记录向导里所选的支付/积分方式(对比"哪种方式绑卡":wizard-address/later-skip · add-credits/skip)
        res["pay_method"] = getattr(page, "_pay_method", None)
        res["credit_method"] = getattr(page, "_credit_method", None)

        # ★防资源浪费/数据丢失:取key 失败的号【绝不再加卡/充值/改密】——否则给【没有 API Key 的废号】白绑一张卡
        #   (卡池的卡被消耗+计入BIN当日额度,聚合页就是"有卡末4/card-bound 但 API Key 空"的废行),卡和号全浪费。
        #   留着卡和号下轮重试。只有【取key成功(含续跑复用)或 本就不取key(do_key 关,如纯加卡模式)】才往下做账单。
        _key_ok = bool(res["steps"].get("key")) or bool(res.get("api_key"))
        _bill_ok = _key_ok or (not opts.get("do_key", True))
        if opts.get("do_key", True) and not _key_ok:
            log("[流程] %s 取key失败 → 跳过加卡/充值/改密(不给无key废号浪费卡,留着重试)" % email)

        if opts.get("do_card") and _bill_ok:
            log_stage(slot, email, "card")
        if opts.get("do_card") and _bill_ok and _prior_done(acct, "card"):
            # ★已绑卡(prior stages.card=ok)→ 跳过加卡,省一整段绑卡(还避免冷却/换卡冲突)。
            res["steps"]["card"] = "card-bound"
            res["card_skipped"] = True
            log("[续跑] %s 已绑卡,跳过加卡" % email)
        elif opts.get("do_card") and _bill_ok:
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
        if opts.get("do_purchase") and _bill_ok:
            log_stage(slot, email, "charge")
        if opts.get("do_purchase") and _bill_ok and (_prior_done(acct, "charge") or acct.get("charged")):
            res["steps"]["purchase"] = "success"
            res["skipped_charge"] = True
            res["charged"] = opts.get("amount", 5)   # 已充过(续跑跳过):结果行仍带金额,账号页/聚合页回显(不重复扣款)
            log("[续跑] %s 已充值,跳过(防重复扣款)" % email)
        elif opts.get("do_purchase") and _bill_ok:
            r = steps_billing.purchase(page, opts.get("amount", 5), cfg, opts.get("manual_hcaptcha", True))
            res["steps"]["purchase"] = r.get("result")
            res["balance_after"] = r.get("balance_after")
            if r.get("result") == "success":
                res["charged"] = opts.get("amount", 5)   # ★充值额进结果行(供 UI/台账回显;之前漏写=账号页显示 $0)
                _ck(checkpoint, email, "charge", "ok", amount=opts.get("amount", 5), balance_after=r.get("balance_after"))

        # ★【CHANGEPW_REQUIRE_PURCHASE=on】只在充值【确认成功】才改邮箱密码(用户选:最严)。
        #   默认空=关=与现状逐字节一致(取到 key 即改密,与充值结果无关)。
        #   on:本批配置了充值且前置 ok → 必须 purchase==success(或续跑已充)才改密;
        #      declined / server-error / unknown 一律【跳过改密】→ 该号保持"未定型"可干净重试,邮箱密码不被提前改掉。
        #   错误不做糊涂账:跳过时把"为啥跳"写进结果行(skipped_changepw_reason),UI/分析一眼看清在哪步因为啥停。
        _cpw_gate = True
        if opts.get("do_changepw") and (os.environ.get("CHANGEPW_REQUIRE_PURCHASE", "") or "").strip().lower() in ("1", "true", "on", "yes"):
            if opts.get("do_purchase") and _bill_ok:
                _cpw_gate = (res["steps"].get("purchase") == "success") or bool(res.get("skipped_charge"))
                if not _cpw_gate:
                    res["skipped_changepw"] = True
                    res["skipped_changepw_reason"] = "purchase-" + str(res["steps"].get("purchase") or "none")
                    log("[拒付/未成功] %s 充值=%s → 跳过改密(保号可干净重试)" % (email, res["steps"].get("purchase")))
        if opts.get("do_changepw") and opts.get("unified_pw") and _bill_ok and _cpw_gate:
            log_stage(slot, email, "changepw")
        if opts.get("do_changepw") and opts.get("unified_pw") and _bill_ok and _cpw_gate and _prior_done(acct, "changepw"):
            # ★止血#3:已改密(prior stages.changepw=ok)→ 跳过。旧邮箱密码已失效,再改必 fail。
            res["steps"]["changepw"] = True
            res["skipped_changepw"] = True
            log("[续跑] %s 已改密,跳过" % email)
        elif opts.get("do_changepw") and opts.get("unified_pw") and _bill_ok and _cpw_gate:
            ok = firstmail.change_mailbox_password(email, mailbox_pw, opts["unified_pw"],
                                                   cfg["mail_key"], cfg["mail_base"])
            res["steps"]["changepw"] = bool(ok)
            if ok:
                _ck(checkpoint, email, "changepw", "ok")

        # ★用户原则「每个关键节点都以是否成功为基准,其余均为失败」:原来只看 auth+key(不看 card/purchase)→
        #   绑卡失败(hcaptcha/declined/server-error/unknown)却 ok=true 被误算成功(实测大量)。现按【已开启的关键节点逐级 gate】:
        #   do_card 开 → 必须 card=='card-bound';do_purchase 开 → 必须 purchase=='success'。与 357-360 的 fail_stage 同判据(消除"ok=true 又 fail_stage=card"自相矛盾)。
        #   注:changepw 是收尾维护步(失败不丢账号价值,可续跑补)→ 不纳入成功门,与 CHANGEPW_REQUIRE_PURCHASE 一致。纯取key模式(do_card 关)逐字节等价原逻辑。
        _ok = res["steps"].get("auth") == "ok" and res["steps"].get("key", True) is not False
        if opts.get("do_card"):
            _ok = _ok and res["steps"].get("card") == "card-bound"
        if opts.get("do_purchase"):
            _ok = _ok and res["steps"].get("purchase") == "success"
        res["ok"] = _ok
        # ★错误不做糊涂账:把"在哪一步、因为啥"失败浓缩成 fail_stage/fail_reason 两字段(按流程顺序取第一个没过的环节),
        #   UI/分析页直接显示,不用人肉拼 steps 字典。原始 steps/各 reason 字段照旧保留,这里只做归因汇总。
        try:
            _st = res.get("steps") or {}
            _fs = _fr = None
            if _st.get("auth") not in ("ok", None):
                _fs, _fr = "register", str(_st.get("auth") or "register-failed")
            elif _st.get("key") is False:
                _fs, _fr = "key", str(res.get("key_reason") or "key-not-captured")
            elif opts.get("do_card") and _bill_ok and _st.get("card") not in ("card-bound", None):
                _fs, _fr = "card", str(_st.get("card"))            # declined / card-502 / hcaptcha / needphone …
            elif opts.get("do_purchase") and _bill_ok and _st.get("purchase") not in ("success", None):
                _fs, _fr = "charge", str(_st.get("purchase"))      # declined / server-error / unknown
            elif opts.get("do_changepw") and _bill_ok and _cpw_gate and _st.get("changepw") is False:
                _fs, _fr = "changepw", "changepw-failed"
            if _fs:
                res["fail_stage"] = _fs
                res["fail_reason"] = _fr
        except Exception:
            pass
        return res
    except Exception as e:
        res["error"] = str(e)[:200]
        res["fail_stage"] = "exception"            # 异常也归因,不做糊涂账:哪步抛的看 stage 进度,为啥看 fail_reason
        res["fail_reason"] = str(e)[:160]
        log("账号 %s 异常: %s" % (email, str(e)[:140]))
        return res
    finally:
        log_stage(slot, email, "done", "done")
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
