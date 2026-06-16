#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 失败归因(单一来源)—— 把一条结果按【流程顺序】浓缩成 (fail_stage, fail_reason)
#
# 文件定位:Openrouter/0.0.1/selenium-e2e/common/attribution.py
#
# 背景:用户原则「每个失败的运行必须标注好啥错误」。原来只有纯 Selenium(pipeline.py)
#   内联写 fail_stage/fail_reason,混合引擎(hybrid_run.py)一个都不写 → 混合失败全靠前端
#   反推 → 分析页「Z.其它」虚高。把归因逻辑抽到这里,pipeline 与 hybrid 共用一套,杜绝漂移。
#
# ★兼容两套 steps 键名(单一函数同时认):
#   · 纯 Sel(pipeline):取 key 的环节写 steps["key"](bool);purchase 写 steps["purchase"]
#   · 混合(hybrid):取 key 由 Playwright 做,写 steps["pw"]/steps["pw_reason"];
#                    purchase 结果在【顶层】res["purchase"](非 steps);加卡放弃写 steps["giveup"]
#
# ★铁律:
#   - 只读 steps/opts/res,【绝不修改】任何字段(原始 steps 保留给详情诊断)。
#   - 按 register→key→card→charge→changepw 顺序取【第一个】没过的环节,只记一个。
#   - 对纯 Selenium 输入,本函数输出与 pipeline.py 原内联块【逐字节等价】(见 test_attribution.py)。
#   - 异常一律返回 (None, None),绝不抛(与 pipeline.py 原 try/except 同款防御)。
#   - 不做异常(exception)归因 —— 那是调用方在 except 分支里另记 fail_stage="exception"。
# ═══════════════════════════════════════════════════════════════════════
import os
import re as _re


# ── Stripe 拒付原因分类(页面拒付文案 → 结构化 decline_code)────────────────────
# 背景:系统原来把所有拒付塌成一个 "declined",分不清「卡真没钱(insufficient_funds)」与
#   「环境/风控(do_not_honor / generic_decline)」→ 无法据此走对的恢复流程(没钱该换卡、风控该换IP)。
# ★诚实约束:Stripe Radar 风控拦截在页面上几乎只显示通用 "Your card was declined.",文字层面【无法】
#   与普通 generic_decline 区分 → 本函数对这类只给 generic_decline,【绝不】假装识别出 radar_block。
# ★必须与 web/decline-classify.js classifyDecline 逐枚举同口径(同序同码),改一处必同步另一处。
_DECL_PATTERNS = [
    ("insufficient_funds", _re.compile(r"insufficient funds|insufficient balance", _re.I)),
    ("incorrect_cvc",      _re.compile(r"security code is (?:incorrect|invalid)|incorrect (?:cvc|cvv)|invalid (?:cvc|cvv)", _re.I)),
    ("incorrect_number",   _re.compile(r"card number is (?:incorrect|invalid)|incorrect card number|invalid card number", _re.I)),
    ("expired_card",       _re.compile(r"card (?:has )?expired|expired card|card is expired|expired card number", _re.I)),
    ("do_not_honor",       _re.compile(r"do not honou?r", _re.I)),
    ("card_not_supported", _re.compile(r"card (?:type )?(?:is )?not supported|your card is not supported", _re.I)),
    ("generic_decline",    _re.compile(r"card was declined|payment (?:failed|was declined)|could not complete|\bdeclined\b", _re.I)),
]


def classify_decline(text):
    """页面拒付文案 → decline_code ∈ insufficient_funds / incorrect_cvc / incorrect_number /
       expired_card / do_not_honor / card_not_supported / generic_decline;没匹配到拒付返回 ""。
       匹配顺序【具体→通用】:最关键的 insufficient_funds 是很具体的短语,优先且不易误命中。
       ★与 web/decline-classify.js 同口径,改一处必同步另一处。"""
    try:
        t = str(text or "")
        if not t:
            return ""
        for code, rx in _DECL_PATTERNS:
            if rx.search(t):
                return code
        return ""
    except Exception:
        return ""


def _changepw_require_purchase():
    return (os.environ.get("CHANGEPW_REQUIRE_PURCHASE", "") or "").strip().lower() in ("1", "true", "on", "yes")


def attribute_failure(steps, opts, res=None):
    """返回 (fail_stage, fail_reason);无失败(或归因不出)返回 (None, None)。

    steps : res["steps"](auth/key|pw/card/purchase/changepw/giveup …)
    opts  : 选项 dict(do_key/do_card/do_purchase/do_changepw)。混合引擎恒做 key+card,传 True。
    res   : 整个结果 dict(取 key_reason / api_key / skipped_charge / 顶层 purchase)。
    """
    try:
        steps = steps or {}
        opts = opts or {}
        res = res or {}

        # 计费门(与 pipeline.py:252-253 同口径):取 key 成功(纯Sel steps.key / 混合 steps.pw / 复用 api_key)
        #   或【本就不取 key】(do_key 关)→ 才追究 card/charge/changepw,否则只追到 key 为止。
        key_attained = bool(steps.get("key")) or bool(steps.get("pw")) or bool(res.get("api_key"))
        bill_ok = key_attained or (not opts.get("do_key", True))

        # purchase 结果:纯Sel 在 steps["purchase"],混合在顶层 res["purchase"] → 二者取其一(与 Node isSuccessRow 同口径)。
        pur = steps.get("purchase")
        if pur is None:
            pur = res.get("purchase")

        # changepw 闸(与 pipeline.py:325-328 同口径):CHANGEPW_REQUIRE_PURCHASE 开时,只有充值确认成功
        #   (或续跑已充 skipped_charge)才追究改密失败;否则改密本就不该跑、不归因。
        cpw_gate = True
        if _changepw_require_purchase():
            cpw_gate = (pur == "success") or bool(res.get("skipped_charge"))

        fs = fr = None
        if steps.get("auth") not in ("ok", None):
            fs, fr = "register", str(steps.get("auth") or "register-failed")
        elif steps.get("key") is False or steps.get("pw") is False:
            # 纯Sel: key=False;混合: pw=False(Playwright 取 key 失败)→ 同归「取 key」阶段
            fs, fr = "key", str(res.get("key_reason") or steps.get("pw_reason") or "key-not-captured")
        elif opts.get("do_card") and bill_ok and steps.get("card") not in ("card-bound", None):
            # 加卡没绑成:declined / card-502 / hcaptcha / server-error / needphone …
            #   放弃原因(giveup)更可读(如 all-segments-502)→ 优先用它,没有再退裸 card 结果。
            fs, fr = "card", str(steps.get("giveup") or steps.get("card"))
        elif opts.get("do_card") and bill_ok and steps.get("giveup"):
            # 加卡放弃但 card 没落非法值(如开局就 no-good-proxy,card 还没结果)→ 仍归加卡阶段
            fs, fr = "card", str(steps.get("giveup"))
        elif opts.get("do_purchase") and bill_ok and pur not in ("success", None):
            fs, fr = "charge", str(pur)
        elif opts.get("do_changepw") and bill_ok and cpw_gate and steps.get("changepw") is False:
            fs, fr = "changepw", "changepw-failed"
        return fs, fr
    except Exception:
        return None, None
