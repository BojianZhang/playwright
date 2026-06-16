#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 单账号编排(z.ai)：新建环境 → 接管 → 注册/登录 → 创建API Key → 订阅+支付 → 删环境
#
# 文件定位：GLM/0.0.1/selenium-e2e/pipeline.py
#
# 每账号【新建+删除】一个干净 AdsPower 环境(try/finally 保证删)，保证状态干净。
# 阶段:env → auth(register|login) → apikey(可开关) → subscribe(可开关,真金白银)。
#   apikey 与 subscribe 互不依赖:创建 API Key 可以在订阅之前/不订阅就单独做。
# ═══════════════════════════════════════════════════════════════════════

import os
import time

import common
from services import adspower_env
from steps import steps_auth
from steps import steps_apikey
from steps import steps_subscribe
from services import firstmail   # noqa: F401  (改密备用;当前流程未用,保留以备扩展)
from common import log, log_stage


def _ck(checkpoint, email, stage, status, **prod):
    """把一个阶段写进 checkpoint 的 stages 子树(run.py.save_progress 识别 _stage)。
    stage∈register/login/apikey/subscribe;status="ok"=已完成可跳过;prod=该阶段产物(api_key/plan/amount...)。"""
    if not checkpoint:
        return
    try:
        obj = dict(status=status, at=time.strftime("%Y-%m-%d %H:%M:%S"))
        obj.update({k: v for k, v in prod.items() if v not in (None, "")})
        checkpoint(email, _stage=(stage, obj))
    except Exception as _e:
        try: log("[checkpoint] ⚠ 阶段 %s 落盘异常(续跑可能漏判,订阅步可能重扣): %s" % (stage, str(_e)[:80]))
        except Exception: pass


def _prior_done(acct, stage):
    """续跑判定:该号 prior 进度里 stage 是否已 status==ok(可跳过/复用)。"""
    pst = ((acct.get("prior") or {}).get("stages") or {}).get(stage) or {}
    return pst.get("status") == "ok"


# 支付结果 → 记账动作(纯函数,供 test_pipeline_logic 单测,防"哪个结果该 commit/release"再回归):
#   commit   = 确定已扣(success)
#   release  = 确定未扣(明确拒付/金额非法,或 Confirm 之前就失败)→ 释放预留可重试
#   uncertain= Confirm 已点但终态不明(unknown/server-error/未知值)→ 保守按已扣记账、绝不自动重扣
_CHARGE_NO_CHARGE = ("declined", "invalid-amount", "plan-not-found", "plan-unconfirmed", "no-payment-form", "confirm-not-found")


def _charge_disposition(result):
    if result == "success":
        return "commit"
    if result in _CHARGE_NO_CHARGE:
        return "release"
    return "uncertain"   # ★未知值默认 uncertain(绝不落 release→重扣)


def _subscribe_already_done(acct):
    """订阅去重门(防重复扣款的信号):checkpoint stages.subscribe∈(ok, uncertain) 或 results 还原的 subscribed。
    任一为真即跳过订阅(真金白银,不可回滚)。★uncertain=上次 Confirm 已点但终态未确认(可能已扣)→ 同样【绝不重扣】。
    抽成纯函数供 test_pipeline_logic 单测。"""
    _st = (((acct.get("prior") or {}).get("stages") or {}).get("subscribe") or {}).get("status")
    return bool(_st in ("ok", "uncertain") or (acct or {}).get("subscribed"))


