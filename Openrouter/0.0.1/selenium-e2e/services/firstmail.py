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


def get_latest_message(email, password, api_key, base_url=DEFAULT_BASE, folder="INBOX", timeout=12):
    # 【#9 修】单次超时 30→12s:住宅代理间歇飙延迟时,14 次轮询最坏 14×(30+3)≈462s,远超预期。
    #   降到 12s 让卡顿的请求快速失败、由外层 14 次轮询继续重试(总墙钟回到几十秒量级)。change_mailbox_password 另有独立 timeout 不受影响。
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


def wait_verify_link(email, password, api_key, base_url=DEFAULT_BASE, attempts=14, interval=3, alt_password=""):
    """轮询邮箱拿 Clerk 注册验证链接（注册邮件可能晚到几秒）。
       alt_password:改密后邮箱真实密码已变成统一密码 → 旧密码读不动就用统一密码再试(同 wait_verify_code)。"""
    _pws = list(dict.fromkeys([p for p in (password, alt_password) if p]))   # 主+备用密码,去重去空,保序
    for i in range(attempts):
        msg = None
        _err = None
        for _pw in _pws:
            try:
                msg = get_latest_message(email, _pw, api_key, base_url)
                break
            except Exception as e:
                _err = e
        if msg is not None:
            link = extract_clerk_verify_link(msg)
            if link:
                log("Firstmail 第 %d 次轮询：找到验证链接" % (i + 1))
                return link
            log("Firstmail 第 %d 次轮询：暂无验证链接" % (i + 1))
        else:
            log("Firstmail 轮询出错：%s" % str(_err)[:80])
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
                     attempts=14, interval=3, since_ts=0, stale_code="", skew_ms=60000, strict=False, alt_password=""):
    """轮询邮箱拿【本次登录的新】6 位验证码（按 since_ts 过滤旧码，与上次码去重）。
       strict=True（登录 OTP 这种强时效场景）：超时【不回退旧码】，宁可 return None 让上层当'码没到、可重试'，
                 也不把过期码提交上去被拒、误判成 OTP/账号错。
       【alt_password】★改密后邮箱真实密码已变成统一密码,但账号文件里还是旧密码 → 每轮先用 password 读,
                 认证失败再用 alt_password 读 → 解决"改过密的号登录读不到 OTP、OTP 框一直空等"。
       新鲜度判定：能解析到发件日期才算数；解析不到且设了 since_ts → 保守视作'无法确认新鲜'(疑旧)继续等。"""
    _pws = list(dict.fromkeys([p for p in (password, alt_password) if p]))   # 主+备用(改密后)密码,去重去空,保序
    last = None
    for i in range(attempts):
        msg = None
        _err = None
        for _pw in _pws:
            try:
                msg = get_latest_message(email, _pw, api_key, base_url)
                break                                       # 这个密码能登进去读到信
            except Exception as e:
                _err = e                                    # 换下一个密码再试
        if msg is None:
            log("Firstmail 第 %d 次轮询：读信失败(密码都不对?) %s" % (i + 1, str(_err)[:70]))
        else:
            code = extract_code(msg)
            if code:
                last = code
                ts = _msg_date_ms(msg)
                fresh = ((ts is not None) and (ts >= since_ts - skew_ms)) if since_ts else True   # 日期不明→不算新鲜
                dup = bool(stale_code) and code == stale_code
                if fresh and not dup:
                    log("Firstmail 第 %d 次轮询：找到新验证码 %s" % (i + 1, code))
                    return code
                why = "与上次相同" if dup else ("发件早于本次" if ts is not None else "发件日期不明,疑旧")
                log("Firstmail 第 %d 次轮询：%s 疑似旧码(%s)，继续等" % (i + 1, code, why))
            else:
                log("Firstmail 第 %d 次轮询：暂无" % (i + 1))
        if i < attempts - 1:
            time.sleep(interval)
    if last and not strict:
        log("Firstmail 未确认到更新的码，回退用最近读到的 %s" % last)
        return last
    if last and strict:
        log("Firstmail 未确认到更新的码（strict：不回退旧码 %s，当作码没到）" % last)
    return None


def change_mailbox_password(email, current, new, api_key, base_url=DEFAULT_BASE, timeout=30):
    """改 Firstmail 邮箱密码:POST /api/v1/email/password/change/  body={email,current_password,new_password}。
    【按 HTTP 状态判定,不靠 body 形状】2xx=接口接受=改成(原来 http_post_json 对空/非JSON的200会 json.loads 抛错→误判失败,
    且非2xx直接 raise 把真因吞掉)。非2xx读出 error body 记真因(密码不对/key失效/限频一目了然)。
    幂等:旧密码被拒(4xx)时再用 new 当 current 试一次——上轮已改过则当前真实密码=new,确认即视为成功,不重复失败。"""
    import json as _json
    import urllib.request as _ur
    import urllib.error as _ue
    url = base_url + "/api/v1/email/password/change/"
    hdr = {"Content-Type": "application/json", "accept": "application/json", "X-API-KEY": api_key}
    opener = _ur.build_opener(_ur.ProxyHandler({}))   # 直连,不走系统代理(同 http_post_json,避免系统代理把外网 API 打成 502)

    def _post(cur):
        data = _json.dumps({"email": email, "current_password": cur, "new_password": new}).encode("utf-8")
        req = _ur.Request(url, data=data, method="POST", headers=hdr)
        with opener.open(req, timeout=timeout) as r:
            code = getattr(r, "status", None) or r.getcode()
            body = r.read().decode("utf-8", "replace")
        return code, body

    try:
        code, body = _post(current)
        log("改邮箱密码: 成功 (HTTP %s) %s" % (code, body[:80]))   # 2xx 即成
        return True
    except _ue.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        # 旧密码被拒 → 可能上轮已把密码改成 new(当前真实密码=new)→ 用 new 当 current 确认一次,幂等收尾
        if e.code in (400, 401, 403, 409, 422) and current != new:
            try:
                code2, body2 = _post(new)
                log("改邮箱密码: 旧密码被拒,但 new 当前有效 → 已是目标密码,视为成功 (HTTP %s)" % code2)
                return True
            except Exception:
                pass
        log("改邮箱密码: 失败 HTTP %s — %s" % (e.code, body[:140]))
        return False
    except Exception as e:
        log("改邮箱密码异常: %s" % str(e)[:100])
        return False
