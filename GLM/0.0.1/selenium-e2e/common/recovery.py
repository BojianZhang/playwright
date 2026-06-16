#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 失败恢复策略消费(单一来源) — Openrouter / selenium-e2e / common/recovery.py
#
# 文件定位:Openrouter/0.0.1/selenium-e2e/common/recovery.py
#
# 【做什么】解析 web 注入的 GLM_RECOVERY_JSON(失败恢复策略激活预设),给 run.py 的
#   AUTO_RETRY_FAILED 循环按【失败类型 fail_stage】决定某号是否参与重跑。依赖 Stage 1B 写进
#   结果行的 fail_stage(register/key/card/charge)。
#
# 【铁律·默认逐字节不变】没注入 / 解析失败 / 某类型没配 → 一律返回 True(重试)= 现状「重试所有
#   非永久失败」。歧义态(server-error/card-502/needphone)由 run.py 自己计完成(RETRY-CARD-01),
#   根本不会走到这里问"要不要重试" → 本模块【绝不】能让歧义态重绑。
# ═══════════════════════════════════════════════════════════════════════
import json
import os

_PARSED = None   # 进程内缓存(env 在子进程启动后不变)

# fail_stage(结果行/attribution 写的)→ recovery 预设里的开关 key
# ★attribution.attribute_failure 实际产出的是 register/apikey/subscribe(z.ai 流程名),
#   故必须把 apikey→retryKey、subscribe→retryCharge 映上,否则 web 配的「不重试取Key/扣款失败」开关【永远不生效】
#   (原只有 key/card/charge 这些旧名 → apikey/subscribe 落到默认 True 被无视)。保留旧名做别名,默认仍是 True(逐字节不变)。
_RETRY_KEY = {
    "register": "retryRegister",
    "apikey": "retryKey",        # attribution 写的真实阶段名
    "subscribe": "retryCharge",  # attribution 写的真实阶段名(订阅=扣款)
    "key": "retryKey",           # 别名(向后兼容旧结果行)
    "card": "retryCard",
    "charge": "retryCharge",
}


def _policy():
    global _PARSED
    if _PARSED is not None:
        return _PARSED
    raw = os.environ.get("GLM_RECOVERY_JSON", "") or ""
    d = {}
    try:
        if raw.strip():
            j = json.loads(raw)
            if isinstance(j, dict):
                d = j
    except Exception:
        d = {}
    _PARSED = d
    return _PARSED


def _retry_map():
    pol = _policy()
    r = pol.get("retry")
    return r if isinstance(r, dict) else {}


def should_retry(fail_stage):
    """自动重试循环:某失败类型(fail_stage)是否参与重跑。
    默认 True(现状)。未知/缺失 fail_stage → True(不因归因缺失而漏重试,与原"重试所有非完成号"一致)。
    只有用户显式把某类型配成 off,才返回 False。"""
    key = _RETRY_KEY.get(str(fail_stage or "").strip())
    if not key:
        return True   # 未知类型 / 无归因(老结果行)→ 默认重试,绝不因归因缺失漏跑
    v = _retry_map().get(key)
    if v is None:
        return True   # 没配 → 默认重试
    return str(v).strip().lower() not in ("off", "0", "false", "no")


def reset_cache():
    """仅供测试:清进程内缓存,让下次 should_retry 重读 env。"""
    global _PARSED
    _PARSED = None
