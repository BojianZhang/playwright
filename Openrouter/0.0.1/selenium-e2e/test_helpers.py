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
    common.paths.POOL_FILE = os.path.join(d, "pool.json")
    common.paths.CARD_ASSIGN_FILE = os.path.join(d, "assign.json")
    common.paths.BIN_USAGE_FILE = os.path.join(d, "bin.json")
    common.paths.PROXY_STATS_FILE = os.path.join(d, "proxy.json")
    return d


def _pool(cards):
    json.dump(cards, open(common.paths.POOL_FILE, "w", encoding="utf-8"))


def _pool0():
    return json.load(open(common.paths.POOL_FILE, encoding="utf-8"))[0]


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
    a1 = (json.load(open(common.paths.BIN_USAGE_FILE)).get(today, {}).get(b1) or {}).get("assigned", 0)
    check("首次分配占 BIN 额度=1", a1 == 1)
    check("assign 落盘", json.load(open(common.paths.CARD_ASSIGN_FILE))[EM] == c1["id"])

    c1b = common.load_card(EM)
    check("重试复用同卡", c1b["id"] == c1["id"])

    c2 = common.load_card(EM, exclude={c1["id"]}, count_bin=False)
    b2 = c2["number"][:6]
    bu = json.load(open(common.paths.BIN_USAGE_FILE))
    a2 = (bu.get(today, {}).get(b2) or {}).get("assigned", 0)
    a1after = (bu.get(today, {}).get(b1) or {}).get("assigned", 0)
    check("换卡返回不同卡", c2["id"] != c1["id"])
    check("换卡不占新 BIN 额度", a2 == 0)
    check("换卡不动原 BIN 额度", a1after == 1)
    check("换卡不覆盖原分配", json.load(open(common.paths.CARD_ASSIGN_FILE))[EM] == c1["id"])

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
    t = json.load(open(common.paths.BIN_USAGE_FILE)).get(today, {}).get("436120", {})
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
    """Fix #2:坏代理/缺依赖时 proxy_ok 不抛,且稳定返回 (bool, None|数) 二元组。
       地址用非可路由 TEST-NET(RFC5737 10.255.255.1):连接本地即失败,不触达任何真实服务;
       缺 requests/socks 时 proxy_ok 会提前返回 (True,None)。两种路径都只验"契约稳定"。"""
    r = common.proxy_ok({"host": "10.255.255.1", "port": "1", "user": "", "pass": ""}, timeout=1)
    check("proxy_ok 返回二元组不抛", isinstance(r, tuple) and len(r) == 2)
    # 真正校验返回契约(原断言是对字面量自证的恒真重言式,等于没测):首元素 bool,次元素 None 或数值
    ok_flag, latency = r
    check("proxy_ok 契约:首 bool、次 None/数值",
          isinstance(ok_flag, bool) and (latency is None or isinstance(latency, (int, float))))


def test_binusage_legacy():
    """_bin_today 把旧 {BIN:int} 规整成 {BIN:{assigned:int}}。"""
    _tmpstate()
    today = datetime.date.today().isoformat()
    json.dump({today: {"400111": 5}}, open(common.paths.BIN_USAGE_FILE, "w"))
    bu = common._read_bin_usage()
    t = common._bin_today(bu, today)
    check("旧int格式兼容", isinstance(t.get("400111"), dict) and t["400111"].get("assigned") == 5)


def test_firstmail_otp_strict():
    """Fix B:strict 不回退旧码 / 日期不明保守不吞 / 新码正常 / 无since_ts兼容。"""
    from services import firstmail
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
def test_bad_mailbox():
    """坏邮箱判定:整邮箱命中 + 按 @domain 命中 + 空邮箱安全(2026-06-13)。"""
    bad = {"dead@x.com": {}, "@deaddomain.com": {}}
    check("坏邮箱:整邮箱命中", common.is_bad_mailbox("dead@x.com", bad) is True)
    check("坏邮箱:按域命中", common.is_bad_mailbox("anyone@deaddomain.com", bad) is True)
    check("坏邮箱:不命中", common.is_bad_mailbox("ok@good.com", bad) is False)
    check("坏邮箱:空安全", common.is_bad_mailbox("", bad) is False)


def test_verify_fail_counter():
    """软坏邮箱(可达但收不到验证信)跨批计数器:mark 自增返回累计、clear 清零、达阈值升级坏邮箱、域坏号计数。"""
    import shutil
    d = tempfile.mkdtemp(prefix="orsoftbad_")
    _saved = common.paths.HERE
    try:
        common.paths.HERE = d                       # 把 state/ 指到临时目录(_verify_fail_file/_bad_mailbox_file 都派生自 HERE)
        em = "nomail@example.com"
        check("软坏:初始无记录", common.load_verify_fails().get(em) is None)
        check("软坏:mark 返回累计 1", common.mark_verify_fail(em, "no-verify-mail") == 1)
        check("软坏:mark 返回累计 2", common.mark_verify_fail(em) == 2)
        check("软坏:count 落盘=2", int(common.load_verify_fails()[em]["count"]) == 2)
        common.clear_verify_fail(em)
        check("软坏:clear 后清零", common.load_verify_fails().get(em) is None)
        n = 0
        for _ in range(3):
            n = common.mark_verify_fail(em)
        check("软坏:三次后累计=3", n == 3)
        common.mark_bad_mailbox(em, "no-verify-mail:3x")   # 达阈值升级
        check("软坏:升级后 is_bad_mailbox 命中", common.is_bad_mailbox(em) is True)
        # 域坏号计数(供整域拉黑判阈值):整域条目本身不计入
        common.mark_bad_mailbox("a@deaddom.com")
        common.mark_bad_mailbox("b@deaddom.com")
        check("域:count_bad_in_domain=2", common.count_bad_in_domain("@deaddom.com") == 2)
        common.mark_bad_mailbox("@deaddom.com")
        check("域:整域条目本身不计仍=2", common.count_bad_in_domain("deaddom.com") == 2)
    finally:
        common.paths.HERE = _saved
        shutil.rmtree(d, ignore_errors=True)


