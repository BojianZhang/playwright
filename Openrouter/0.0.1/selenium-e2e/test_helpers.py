#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 离线回归测试套件(纯合成数据,不碰真实卡池/账号/代理、不联网、不花卡)。
# 锁住 common.py 的纯逻辑 helper —— 尤其本轮修的 4 处 bug,防回归。
# 用法:  python test_helpers.py      (全绿才算通过;任一 FAIL 退出码=1)
import os, sys, json, tempfile, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

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


def _tmpstate():
    """把所有状态文件指到临时目录,绝不碰真实 state/。"""
    d = tempfile.mkdtemp(prefix="orhelpertest_")
    common.POOL_FILE = os.path.join(d, "pool.json")
    common.CARD_ASSIGN_FILE = os.path.join(d, "assign.json")
    common.BIN_USAGE_FILE = os.path.join(d, "bin.json")
    common.PROXY_STATS_FILE = os.path.join(d, "proxy.json")
    return d


def _pool(cards):
    json.dump(cards, open(common.POOL_FILE, "w", encoding="utf-8"))


def _pool0():
    return json.load(open(common.POOL_FILE, encoding="utf-8"))[0]


def _card(cid, bin6, **kw):
    c = {"id": cid, "number": bin6 + "0000000000", "last4": bin6[-4:],
         "status": "active", "usedCount": 0, "maxUses": 10}
    c.update(kw)
    return c


# ─────────────────────────────────────────────────────────────────────
def test_is_banned_reason():
    """Fix #4:三处统一的 banned 判定。"""
    for s in ["not allowed to access this application", "ACCOUNT_NOT_ALLOWED",
              "access denied", "not permitted", "User is NOT_ALLOWED"]:
        check("banned(%r)" % s[:20], common.is_banned_reason(s) is True)
    for s in ["", None, "login ok", "application error", "server error 502", "timeout"]:
        check("not-banned(%r)" % s, common.is_banned_reason(s) is False)
    check("banned multipart", common.is_banned_reason(None, "ok", "not allowed") is True)
    check("not-banned multipart", common.is_banned_reason(None, "ok", "") is False)


def test_load_card_count_bin():
    """Fix #1:换卡(count_bin=False)不重复占 BIN 额度、不覆盖原分配;续跑复用原卡。"""
    _tmpstate()
    os.environ["CARD_STRATEGY"] = "spread"
    _pool([_card("A", "400111"), _card("B", "555222")])
    EM = "swap@x.com"
    today = datetime.date.today().isoformat()

    c1 = common.load_card(EM)
    b1 = c1["number"][:6]
    a1 = (json.load(open(common.BIN_USAGE_FILE)).get(today, {}).get(b1) or {}).get("assigned", 0)
    check("首次分配占 BIN 额度=1", a1 == 1)
    check("assign 落盘", json.load(open(common.CARD_ASSIGN_FILE))[EM] == c1["id"])

    c1b = common.load_card(EM)
    check("重试复用同卡", c1b["id"] == c1["id"])

    c2 = common.load_card(EM, exclude={c1["id"]}, count_bin=False)
    b2 = c2["number"][:6]
    bu = json.load(open(common.BIN_USAGE_FILE))
    a2 = (bu.get(today, {}).get(b2) or {}).get("assigned", 0)
    a1after = (bu.get(today, {}).get(b1) or {}).get("assigned", 0)
    check("换卡返回不同卡", c2["id"] != c1["id"])
    check("换卡不占新 BIN 额度", a2 == 0)
    check("换卡不动原 BIN 额度", a1after == 1)
    check("换卡不覆盖原分配", json.load(open(common.CARD_ASSIGN_FILE))[EM] == c1["id"])

    c3 = common.load_card(EM)
    check("续跑复用最初分配卡(非最后换的)", c3["id"] == c1["id"])


def test_load_card_exclude_fallback():
    """exclude 掉全部 → active 为空应抛(而非死循环/返回 None)。"""
    _tmpstate()
    os.environ["CARD_STRATEGY"] = "spread"
    _pool([_card("A", "400111")])
    try:
        common.load_card("e@x.com", exclude={"A"})
        check("exclude 全部应抛 RuntimeError", False)
    except RuntimeError:
        check("exclude 全部应抛 RuntimeError", True)


def test_mark_card_declined():
    # 用户(2026-06-12)新认知:declined 多是【环境因素】(ZIP/AVS/IP)非卡坏 → 单次只【冷却可复用】,
    # declineCount 累到阈值(CARD_DECLINE_DISABLE_AT 默认2)才禁用。
    os.environ.pop("CARD_DECLINE_DISABLE_AT", None)
    _tmpstate()
    _pool([_card("A", "400111")])
    common.mark_card_result({"id": "A", "number": "4001110000000000"}, "declined")
    check("declined第1次只冷却不禁用", _pool0()["status"] == "active" and bool(_pool0().get("cooldownUntil")))
    common.mark_card_result({"id": "A", "number": "4001110000000000"}, "declined")
    check("declined第2次(≥阈值)才禁用", _pool0()["status"] == "disabled" and _pool0()["disabledReason"] == "declined")


