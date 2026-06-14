#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 会话检测 / 登出 / 注册 / 登录（纯 Selenium，含 Turnstile + 邮箱 OTP）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/steps_auth.py
#
# 移植自 stages.js 的 register/signInExisting/detectSession/clerkSignOut。
# 入参 op_password = OpenRouter 账号密码(注册时设/登录时用)；mailbox_pw = 邮箱密码(读 OTP 用)。
# ═══════════════════════════════════════════════════════════════════════

import os
import time

import common
from common import log, SIGNUP_URL, SIGNIN_URL, KEYS_URL
from common.selectors import sel, sel_csv   # 元素维护页可覆盖关键元素选择器(无覆盖=内置默认,老代码原样)
from services import captcha
from services import firstmail


def _set_value(page, css, value):
    """填一个普通输入框（主文档，OpenRouter 自己的表单不在 iframe）。"""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    try:
        for el in page.d.find_elements(By.CSS_SELECTOR, css):
            if el.is_displayed():
                el.click()
                el.send_keys(Keys.CONTROL, "a"); el.send_keys(Keys.DELETE)
                el.send_keys(str(value))
                return True
    except Exception:
        pass
    return False


def _check(page, css):
    from selenium.webdriver.common.by import By
    try:
        for el in page.d.find_elements(By.CSS_SELECTOR, css):
            if el.is_displayed() and not el.is_selected():
                try:
                    el.click()
                except Exception:
                    page.d.execute_script("arguments[0].click()", el)
                return True
    except Exception:
        pass
    return False


def _diag(page, tag):
    """打印当前注册/登录页关键状态 + 截图，定位卡点。截图存 _reg_<tag>.png(已 gitignore)。"""
    try:
        d = page.js(
            "return {url:location.href,"
            "fn:(document.querySelector('#firstName-field')||{}).value,"
            "ln:(document.querySelector('#lastName-field')||{}).value,"
            "em:(document.querySelector('#emailAddress-field')||{}).value,"
            "pw:((document.querySelector('#password-field')||{}).value||'').length,"
            "legal:(document.querySelector('#legalAccepted-field')||{}).checked,"
            "cfkey:(window.__cfParams||{}).sitekey||null,"
            "tsw:!!(window.turnstile&&window.turnstile.__w),"
            "cfIframe:!!document.querySelector('iframe[src*=\"challenges.cloudflare.com\"],iframe[src*=\"turnstile\"]'),"
            "btns:Array.from(document.querySelectorAll('button')).filter(function(b){return b.offsetParent!==null;}).map(function(b){return (b.innerText||'').trim().slice(0,16)+(b.disabled?'<off>':'');}).slice(0,6),"
            "err:(function(){var t=document.body.innerText||'';var m=t.match(/[^\\n]*(error|invalid|must |taken|already|incorrect|required|wrong|try again|too )[^\\n]*/i);return m?m[0].slice(0,120):'';})(),"
            "body:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,180)};") or {}
        log("[诊断:%s] url=…%s 字段(fn=%s ln=%s em=%s pw位=%s legal=%s) cf(key=%s w=%s iframe=%s) 按钮=%s%s" % (
            tag, str(d.get('url'))[-42:], d.get('fn'), d.get('ln'), d.get('em'), d.get('pw'), d.get('legal'),
            str(d.get('cfkey'))[:10], d.get('tsw'), d.get('cfIframe'), d.get('btns'),
            (" ⚠错误[%s]" % d.get('err')) if d.get('err') else ""))
        if not (d.get('err')):
            log("[诊断:%s] 正文: %s" % (tag, d.get('body')))
        try:
            page.shot("_reg_%s.png" % tag)
        except Exception:
            pass
    except Exception as e:
        log("[诊断:%s] 取状态失败 %s" % (tag, str(e)[:60]))