def test_card_captcha_disable():
    """spread:弹框累计冷却,但撞≥5次禁用本卡(防反复重用热卡;2026-06-13)。"""
    _tmpstate()
    os.environ["CARD_STRATEGY"] = "spread"
    os.environ.pop("CARD_CAPTCHA_DISABLE", None)
    _pool([_card("A", "400111")])
    for _ in range(4):
        common.mark_card_result({"id": "A", "number": "4001110000000000"}, "hcaptcha")
    check("spread撞4次仍active", _pool0()["status"] == "active")
    common.mark_card_result({"id": "A", "number": "4001110000000000"}, "hcaptcha")
    check("spread撞5次→禁用", _pool0()["status"] == "disabled" and _pool0().get("disabledReason") == "too-many-captcha")
    os.environ.pop("CARD_STRATEGY", None)


def test_file_lock():
    """跨进程文件锁:获取建 lockfile、释放删之、可顺序重复获取(2026-06-13)。"""
    d = _tmpstate()
    tgt = os.path.join(d, "x.json")
    with common._file_lock(tgt):
        check("文件锁:lockfile 存在", os.path.exists(tgt + ".lock"))
    check("文件锁:释放后删除", not os.path.exists(tgt + ".lock"))
    with common._file_lock(tgt):
        pass
    with common._file_lock(tgt):
        pass
    check("文件锁:可顺序重复获取", not os.path.exists(tgt + ".lock"))


def test_grid_min_size():
    """窗口最小可用尺寸:高并发也不缩到不可用(≥600×500);10并发铺满非重叠(2026-06-13)。"""
    os.environ["SCREEN_W"] = "3440"; os.environ["SCREEN_H"] = "1440"
    for k in ("GRID_TOTAL", "GRID_SLOT_OFFSET", "GRID_MIN_W", "GRID_MIN_H"):
        os.environ.pop(k, None)
    r = common.grid_rect(0, 20)
    check("20并发窗口仍≥可用(600×500)", r[2] >= 600 and r[3] >= 500)
    rs = [common.grid_rect(i, 10) for i in range(10)]
    check("10并发10格各不同(铺满非重叠)", len(set(rs)) == 10)
    os.environ.pop("SCREEN_W", None); os.environ.pop("SCREEN_H", None)


def test_recovery_should_retry():
    """失败恢复策略门(common.recovery.should_retry):默认全 True(逐字节不变);只有显式 off 才拦;
    坏 JSON/未知 stage → 默认重试;★动作字段(ipRounds 等)对 Python 不可见(只读 retry.*)。"""
    rec = common.recovery

    def _set(env):
        if env is None:
            os.environ.pop("OPENROUTER_RECOVERY_JSON", None)
        else:
            os.environ["OPENROUTER_RECOVERY_JSON"] = env
        rec.reset_cache()

    # ① 无 env → 所有失败类型默认重试(现状)
    _set(None)
    check("无策略→register/key/card/charge 全默认重试", all(rec.should_retry(s) for s in ("register", "key", "card", "charge")))
    # ② 显式把 charge 关掉 → 只 charge 不重试,其余仍重试
    _set('{"retry":{"retryCharge":"off"}}')
    check("retryCharge=off → charge 不重试", rec.should_retry("charge") is False)
    check("retryCharge=off → card 仍重试", rec.should_retry("card") is True)
    # ③ 未知/缺失 stage → 默认重试(不因归因缺失漏跑)
    _set('{"retry":{"retryCard":"off"}}')
    check("未知 stage → 默认重试", rec.should_retry("chrge_typo") is True)
    check("retryCard=off → card 不重试", rec.should_retry("card") is False)
    # ④ 坏 JSON → 默认全重试(解析失败退现状)
    _set("{not valid json")
    check("坏 JSON → 默认重试", all(rec.should_retry(s) for s in ("register", "card", "charge")))
    # ⑤ ★动作字段对 Python 不可见:顶层混入 ipRounds/zipRetry 不影响 retry 判定(只读 retry.*)
    _set('{"retry":{"retryCharge":"off"},"ipRounds":"3","zipRetry":"2"}')
    check("动作字段不污染 retry 判定(charge 仍 off)", rec.should_retry("charge") is False)
    check("动作字段不污染 retry 判定(register 仍 on)", rec.should_retry("register") is True)
    _set(None)


TESTS = [
    test_recovery_should_retry,
    test_is_banned_reason,
    test_bad_mailbox,
    test_verify_fail_counter,
    test_card_captcha_disable,
    test_file_lock,
    test_grid_min_size,
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
