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


TESTS = [
    test_prior_done,
    test_save_progress_stage_merge,
    test_charge_double_spend_gate,
    test_diversify_proxies,
    test_acquire_browser_proxy_scoring,
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