def _acquire_browser(proxies, start_idx, group_id, name, max_try=5):
    """从 start_idx 起轮询代理池：建环境→启动。代理校验失败就删环境换下一个。
    成功返回 (env_id, port, proxy)；连续 max_try 个都失败则抛错。接入共享 proxy 评分(退役跳过)。
    ★按 order_proxies 偏好排序:【优先用没用过的 IP】、滑块封过的 IP 降到最后(详见 ledger.order_proxies);
      选中即标 used(下个号不再优先选它)。无战绩时等价原 start_idx 轮转(行为不变)。"""
    n = len(proxies)
    last = [""]
    try:
        proxies = common.order_proxies(proxies, start_idx)   # 重排:fresh → 用过 → 滑块封 → 退役;同档按 start_idx 轮转分散
        start_idx = 0                                        # 顺序已编码偏好+轮转,从头依次取即可
    except Exception:
        pass

    def _try(proxy):
        env_id = None
        try:
            env_id = adspower_env.create_env(name, proxy, group_id)
            port = common.adspower_start(env_id)
            try: common.mark_proxy_used(proxy)               # ★标记该 IP 已被分配 → 后续优先选没用过的
            except Exception: pass
            return (env_id, port, proxy)
        except Exception as e:
            last[0] = str(e)
            try:
                common.mark_proxy_result(proxy, "dead")
            except Exception:
                pass
            log("代理 %s:%s 启动失败(%s)→换下一个代理" % (proxy.get("host"), proxy.get("port"), last[0][:60]))
            if env_id:
                try: common.adspower_stop(env_id)
                except Exception: pass
                try: adspower_env.delete_env(env_id)
                except Exception: pass
            time.sleep(1.2)
            return None

    tried = 0; scanned = 0; k = 0
    while tried < min(max_try, n) and scanned < n:
        proxy = proxies[(start_idx + k) % n]
        k += 1; scanned += 1
        try:
            if common.proxy_retired(proxy):
                continue
        except Exception:
            pass
        tried += 1
        got = _try(proxy)
        if got:
            return got
    if tried == 0 and n:
        log("[代理] 候选全部已退役 → 放宽忽略退役兜底选取(小池保命)")
        for k in range(min(max_try, n)):
            got = _try(proxies[(start_idx + k) % n])
            if got:
                return got
    raise RuntimeError("连续尝试代理都失败(真试 %d,扫描 %d/%d)，最后一个: %s" % (tried, scanned, n, last[0][:120]))


class _AcctTimeout(Exception):
    """★Opt2:单号超墙钟(ACCOUNT_DEADLINE)→ 在阶段边界抛出,主 try 捕获判 ACCOUNT_TIMEOUT 放弃换下一个号。"""
    pass


