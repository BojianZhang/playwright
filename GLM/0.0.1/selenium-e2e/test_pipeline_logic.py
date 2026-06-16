#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 离线回归(无网络/无 AdsPower/无扣款):z.ai 流水线核心逻辑单测
#
# 文件定位：GLM/0.0.1/selenium-e2e/test_pipeline_logic.py
# 跑法：python selenium-e2e/test_pipeline_logic.py   (全绿才算过)
#
# 覆盖:逐阶段续跑跳过(_prior_done)、save_progress 阶段合并、订阅去重门(防重复扣款)、
#   失败归因(register→apikey→subscribe)、充值容量账本原子预留/提交/释放、滑块拖拽轨迹。
# ═══════════════════════════════════════════════════════════════════════

import os
import sys
import json
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import common
import pipeline
import run
from common.attribution import attribute_failure
from services import slider

_PASS = 0; _FAIL = 0


def check(name, cond):
    global _PASS, _FAIL
    if cond:
        _PASS += 1; print("  ✓ %s" % name)
    else:
        _FAIL += 1; print("  ✗ %s" % name)


# ── 1) 逐阶段续跑跳过 ──────────────────────────────────────────────────────
def test_prior_done():
    print("test_prior_done")
    a = {"prior": {"stages": {"apikey": {"status": "ok"}, "subscribe": {"status": "ok"}}}}
    check("apikey done", pipeline._prior_done(a, "apikey") is True)
    check("subscribe done", pipeline._prior_done(a, "subscribe") is True)
    check("register not done", pipeline._prior_done(a, "register") is False)
    check("empty acct safe", pipeline._prior_done({}, "subscribe") is False)


# ── 2) 订阅去重门(防重复扣款)──────────────────────────────────────────────
def test_subscribe_gate():
    print("test_subscribe_gate")
    check("checkpoint signal", pipeline._subscribe_already_done({"prior": {"stages": {"subscribe": {"status": "ok"}}}}) is True)
    check("results signal", pipeline._subscribe_already_done({"subscribed": 30}) is True)
    check("results bool signal", pipeline._subscribe_already_done({"subscribed": True}) is True)
    check("not subscribed", pipeline._subscribe_already_done({"prior": {"stages": {}}}) is False)
    check("empty safe", pipeline._subscribe_already_done({}) is False)
    # ★uncertain(上次 Confirm 已点、终态未确认=可能已扣)也必须当"已订阅"跳过 → 绝不自动重扣
    check("uncertain blocks recharge", pipeline._subscribe_already_done({"prior": {"stages": {"subscribe": {"status": "uncertain"}}}}) is True)
    # ★写前 checkpoint 防硬kill双扣:release 分支把写前 "uncertain" 降级成 "not-charged"(非 ok/uncertain)→ 不跳过,
    #   续跑可重试(明确没扣的号绝不被永久 stuck)。这条护住"降级状态必须可重试"不被回归。
    check("not-charged retryable", pipeline._subscribe_already_done({"prior": {"stages": {"subscribe": {"status": "not-charged"}}}}) is False)


# ── 2c) 支付结果 → 记账动作(commit/release/uncertain)防"哪个结果该不该扣"回归 ──
def test_charge_disposition():
    print("test_charge_disposition")
    cd = pipeline._charge_disposition
    check("success -> commit", cd("success") == "commit")
    # 确定未扣(明确拒付/金额非法 + Confirm 之前就失败的三种)→ release 可重试,绝不误记账
    for r in ("declined", "invalid-amount", "plan-not-found", "plan-unconfirmed", "no-payment-form", "confirm-not-found"):
        check("%s -> release" % r, cd(r) == "release")
    # Confirm 已点、终态不明 → uncertain(保守按已扣防重扣)
    check("unknown -> uncertain", cd("unknown") == "uncertain")
    check("server-error -> uncertain", cd("server-error") == "uncertain")
    check("未知值 -> uncertain(默认绝不release重扣)", cd("some-new-status") == "uncertain")


# ── 2b) 充值提交返回值 + 恢复策略 key 映射 + 账号去重 + 已存在邻近匹配 ──────────
def test_commit_return_and_recovery():
    print("test_commit_return_and_recovery")
    import tempfile, json as _j
    from common import recovery
    # commit_charge 返回 bool:无 card_id=True(未跟踪);卡池缺失=False(落盘前读失败)
    check("commit no-card -> True", common.commit_charge("", 5) is True)
    with tempfile.TemporaryDirectory() as d:
        pool = os.path.join(d, "cp.json")
        with open(pool, "w", encoding="utf-8") as f:
            _j.dump([{"id": "C1", "chargeCap": 5, "chargedTotal": 0, "chargeInflight": 1, "balance": 50}], f)
        old = common.paths.POOL_FILE; common.paths.POOL_FILE = pool
        try:
            check("commit ok -> True", common.commit_charge("C1", 5) is True)
        finally:
            common.paths.POOL_FILE = old
    # recovery:attribution 真实产出的 apikey/subscribe 必须能被开关命中(原来只认 key/charge → 永不生效)
    recovery.reset_cache()
    os.environ["GLM_RECOVERY_JSON"] = _j.dumps({"retry": {"retryCharge": "off", "retryKey": "off"}})
    recovery.reset_cache()
    check("subscribe retry off honored", recovery.should_retry("subscribe") is False)
    check("apikey retry off honored", recovery.should_retry("apikey") is False)
    check("register default retry", recovery.should_retry("register") is True)
    os.environ.pop("GLM_RECOVERY_JSON", None); recovery.reset_cache()
    check("default no-policy -> retry", recovery.should_retry("subscribe") is True)


