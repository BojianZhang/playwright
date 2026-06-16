#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 失败归因(单一来源)—— 把一条结果按【流程顺序】浓缩成 (fail_stage, fail_reason)
#
# 文件定位:GLM/0.0.1/selenium-e2e/common/attribution.py
#
# z.ai 流程顺序:register(注册/登录) → apikey(创建 API Key) → subscribe(选套餐 + 信用卡支付)。
#   apikey 与 subscribe 各自独立可开关(do_apikey / do_subscribe),互不依赖
#   (与 OpenRouter「key 失败就跳过 billing」的耦合【故意解除】)。
#
# ★铁律:
#   - 只读 steps/opts/res,【绝不修改】任何字段(原始 steps 保留给详情诊断)。
#   - 按 register→apikey→subscribe 顺序取【第一个】没过的环节,只记一个。
#   - 异常一律返回 (None, None),绝不抛。
#   - 不做异常(exception)归因 —— 那是调用方在 except 分支里另记 fail_stage="exception"。
# ═══════════════════════════════════════════════════════════════════════


def attribute_failure(steps, opts, res=None):
    """返回 (fail_stage, fail_reason);无失败(或归因不出)返回 (None, None)。

    steps : res["steps"](auth / apikey / subscribe …)
    opts  : 选项 dict(do_apikey / do_subscribe)。
    res   : 整个结果 dict(取 key_reason / api_key / payment_status / skipped_subscribe)。
    """
    try:
        steps = steps or {}
        opts = opts or {}
        res = res or {}

        fs = fr = None
        # ① 注册/登录:auth 非 ok(且非 None=没跑)→ register 阶段失败。
        if steps.get("auth") not in ("ok", None):
            fs, fr = "register", str(steps.get("auth") or "register-failed")
        # ② 创建 API Key:开了 do_apikey 且 apikey==False(明确失败,非 None=没跑/没开)→ apikey 阶段。
        elif opts.get("do_apikey") and steps.get("apikey") is False:
            fs, fr = "apikey", str(res.get("key_reason") or "apikey-not-captured")
        # ③ 订阅+支付:开了 do_subscribe 且 subscribe 非 success(declined/failed/invalid-amount…)→ subscribe 阶段。
        #    dryrun(未真扣)与 None(没跑)不算失败。★uncertain(终态不明、已保守按已扣记账+防自动重扣)也【不算失败】:
        #    它由 res["subscribe_uncertain"] 标志 + node_status="uncertain" 单独追踪;归因里当失败会污染失败统计、误导恢复策略。
        elif opts.get("do_subscribe") and steps.get("subscribe") not in ("success", "dryrun", "uncertain", None):
            fs, fr = "subscribe", str(res.get("payment_status") or steps.get("subscribe"))
        return fs, fr
    except Exception:
        return None, None