def run_account(acct, proxies, start_idx, group_id, opts, slot=0, slots_total=1, checkpoint=None):
    """acct={email,mailbox_pw,registered?,prior?,prior_key?,subscribed?}。
    opts:{cfg,do_apikey,do_subscribe,plan,cycle,real_charge,card_charge_gate,try_batch_charge,
          unified_pw,key_name,delete_env}。返回结果 dict。"""
    email = acct["email"]
    mailbox_pw = acct["mailbox_pw"]
    # z.ai 账号密码:统一密码优先,否则=邮箱密码(实测 firstmail 第二列即注册所用密码,与 OpenRouter 同口径)。
    op_pw = opts.get("unified_pw") or mailbox_pw
    cfg = opts["cfg"]
    res = {"email": email, "ok": False, "steps": {}, "timings": {}, "password": op_pw, "node_status": {}}
    t_start = time.perf_counter()
    _ACCT_DEADLINE = float(os.environ.get("ACCOUNT_DEADLINE", "0") or 0)   # ★Opt2 单号墙钟(秒,0=关)
    _clk = {"name": None, "t": t_start}
    _node_clk = {"t": time.perf_counter()}   # ★逐节点计时:记上一节点完成时刻,算每环节耗时

    def _mark_stage(name):
        now = time.perf_counter()
        # ★Opt2(ACCOUNT_DEADLINE 秒,0=关):单号总耗时超墙钟 → 阶段边界直接放弃换下一个号
        #   (防个别号无限重试卡死,实测 max 478s/号,占着环境名额+撞 AdsPower 拖死整批吞吐)。
        if name and _ACCT_DEADLINE > 0 and (now - t_start) > _ACCT_DEADLINE:
            raise _AcctTimeout("ACCOUNT_TIMEOUT %.0fs>%.0fs" % (now - t_start, _ACCT_DEADLINE))
        if _clk["name"]:
            try: res["timings"][_clk["name"]] = round(now - _clk["t"], 1)
            except Exception: pass
        _clk["name"] = name; _clk["t"] = now

    def _record_node(node, status="ok", reason=None):
        """★统一节点状态+耗时记录(供逐节点 N成功/M失败 + 每环节耗时 统计)。status 形如 "ok" / "fail:XXX";自动拆 reason。
           落 res["node_status"][node]={status,reason,ts,dur(距上一节点秒数≈本环节耗时)} → 随 res 写 results.jsonl,analytics 按 node 聚合状态+耗时。"""
        s = str(status) if status is not None else "ok"   # status=None 防御:当成 ok(避免落入 status="None" 脏值)
        st = "ok" if s == "ok" else ("fail" if s.startswith("fail") else s)
        rs = reason if reason is not None else (s.split(":", 1)[1] if (st == "fail" and ":" in s) else None)
        try:
            _pf = time.perf_counter()
            _dur = max(0.0, round(_pf - _node_clk["t"], 2))   # 距上一节点完成的耗时 ≈ 走完本环节用时;max(0) 防跨重试/时钟异常的负值
            _node_clk["t"] = _pf
            res.setdefault("node_status", {})[node] = {"status": st, "reason": rs, "ts": round(time.time(), 3), "dur": _dur}
        except Exception:
            pass

    env_id = None; driver = None
    common.alive_acquire()                       # ★P2:占在飞浏览器名额(建环境前,阻塞直到 ≤ADS_MAX_ALIVE);finally 必释放
    try:
        log_stage(slot, email, "env"); _mark_stage("env")
        env_id, port, proxy = _acquire_browser(proxies, start_idx, group_id, "glm-" + email.split("@")[0][:18])
        res["env_id"] = env_id
        res["proxy"] = "%s:%s" % (proxy.get("host"), proxy.get("port"))
        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
        try:
            common.place_window(driver, common.grid_rect(slot, slots_total))
        except Exception:
            pass
        try:
            driver.execute_cdp_cmd("Browser.grantPermissions", {"permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"]})
        except Exception:
            pass
        steps_apikey.inject_key_capture(driver)   # 导航前注入 key 网络抓取钩子(创建 key 时后端返回明文即存 sessionStorage)
        page = common.Page(driver)
        # ★用户定:浏览器一接管就【直接到 chat.z.ai/auth】(此页既有登录又有注册),不先开 chat.z.ai 首页(省一次加载)。
        #   每号用全新 AdsPower 环境=无残留登录态,故无需先去首页探"是否已登录";register_or_login 会在 /auth 上自走注册/登录。
        page.goto(common.AUTH_URL, wait=2)

        # ── auth ───────────────────────────────────────────────────────────
        log_stage(slot, email, "auth"); _mark_stage("auth")
        _node_clk["t"] = time.perf_counter()   # ★从 auth 起算逐节点耗时(否则首个节点 dur 含 env+建浏览器,失真)
        # ★每个关键节点【成功即刻落盘】,不做糊涂账(成功就是成功):注册成功就标 registered,
        #   即便后面登录失败,下次也不再重注册;各子节点(register_slider/verify_email/complete_reg/login_slider/login)
        #   独立记录在 checkpoint stages 子树 + res["steps"],续跑据此跳过已完成节点。
        res["steps"].setdefault("auth_nodes", {})

        def _on_node(stage, status="ok", **prod):
            res["steps"]["auth_nodes"][stage] = status
            # ★统一节点状态(供逐节点统计 N成功/M失败):status 形如 "ok" / "fail:SLIDER_FAIL" → 归一成 {status,reason,ts}。
            _record_node(stage, status, prod.get("reason"))
            _ck(checkpoint, email, stage, status, **prod)
            if status == "ok" and stage in ("register", "login") and checkpoint:
                try: checkpoint(email, registered=True, env_id=env_id)
                except Exception: pass

        # 传 env_id 给下游(滑块诊断按环境编号命名,并发也能对上是哪个号);per-account 拷贝,不污染共享 cfg。
        auth = steps_auth.register_or_login(page, email, op_pw, mailbox_pw,
                                            {**cfg, "_env_id": env_id or ""},
                                            registered=bool(acct.get("registered")),
                                            on_node=_on_node)
        res["steps"]["auth"] = auth
        # ★给当前 IP 记滑块战绩(用户策略:拖到正确位置仍过不去 → 标记该 IP、后续优先用没用过的 IP)。
        #   SLIDER_FAIL=滑块没过(多为该 IP 被行为检测盯上)→ slider-fail;走到过了滑块的任一节点 → slider-pass(证明该 IP 能过)。
        try:
            _an = res["steps"].get("auth_nodes") or {}
            if auth == "fail:SLIDER_FAIL":
                common.mark_proxy_result(proxy, "slider-fail")
            elif auth == "ok" or _an.get("register_slider") == "ok" or _an.get("login_slider") == "ok":
                common.mark_proxy_result(proxy, "slider-pass")
        except Exception:
            pass
        if auth != "ok" and common.is_banned_reason(auth):
            res["not_allowed"] = True
        if auth == "ok" and checkpoint:
            try: checkpoint(email, registered=True, env_id=env_id)
            except Exception: pass
        if auth != "ok":
            return res

        # ── apikey(可开关;独立于 subscribe,可先于订阅或不订阅就单独创建)──────────
        prior_key = acct.get("prior_key") or (acct.get("prior") or {}).get("api_key")
        if opts.get("do_apikey", True):
            log_stage(slot, email, "apikey"); _mark_stage("apikey")
            if prior_key:
                res["steps"]["apikey"] = True
                res["api_key"] = prior_key
                res["key_reused"] = True
                # ★续跑复用 key 也要记 apikey 节点(否则 node_status 缺 apikey 条目 → analytics 漏统计、成功率被低估;
                #   与新建 key 路径 line 262 的 _record_node 对齐,且推进 _node_clk 让后续节点耗时口径正确)。
                _record_node("apikey", "ok")
                log("[续跑] %s 复用已有 API Key(跳过创建)" % email)
            else:
                def _on_key(_k):
                    if checkpoint and _k:
                        try: checkpoint(email, registered=True, api_key=_k)
                        except Exception: pass
                        _ck(checkpoint, email, "apikey", "ok", api_key=_k, key_name="glm")
                # ★取 Key 重登走【正确 OAuth 入口】(用户步骤6):点 API→Login→Continue with Email→登录,完成 code 兑换建 z.ai 真会话。
                #   不能用 plain login()(走干净 /auth,无 response_type=code → 建不了 z.ai 会话)。
                _relogin = lambda: steps_auth.enter_apikey_oauth(page, email, op_pw, mailbox_pw, {**cfg, "_env_id": env_id or ""}, on_node=_on_node)
                # ★取Key步:每轮【先走正确 OAuth 入口】(点 API→Login→Continue with Email→登录,建 z.ai 真会话)再建Key。
                #   ★INF-001 修:relogin【放进循环内】+ 每轮开头查总时限(覆盖 relogin),去掉原【循环外无界 upfront 调用】,防失控。
                #   不再赌"直接 goto 取Key页"的 SSO 临时渲染(~20s 必被踢回选择屏 → ADD_BUTTON_NOT_FOUND)。建Key非花钱可安全重试。
                # ★稳定 key 名(R2-IDEMPOTENCY-002):整个重试循环用【同一个】name,而非每轮 get_api_key 内各自随机。
                #   Create 点中但抓不到 key(秘钥只显一次、丢了不可恢复)时上层会重试 → 随机名会造【不同名】孤儿 key;
                #   同名则孤儿易识别清理,且 z.ai 若拒重复名反而直接免掉第二把孤儿。
                _key_name = opts.get("key_name") or common.rand_name(8)
                k = {"ok": False, "key": None, "name": _key_name, "reason": "KEY_FAIL"}
                _key_tries = max(1, int(os.environ.get("GLM_KEY_TRIES", "2") or 2))
                _key_dl = float(os.environ.get("GLM_KEY_RETRY_DEADLINE", "240") or 240)   # 取Key步总墙钟上限(秒):含 relogin;超了就不再起新一轮,免拖垮并发
                for _kt in range(_key_tries):
                    if (time.perf_counter() - t_start) > _key_dl:   # ★每轮(含第0轮)开头查总时限 → 覆盖 relogin,绝不在超时后再起重登
                        log("[取Key] 已超时限(%.0fs)→ 停(免拖垮并发)" % _key_dl); break
                    if _kt > 0:
                        log("[取Key] 自我修复重试 %d/%d(上次:%s)" % (_kt + 1, _key_tries, k.get("reason")))
                    try:
                        if _relogin(): log("[取Key] OAuth 入口登录成功 → z.ai 会话已建")
                        else: log("[取Key] OAuth 入口未确认 → 仍尝试建 Key(get_api_key 内再自愈)")
                    except Exception as _re:
                        log("[取Key] OAuth 入口/重登异常: %s" % str(_re)[:80])
                    k = steps_apikey.get_api_key(page, name=_key_name, on_key=_on_key, relogin=_relogin, on_node=_on_node)
                    if k.get("ok") and k.get("key"):
                        break
                res["steps"]["apikey"] = bool(k.get("ok"))
                res["api_key"] = k.get("key")
                res["api_key_name"] = k.get("name")
                if k.get("ok") and k.get("key"):
                    _record_node("apikey", "ok")
                    if checkpoint:
                        try: checkpoint(email, registered=True, api_key=k.get("key"))
                        except Exception: pass
                        _ck(checkpoint, email, "apikey", "ok", api_key=k.get("key"), key_name=k.get("name"))
                else:
                    _record_node("apikey", "fail:" + str(k.get("reason") or "KEY_FAIL"))
                    res["key_reason"] = k.get("reason") or k.get("name")
                    # ★孤儿 key 提醒(R2-IDEMPOTENCY-002):KEY_NOT_CAPTURED = Create 已点、服务端 key 已生成但秘钥没抓到
                    #   (只显一次,不可恢复)→ z.ai 该号下可能残留 1~%d 把名为「%s」的废 key,需人工清理。透出到结果供排查。
                    if str(k.get("reason") or "").startswith("KEY_NOT_CAPTURED"):
                        res["orphan_key_name"] = _key_name
                        log("[取Key] ⚠ %s 可能残留孤儿 key(名「%s」,最多 %d 把):Create 已点但秘钥未抓到、不可恢复 → 请到 z.ai 清理" % (email, _key_name, _key_tries))

        # ── subscribe(可开关;真金白银,可能是周期扣款)───────────────────────
        if opts.get("do_subscribe"):
            log_stage(slot, email, "subscribe"); _mark_stage("subscribe")
        if opts.get("do_subscribe") and _subscribe_already_done(acct):
            # ★防重复扣款:两个独立信号(checkpoint stages.subscribe / results.jsonl 还原的 acct["subscribed"])。
            res["steps"]["subscribe"] = "success"
            res["skipped_subscribe"] = True
            res["subscribed"] = acct.get("subscribed") or True
            res["payment_status"] = "success"
            # ★在【真实跳过点】记 subscribe 节点(否则 dur 会被后面 charge 逻辑污染,统计口径不准);本次没真扣→不记 charge 节点。
            _record_node("subscribe", "ok")
            log("[续跑] %s 已订阅,跳过(防重复扣款)" % email)
        elif opts.get("do_subscribe"):
            plan = (opts.get("plan") or "pro").lower()
            cycle = (opts.get("cycle") or "monthly").lower()
            _amt = _price_for(cfg, plan, cycle)
            res["plan"] = plan; res["cycle"] = cycle; res["amount"] = _amt
            addr = common.rand_address()
            # 拒付→换卡(不同BIN)重试,最多 CARD_SWAP_ON_DECLINE 张。
            max_swaps = max(1, int(os.environ.get("CARD_SWAP_ON_DECLINE", "3")))
            tried_ids, tried_bins, r, card = set(), set(), None, None
            for _att in range(max_swaps):
                try:
                    card = common.load_card(email, exclude=tried_ids, exclude_bins=tried_bins, count_bin=(_att == 0))
                except RuntimeError as _ce:
                    log("[订阅] 无可换的新卡了(已试 %d 张): %s" % (len(tried_ids), str(_ce)[:80])); break
                if not card:
                    log("[订阅] 无可换的新卡了(已试 %d 张)" % len(tried_ids)); break
                res["card_last4"] = card.get("last4")
                res["card_id"] = card.get("id") or card.get("number")
                _cid = res.get("card_id")
                _gate = opts.get("card_charge_gate")
                _reserved = False; _resolved = False; _do_real = True
                # 真实充值开关关 → dry-run:走到 Confirm 但不真点。
                if not opts.get("real_charge"):
                    r = steps_subscribe.subscribe(page, plan, cycle, card, addr, cfg, opts, real_charge=False)
                    res["steps"]["subscribe"] = r.get("result")   # 通常 "dryrun"
                    res["payment_status"] = r.get("payment_status") or "dryrun"
                    log("[订阅] dry-run(未开真实充值):走到 Confirm 不真扣 — %s" % email)
                    break
                try:
                    # ① 容量账本原子预留(够 + 同卡并发未满 才放行;未跟踪卡永远放行)
                    if _gate and _cid:
                        try: _ok, _reason = common.reserve_charge(_cid, _amt)
                        except Exception: _ok, _reason = True, ""
                        if _ok:
                            _reserved = True
                        else:
                            _rmap = {"capacity": "卡容量用尽", "concurrency": "同卡并发已满", "no-card": "无绑卡",
                                     "no-pool": "卡池读失败", "write-fail": "卡池落盘失败", "lock-degraded": "卡池锁退化"}
                            res["steps"]["subscribe"] = "insufficient-funds"
                            res["payment_status"] = "insufficient-funds"
                            res["fail_stage"] = "subscribe"; res["fail_reason"] = "钱不够:" + _rmap.get(_reason, str(_reason))
                            _do_real = False; _resolved = True
                            log("[订阅] %s 预留失败(%s)→ 不真扣,END" % (email, _reason))
                    # ② 整批真充测试帽
                    _try_batch = opts.get("try_batch_charge")
                    if _do_real and _try_batch and not _try_batch():
                        if _reserved:
                            try: common.release_charge(_cid)
                            except Exception: pass
                            _resolved = True
                        res["steps"]["subscribe"] = "charge-test-capped"
                        res["payment_status"] = "charge-test-capped"
                        res["fail_stage"] = "subscribe"; res["fail_reason"] = "整批已达最多真充次数(测试帽)"
                        _do_real = False
                        log("[订阅] %s 整批真充已达上限(测试帽)→ 不真扣,END" % email)
                    # ③ 真实订阅 + 支付
                    if _do_real:
                        # ★写前 checkpoint(R2-IDEMPOTENCY-003 防硬kill双扣):Confirm 点中那刻先落 "uncertain" 凭据。
                        #   即便此后进程被 SIGKILL/OOM 无法落终态,续跑也因 checkpoint=uncertain 而跳过、绝不重扣。
                        #   终态确定后会被下面覆盖:success→"ok";明确未扣→"not-charged"(可重试);uncertain→保持 "uncertain"。
                        def _on_confirm(_e=email, _p=plan, _c=cycle, _a=_amt):
                            _ck(checkpoint, _e, "subscribe", "uncertain", plan=_p, cycle=_c, amount=_a)
                        r = steps_subscribe.subscribe(page, plan, cycle, card, addr, cfg, opts, real_charge=True, on_confirm=_on_confirm)
                        _result = r.get("result")
                        res["steps"]["subscribe"] = _result
                        res["payment_status"] = r.get("payment_status") or _result
                        try: common.mark_card_result(card, _result)
                        except Exception: pass
                        # ★扣款语义三分(真金白银,绝不自动重扣):
                        #   success                  → 确定已扣:先落【防重扣】checkpoint(去重凭证)再 commit 容量账本
                        #   【确定未扣】declined/invalid-amount(Confirm 后明确拒/金额非法)+ plan-not-found/plan-unconfirmed/
                        #       no-payment-form(都在【点 Confirm 之前】就返回了,根本没扣)→ 释放预留,可换卡/重试。
                        #   其它(unknown/server-error/任何未知值)→ Confirm 已点、终态未确认 → 扣款【可能已发生】:
                        #       保守按【已扣】记账(commit + 标 subscribed 防自动重扣)+ 标 uncertain 供人工核对;
                        #       result 非 success → res.ok=False。★默认未知值落 uncertain(不释放)= 宁可漏判也绝不在"可能已扣"上重扣。
                        _disp = _charge_disposition(_result)
                        if _disp == "commit":
                            res["subscribed"] = _amt
                            _ck(checkpoint, email, "subscribe", "ok", plan=plan, cycle=cycle, amount=_amt)  # 先落去重凭证(收窄"已扣未记→重扣"窗口)
                            if _reserved:
                                _cm = True
                                try: _cm = common.commit_charge(_cid, _amt)
                                except Exception: _cm = False
                                if _cm is False:
                                    res["charge_commit_failed"] = True
                                    log("[订阅] ⚠⚠ %s 扣款成功但容量账本提交失败 → 该卡容量可能多算,请人工核对" % email)
                            _resolved = True
                        elif _disp == "release":
                            # 未扣(明确拒付/金额非法,或 Confirm 之前就失败)→ 释放预留,不记账、不标 subscribed
                            if _reserved:
                                try: common.release_charge(_cid)
                                except Exception: pass
                            # ★降级写前凭据(本次明确未扣):把可能存在的 "uncertain"(_on_confirm 落的)覆盖成非跳过状态,
                            #   否则续跑会因 checkpoint=uncertain 把【其实没扣、本可换卡重试】的号永久跳过(stuck)。
                            #   状态值不在 (ok/uncertain) 即可(_subscribe_already_done 不跳);Confirm 没点到时这步也无害。
                            _ck(checkpoint, email, "subscribe", "not-charged", plan=plan, cycle=cycle)
                            _resolved = True
                        else:
                            # 终态不明(unknown/server-error)→ Confirm 已点、可能已扣:不释放预留、按已扣记账、防自动重扣 + 标人工核对
                            res["subscribed"] = _amt
                            res["subscribe_uncertain"] = True
                            # ★状态单一口径(R2-UNCERTAIN):steps.subscribe 也置 "uncertain"(原来留 "unknown"/"server-error" 原始值)→
                            #   让 steps / node_status / checkpoint 三处一致。否则下面 node 记成 "fail:unknown"、attribution 误报 subscribe 失败。
                            #   ★不改 res["ok"](仍 False):uncertain=终态未知,绝不当干净成功上报(必须人工核对该卡是否真扣),只把"标签"统一。
                            res["steps"]["subscribe"] = "uncertain"
                            _ck(checkpoint, email, "subscribe", "uncertain", plan=plan, cycle=cycle, amount=_amt)
                            if _reserved:
                                _cm = True
                                try: _cm = common.commit_charge(_cid, _amt)
                                except Exception: _cm = False
                                if _cm is False:
                                    res["charge_commit_failed"] = True
                            _resolved = True
                            log("[订阅] ⚠ %s 支付终态未确认(%s):Confirm 已点、扣款可能已发生 → 保守按已扣记账、绝不自动重扣,请人工核对该卡" % (email, _result))
                finally:
                    if _reserved and not _resolved:
                        try: common.release_charge(_cid)
                        except Exception: pass
                # 拒付且还有换卡名额 → 换不同卡/BIN 重试
                if r and r.get("result") in ("declined", "failed") and _att + 1 < max_swaps and opts.get("real_charge"):
                    tried_ids.add(card.get("id") or card.get("number"))
                    _bin = str(card.get("number") or "")[:6]
                    if _bin: tried_bins.add(_bin)
                    log("[订阅] 卡 ••%s 支付被拒 → 换不同卡+BIN 重试 %d/%d" % (str(card.get("last4") or "")[-4:], _att + 2, max_swaps))
                    continue
                break

        # ── 成功判定(每个开启的关键节点都必须真成功)─────────────────────────
        _ok = res["steps"].get("auth") == "ok"
        if opts.get("do_apikey", True):
            _ok = _ok and (res["steps"].get("apikey") is True or bool(res.get("api_key")))
        if opts.get("do_subscribe") and opts.get("real_charge"):
            _ok = _ok and res["steps"].get("subscribe") == "success"
        res["ok"] = _ok
        # ★补记 subscribe/charge 终端节点状态(供逐节点统计:N成功/M失败/uncertain)
        #   守卫 "not in node_status":续跑跳过路径已在跳过点记过 subscribe(line ~283)→ 不重记、不污染其 dur。
        if opts.get("do_subscribe"):
            _sub = res["steps"].get("subscribe")
            _ns = res.get("node_status") or {}
            if _sub is not None and "subscribe" not in _ns:
                # uncertain 与 charge 节点(L418)同口径:支付终态不明→记 "uncertain" 不记 "fail",否则统计把"可能已扣"误算成失败
                _record_node("subscribe", "ok" if _sub in ("success", "dryrun") else ("uncertain" if res.get("subscribe_uncertain") else "fail:" + str(_sub)))
            # charge 节点只记【本次真发生的扣款】:dryrun 不记、续跑跳过(skipped_subscribe,本次没扣)不记 → 避免虚增 charge 成功数
            if (_sub is not None and opts.get("real_charge") and _sub != "dryrun"
                    and not res.get("skipped_subscribe") and "charge" not in _ns):
                # 充值(真金白银):success=已扣;uncertain=可能已扣(需人工核);其它=未扣失败
                _record_node("charge", "ok" if _sub == "success" else ("uncertain" if res.get("subscribe_uncertain") else "fail:" + str(_sub)))
        try:
            _fs, _fr = common.attribute_failure(res.get("steps"), opts, res)
            if _fs and not res.get("fail_stage"):
                res["fail_stage"] = _fs; res["fail_reason"] = _fr
        except Exception:
            pass
        return res
    except _AcctTimeout as _te:
        # ★Opt2:超单号墙钟 → 放弃本号(换下一个),归因 ACCOUNT_TIMEOUT,不当普通异常
        res["fail_stage"] = "account_timeout"; res["fail_reason"] = "ACCOUNT_TIMEOUT"
        res["error"] = str(_te)[:120]
        log("账号 %s 超墙钟放弃: %s" % (email, str(_te)[:80]))
        return res
    except Exception as e:
        res["error"] = str(e)[:200]
        res["fail_stage"] = "exception"
        res["fail_reason"] = str(e)[:160]
        log("账号 %s 异常: %s" % (email, str(e)[:140]))
        return res
    finally:
        try:
            _mark_stage(None)
            res["timings"]["total"] = round(time.perf_counter() - t_start, 1)
        except Exception:
            pass
        log_stage(slot, email, "done", "done")
        try:
            if driver:
                driver.quit()
        except Exception:
            pass
        if env_id:
            try: common.adspower_stop(env_id)
            except Exception: pass
            time.sleep(1.5)
            if opts.get("delete_env", True):
                # ★删环境失败要【可见】(否则并发跑久了 AdsPower 攒一堆孤儿环境耗资源)→ 重试一次,仍不成标 res.env_leaked
                #   供结果行暴露,运维可批量 GC(配合 proc-cleanup / kill-orphans)。delete_env 返回 True=真删成。
                _deleted = None
                try: _deleted = adspower_env.delete_env(env_id)
                except Exception as _e: log("删环境异常: %s" % str(_e)[:60])
                if _deleted is False:
                    time.sleep(1.5)
                    try: _deleted = adspower_env.delete_env(env_id)
                    except Exception: pass
                if _deleted is False:
                    res["env_leaked"] = env_id
                    log("[环境] ⚠ %s 删除失败(留孤儿环境 %s)→ 已标 env_leaked,建议事后批量清理" % (email, env_id))
            else:
                log("保留环境 %s（--no-delete-env）" % env_id)
        common.alive_release()                   # ★P2:删环境后释放在飞浏览器名额(与 alive_acquire 成对,保证 ≤ADS_MAX_ALIVE)


def _price_for(cfg, plan, cycle):
    """从 config.subscribe.prices[plan][cycle] 取金额(美元);缺失回退 0(容量闸据此放行,不阻塞)。"""
    try:
        return float(((cfg.get("subscribe_prices") or {}).get(plan) or {}).get(cycle) or 0)
    except Exception:
        return 0