def test_accounts_dedup():
    print("test_accounts_dedup")
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "ac.txt")
        with open(p, "w", encoding="utf-8") as f:
            f.write("a@x.com:pw1\nA@X.com:pw2\nb@y.com:pw3\n# comment\na@x.com:pw4\n")
        acc = run.read_accounts(p)
        emails = [a["email"] for a in acc]
        check("dedup same email (case-insensitive)", len(acc) == 2)
        check("keeps first occurrence", emails[0] == "a@x.com" and acc[0]["mailbox_pw"] == "pw1")


def test_exists_proximity():
    print("test_exists_proximity")
    from steps import steps_auth
    # 复用注册里同款判据:用一个小包装直接测正则(邻近匹配,不再全页共现)
    def is_exists(t):
        t = t.lower()
        import re as _re
        return bool(_re.search(r"already\s+(in[\s-]?use|registered|exists?|taken)", t)
                    or _re.search(r"(e-?mail|account)\b[^.<>]{0,40}already", t)
                    or _re.search(r"已(注册|存在|被注册|被使用)", t) or "邮箱已被" in t)
    check("true: email already in use", is_exists("This email is already in use") is True)
    check("true: already registered", is_exists("Account already registered") is True)
    check("true: 已注册", is_exists("该邮箱已注册") is True)
    # ★全新号页面的干扰文案不得误判:页脚 registered trademark + Already have an account
    check("false: trademark + already-have", is_exists("Already have an account? Sign in. © Registered trademark.") is False)
    check("false: plain signup", is_exists("Create your account. Sign up to get started.") is False)


# ── 3) save_progress 阶段合并(apikey + subscribe 并存,不互相覆盖)───────────
def test_save_progress_merge():
    print("test_save_progress_merge")
    with tempfile.TemporaryDirectory() as d:
        run._PROGRESS_FILE = os.path.join(d, "prog.json")
        run.save_progress("a@x.com", registered=True)
        run.save_progress("a@x.com", _stage=("apikey", {"status": "ok", "api_key": "K1"}))
        run.save_progress("a@x.com", _stage=("subscribe", {"status": "ok", "plan": "pro", "amount": 64.8}))
        with open(run._PROGRESS_FILE, encoding="utf-8") as f:
            d2 = json.load(f)
        rec = d2["a@x.com"]
        check("registered kept", rec.get("registered") is True)
        check("apikey stage", rec["stages"]["apikey"]["status"] == "ok")
        check("apikey key kept", rec["stages"]["apikey"]["api_key"] == "K1")
        check("subscribe stage coexists", rec["stages"]["subscribe"]["plan"] == "pro")


# ── 4) 失败归因(register→apikey→subscribe)──────────────────────────────────
def test_attribution():
    print("test_attribution")
    fs, fr = attribute_failure({"auth": "fail:SLIDER_FAIL"}, {"do_apikey": True, "do_subscribe": True})
    check("register first", fs == "register" and "SLIDER" in fr)
    fs, fr = attribute_failure({"auth": "ok", "apikey": False}, {"do_apikey": True}, {"key_reason": "KEY_NOT_CAPTURED"})
    check("apikey reason", fs == "apikey" and fr == "KEY_NOT_CAPTURED")
    fs, fr = attribute_failure({"auth": "ok", "apikey": True, "subscribe": "declined"},
                               {"do_apikey": True, "do_subscribe": True, "real_charge": True},
                               {"payment_status": "declined"})
    check("subscribe declined", fs == "subscribe" and fr == "declined")
    fs, fr = attribute_failure({"auth": "ok", "apikey": True, "subscribe": "success"},
                               {"do_apikey": True, "do_subscribe": True})
    check("all ok -> none", fs is None and fr is None)
    fs, fr = attribute_failure({"auth": "ok", "apikey": True, "subscribe": "dryrun"},
                               {"do_apikey": True, "do_subscribe": True})
    check("dryrun not fail", fs is None)
    fs, fr = attribute_failure({"auth": "ok", "subscribe": "success"}, {"do_apikey": False, "do_subscribe": True})
    check("apikey off no-attr", fs is None)
    # R2-UNCERTAIN:支付终态不明保守按已扣(steps.subscribe 现统一为 "uncertain")→ 归因【不当失败】(由 subscribe_uncertain 单独追踪)
    fs, fr = attribute_failure({"auth": "ok", "apikey": True, "subscribe": "uncertain"},
                               {"do_apikey": True, "do_subscribe": True, "real_charge": True},
                               {"subscribe_uncertain": True, "payment_status": "uncertain"})
    check("uncertain not fail (已保守记账,不重报失败)", fs is None and fr is None)


