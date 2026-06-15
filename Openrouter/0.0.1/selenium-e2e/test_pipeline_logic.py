#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 编排层离线回归测试(纯合成数据,不联网 / 不碰真实状态 / 不花卡)。
# 锁住本会话反复出 bug 的三处【决策逻辑】:续跑逐阶段跳过 / 防重复扣款 / 代理多样化。
# 与 test_helpers.py 分开(那个只 import common 保持轻量;这个要 import pipeline/run/hybrid_run)。
# 用法:  python test_pipeline_logic.py     (全绿才算通过;任一 FAIL 退出码=1)
import os, sys, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pipeline, run, hybrid_run

PASS = 0
FAIL = 0
FAILED = []


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        FAILED.append(name)
        print("  ✗ FAIL:", name)


def test_prior_done():
    """续跑逐阶段跳过判定:只认 status=='ok'(其余/缺失都不跳,防漏做)。"""
    acct = {"prior": {"stages": {"card": {"status": "ok"}, "charge": {"status": "pending"}}}}
    check("card ok → 跳过", pipeline._prior_done(acct, "card") is True)
    check("charge pending → 不跳", pipeline._prior_done(acct, "charge") is False)
    check("未走过的阶段 → 不跳", pipeline._prior_done(acct, "changepw") is False)
    check("无 prior → 不跳", pipeline._prior_done({}, "card") is False)


def test_save_progress_stage_merge():
    """save_progress 的 _stage 写进 stages 子树:多阶段共存、不互相覆盖、普通字段不清 stages
       (根治过'写新阶段把旧阶段冲掉→续跑重复取key/重复扣款'的回归)。"""
    d = tempfile.mkdtemp(prefix="orpipetest_")
    run._PROGRESS_FILE = os.path.join(d, "prog.json")
    run.save_progress("a@x.com", _stage=("key", {"status": "ok", "api_key": "sk-or-1"}))
    run.save_progress("a@x.com", _stage=("charge", {"status": "ok"}))
    run.save_progress("a@x.com", registered=True)   # 普通字段不应清掉 stages 子树
    rec = json.load(open(run._PROGRESS_FILE, encoding="utf-8"))["a@x.com"]
    check("key 阶段在", rec.get("stages", {}).get("key", {}).get("status") == "ok")
    check("charge 阶段在(未被 key 覆盖)", rec.get("stages", {}).get("charge", {}).get("status") == "ok")
    check("api_key 产物落在 key 阶段", rec["stages"]["key"].get("api_key") == "sk-or-1")
    check("普通字段写入且不清 stages", rec.get("registered") is True and "key" in rec.get("stages", {}))
    # 读回构造 prior → pipeline 逐阶段都能跳(续跑契约闭环)
    acct = {"prior": rec}
    check("读回 key 可跳", pipeline._prior_done(acct, "key") is True)
    check("读回 charge 可跳", pipeline._prior_done(acct, "charge") is True)


def test_charge_double_spend_gate():
    """防重复扣款不变量(真金白银不可回滚):stages.charge=ok 或 acct['charged'] 任一为真 → 跳过充值。
       对齐 pipeline.run_account 的 gate:(_prior_done(acct,'charge') or acct.get('charged'))。"""
    gate = lambda a: bool(pipeline._prior_done(a, "charge") or a.get("charged"))
    check("stages.charge=ok → 跳(checkpoint 信号)", gate({"prior": {"stages": {"charge": {"status": "ok"}}}}) is True)
    check("charged=True → 跳(results 还原的第二独立信号)", gate({"charged": True}) is True)
    check("两信号都无 → 不跳(允许首次充值)", gate({"prior": {"stages": {}}}) is False)


def test_diversify_proxies():
    """代理多样化:不丢号、不重复、相邻尽量不同 /24 段(避 Stripe Radar velocity/设备关联)。"""
    px = ([{"host": "1.1.1.%d" % i} for i in range(2)]
          + [{"host": "2.2.2.%d" % i} for i in range(2)]
          + [{"host": "3.3.3.%d" % i} for i in range(2)])
    out = hybrid_run._diversify_proxies(list(px))
    check("不丢号(长度相等)", len(out) == len(px))
    check("不重复不丢(集合相等)", set(p["host"] for p in out) == set(p["host"] for p in px))
    # 3 段各 2 个 → round-robin 每轮各段取一 → 相邻必不同段(与随机 shuffle 无关,结构性保证)
    segs = [hybrid_run._proxy_seg(p) for p in out]
    adj_same = sum(1 for i in range(1, len(segs)) if segs[i] == segs[i - 1])
    check("均衡时相邻无同段", adj_same == 0)
    # 不均衡(4+1)也绝不丢号(尾部同段不可避免,但不能少号)
    px2 = [{"host": "9.9.9.%d" % i} for i in range(4)] + [{"host": "8.8.8.1"}]
    out2 = hybrid_run._diversify_proxies(list(px2))
    check("不均衡不丢号", set(p["host"] for p in out2) == set(p["host"] for p in px2))


