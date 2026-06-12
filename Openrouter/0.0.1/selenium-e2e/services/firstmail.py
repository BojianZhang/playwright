#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# Firstmail：读 OTP 验证码 + 改邮箱密码（HTTP，移植自 firstmail-client.js）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/firstmail.py
#
# 注意：读信用【邮箱密码】(=账号文件 email:邮箱密码 的第二列)，不是 OpenRouter 密码。
# ═══════════════════════════════════════════════════════════════════════

import re
import time

from common import http_post_json, log

DEFAULT_BASE = "https://firstmail.ltd"


def get_latest_message(email, password, api_key, base_url=DEFAULT_BASE, folder="INBOX", timeout=30):
    return http_post_json(
        base_url + "/api/v1/email/messages/latest",
        {"email": email, "password": password, "folder": folder},
        headers={"X-API-KEY": api_key}, timeout=timeout)


def extract_code(msg):
    data = msg.get("data") if isinstance(msg, dict) and isinstance(msg.get("data"), dict) else msg
    import json as _json
    fields = []
    if isinstance(data, dict):
        fields = [data.get("text"), data.get("html"), data.get("subject")]
    fields.append(_json.dumps(msg, ensure_ascii=False))
    for f in fields:
        if not f:
            continue
        plain = re.sub(r"<[^>]+>", " ", str(f))
        m = re.search(r"(?:code|verification|otp)[^0-9]{0,20}(\d{6})", plain, re.I)
        if m:
            return m.group(1)
        m = re.search(r"\b(\d{6})\b", plain)
        if m:
            return m.group(1)
    return None


def extract_clerk_verify_link(msg):
    """从邮件 JSON 抽 Clerk 验证链接 https://clerk.openrouter.ai/v1/verify?...（注册是链接验证，非验证码）。"""
    import json as _json
    text = _json.dumps(msg, ensure_ascii=False)
    m = re.search(r'https:\\?/\\?/clerk\.openrouter\.ai\\?/v1\\?/verify[^"\\\s]+', text)
    if not m:
        return None
    return m.group(0).replace("\\/", "/").replace("&amp;", "&")


def wait_verify_link(email, password, api_key, base_url=DEFAULT_BASE, attempts=14, interval=3):
    """轮询邮箱拿 Clerk 注册验证链接（注册邮件可能晚到几秒）。"""
    for i in range(attempts):
        try:
            msg = get_latest_message(email, password, api_key, base_url)
            link = extract_clerk_verify_link(msg)
            if link:
                log("Firstmail 第 %d 次轮询：找到验证链接" % (i + 1))
                return link
            log("Firstmail 第 %d 次轮询：暂无验证链接" % (i + 1))
        except Exception as e:
            log("Firstmail 轮询出错：%s" % str(e)[:80])
        if i < attempts - 1:
            time.sleep(interval)
    return None


def _msg_date_ms(msg):
    data = msg.get("data") if isinstance(msg, dict) and isinstance(msg.get("data"), dict) else msg
    d = (msg.get("date") or msg.get("Date")) if isinstance(msg, dict) else None
    if not d and isinstance(data, dict):
        d = data.get("date") or data.get("Date") or data.get("received") or data.get("timestamp")
    if not d:
        return None
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(d).timestamp() * 1000.0
    except Exception:
        try:
            import datetime
            return datetime.datetime.fromisoformat(str(d).replace("Z", "+00:00")).timestamp() * 1000.0
        except Exception:
            return None


def wait_verify_code(email, password, api_key, base_url=DEFAULT_BASE,
                     attempts=14, interval=3, since_ts=0, stale_code="", skew_ms=60000, strict=False):
    """轮询邮箱拿【本次登录的新】6 位验证码（按 since_ts 过滤旧码，与上次码去重）。
       strict=True（登录 OTP 这种强时效场景）：超时【不回退旧码】，宁可 return None 让上层当'码没到、可重试'，
                 也不把过期码提交上去被拒、误判成 OTP/账号错。
       新鲜度判定：能解析到发件日期才算数；解析不到且设了 since_ts → 保守视作'无法确认新鲜'(疑旧)继续等，
                 不再像旧逻辑那样第一次轮询就把日期不明的旧码当新码吞掉。"""
    last = None
    for i in range(attempts):
        try:
            msg = get_latest_message(email, password, api_key, base_url)
            code = extract_code(msg)
            if code:
                last = code
                ts = _msg_date_ms(msg)
                if since_ts:
                    fresh = (ts is not None) and (ts >= since_ts - skew_ms)   # 日期不明→不算新鲜
                else:
                    fresh = True
                dup = bool(stale_code) and code == stale_code
                if fresh and not dup:
                    log("Firstmail 第 %d 次轮询：找到新验证码 %s" % (i + 1, code))
                    return code
                why = "与上次相同" if dup else ("发件早于本次" if ts is not None else "发件日期不明,疑旧")
                log("Firstmail 第 %d 次轮询：%s 疑似旧码(%s)，继续等" % (i + 1, code, why))
            else:
                log("Firstmail 第 %d 次轮询：暂无" % (i + 1))
        except Exception as e:
            log("Firstmail 轮询出错：%s" % str(e)[:80])
        if i < attempts - 1:
            time.sleep(interval)
    if last and not strict:
        log("Firstmail 未确认到更新的码，回退用最近读到的 %s" % last)
        return last
    if last and strict:
        log("Firstmail 未确认到更新的码（strict：不回退旧码 %s，当作码没到）" % last)
    return None


def change_mailbox_password(email, current, new, api_key, base_url=DEFAULT_BASE, timeout=30):
    try:
        j = http_post_json(base_url + "/api/v1/email/password/change/",
                           {"email": email, "current_password": current, "new_password": new},
                           headers={"X-API-KEY": api_key}, timeout=timeout)
        ok = bool(j) and (j.get("status") in (True, "success", 200) or j.get("ok") or "success" in str(j).lower())
        log("改邮箱密码: %s" % ("成功" if ok else ("失败 " + str(j)[:80])))
        return ok
    except Exception as e:
        log("改邮箱密码异常: %s" % str(e)[:80])
        return False
