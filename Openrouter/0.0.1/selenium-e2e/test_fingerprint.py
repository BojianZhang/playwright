#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 指纹自测工具(tools/fingerprint_check.py)的离线回归测试 —— 只测纯逻辑,不联网/不开浏览器/不碰钱。
# 锁住:Server API 信号解析(v4 扁平 + v3 products 两种结构都要解对)、单环境定档、碰撞检测、报表不崩、JS 构造防注入。
# 用法:  python test_fingerprint.py     (全绿才算通过;任一 FAIL → 退出码 1)
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))   # 让 import fingerprint_check 可解析
import fingerprint_check as fc                     # noqa: E402

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


# ─────────────────────────────────────────────────────────────────────
def test_summarize_v4_flat():
    """v4:扁平 snake_case。bot 是枚举字符串,其余布尔在顶层,visitor_id/confidence 在 identification 下。"""
    resp = {
        "identification": {"visitor_id": "VID_ABC", "confidence": {"score": 0.97}},
        "bot": "not_detected",
        "vpn": False, "proxy": True, "tampering": False,
        "virtual_machine": False, "incognito": False,
        "ip_blocklist": {"email_spam": False, "attack_source": False, "tor_node": False},
    }
    s = fc.summarize_signals(resp)
    check("v4 visitor_id", s["visitor_id"] == "VID_ABC")
    check("v4 confidence", s["confidence"] == 0.97)
    check("v4 bot", s["bot"] == "not_detected")
    check("v4 proxy True", s["proxy"] is True)
    check("v4 vpn False", s["vpn"] is False)
    check("v4 tampering False", s["tampering"] is False)
    check("v4 vm False", s["virtual_machine"] is False)
    check("v4 ip_blocklist tor", s.get("ip_blocklist", {}).get("tor_node") is False)


def test_summarize_v3_products():
    """v3:products.<x>.data.result 嵌套结构。解析器必须照样抽得出(向后兼容)。"""
    resp = {"products": {
        "identification": {"data": {"visitorId": "VID_V3", "confidence": {"score": 0.88}}},
        "botd": {"data": {"bot": {"result": "bad"}}},
        "vpn": {"data": {"result": True}},
        "proxy": {"data": {"result": False}},
        "tampering": {"data": {"result": True}},
        "virtualMachine": {"data": {"result": False}},
        "incognito": {"data": {"result": False}},
    }}
    s = fc.summarize_signals(resp)
    check("v3 visitor_id", s["visitor_id"] == "VID_V3")
    check("v3 confidence", s["confidence"] == 0.88)
    check("v3 bot=bad", s["bot"] == "bad")
    check("v3 vpn True", s["vpn"] is True)
    check("v3 tampering True", s["tampering"] is True)


def test_summarize_garbage():
    """烂输入不崩,返回 {}/None,不抛。"""
    check("garbage None", fc.summarize_signals(None) == {})
    check("garbage str", fc.summarize_signals("nope") == {})
    s = fc.summarize_signals({})
    check("empty visitor None", s.get("visitor_id") is None)


# ─────────────────────────────────────────────────────────────────────
def test_classify_good():
    sig = {"bot": "not_detected", "tampering": False, "vpn": False, "proxy": False, "virtual_machine": False}
    c = fc.classify_env(sig, stable=True, is_collision=False, ok=True)
    check("good tier", c["tier"] == "✅好")
    check("good no reasons", c["reasons"] == [])


def test_classify_collision():
    c = fc.classify_env({}, stable=None, is_collision=True, ok=True)
    check("collision bad", c["tier"] == "❌差")
    check("collision reason", any("碰撞" in r for r in c["reasons"]))


def test_classify_unstable():
    c = fc.classify_env({"bot": "not_detected"}, stable=False, is_collision=False, ok=True)
    check("unstable bad", c["tier"] == "❌差")
    check("unstable reason", any("变了" in r for r in c["reasons"]))


def test_classify_detected():
    for key, val in (("bot", "bad"), ("tampering", True), ("virtual_machine", True)):
        c = fc.classify_env({key: val}, stable=True, is_collision=False, ok=True)
        check("detected %s bad" % key, c["tier"] == "❌差")


def test_classify_proxy_is_ok():
    """proxy=true 是用代理的预期内现象 → 不算坏,只进备注。"""
    c = fc.classify_env({"bot": "not_detected", "proxy": True}, stable=True, is_collision=False, ok=True)
    check("proxy not bad", c["tier"] == "✅好")
    check("proxy in notes", any("proxy" in n for n in c["notes"]))


def test_classify_not_ok():
    c = fc.classify_env({}, stable=None, is_collision=False, ok=False)
    check("not ok tier", c["tier"] == "⚠未取到")


# ─────────────────────────────────────────────────────────────────────
def test_analyze_collision():
    envs = {
        "e1": {"visitor_id": "A"},
        "e2": {"visitor_id": "B"},
        "e3": {"visitor_id": "A"},   # 与 e1 碰撞
        "e4": {"ok": False},          # 没 visitor_id,不计
    }
    info = fc.analyze(envs)
    check("analyze total", info["total"] == 4)
    check("analyze distinct", info["distinct_visitor_ids"] == 2)   # A, B
    check("analyze collision found", "A" in info["collisions"])
    check("analyze collision members", set(info["collisions"]["A"]) == {"e1", "e3"})
    check("analyze B not collision", "B" not in info["collisions"])


def test_analyze_empty():
    info = fc.analyze({})
    check("analyze empty total", info["total"] == 0)
    check("analyze empty collisions", info["collisions"] == {})


# ─────────────────────────────────────────────────────────────────────
def test_render_report():
    check("render empty no crash", "指纹自测报告" in fc.render_report({"envs": {}}))
    scores = {"envs": {
        "e1": {"env_id": "e1", "ok": True, "visitor_id": "A", "stable": True,
               "signals": {"bot": "not_detected", "tampering": False}},
        "e2": {"env_id": "e2", "ok": True, "visitor_id": "A", "stable": True,
               "signals": {"bot": "not_detected"}},   # 与 e1 碰撞
    }}
    rep = fc.render_report(scores)
    check("render shows collision", "碰撞" in rep)
    check("render has env rows", "e1" in rep and "e2" in rep)


# ─────────────────────────────────────────────────────────────────────
def test_fp_eval_js_injection_safe():
    """key/region 必须以 JSON 字面量内嵌(防 ' 闭合注入),且含 CDN v4 路径。"""
    js = fc._fp_eval_js("abc123", "ap")
    check("js has cdn v4", "fpjscdn.net/v4/" in js)
    check("js key as json literal", '"abc123"' in js)
    check("js region as json literal", '"ap"' in js)
    # 带引号的恶意 key 应被 JSON 转义,不产生裸的闭合
    js2 = fc._fp_eval_js('a"+evil+"b', "ap")
    check("js escapes quote", '\\"' in js2)


def test_region_server_map():
    check("ap server", fc.REGION_SERVER["ap"] == "https://ap.api.fpjs.io")
    check("eu server", fc.REGION_SERVER["eu"] == "https://eu.api.fpjs.io")


# ─────────────────────────────────────────────────────────────────────
def run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    print("跑 %d 组指纹自测离线测试…" % len(tests))
    for t in tests:
        t()
    print("─" * 50)
    if FAIL:
        print("✗ %d 通过, %d 失败:%s" % (PASS, FAIL, ", ".join(FAILED)))
        sys.exit(1)
    print("✓ 全绿:%d 项通过" % PASS)


if __name__ == "__main__":
    run()