def test_acquire_browser_proxy_scoring():
    """_acquire_browser 代理评分:跳过退役 / 启动失败标 dead / 全退役兜底(全程 mock,绝不碰真实 AdsPower/sleep)。"""
    import pipeline as P
    bak = (P.adspower_env.create_env, P.adspower_env.delete_env, P.common.adspower_start,
           P.common.adspower_stop, P.common.proxy_retired, P.common.mark_proxy_result, P.time.sleep)
    try:
        P.time.sleep = lambda *a, **k: None                      # 别真睡 1.2s
        P.adspower_env.create_env = lambda name, proxy, gid: "env-" + proxy["host"]
        P.adspower_env.delete_env = lambda e: None
        P.common.adspower_stop = lambda e: None
        marked = []
        P.common.mark_proxy_result = lambda p, r: marked.append((p["host"], r))
        proxies = [{"host": "1.1.1.1", "port": "1"}, {"host": "2.2.2.2", "port": "2"}, {"host": "3.3.3.3", "port": "3"}]

        # A) 前两个退役 → 必选第三个(退役的根本不 create)
        P.common.proxy_retired = lambda p: p["host"] in ("1.1.1.1", "2.2.2.2")
        P.common.adspower_start = lambda e: 9999
        eid, port, px = P._acquire_browser(proxies, 0, "g", "nm")
        check("跳退役→选到未退役第三个", px["host"] == "3.3.3.3" and eid == "env-3.3.3.3")

        # B) 不退役但第一个启动失败 → 标 dead + 换下一个成功
        marked.clear()
        P.common.proxy_retired = lambda p: False

        def _start(e):
            if e == "env-1.1.1.1":
                raise RuntimeError("Check Proxy Fail")
            return 9999
        P.common.adspower_start = _start
        eid, port, px = P._acquire_browser(proxies, 0, "g", "nm")
        check("启动失败的代理被标 dead", ("1.1.1.1", "dead") in marked)
        check("失败后换到下一个成功", px["host"] == "2.2.2.2")

        # C) 全退役 → 兜底仍能选到一个(小池保命,不抛"无代理可建")
        P.common.proxy_retired = lambda p: True
        P.common.adspower_start = lambda e: 9999
        eid, port, px = P._acquire_browser(proxies, 0, "g", "nm")
        check("全退役→兜底仍选到", bool(eid) and px is not None)
    finally:
        (P.adspower_env.create_env, P.adspower_env.delete_env, P.common.adspower_start,
         P.common.adspower_stop, P.common.proxy_retired, P.common.mark_proxy_result, P.time.sleep) = bak


