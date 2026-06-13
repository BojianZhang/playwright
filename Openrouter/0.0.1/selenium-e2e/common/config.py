#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 配置读取(config.local.json 覆盖 config.json)+ 随机账单地址/随机名 + OpenRouter 封禁判定。
import os
import re
import json
import random

from .paths import CONFIG_JSON, CONFIG_LOCAL

# OpenRouter 直接封禁/拒绝该邮箱:"… is not allowed to access this application"。
# 撞这个就【登记并永久跳过】。三处(hybrid_run/hyb_loop/cleanup_envs)共用此判定,口径必须一致 ——
# 否则 'access denied' 类被拒号在某处算 banned、另一处不认 → 反复空转重试。
_BANNED_RE = re.compile(r"not[\s_]*allowed|NOT_ALLOWED|access[\s_]*denied|not[\s_]*permitted", re.I)


def is_banned_reason(*parts):
    """传入若干 reason 片段(pw_reason/auth/steps 文本),任一含'账号被 OpenRouter 拒绝'字样即 True。"""
    s = " ".join(str(p) for p in parts if p)
    return bool(s) and bool(_BANNED_RE.search(s))


def rand_address():
    first = random.choice(["Mark", "Karen", "Thomas", "Laura", "Brian", "Nancy", "Kevin", "Susan"])
    last = random.choice(["Lopez", "Robinson", "Flores", "Bennett", "Sanders", "Hughes", "Coleman"])
    # 免税州 + 配套真实城市/邮编（city/state/zip 错配会被 Radar 加分）
    state, city, zc = random.choice([
        ("Montana", "Billings", "59101"), ("Montana", "Helena", "59601"),
        ("Oregon", "Salem", "97301"), ("Oregon", "Portland", "97201"),
        ("New Hampshire", "Nashua", "03063"), ("New Hampshire", "Concord", "03301"),
        ("Delaware", "Dover", "19901"), ("Delaware", "Wilmington", "19801"),
    ])
    return {"name": "%s %s" % (first, last),
            "line1": "%d %s" % (random.randint(100, 9000), random.choice(["E 5th Ave", "Birch Ter", "S Cedar Way", "Pine St", "Oak Dr", "Maple Ln"])),
            "city": city, "country": "United States", "state": state, "zip": zc}


def load_config():
    """读 config.local.json(优先) + config.json，取 2captcha key / firstmail key。"""
    cfg = {}
    for f in (CONFIG_JSON, CONFIG_LOCAL):  # local 后读 → 覆盖
        try:
            with open(f, "r", encoding="utf-8") as fp:
                _deep_merge(cfg, json.load(fp))
        except Exception:
            pass
    cap = cfg.get("captcha", {}) or {}
    mb = cfg.get("mailbox", {}) or {}
    # apiTimeoutMs 可能被写成 null / 字符串 / 0:默认值只在"键缺失"时生效,present-but-bad 会让
    # 原来的 `mb.get(...,30000)/1000.0` 抛 TypeError/ValueError,整个 load_config 连带流水线崩。防御式转型。
    try:
        mail_timeout = float(mb.get("apiTimeoutMs") or 30000) / 1000.0
    except (TypeError, ValueError):
        mail_timeout = 30.0
    # 环境变量优先(web 控制台「验证码/邮箱 key 池」选用的 key 经 engine-runner 注入;无则用文件值)。
    return {
        "captcha_key": os.environ.get("OPENROUTER_CAPTCHA_KEY") or cap.get("apiKey", ""),
        "captcha_provider": os.environ.get("OPENROUTER_CAPTCHA_PROVIDER") or cap.get("provider", "twocaptcha"),
        "mail_key": os.environ.get("OPENROUTER_FIRSTMAIL_KEY") or mb.get("apiKey", ""),
        "mail_base": os.environ.get("OPENROUTER_FIRSTMAIL_BASE") or mb.get("apiBaseUrl", "https://firstmail.ltd"),
        "mail_timeout": mail_timeout,
    }


def _deep_merge(dst, src):
    for k, v in (src or {}).items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def rand_name(n=10):
    import string
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


__all__ = [
    "_BANNED_RE", "is_banned_reason",
    "rand_address", "load_config", "_deep_merge", "rand_name",
]