def test_mark_card_hcaptcha():
    os.environ["CARD_CAPTCHA_LIMIT"] = "3"
    # spread(生产默认):hcaptcha 是账号级风控,【绝不禁卡】(只计数),避免误禁好卡
    _tmpstate()
    os.environ["CARD_STRATEGY"] = "spread"
    _pool([_card("A", "400111")])
    for _ in range(4):
        common.mark_card_result({"id": "A", "number": "4001110000000000"}, "hcaptcha")
    check("spread:校验框4次仍active(不禁卡,只计数)", _pool0()["status"] == "active" and _pool0().get("captchaCount") == 4)
    # concentrate(容量测试):达阈值才禁
    _tmpstate()
    os.environ["CARD_STRATEGY"] = "concentrate"
    _pool([_card("A", "400111")])
    for _ in range(2):
        common.mark_card_result({"id": "A", "number": "4001110000000000"}, "hcaptcha")
    check("concentrate:校验框2次未到阈值", _pool0()["status"] == "active")
    common.mark_card_result({"id": "A", "number": "4001110000000000"}, "hcaptcha")
    check("concentrate:校验框3次禁用", _pool0()["status"] == "disabled" and _pool0()["disabledReason"] == "too-many-captcha")
    os.environ["CARD_STRATEGY"] = "spread"   # 复原,别影响后续用例


def test_mark_card_server_error():
    # 用户规则:server-error/unknown 不是卡坏(Radar/网络)→ 永不禁卡,只计数
    _tmpstate()
    _pool([_card("A", "400111")])
    for _ in range(6):
        common.mark_card_result({"id": "A", "number": "4001110000000000"}, "server-error")
    check("server-error 6次仍active(不禁卡,只计数)", _pool0()["status"] == "active" and _pool0()["errorCount"] == 6)


def test_mark_card_bound_resets_error():
    _tmpstate()
    _pool([_card("A", "400111", errorCount=3)])
    common.mark_card_result({"id": "A", "number": "4001110000000000"}, "card-bound")
    p = _pool0()
    check("绑成 success++/used++/errorCount清零", p["successCount"] == 1 and p["usedCount"] == 1 and p["errorCount"] == 0)


def test_mark_card_bin_histogram():
    """加卡结果写 per-BIN 当日直方图。"""
    _tmpstate()
    _pool([_card("A", "436120")])
    common.mark_card_result({"id": "A", "number": "4361200000000000"}, "server-error")
    today = datetime.date.today().isoformat()
    t = json.load(open(common.BIN_USAGE_FILE)).get(today, {}).get("436120", {})
    check("BIN 直方图记 server-error", t.get("server-error") == 1)


def test_proxy_streak():
    """Fix(已有):dead/unknown 累连击,card-bound 清零,server-error 不计连击;阈值5退役。"""
    _tmpstate()
    os.environ["PROXY_RETIRE_STREAK"] = "5"
    px = {"host": "1.2.3.4", "port": "1000"}
    for _ in range(4):
        common.mark_proxy_result(px, "dead")
    check("4 次 dead 未退役", common.proxy_retired(px) is False)
    common.mark_proxy_result(px, "dead")
    check("5 次 dead 退役", common.proxy_retired(px) is True)
    common.mark_proxy_result(px, "card-bound")
    check("绑成清连击/复活", common.proxy_retired(px) is False)
    for _ in range(6):
        common.mark_proxy_result(px, "server-error")
    check("server-error 不计连击(不退役)", common.proxy_retired(px) is False)


def test_proxy_ok_robust():
    """Fix #2:坏代理返回 (False,None) 不抛;函数签名返回二元组。"""
    r = common.proxy_ok({"host": "10.255.255.1", "port": "1", "user": "", "pass": ""}, timeout=2)
    check("proxy_ok 坏代理返回二元组不抛", isinstance(r, tuple) and len(r) == 2)
    # SOCKS 依赖缺失分支的字符串判定逻辑(函数内 except 用同样判断)
    m = "Missing dependencies for SOCKS support".lower()
    check("SOCKS缺失判定逻辑", "socks" in m and ("missing" in m or "dependenc" in m))


def test_binusage_legacy():
    """_bin_today 把旧 {BIN:int} 规整成 {BIN:{assigned:int}}。"""
    _tmpstate()
    today = datetime.date.today().isoformat()
    json.dump({today: {"400111": 5}}, open(common.BIN_USAGE_FILE, "w"))
    bu = common._read_bin_usage()
    t = common._bin_today(bu, today)
    check("旧int格式兼容", isinstance(t.get("400111"), dict) and t["400111"].get("assigned") == 5)