def detect_session(page):
    """返回已登录的邮箱(字符串)或 None。"""
    if "openrouter.ai" not in page.url():
        page.goto(KEYS_URL, wait=2)
    info = page.js(
        "return (async()=>{for(var i=0;i<24;i++){if(window.Clerk&&window.Clerk.loaded)break;await new Promise(r=>setTimeout(r,300));}"
        "var c=window.Clerk;if(!c)return {clerk:false};var u=c.user;if(!u)return {clerk:true,loggedIn:false};"
        "var em=(u.primaryEmailAddress&&u.primaryEmailAddress.emailAddress)||(u.emailAddresses&&u.emailAddresses[0]&&u.emailAddresses[0].emailAddress)||'';"
        "return {clerk:true,loggedIn:true,email:em};})()") or {}
    if info.get("loggedIn"):
        return info.get("email") or ""
    return None


def sign_out(page):
    page.js("try{if(window.Clerk&&window.Clerk.signOut)window.Clerk.signOut();}catch(e){}")
    time.sleep(2.5)
    page.goto(KEYS_URL, wait=1.5)
    out = page.js("var noUser=!(window.Clerk&&window.Clerk.user);var onAuth=/sign-in|sign-up/.test(location.pathname)||!!document.querySelector('#identifier-field,#password-field');return noUser||onAuth;")
    log("登出: %s" % ("已登出" if out else "可能未登出"))
    return bool(out)


def _solve_turnstile_if_present(page, page_url, cfg, exit_url_substrs):
    """轮询等 Turnstile hook 抓到 sitekey 再解；中途再点一次 Continue。
       已跳到 exit_url(成功/进下一步) → 直接返回 True(无需解)。无 Turnstile 也返回 True。"""
    for i in range(22):
        u = page.url()
        if any(s in u for s in exit_url_substrs):
            log("[Turnstile] 已进入下一步(…%s)，无需解" % u[-28:])
            return True
        params = page.js("return window.__cfParams||null")
        if params and params.get("sitekey"):
            log("[Turnstile] hook 抓到 sitekey=%s action=%s cdata=%s → 2captcha 求解" % (
                str(params.get('sitekey'))[:12], params.get('action'), "有" if params.get('cdata') else "无"))
            ok = captcha.solve_turnstile(page.d, page_url, cfg, timeout=cfg.get("captcha_timeout", 180))
            log("[Turnstile] 2captcha 解结果=%s" % ok)
            time.sleep(2.5)
            page.click_text(["Continue"], 3)
            time.sleep(2)
            return True
        if i == 10:
            log("[Turnstile] 10s 没抓到 sitekey，再点一次 Continue 触发渲染")
            page.click_text(["Continue"], 3)  # widget 没出来 → 再点一次触发
        time.sleep(1)
    log("[Turnstile] 22s 内 hook 没抓到 __cfParams（widget 没渲染/被拦/表单没提交）")
    return False  # 没抓到 hook（可能没 Turnstile 但也没推进）


def _enter_otp(page, email, mailbox_pw, cfg, since_ts, op_password=""):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    log("[OTP] 到验证页，读邮箱 %s 的验证码…" % email)
    # alt_password=op_password:★该号若被改过密,邮箱真实密码已是统一密码,旧 mailbox_pw 读不到信 → 自动换统一密码读(根治 fail:OTP)。
    code = firstmail.wait_verify_code(email, mailbox_pw, cfg.get("mail_key"), cfg.get("mail_base"),
                                      attempts=16, interval=3, since_ts=since_ts, strict=True, alt_password=op_password)
    if not code:
        # 兜底:OTP 邮件偶尔晚到 → 多等几秒再多轮询一组(仍 strict,绝不回退旧码),取最新一封
        log("[OTP] 首轮没读到码 → 等 6s 再兜底轮询一次(仍 strict)")
        time.sleep(6)
        code = firstmail.wait_verify_code(email, mailbox_pw, cfg.get("mail_key"), cfg.get("mail_base"),
                                          attempts=6, interval=3, since_ts=since_ts, strict=True, alt_password=op_password)
    if not code:
        log("[OTP] ✗ Firstmail 没读到【本次的新】验证码(strict:不提交旧码)"); return False
    log("[OTP] 读到验证码 %s，填入并提交" % code)
    # 填 OTP（Clerk 多为单框/拆分框，往第一个可见的填整码通常能填满）
    filled = False
    for css in sel('otp_input', 'input[inputmode="numeric"]', 'input[name="code"]', 'input[autocomplete="one-time-code"]', 'input[id*="code"]'):
        try:
            els = [e for e in page.d.find_elements(By.CSS_SELECTOR, css) if e.is_displayed()]
            if els:
                els[0].click()
                els[0].send_keys(code)
                filled = True
                break
        except Exception:
            pass
    if not filled:
        log("✗ 没找到 OTP 输入框"); return False
    time.sleep(1.5)
    page.click_text(["Continue", "Verify"], 5)
    time.sleep(3.5)
    return True