def test_attribution_helper():
    """common.attribute_failure 失败归因单一来源:
       ① 对纯Sel输入与 pipeline 原内联块【逐字节等价】(等价对拍,守住"默认逐字节不变");
       ② 混合专属(pw=False/giveup/顶层 res.purchase)正确归因;③ 边界不抛。"""
    import common
    af = common.attribute_failure

    # 参考实现 = pipeline 重构前的原内联块(byte-exact 复刻),用于等价对拍
    def old(st, opts, res):
        st = st or {}
        res = res or {}
        key_ok = bool(st.get("key")) or bool(res.get("api_key"))
        bill_ok = key_ok or (not opts.get("do_key", True))
        cpw_gate = True
        if (os.environ.get("CHANGEPW_REQUIRE_PURCHASE", "") or "").strip().lower() in ("1", "true", "on", "yes"):
            cpw_gate = (st.get("purchase") == "success") or bool(res.get("skipped_charge"))
        fs = fr = None
        if st.get("auth") not in ("ok", None):
            fs, fr = "register", str(st.get("auth") or "register-failed")
        elif st.get("key") is False:
            fs, fr = "key", str(res.get("key_reason") or "key-not-captured")
        elif opts.get("do_card") and bill_ok and st.get("card") not in ("card-bound", None):
            fs, fr = "card", str(st.get("card"))
        elif opts.get("do_purchase") and bill_ok and st.get("purchase") not in ("success", None):
            fs, fr = "charge", str(st.get("purchase"))
        elif opts.get("do_changepw") and bill_ok and cpw_gate and st.get("changepw") is False:
            fs, fr = "changepw", "changepw-failed"
        return fs, fr

    OPTS = {"do_key": True, "do_card": True, "do_purchase": True, "do_changepw": True}
    matrix = [
        {"auth": "ok", "key": True, "card": "card-bound", "purchase": "success", "changepw": True},
        {"auth": "fail:FORM_NOT_FILLED"},
        {"auth": "ok", "key": False},
        {"auth": "ok", "key": True, "card": "declined"},
        {"auth": "ok", "key": True, "card": "hcaptcha"},
        {"auth": "ok", "key": True, "card": "server-error"},
        {"auth": "ok", "key": True, "card": "card-bound", "purchase": "declined"},
        {"auth": "ok", "key": True, "card": "card-bound", "purchase": "success", "changepw": False},
        {"auth": "ok"},                                       # 只注册没往下(缺 key)
        {"auth": "ok", "key": True, "card": "card-bound"},    # 缺 purchase(do_purchase 开但无结果 → None → 不归 charge)
    ]
    # ① 纯Sel 等价对拍:matrix × res 变体 × opts 变体
    for st in matrix:
        for res_extra in ({}, {"key_reason": "WIZARD_KEY_NOT_CAPTURED"}, {"api_key": "sk-or-x"}):
            res = dict(res_extra)
            check("等价 st=%s res=%s" % (st, res_extra), af(dict(st), OPTS, res) == old(dict(st), OPTS, res))
    for opts in ({"do_key": True, "do_card": False, "do_purchase": False, "do_changepw": False},
                 {"do_key": False, "do_card": True, "do_purchase": True, "do_changepw": True}):
        for st in matrix:
            check("等价 opts=%s st=%s" % (opts, st), af(dict(st), opts, {}) == old(dict(st), opts, {}))
    # 等价对拍也覆盖 CHANGEPW_REQUIRE_PURCHASE=on 分支
    _bak_env = os.environ.get("CHANGEPW_REQUIRE_PURCHASE")
    os.environ["CHANGEPW_REQUIRE_PURCHASE"] = "on"
    try:
        for st in matrix:
            for res_extra in ({}, {"skipped_charge": True}):
                check("等价(cpw-req) st=%s res=%s" % (st, res_extra),
                      af(dict(st), OPTS, dict(res_extra)) == old(dict(st), OPTS, dict(res_extra)))
    finally:
        if _bak_env is None:
            os.environ.pop("CHANGEPW_REQUIRE_PURCHASE", None)
        else:
            os.environ["CHANGEPW_REQUIRE_PURCHASE"] = _bak_env

    # ② 混合专属归因
    check("混合 pw=False → key", af({"auth": "ok", "pw": False, "pw_reason": "API_KEY_MODAL"}, OPTS, {}) == ("key", "API_KEY_MODAL"))
    check("混合 giveup → card(优先 giveup 文案)",
          af({"auth": "ok", "pw": True, "card": "server-error", "giveup": "all-segments-502"}, OPTS, {}) == ("card", "all-segments-502"))
    check("混合 giveup 但 card 无值 → card",
          af({"auth": "ok", "pw": True, "giveup": "no-good-proxy"}, OPTS, {}) == ("card", "no-good-proxy"))
    check("混合 顶层 res.purchase 失败 → charge",
          af({"auth": "ok", "pw": True, "card": "card-bound"}, OPTS, {"purchase": "declined"}) == ("charge", "declined"))
    check("混合 复用 key(api_key)→ bill_ok 成立 → 仍追加卡失败",
          af({"auth": "ok", "card": "declined"}, OPTS, {"api_key": "sk-or-x"}) == ("card", "declined"))

    # ③ 边界
    check("全成 → (None,None)", af({"auth": "ok", "key": True, "card": "card-bound", "purchase": "success"}, OPTS, {}) == (None, None))
    check("None 输入不抛 → (None,None)", af(None, None, None) == (None, None))
    check("取key失败 → 只到 key 不追卡(bill_ok=False 拦住)",
          af({"auth": "ok", "key": False, "card": "declined"}, OPTS, {}) == ("key", "key-not-captured"))


TESTS = [
    test_prior_done,
    test_save_progress_stage_merge,
    test_charge_double_spend_gate,
    test_diversify_proxies,
    test_acquire_browser_proxy_scoring,
    test_attribution_helper,
]


def main():
    print("=" * 56)
    print("  编排层(续跑/防双扣/代理多样化)离线回归")
    print("=" * 56)
    for t in TESTS:
        print("·", t.__name__)
        try:
            t()
        except Exception as e:
            global FAIL
            FAIL += 1
            FAILED.append("%s 抛异常: %s" % (t.__name__, str(e)[:80]))
            print("  ✗ EXC:", str(e)[:80])
    print("-" * 56)
    print("结果: %d 通过, %d 失败" % (PASS, FAIL))
    if FAILED:
        print("失败项:")
        for f in FAILED:
            print("  -", f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