def test_firstmail_otp_strict():
    """Fix B:strict 不回退旧码 / 日期不明保守不吞 / 新码正常 / 无since_ts兼容。"""
    import firstmail
    def ms(iso):
        return datetime.datetime.fromisoformat(iso).timestamp() * 1000.0
    OLD, NEW = "2020-01-01T00:00:00+00:00", "2030-01-01T00:00:00+00:00"
    since = ms("2025-01-01T00:00:00+00:00")
    orig = firstmail.get_latest_message
    try:
        # 1) 只有旧码 + strict → 不回退,None
        firstmail.get_latest_message = lambda *a, **k: {"data": {"text": "Your code is 123456", "date": OLD}}
        check("strict 不回退旧码", firstmail.wait_verify_code("e", "p", "k", attempts=2, interval=0, since_ts=since, strict=True) is None)
        # 2) 只有旧码 + 非strict → 回退旧码(保持兼容)
        check("非strict 回退旧码", firstmail.wait_verify_code("e", "p", "k", attempts=2, interval=0, since_ts=since, strict=False) == "123456")
        # 3) 新码 → 返回
        firstmail.get_latest_message = lambda *a, **k: {"data": {"text": "code 654321", "date": NEW}}
        check("新码返回", firstmail.wait_verify_code("e", "p", "k", attempts=2, interval=0, since_ts=since, strict=True) == "654321")
        # 4) 日期不明 + since_ts + strict → 不第一次就吞,最终 None
        firstmail.get_latest_message = lambda *a, **k: {"data": {"text": "code 111222"}}
        check("日期不明保守不吞", firstmail.wait_verify_code("e", "p", "k", attempts=2, interval=0, since_ts=since, strict=True) is None)
        # 5) 无 since_ts(注册等无时效场景)→ 任何码算新
        check("无since_ts任何码算新", firstmail.wait_verify_code("e", "p", "k", attempts=2, interval=0, since_ts=0, strict=True) == "111222")
    finally:
        firstmail.get_latest_message = orig


def test_rescue_key():
    """Fix C:从 Node 输出抢救已建的 sk-or- key。"""
    import hybrid_run
    txt = "some log\n[pw] APIKEY_CREATED sk-or-v1-abcdef0123456789abcdef\nmore"
    check("抢救key", hybrid_run._rescue_key(txt) == "sk-or-v1-abcdef0123456789abcdef")
    check("无key返回空", hybrid_run._rescue_key("no key here") == "")
    check("空输入安全", hybrid_run._rescue_key("") == "" and hybrid_run._rescue_key(None) == "")


def test_hcaptcha_text_detect():
    """检测漏修复:RE_HCAPTCHA 命中校验框外壳文案(iframe抓不到时兜底)。"""
    import common
    for t in ["One more step before you're done. Select the checkbox below.",
              "I am human", "select the checkbox below"]:
        check("hcaptcha壳文案命中(%r)" % t[:20], bool(common.RE_HCAPTCHA.search(t)))
    for t in ["Saving...", "card was declined", "payment method added", ""]:
        check("正常文案不误命中(%r)" % t, not common.RE_HCAPTCHA.search(t))


def test_atomic_write():
    """原子写:内容正确 + 不残留 .tmp + 覆盖已有文件。"""
    d = _tmpstate()
    p = os.path.join(d, "sub", "x.json")
    ok = common._atomic_write_json(p, {"a": 1, "b": [2, 3]})
    check("原子写返回True", ok is True)
    check("内容正确", json.load(open(p)) == {"a": 1, "b": [2, 3]})
    common._atomic_write_json(p, {"a": 9})
    check("覆盖正确", json.load(open(p)) == {"a": 9})
    leftover = [f for f in os.listdir(os.path.dirname(p)) if ".tmp." in f]
    check("无 .tmp 残留", leftover == [])


def test_grid_rect():
    os.environ["SCREEN_W"] = "1920"
    os.environ["SCREEN_H"] = "1080"
    rects = [common.grid_rect(i, 4) for i in range(4)]
    check("4 窗格各不同", len(set(rects)) == 4)
    check("窗格是4元组且非负", all(len(r) == 4 and r[0] >= 0 and r[1] >= 0 for r in rects))
    big = common.grid_rect(0, 1)
    check("单窗格够大", big[2] >= 480 and big[3] >= 360)


# ─────────────────────────────────────────────────────────────────────
TESTS = [
    test_is_banned_reason,
    test_load_card_count_bin,
    test_load_card_exclude_fallback,
    test_mark_card_declined,
    test_mark_card_hcaptcha,
    test_mark_card_server_error,
    test_mark_card_bound_resets_error,
    test_mark_card_bin_histogram,
    test_proxy_streak,
    test_proxy_ok_robust,
    test_binusage_legacy,
    test_firstmail_otp_strict,
    test_rescue_key,
    test_hcaptcha_text_detect,
    test_atomic_write,
    test_grid_rect,
]


def main():
    print("=" * 56)
    print("  common.py 离线回归测试")
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