def _verify_email_link(page, email, mailbox_pw, cfg, op_password=""):
    """注册邮箱验证 = Clerk 魔法链接（非验证码）：读链接 → 同浏览器打开 → 回 keys 确认。
    收不到链接时点页面上的 'Resend' 让 OpenRouter 重发再轮询(最多3轮),应对首封邮件丢失/晚到。
    op_password:改过密的号(登录失败回退重注册时)邮箱真实密码已是统一密码 → 旧密码读不到链接就用统一密码读。"""
    log("[验证] 到验证页，读邮箱 %s 的 Clerk 注册验证链接…" % email)
    link = None
    # 【可前端调:高级参数页 邮箱验证组】默认 3轮×12次×3s(+Resend)≈196s。收信慢/想快失败时把这几个调小;
    #   不设=用内置默认(逐字节同原行为)。MAIL_VERIFY_CYCLES=1 即只读不重发。
    _v_cycles = max(1, int(os.environ.get("MAIL_VERIFY_CYCLES", "3") or 3))         # 重发轮数(1 次初始 + 其余重发)
    _v_attempts = max(1, int(os.environ.get("MAIL_VERIFY_ATTEMPTS", "12") or 12))   # 每轮读链接轮询次数
    _v_interval = float(os.environ.get("MAIL_VERIFY_INTERVAL", "3") or 3)           # 每次轮询间隔(秒)
    for _cycle in range(_v_cycles):                  # 1 次初始 + (cycles-1) 次重发
        link = firstmail.wait_verify_link(email, mailbox_pw, cfg.get("mail_key"), cfg.get("mail_base"),
                                          attempts=_v_attempts, interval=_v_interval, alt_password=op_password)
        if link:
            break
        if _cycle < _v_cycles - 1:
            clicked = False
            for _w in range(8):                      # 'Resend (N)' 倒计时结束才可点,最多等 24s
                if page.click_text(["Resend", "Resend link"], 2):
                    clicked = True
                    break
                time.sleep(3)
            log("[验证] 本轮没读到链接 → %s" % ("已点 Resend 重发,继续轮询" if clicked else "Resend 还不可点,继续轮询"))
            time.sleep(2)
    if not link:
        log("[验证] ✗ 重发后仍没读到验证链接")
        # 判定坏邮箱:Firstmail 对该邮箱返回 404=不可访问/根本收不到信 → 登记,后续永久跳过(别再浪费注册)
        try:
            firstmail.get_latest_message(email, mailbox_pw, cfg.get("mail_key"), cfg.get("mail_base"))
        except Exception as e:
            if "404" in str(e):
                common.mark_bad_mailbox(email, "mailbox-404(收不到验证邮件)")
        return False
    log("[验证] 打开验证链接(同浏览器,使邮箱验证生效)…")
    page.goto(link, wait=4)
    page.goto(KEYS_URL, wait=3)
    return True