# ── 5) 充值容量账本:原子预留 / 提交 / 释放(临时卡池,不碰真数据)──────────────
def test_charge_ledger():
    print("test_charge_ledger")
    with tempfile.TemporaryDirectory() as d:
        pool = os.path.join(d, "card-pool.json")
        card = {"id": "CID1", "number": "4242424242424242", "last4": "4242",
                "expMonth": "12", "expYear": "30", "cvc": "123",
                "chargeCap": 2, "chargedTotal": 0, "chargeInflight": 0, "balance": 100}
        with open(pool, "w", encoding="utf-8") as f:
            json.dump([card], f)
        old = common.paths.POOL_FILE
        common.paths.POOL_FILE = pool
        try:
            ok1, r1 = common.reserve_charge("CID1", 30)
            ok2, r2 = common.reserve_charge("CID1", 30)
            check("reserve#1 ok", ok1 is True)
            check("reserve#2 ok (cap2)", ok2 is True)
            ok3, r3 = common.reserve_charge("CID1", 30)
            check("reserve#3 blocked", ok3 is False)
            common.commit_charge("CID1", 30)
            common.release_charge("CID1")
            with open(pool, encoding="utf-8") as f:
                c = json.load(f)[0]
            check("chargedTotal=1 after commit", int(c.get("chargedTotal")) == 1)
            check("inflight back to 0", int(c.get("chargeInflight")) == 0)
            check("balance debited 100->70", float(c.get("balance")) == 70)
            check("no-card -> (False,no-card)", common.reserve_charge("", 5) == (False, "no-card"))
        finally:
            common.paths.POOL_FILE = old


# ── 6) 滑块拖拽轨迹合理性 ──────────────────────────────────────────────────
def test_slider_path():
    print("test_slider_path")
    p = slider.build_drag_path(100, 50, 180)
    check("path has many points", len(p) >= 20)
    check("starts at handle", abs(p[0][0] - 100) < 1)
    check("ends near target", abs(p[-1][0] - 280) < 2)
    check("y near handle row", all(abs(y - 50) < 6 for _, y in p))
    pn = slider.build_drag_path(300, 50, -120)
    check("neg distance ends near", abs(pn[-1][0] - 180) < 2)


# ── 7) 价格矩阵读取 ────────────────────────────────────────────────────────
def test_price_for():
    print("test_price_for")
    cfg = {"subscribe_prices": {"pro": {"monthly": 64.8, "yearly": 604.8}}}
    check("pro/monthly", pipeline._price_for(cfg, "pro", "monthly") == 64.8)
    check("missing -> 0", pipeline._price_for(cfg, "max", "monthly") == 0)
    check("empty cfg -> 0", pipeline._price_for({}, "pro", "monthly") == 0)


def test_on_apikey():
    """P0 回归:detect_session 的 _on_apikey 判据 —— OAuth 回跳 URL(chat.z.ai/auth?...redirect_uri=...manage-apikey,
       query 里含 apikey)【绝不】判成"在取Key页"(裸子串 'apikey' in url 会误判→在登出选择屏找 Add→ADD_BUTTON_NOT_FOUND);
       只有真落到 z.ai/manage-apikey 才判 True。守住头号根因。"""
    from steps.steps_auth import _on_apikey
    check("on_apikey: OAuth回跳URL(query含apikey)判否",
          _on_apikey("https://chat.z.ai/auth?response_type=code&redirect_uri=https%3A%2F%2Fz.ai%2Fmanage-apikey%2Fapikey-list&state=x") is False)
    check("on_apikey: 真取Key页判是", _on_apikey("https://z.ai/manage-apikey/apikey-list") is True)
    check("on_apikey: 真取Key页大写域判是", _on_apikey("https://Z.AI/manage-apikey") is True)
    check("on_apikey: z.ai/subscribe判否", _on_apikey("https://z.ai/subscribe") is False)
    check("on_apikey: chat首页判否", _on_apikey("https://chat.z.ai/") is False)
    check("on_apikey: 裸/auth选择屏判否", _on_apikey("https://chat.z.ai/auth") is False)
    check("on_apikey: 空/None判否", (_on_apikey("") is False) and (_on_apikey(None) is False))


def main():
    global _FAIL
    for t in (test_prior_done, test_subscribe_gate, test_charge_disposition,
              test_commit_return_and_recovery, test_accounts_dedup, test_exists_proximity,
              test_save_progress_merge, test_attribution, test_charge_ledger,
              test_slider_path, test_price_for, test_on_apikey):
        try:
            t()
        except Exception as e:
            _FAIL += 1
            print("  ✗ %s 抛异常: %s" % (t.__name__, e))
    print("\n%d passed, %d failed" % (_PASS, _FAIL))
    sys.exit(1 if _FAIL else 0)


if __name__ == "__main__":
    main()