def register(page, email, op_password, mailbox_pw, cfg):
    """注册。返回 'ok' / 'exists' / 'fail:<reason>'。"""
    log("[注册] %s" % email)
    page.goto(SIGNUP_URL, wait=2.5)
    # 等 Clerk 注册表单真正渲染出来再填（OpenRouter 把注册做成首页上的浮层，慢网下要等）
    if not page.wait_field_present(["#emailAddress-field", "#password-field"], 25, "注册表单"):
        log("[注册] 25s 没等到注册表单 → 重载一次")
        page.goto(SIGNUP_URL, wait=3)
        if not page.wait_field_present(["#emailAddress-field"], 20, "注册表单(重载)"):
            _diag(page, "noform")
            return "fail:NO_SIGNUP_FORM"
    local = email.split("@")[0]
    # 【时序竞态修复】Clerk 注册表单 wait_field_present 一出现就填,但它常在随后 hydrate/重渲染时把刚填的值清掉
    #   (stanleysanchez 现象:_set_value 全 True,但紧接着 #field.value 全空 → 空表单提交触发 required 校验,
    #    再 3 次重提 + 解 Turnstile 干耗 = 看着「卡死」)。_set_value 只确认 send_keys 跑了,没确认值【粘住】。
    #   → 填完【回读真实 #field.value 校验】,email/password(≥8)/legal 没粘住就整体重填,最多 3 轮;粘住才提交。
    def _fill_form():
        _set_value(page, "#firstName-field", (local[:6] or "John").capitalize())
        _set_value(page, "#lastName-field", "M")
        _set_value(page, "#emailAddress-field", email)
        _set_value(page, "#password-field", op_password)
        _check(page, "#legalAccepted-field")

    def _form_stuck():
        d = page.js("return {em:((document.querySelector('#emailAddress-field')||{}).value||''),"
                    "pw:(((document.querySelector('#password-field')||{}).value||'').length),"
                    "legal:!!((document.querySelector('#legalAccepted-field')||{}).checked)};") or {}
        return bool(d.get("em")) and (d.get("pw") or 0) >= 8 and bool(d.get("legal"))

    stuck = False
    for _fa in range(3):
        _fill_form()
        time.sleep(0.8)   # 留窗口给 React:要清值就在这 0.8s 内清掉,之后回读才反映真实状态
        if _form_stuck():
            stuck = True
            break
        log("[注册] 填表值没粘住(第%d次,表单疑似刚 hydrate 重渲染)→ 整体重填" % (_fa + 1))
        time.sleep(1.0)
    log("[注册] 填表 stuck=%s(email/password/legal 已回读确认)" % stuck)
    _diag(page, "filled")
    if not stuck:
        # 3 次重填仍没粘住 → 别空提交(会 3 次重提 + 白解 Turnstile 干耗成"卡死"),快速失败走整号重试(下轮换新环境/重渲染时机不同)。
        log("[注册] 3 次重填后表单值仍没粘住 → 快速失败,不空提交(省 2captcha + 不卡死)")
        _diag(page, "fill_stuck_fail")
        return "fail:FORM_NOT_FILLED"
    since = time.time() * 1000
    # 提交 + 解 Turnstile + 等到验证页;若提交后仍停在 /sign-up(Turnstile widget 在但没提交成功),
    # 再点一次 Sign Up 并必要时重解 Turnstile,最多重试 2 次(共 3 次提交)再判 UNCONFIRMED。
    for _submit in range(3):
        if _submit == 0:
            page.click_text(["Continue"], 8)
            time.sleep(2)
            _diag(page, "after_continue")
            _solve_turnstile_if_present(page, SIGNUP_URL, cfg, ["/verify-email"])
            _diag(page, "after_turnstile")
        else:
            log("[注册] 提交后仍停在 /sign-up(没进 /verify-email)→ 第 %d 次重试提交 + 重解 Turnstile" % _submit)
            page.click_text(["Continue", "Sign Up", "Sign up"], 8)
            time.sleep(2)
            _solve_turnstile_if_present(page, SIGNUP_URL, cfg, ["/verify-email"])
            _diag(page, "after_turnstile_retry%d" % _submit)
        # 等到验证邮件页 / 或撞 already-exists
        reached = False
        for _ in range(16):
            u = page.url()
            if "/verify-email" in u:
                reached = True
                break
            t = (page.all_frames_text() or "").lower()
            if "not allowed to access" in t or "is not allowed" in t:
                log("[注册] %s 被 OpenRouter 拒绝(not allowed to access this application)" % email)
                return "fail:NOT_ALLOWED"
            if "already exists" in t or "already registered" in t or "that email address is taken" in t:
                log("[注册] 邮箱已存在 → 转登录")
                return "exists"
            if "/sign-up" not in u:
                reached = True  # 离开 sign-up(进了下一步)→ 不再重试提交
                break
            time.sleep(2.5)
        if reached or "/verify-email" in page.url():
            break
    log("[注册] 提交后停在 …%s (到验证页=%s)" % (page.url()[-40:], "/verify-email" in page.url()))
    if "/verify-email" in page.url():
        if not _verify_email_link(page, email, mailbox_pw, cfg, op_password=op_password):
            _diag(page, "verify_fail")
            return "fail:VERIFY_LINK"
    # 确认登录
    em = detect_session(page)
    if em:
        log("[注册] 成功，已登录 %s" % em)
        return "ok"
    _diag(page, "unconfirmed")
    return "fail:REGISTER_UNCONFIRMED"


def login(page, email, op_password, mailbox_pw, cfg):
    """登录已存在账号。返回 'ok' / 'fail:<reason>'。"""
    log("[登录] %s" % email)
    page.goto(SIGNIN_URL, wait=2)
    if not page.wait_field_present(["#identifier-field"], 20, "identifier"):
        return "fail:SIGNIN_NO_FORM"
    _set_value(page, sel_csv('signin_identifier', '#identifier-field'), email)
    page.click_text(["Continue"], 6)
    time.sleep(2)
    _set_value(page, "#password-field", op_password)
    page.click_text(["Continue"], 6)
    time.sleep(2.5)
    t = (page.all_frames_text() or "").lower()
    if "not allowed to access" in t or "is not allowed" in t:
        # OpenRouter 直接封禁/拒绝该邮箱 → 上报 NOT_ALLOWED,编排层会登记并永久跳过
        log("[登录] %s 被 OpenRouter 拒绝(not allowed to access this application)" % email)
        return "fail:NOT_ALLOWED"
    if any(s in t for s in ["couldn't find", "no account", "not found", "isn't right", "incorrect", "password is incorrect"]):
        # 密码不对/无账号
        if "incorrect" in t:
            return "fail:SIGNIN_BAD_PASSWORD"
    since = time.time() * 1000
    _solve_turnstile_if_present(page, SIGNIN_URL, cfg, ["/factor-two", "/verify", "/settings"])
    u = page.url()
    if "/factor-two" in u or "/verify" in u:
        # 传 op_password 作备用密码:改过密的号邮箱真实密码=统一密码,旧 mailbox_pw 读不到 OTP(fail:OTP 根因)。
        if not _enter_otp(page, email, mailbox_pw, cfg, since, op_password=op_password):
            return "fail:OTP"
    # 确认
    em = detect_session(page)
    if em:
        log("[登录] 成功，已登录 %s" % em)
        return "ok"
    return "fail:SIGNIN_UNCONFIRMED"


def register_or_login(page, email, op_password, mailbox_pw, cfg, registered=False):
    """先看是否已登录(干净环境不会)；【已知注册过(registered=True)→直接登录,绝不再点注册】;否则注册,撞 exists 转登录。
    返回 'ok' / 'fail:<reason>'。registered 来自历史标记(state/results.jsonl 该号有过 auth=ok)——
    解决"已注册号重跑又去点注册→账号已存在→卡 verify→REGISTER_UNCONFIRMED"。"""
    em = detect_session(page)
    if em:
        if em.lower() == email.lower():
            log("环境已登录目标账号 %s → 跳过" % em)
            return "ok"
        log("环境登录的是别的账号 %s → 登出" % em)
        sign_out(page)
    if registered:
        log("[已注册标记] %s 注册过 → 直接登录(不再点注册)" % email)
        r = login(page, email, op_password, mailbox_pw, cfg)
        if r == "ok":
            return r
        log("[已注册标记] 登录失败(%s)→ 回退尝试注册(标记可能有误/密码不符)" % r)
    r = register(page, email, op_password, mailbox_pw, cfg)
    if r == "exists":
        return login(page, email, op_password, mailbox_pw, cfg)
    return r
