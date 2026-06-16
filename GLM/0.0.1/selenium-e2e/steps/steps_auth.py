#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# z.ai 注册 / 登录（纯 Selenium，Open WebUI 认证 + 滑块拼图 + 邮箱链接验证）
#
# 文件定位：GLM/0.0.1/selenium-e2e/steps/steps_auth.py
#
# 注册:chat.z.ai → Sign in → Continue with Email → Sign up → 填 Name/Email/Password →
#   Click to start verification(滑块) → Create Account → 收验证邮件 → 打开 verify_email 链接 →
#   Complete Registration(设 Password+Confirm) → Registration Complete → 跳登录。
# 登录:Continue with Email → 填 Email/Password → 滑块 → Sign in。
# 入参 op_pw = z.ai 账号密码(注册时设/登录时用)；mailbox_pw = 邮箱密码(读验证邮件用)。
# ═══════════════════════════════════════════════════════════════════════

import os
import re
import time

import common
from common import log, CHAT_URL, AUTH_URL, APIKEY_URL, SUBSCRIBE_URL, clear_input, fast_mode, poll_signal, timed
from common.selectors import sel, sel_csv
from services import slider
from services import firstmail


def _fill(page, css_list, value, label="字段"):
    """在主文档找首个可见输入框,清空后填值并回读确认。返回 True/False。"""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    if value is None:
        return False
    for css in css_list:
        try:
            for el in page.d.find_elements(By.CSS_SELECTOR, css):
                if el.is_displayed():
                    el.click()
                    clear_input(el, Keys)
                    el.send_keys(str(value))
                    got = (el.get_attribute("value") or "")
                    if got:
                        return True
        except Exception:
            continue
    log("  ✗ %s 没填上" % label)
    return False


def _present(page, css_list, timeout=20, label="表单"):
    from selenium.webdriver.common.by import By
    end = time.time() + timeout
    while time.time() < end:
        for css in css_list:
            try:
                if any(e.is_displayed() for e in page.d.find_elements(By.CSS_SELECTOR, css)):
                    return True
            except Exception:
                pass
        time.sleep(0.5)
    log("  ✗ 等【%s】出现超时(%ss)" % (label, timeout))
    return False


def _solve_slider(page, cfg, label=""):
    """解滑块。★触发「Click to start verification」打开拼图浮层的动作交给 slider.solve 内部
    用 CDP 可信点击统一处理(Selenium click 触发不了 z.ai 的 React 验证控件 → 浮层不弹 → 之前
    误把 logo 当拼图送 2captcha 导致 ERROR_CAPTCHA_UNSOLVABLE)。"""
    ok = slider.solve(page.d, cfg, label=label)
    if not ok:
        log("[滑块] %s 验证未通过" % label)
        return ok
    # ★过了之后等拼图浮层真正消失再交回(最多 ~3s):否则上层立刻点 Create Account/Sign in,
    #   可能点在还没收起的浮层上 → 提交没生效/盖两层表单。浮层没了=验证已落地,可安全进下一步。
    for _ in range(15):
        try:
            if page.js("return !document.querySelector('#aliyunCaptcha-float-wrapper, #aliyunCaptcha-img, img.puzzle, #aliyunCaptcha-sliding-slider')"):
                break
        except Exception:
            break
        time.sleep(0.2)
    return ok


def _slider_reentry_count():
    """滑块失败后【整页重进流程】重来的最大次数(env SLIDER_REENTRY,默认1 → 总滑块尝试=1+1=2,即"重进1次后放弃")。
       0=关=滑块失败即返回。★比 slider 内部原地刷新更彻底:阿里云拖失败后把浮层重置成残废态,原地刷新清不干净
       → 后续卡在"等稳定拼图"再也不拖(实测"滚动条不干活");整页回到干净 /auth 重新触发可清掉残废浮层。
       注意:救不了【行为检测拒精准拖拽】那类(重进再拖还是机器轨迹)。"""
    try:
        return max(0, int(os.environ.get("SLIDER_REENTRY", "1") or 1))
    except Exception:
        return 1


def _reset_for_reentry(page):
    """滑块失败后【刷新当前页】重来(用户定的第四步)。★必须 refresh【当前 URL】而非 goto 干净 /auth ——
       取Key重登时当前页是 chat.z.ai/auth?response_type=code&client_id=…&redirect_uri=…(带 OAuth state),
       goto 干净 /auth 会丢掉这些参数 → 重登无法完成 code 兑换 → z.ai 会话建不起来;refresh 保留 state,重登能兑换。
       刷新顺带重置阿里云滑块到「Click to start verification」触发态(治残废浮层)。刷完由调用方点 Continue with Email 重复第三步。"""
    try:
        page.js("try{var s='#aliyunCaptcha-window-popup,#aliyunCaptcha-window-mask,#aliyunCaptcha-float-wrapper';"
                "document.querySelectorAll(s).forEach(function(e){e.remove();});}catch(e){}")
    except Exception:
        pass
    try:
        _u = page.url() or ""
        if "/auth" in _u:
            page.d.refresh()          # ★刷新当前 /auth 页(保留 OAuth state),不丢参数
            time.sleep(1.5)
        else:
            page.goto(AUTH_URL, wait=1.5)   # 不在 /auth(异常态)→ 兜底回 /auth
    except Exception:
        try: page.goto(AUTH_URL, wait=1.5)
        except Exception: pass


def _dismiss_captcha_popup(page):
    """清掉阿里云"验证成功"残留浮层(Please complete security verification / Slide successful!),
       否则它盖在提交按钮上 → 点 Sign in 点不到(实测 REGISTER_UNCONFIRMED 根因之一)。"""
    try:
        page.js("try{document.querySelectorAll("
                "'#aliyunCaptcha-window-popup,#aliyunCaptcha-window-mask,#aliyunCaptcha-float-wrapper,[id^=aliyunCaptcha]')"
                ".forEach(function(e){e.remove();});}catch(e){}")
    except Exception:
        pass


def _submit_auth_form(page, texts, label="提交"):
    """稳妥提交认证表单(登录/注册通用)。★避开两个坑:
       ① z.ai 表单底部有「Already have an account? Sign in」这类【切换链接】,click_text('Sign in') 会误点它而非提交按钮;
       ② 滑块"Slide successful!"浮层会盖住提交按钮 → 点不到。
       做法:先清浮层 → 对可见 password 框【按回车提交】(选择器无关、不被遮挡、绝不误点切换链接)→ 退回点 button[type=submit] → 再退回文本点击。"""
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    _dismiss_captcha_popup(page)
    time.sleep(0.4)
    # ① 回车提交(最稳):对最后一个可见 password 框敲回车,触发表单 submit
    try:
        pws = [e for e in page.d.find_elements(By.CSS_SELECTOR, "input[type=password]") if e.is_displayed()]
        if pws:
            pws[-1].send_keys(Keys.ENTER)
            log("[%s] 回车提交表单" % label); time.sleep(2.0); return True
    except Exception:
        pass
    # ② 精确点表单内 submit 按钮(按类型,不靠文本 → 不会命中切换链接)
    try:
        for b in page.d.find_elements(By.CSS_SELECTOR, "button[type=submit], form button"):
            if b.is_displayed() and b.is_enabled():
                b.click(); log("[%s] 点 submit 按钮提交" % label); time.sleep(2.0); return True
    except Exception:
        pass
    # ③ 兜底:文本点击(最后手段)
    log("[%s] 回退到文本点击提交" % label)
    return page.click_text(texts, 6)


def detect_session(page):
    """已登录返回 email(或 'logged-in');未登录返回 None。
    ★判据【正向】:goto 取 Key 页 → 等 OAuth 跳转稳定 →【只有真落到 manage-apikey 取Key页(url 含 apikey)才算已登录】。
      已登录:z.ai/manage-apikey 经 chat.z.ai/auth?response_type=code 自动跳回取Key页(落 apikey url)。
      未登录:被弹到 /auth 选择屏(Welcome to Z.ai,Continue with Email/Skip,【无密码框】)/登录表单/z.ai 首页 → 停那 → 未登录。
      ★★修真机【假阳性】:旧码靠"页面有没有 input[type=password]"判未登录,但选择屏/首页【根本没有密码框】→ 被误判【已登录】
        → auth=ok 却其实登出 → get_api_key 在登出页点「Add API Key」→ ADD_BUTTON_NOT_FOUND(真机 add-fail dump 实证页面是首页/选择屏)。
        改为正向只认"落到取Key页",选择屏/首页一律未登录,交上层 relogin。"""
    try:
        page.goto(APIKEY_URL, wait=2.0)
    except Exception:
        pass
    deadline = time.time() + float(os.environ.get("SESSION_SETTLE_WAIT", "12") or 12)
    last_u = None; stable = 0
    while True:
        u = page.url() or ""
        if not u:                         # 浏览器窗口已死(no such window)→ 判未登录交上层重起
            return None
        if "apikey" in u.lower():         # ★落到取 Key 页 = 已登录(唯一正向判据)
            break
        if u == last_u:
            stable += 1
        else:
            stable = 0; last_u = u
        if stable >= 3:                   # URL 稳定却【不在取Key页】= 被弹到登录选择屏/表单/首页,没登进去 → 别空等满 deadline
            break
        if time.time() > deadline:
            break
        time.sleep(0.6)
    _u = (page.url() or "").lower()
    if "apikey" not in _u:
        # ★★真机实证(add-fail dump):未建 z.ai 会话时 goto manage-apikey 会弹跳到登出的「Welcome to Z.ai」选择屏
        #   (Continue with Email/Google/Github + Skip for now),此屏【无密码框】且页面可能残留 token → 旧 token 兜底【假阳性】
        #   判已登录 → 跳过 OAuth 重登 → get_api_key 在登出页找 Add → ADD_BUTTON_NOT_FOUND。→ 显式识别选择屏,一律未登录。
        try:
            _is_chooser = page.js(r"""return (function(){var t=((document.body&&document.body.innerText)||'')+'';
              return /continue with (email|google|github)/i.test(t) && /(skip for now|welcome to z\.?ai)/i.test(t);})();""")
        except Exception:
            _is_chooser = False
        if _is_chooser:
            return None
        # ★兜底(AUTH-001):OAuth 偶尔落到非取Key的【已登录页】(/account 等)→ 别误判未登录。
        #   仅当【有 z.ai token + 不在 /auth + 无密码框 + 不是选择屏】才认已登录:选择屏/登出首页无 token → 都被排除,不会退回假阳性。
        try:
            _tok = page.js("try{return localStorage.getItem('token')||localStorage.getItem('access_token')||'';}catch(e){return '';}")
            _has_pw = page.js("return !!document.querySelector('input[type=password]')")
            if _tok and "/auth" not in _u and not _has_pw:
                page.clear_promo()
                _em = page.js("try{var u=JSON.parse(localStorage.getItem('user')||'{}');return u.email||'';}catch(e){return '';}") or ""
                return _em or "logged-in"
        except Exception:
            pass
        return None                       # ★正向:只有真落到取Key页(或上面 token 兜底)才算登录;选择屏/登录表单/登出首页 一律未登录
    page.clear_promo()                    # 已在取Key页:关掉 GLM Coding Plan 促销弹窗(复用 Page.clear_promo),别挡后续建 Key
    em = page.js(
        "try{var u=JSON.parse(localStorage.getItem('user')||'{}');return u.email||'';}catch(e){return '';}") or ""
    return em or "logged-in"


def sign_out(page):
    try:
        page.js("try{localStorage.removeItem('token');localStorage.removeItem('user');}catch(e){}")
    except Exception:
        pass
    page.goto(AUTH_URL, wait=1.5)
    return True


def _open_auth(page):
    """落到 /auth 登录/注册浮层。★直接 goto chat.z.ai/auth(此页本身既有登录又有注册)—— 不先开 chat.z.ai 首页再点
       Sign in,省一次页面加载(用户定:打开浏览器直接到 /auth 自注册/登录)。已在 /auth 则不重复导航(别打断已渲染的表单/滑块)。"""
    if "/auth" not in (page.url() or ""):
        page.goto(AUTH_URL, wait=2.5)                      # ★一步到位:直达 /auth
        # 兜底:万一直达没落到 /auth(极少)→ 回首页点 Sign in 再来一次
        if "/auth" not in (page.url() or ""):
            page.goto(CHAT_URL, wait=2.0)
            page.click_text(sel("sign_in", "Sign in", "Sign In", "Log in", "登录"), 8)
            time.sleep(1.2)
    # 选「Continue with Email」(若当前是社交登录选择屏)
    page.click_text(sel("continue_with_email", "Continue with Email", "Continue with email", "邮箱登录"), 6)
    time.sleep(1.0)


def _verify_email_link(page, email, mailbox_pw, cfg, op_password="", since_ts=0):
    """注册邮箱验证 = z.ai 魔法链接:读链接 → 同浏览器打开 → 落到 Complete Registration。"""
    log("[验证] 到验证页,读邮箱 %s 的 z.ai 验证链接…" % email)
    _v_cycles = max(1, int(os.environ.get("MAIL_VERIFY_CYCLES", "3") or 3))
    _v_attempts = max(1, int(os.environ.get("MAIL_VERIFY_ATTEMPTS", "12") or 12))
    _v_interval = float(os.environ.get("MAIL_VERIFY_INTERVAL", "3") or 3)
    _deadline = time.time() + float(os.environ.get("MAIL_VERIFY_DEADLINE", "180") or 180)   # ★外层总时限:防多轮累积挂死(最坏可达 600s+)
    link = None; _mailbox_ok = False; _bad_mail_seen = False
    for _cycle in range(_v_cycles):
        if time.time() > _deadline:
            log("[验证] 已超读信总时限(%.0fs)→ 停轮询" % float(os.environ.get("MAIL_VERIFY_DEADLINE", "180") or 180)); break
        _mst = {}
        link = firstmail.wait_verify_link(email, mailbox_pw, cfg.get("mail_key"), cfg.get("mail_base"),
                                          attempts=_v_attempts, interval=_v_interval, alt_password=op_password,
                                          status=_mst, since_ts=since_ts)
        if _mst.get("bad_mailbox") is False:
            _mailbox_ok = True
        elif _mst.get("bad_mailbox"):
            _bad_mail_seen = True
        if link:
            break
        if _cycle < _v_cycles - 1 and time.time() < _deadline:
            # ★Resend 冷却感知:按钮显「Resend (30s)」或 disabled = 冷却中,点了没用 → 别空转 8×3s;只在可点(无倒计时)时点一次。
            _resent = False
            try:
                _rb = page.js(r"""return (function(){
                  var els=[].slice.call(document.querySelectorAll('button,[role=button],a'));
                  for(var i=0;i<els.length;i++){var e=els[i];var t=((e.innerText||'')+'').trim();
                    if(/resend|重新发送/i.test(t)){ var cd=/\(\s*\d+\s*s?\s*\)/.test(t) || e.disabled===true;
                      var r=e.getBoundingClientRect(); return {cooldown:cd, x:r.left+r.width/2, y:r.top+r.height/2}; }}
                  return null; })();""")
            except Exception:
                _rb = None
            if _rb and not _rb.get("cooldown") and _rb.get("x") is not None:
                try: page.cdp_click(_rb["x"], _rb["y"]); _resent = True
                except Exception: pass
            log("[验证] 本轮没读到链接 → %s" % ("已点 Resend,继续轮询" if _resent else "Resend 冷却中/不可点 → 不空转,继续轮询"))
            time.sleep(2)
    if not link:
        log("[验证] ✗ 重发后仍没读到验证链接")
        if _bad_mail_seen and not _mailbox_ok:
            common.mark_bad_mailbox(email, "mailbox-404(收不到验证邮件)")
        return False
    log("[验证] 打开验证链接(同浏览器)…")
    page.goto(link, wait=4)
    return True


def _complete_registration(page, op_pw):
    """Complete Registration 页:设 Password + Confirm Password → 提交。返回 True/False。"""
    from selenium.webdriver.common.by import By
    if not _present(page, ["input[type=password]"], 20, "完成注册-密码框"):
        return False
    # 页面有两个 password 框(Password + Confirm Password)→ 都填 op_pw
    pw_filled = 0
    try:
        for el in page.d.find_elements(By.CSS_SELECTOR, "input[type=password]"):
            if el.is_displayed():
                from selenium.webdriver.common.keys import Keys
                el.click(); clear_input(el, Keys); el.send_keys(op_pw)
                pw_filled += 1
    except Exception:
        pass
    if pw_filled == 0:
        log("[完成注册] 密码框没填上"); return False
    log("[完成注册] 已填 %d 个密码框,点 Complete Registration" % pw_filled)
    page.click_text(sel("complete_registration", "Complete Registration", "完成注册"), 8)
    # ★用 common.poll_signal 轮询成功信号(注册落库是服务端动作,有延迟;只查一次会漏判→误判 COMPLETE_REG_FAIL)。
    def _check():
        t = (page.all_frames_text() or "").lower()
        u = page.url()
        # 强成功:明确「注册完成」文案 或 已跳回登录页 /auth。
        if ("registration complete" in t or "registration completed" in t
                or "注册完成" in t or "successfully registered" in t or "/auth" in u):
            return True
        # 明确报错 → 失败(★不用裸 "complete"/"success":页面残留按钮文案会假阳性)。
        if any(s in t for s in ("invalid", "failed", "try again", "expired",
                                "do not match", "doesn't match", "密码不一致", "出错", "失败")):
            log("[完成注册] 提交后报错(…%s)" % u[-40:]); return False
        # 弱信号:密码表单已消失(页面确实前进了)→ 视为完成。
        try:
            if not page.js("return !!document.querySelector('input[type=password]')"):
                log("[完成注册] 密码表单已消失(页面前进)→ 视为完成"); return True
        except Exception:
            pass
        return None
    r = poll_signal(_check, timeout=12.0, interval=0.5)
    if r is None:
        log("[完成注册] 12s 内未见成功信号 → 失败(…%s)" % page.url()[-40:])
    return bool(r)


def _verify_login_loop(page, fill_and_slide, no_form_status, on_node, form_node, slider_node, label):
    """★统一的【验证码登录】工具 —— 三处共用同一套逻辑:注册表单 / 登录表单 / 取Key 的 OAuth 登录表单(后者走 login() 间接用它)。
       fill_and_slide(): 填好表单 + 调 _solve_slider 解滑块,返回 'ok' / no_form_status(没表单) / 'fail:SLIDER_FAIL'。
       逻辑(用户定):
         · 成功 → 记 form_node/slider_node=ok,返回 'ok'(调用方走下一步);
         · 滑块失败 → 【刷新当前页】(_reset_for_reentry:refresh 当前 URL,保住 OAuth 的 response_type=code state,
           顺带清掉阿里云拖失败的残废浮层),重新填表单+解,最多 _slider_reentry_count()+1 次;
         · 没表单(no_form_status)≠ 滑块问题 → 直接返回(重试无用)。
       三处不再各抄一份循环 → 改一处全生效,逻辑保证一致。"""
    _r = "fail:SLIDER_FAIL"
    for _i in range(_slider_reentry_count() + 1):
        if _i > 0:
            log("[%s] 滑块失败 → 刷新当前页重试(第%d次)" % (label, _i + 1))
            _reset_for_reentry(page)
        _r = fill_and_slide()
        if _r == "ok":
            break
        if _r == no_form_status:
            if on_node: on_node(form_node, no_form_status)
            return _r   # 没表单 ≠ 滑块问题,重试无用,直接返回
    if _r != "ok":
        if on_node: on_node(slider_node, "fail:SLIDER_FAIL")
        return "fail:SLIDER_FAIL"
    if on_node: on_node(form_node, "ok")
    if on_node: on_node(slider_node, "ok")
    return "ok"


def register(page, email, op_pw, mailbox_pw, cfg, on_node=None):
    """注册。返回 'ok' / 'exists' / 'fail:<reason>'。on_node(stage,status)=每个关键节点成功即刻登记(不做糊涂账)。"""
    log("[注册] %s" % email)
    local = email.split("@")[0]

    def _fill_signup_and_slide():
        """填注册表单 + 过滑块。返回 'ok' / 'fail:NO_SIGNUP_FORM' / 'fail:SLIDER_FAIL'。每次都从干净 /auth 开始。"""
        _open_auth(page)
        page.click_text(sel("sign_up", "Sign up", "Sign Up", "注册"), 6)
        time.sleep(1.2)
        if not _present(page, sel("signup_email", 'input[type=email]', 'input[placeholder*="email" i]'), 20, "注册表单"):
            log("[注册] 20s 没等到注册表单 → 重载一次")
            _open_auth(page)
            page.click_text(sel("sign_up", "Sign up"), 6)
            if not _present(page, ['input[type=email]', 'input[placeholder*="email" i]'], 15, "注册表单(重载)"):
                return "fail:NO_SIGNUP_FORM"
        _fill(page, sel("signup_name", 'input[placeholder*="name" i]', 'input[type=text]:not([type=email])'), local[:18] or "user", "Name")
        _fill(page, sel("signup_email", 'input[type=email]', 'input[placeholder*="email" i]'), email, "Email")
        _fill(page, sel("signup_password", 'input[type=password]'), op_pw, "Password")
        time.sleep(0.6)
        with timed("auth.slider.register"):
            return "ok" if _solve_slider(page, cfg, "注册") else "fail:SLIDER_FAIL"

    # ★验证码登录走【统一工具】:成功→下一步;滑块失败→刷新当前页重试;没表单直接返回。三处共用同一逻辑。
    _r = _verify_login_loop(page, _fill_signup_and_slide, "fail:NO_SIGNUP_FORM", on_node, "signup_form", "register_slider", "注册")
    if _r != "ok":
        return _r
    since = time.time() * 1000
    page.click_text(sel("create_account", "Create Account", "创建账号", "Create account"), 8)

    # ★轮询提交后的去向(服务端有延迟,措辞可能晚出现):到验证页 / 已存在 / 被拒 / 都不是。
    def _post_create():
        u = (page.url() or "").lower()
        t = (page.all_frames_text() or "").lower()
        if ("verify" in u or "verify your email" in t or "verification link" in t
                or "email verify sent" in t or "check your email" in t or "查收" in t or "验证邮件" in t):
            return "verify"
        # 已存在(★邻近匹配,不再用"already"与关键词全页共现 —— 否则页脚 "registered trademark" + "Already have an account?"
        #   会把【全新号】误判已存在 → 标 registered → 永远跳过注册把号锁死。要求 already 紧跟关键词,或 email/account 后短窗内出现 already)。
        if (re.search(r"already\s+(in[\s-]?use|registered|exists?|taken)", t)
                or re.search(r"(e-?mail|account)\b[^.<>]{0,40}already", t)
                or re.search(r"已(注册|存在|被注册|被使用)", t) or "邮箱已被" in t):
            return "exists"
        if "not allowed" in t or "is not permitted" in t or "access denied" in t or "不允许" in t:
            return "notallowed"
        return None
    r = poll_signal(_post_create, timeout=20.0, interval=1.0)
    if r == "exists":
        if on_node: on_node("create_account", "fail:EXISTS")
        log("[注册] 邮箱已存在 → 转登录"); return "exists"
    if r == "notallowed":
        if on_node: on_node("create_account", "fail:NOT_ALLOWED")
        log("[注册] %s 被拒(not allowed)" % email); return "fail:NOT_ALLOWED"
    if r != "verify":
        # ★没到验证页:打印 z.ai 实际页面文本,便于定位是哪种措辞/状态(否则做糊涂账)。
        if on_node: on_node("create_account", "fail:NO_VERIFY_PAGE")
        _txt = (page.all_frames_text() or "").replace("\n", " ")
        log("[注册] 提交后没到验证页(停 …%s);页面文本: %s" % (page.url()[-40:], _txt[:240]))
        return "fail:NO_VERIFY_PAGE"
    if on_node: on_node("create_account", "ok")   # 提交后到了验证页 = Create Account 这步成
    # 读验证链接 → 打开 → 完成注册
    with timed("auth.verify_email"):
        _vok = _verify_email_link(page, email, mailbox_pw, cfg, op_password=op_pw, since_ts=since)
    if not _vok:
        if on_node: on_node("verify_email", "fail:VERIFY_LINK")
        return "fail:VERIFY_LINK"
    if on_node: on_node("verify_email", "ok")
    with timed("auth.complete_reg"):
        _crok = _complete_registration(page, op_pw)
    if not _crok:
        if on_node: on_node("complete_registration", "fail:COMPLETE_REG_FAIL")
        return "fail:COMPLETE_REG_FAIL"
    if on_node: on_node("complete_registration", "ok")
    if on_node: on_node("register", "ok")   # ★完成注册=账号已建,立刻登记;后面登录即便失败,下次也不再重注册
    log("[注册] 完成注册成功,确认会话")
    # ★优化:有些情况下完成注册后已直接处于登录态 → 先查会话,已登录就跳过重新登录(省掉【第二次滑块】+第二次取信)。
    em = detect_session(page)
    if em and (em == "logged-in" or str(em).lower() == email.lower()):
        log("[注册] 完成注册后已是登录态 → 跳过重新登录(省一次滑块)")
        if on_node: on_node("login", "ok")
        return "ok"
    # 否则按 z.ai 常规:注册完成跳登录页 → 登录拿会话(会再过一次滑块)。
    r = login(page, email, op_pw, mailbox_pw, cfg, on_node=on_node)
    if r == "ok":
        return "ok"
    if on_node: on_node("session_confirm", "fail:REGISTER_UNCONFIRMED")
    return "fail:REGISTER_UNCONFIRMED"


def login(page, email, op_pw, mailbox_pw, cfg, on_node=None):
    """登录已存在账号。返回 'ok' / 'fail:<reason>'。on_node(stage,status)=关键节点成功即刻登记。"""
    log("[登录] %s" % email)

    def _fill_signin_and_slide():
        """填登录表单 + 过滑块。返回 'ok' / 'fail:SIGNIN_NO_FORM' / 'fail:SLIDER_FAIL'。每次从干净 /auth 开始。"""
        _open_auth(page)
        if not _present(page, sel("signin_email", 'input[type=email]', 'input[placeholder*="email" i]'), 18, "登录表单"):
            return "fail:SIGNIN_NO_FORM"
        _fill(page, sel("signin_email", 'input[type=email]', 'input[placeholder*="email" i]'), email, "Email")
        _fill(page, sel("signin_password", 'input[type=password]'), op_pw, "Password")
        time.sleep(0.5)
        with timed("auth.slider.login"):
            return "ok" if _solve_slider(page, cfg, "登录") else "fail:SLIDER_FAIL"

    # ★验证码登录走【统一工具】(与注册、取Key OAuth登录同一套):成功→下一步;滑块失败→刷新当前页重试;没表单直接返回。
    _r = _verify_login_loop(page, _fill_signin_and_slide, "fail:SIGNIN_NO_FORM", on_node, "signin_form", "login_slider", "登录")
    if _r != "ok":
        return _r
    # ★稳妥提交:先清"Slide successful!"残留浮层(它会盖住 Sign in 按钮)→ 回车提交(不被遮挡、不误点"Sign up"切换链接)。
    _submit_auth_form(page, sel("sign_in_submit", "Sign in", "Sign In", "登录"), "登录提交")
    time.sleep(2.5)
    t = (page.all_frames_text() or "").lower()
    if "not allowed" in t or "access denied" in t:
        if on_node: on_node("login_submit", "fail:NOT_ALLOWED")
        return "fail:NOT_ALLOWED"
    if any(s in t for s in ["incorrect", "invalid password", "wrong password", "isn't right", "密码错误"]):
        if on_node: on_node("login_submit", "fail:SIGNIN_BAD_PASSWORD")
        return "fail:SIGNIN_BAD_PASSWORD"
    if any(s in t for s in ["no account", "not found", "couldn't find", "账号不存在"]):
        if on_node: on_node("login_submit", "fail:SIGNIN_NO_ACCOUNT")
        return "fail:SIGNIN_NO_ACCOUNT"
    # 确认会话
    em = detect_session(page)
    if em:
        if em != "logged-in" and str(em).lower() != email.lower():
            log("[登录] 会话邮箱(%s)≠目标(%s)→ 不算成功" % (em, email))
            if on_node: on_node("session_confirm", "fail:SIGNIN_UNCONFIRMED")
            return "fail:SIGNIN_UNCONFIRMED"
        log("[登录] 成功,已登录 %s" % em)
        if on_node: on_node("login_submit", "ok")
        if on_node: on_node("session_confirm", "ok")
        if on_node: on_node("login", "ok")
        return "ok"
    if on_node: on_node("session_confirm", "fail:SIGNIN_UNCONFIRMED")
    return "fail:SIGNIN_UNCONFIRMED"


def _current_logged_in(page):
    """轻量【当前页】登录态探测(★不导航 → 不会先跳去 API Key 页):查当前 chat.z.ai 页 localStorage 的 token/email。
       已登录返回 email(或 'logged-in');未登录/在 /auth 返回 None。供 register_or_login 开头判"环境是否已登录",
       替代 detect_session(后者会 goto z.ai 取 Key 页 → 让全新号【先跳一趟 API Key 页】再回来注册,正是用户问的"为啥先跳API KEY")。"""
    try:
        if "/auth" in (page.url() or ""):
            return None
        tok = page.js("try{return localStorage.getItem('token')||localStorage.getItem('access_token')||'';}catch(e){return '';}")
        if not tok:
            return None
        em = page.js("try{var u=JSON.parse(localStorage.getItem('user')||'{}');return u.email||'';}catch(e){return '';}") or ""
        return em or "logged-in"
    except Exception:
        return None


def _click_api_entry(page):
    """精确点 chat.z.ai 右上角「API」链接进 z.ai —— 避免 click_text 子串 'api' 误点 'Create API'/'Pricing API' 等(SEL-001)。
       优先 JS 找【文本恰为 API / href 指向 z.ai 或 manage-apikey】的链接做 CDP 可信点击;失败退 click_text("API")。返回 bool。"""
    try:
        xy = page.js(r"""return (function(){
          var els=[].slice.call(document.querySelectorAll('a,button,[role=button]'));
          for(var i=0;i<els.length;i++){var e=els[i];
            var t=((e.innerText||e.textContent||'')+'').trim();
            var href=(((e.getAttribute&&e.getAttribute('href'))||'')+'');
            var hit = /^api$/i.test(t) || (/^api\b/i.test(t) && t.length<=8) || /manage-apikey|\/api(\/|$|\?)/.test(href) || (/^https?:\/\/z\.ai/.test(href) && t.length<=8);
            if(hit){ var r=e.getBoundingClientRect(); if(r.width>0 && r.height>0) return {x:r.left+r.width/2, y:r.top+r.height/2}; }
          } return null; })();""")
        if xy and xy.get("x") is not None:
            if page.cdp_click(xy["x"], xy["y"]):
                return True
    except Exception:
        pass
    return bool(page.click_text(sel("api_entry", "API"), 8))


def _open_zai_menu(page):
    """打开 z.ai/subscribe 右上角 ☰ 汉堡菜单(「Login」藏在里面,不是可见按钮 → 直接 click_text('Login') 点不到、卡在订阅页)。
       JS 找【右上角、无文本/含 svg、或 aria-label 含 menu】的按钮 CDP 点开。返回 bool。"""
    try:
        xy = page.js(r"""return (function(){
          var W=window.innerWidth;
          var bs=[].slice.call(document.querySelectorAll('button,[role=button],[aria-label],a'));
          for(var i=0;i<bs.length;i++){var e=bs[i];var r=e.getBoundingClientRect();
            if(!(r.width>0&&r.height>0&&r.top<140&&r.left>W*0.55)) continue;   // 仅右上角
            var lab=(((e.getAttribute&&e.getAttribute('aria-label'))||'')+'').toLowerCase();
            var t=((e.innerText||e.textContent||'')+'').trim();
            if(lab.indexOf('menu')>=0 || /menu|hamburger|nav-toggle/i.test(((e.className||'')+'')) || (t.length<=1 && e.querySelector && e.querySelector('svg'))){
              return {x:r.left+r.width/2, y:r.top+r.height/2};
            }}
          return null; })();""")
        if xy and xy.get("x") is not None:
            return bool(page.cdp_click(xy["x"], xy["y"]))
    except Exception:
        pass
    return False


def enter_apikey_oauth(page, email, op_pw, mailbox_pw, cfg, on_node=None):
    """进取Key阶段(用户步骤6,正确入口):chat.z.ai 登录态 → 点右上角「API」→(若落 z.ai/subscribe)点「Login」
       → OAuth 选择屏(chat.z.ai/auth?response_type=code&redirect_uri=z.ai/login/callback&state=…)
       → Continue with Email → 填邮箱密码 → Click to start verification 过滑块 → Sign in → 完成 OAuth code 兑换 → 建【z.ai 真会话】。
       ★必须经「API」入口走完整 OAuth:直接 goto z.ai/manage-apikey 只拿到 chat.z.ai SSO 的【临时渲染】(~20s 被踢回选择屏 → ADD_BUTTON_NOT_FOUND);
         走 plain /auth(无 response_type=code)登录只建 chat.z.ai 会话、建不了 z.ai 会话。两者都不行,必须保住 OAuth state。返回 True/False。"""
    # ★每个环节打独立标识(node_status),便于排查到底卡哪一步;z.ai 登录用 "oauth_" 前缀,与 chat.z.ai 注册登录【区分开不覆盖】。
    def _nd(node, status="ok"):
        if on_node:
            try: on_node(node, status)
            except Exception: pass
    _oauth_nd = (lambda n, s="ok": _nd("oauth_" + n, s)) if on_node else None
    # ★防标签堆积(用户报"频繁弹新窗口"):取Key 每轮重试点「API」都会开一个新标签 → 进来先关掉多余标签只留一个,
    #   再走 OAuth(会话是 cookie 级、跨标签共享,goto(CHAT_URL) 会把留下的标签重新带回登录态)。
    try:
        _hs = page.d.window_handles
        if len(_hs) > 1:
            _keep = _hs[-1]
            for _h in _hs:
                if _h == _keep:
                    continue
                try: page.d.switch_to.window(_h); page.d.close()
                except Exception: pass
            try: page.d.switch_to.window(_keep)
            except Exception: pass
            log("[取Key] 清理多余标签(%d→1)再进 OAuth,防标签堆积" % len(_hs))
    except Exception:
        pass
    try:
        page.goto(CHAT_URL, wait=2.5)                      # 回 chat.z.ai 登录态首页
    except Exception:
        pass
    try: page.clear_promo()
    except Exception: pass
    _api_ok = _click_api_entry(page)                       # 右上角「API」链接 → 进 z.ai(精确点,避免子串误点)
    time.sleep(2.0)
    # ★★关键修(NEW-TAB,真机+截图实证):点「API」会【新开一个标签页】跳 z.ai/subscribe,而 Selenium 的 driver 句柄
    #   仍停在旧 chat.z.ai 标签 →(a)page.url() 读旧标签→_navigated 永远 False;(b)后续 login() 在错标签跑;
    #   (c)那个新 subscribe 标签【没人驱动】→ 永远空白 Loading → z.ai 会话建不起来 → ADD_BUTTON_NOT_FOUND/NOT_LOGGED_IN。
    #   → 点完若多了标签,切到【最新】那个;并等它真加载出 z.ai url(治"空白 Loading")。
    try:
        _handles = page.d.window_handles
        if len(_handles) > 1:
            page.d.switch_to.window(_handles[-1])
            log("[取Key] 点「API」开了新标签(共%d个)→ 切到最新标签接管" % len(_handles))
            for _ in range(20):                            # 等新标签加载出真实 url(最多 ~10s),治空白 Loading
                _u = page.url() or ""
                if _u and "about:blank" not in _u and ("z.ai" in _u or "/auth" in _u):
                    break
                time.sleep(0.5)
    except Exception as _we:
        log("[取Key] 切新标签异常: %s" % str(_we)[:60])
    _cur = page.url() or ""
    _navigated = ("z.ai" in _cur and "chat.z.ai" not in _cur) or "/auth" in _cur
    # ★兜底:既没新标签、当前标签也没跳(API 没点中/新标签空白)→ 当前标签直接 goto z.ai/subscribe,照样走 Login→OAuth(不赌 API 链接)
    if not _navigated:
        try:
            page.goto(SUBSCRIBE_URL, wait=3.0)
            _cur = page.url() or ""
            _navigated = "z.ai" in _cur and "chat.z.ai" not in _cur
            log("[取Key] API 入口未跳转 → 兜底直接 goto z.ai/subscribe(now=%s)" % _cur[:50])
        except Exception:
            pass
    _nd("oauth_api_click", "ok" if _navigated else "fail:API_LINK_NOT_FOUND")
    if not _navigated:
        log("[取Key] ⚠ 进 z.ai 失败(仍在 %s)→ 入口没点对/页面未登录" % (page.url() or "")[:60])
    try: page.clear_promo()
    except Exception: pass
    # 状态分流:已在 OAuth 选择屏(/auth)→ 直接登录;落到 z.ai/subscribe(GLM Coding Plan)→ 先点「Login」进 OAuth(别乱跳)
    if "/auth" in (page.url() or ""):
        _nd("oauth_login_click", "ok")                     # 已到 OAuth 选择屏,无需点 Login
    else:
        # z.ai/subscribe:先试直接点 Login;点不到(在 ☰ 菜单里)→ 开菜单再点(治"卡在 subscribe 页")
        _login_ok = page.click_text(sel("zai_login", "Login", "Log in", "Sign in", "登录"), 4)
        if not _login_ok and "/auth" not in (page.url() or ""):
            if _open_zai_menu(page):
                time.sleep(1.0)
                _login_ok = page.click_text(sel("zai_login", "Login", "Log in", "Sign in", "登录"), 6)
        _nd("oauth_login_click", "ok" if (_login_ok or "/auth" in (page.url() or "")) else "fail:LOGIN_BTN_NOT_FOUND")
        time.sleep(2.0)
    # 现在应在 OAuth 选择屏 → login()(节点带 oauth_ 前缀)走 Continue with Email→填→Click to start verification 滑块→Sign in 完成 OAuth 兑换
    r = login(page, email, op_pw, mailbox_pw, cfg, on_node=_oauth_nd)
    _nd("oauth_zai_login", "ok" if r == "ok" else ("fail:" + r if isinstance(r, str) else "fail:OAUTH_LOGIN"))
    return r == "ok"


def register_or_login(page, email, op_pw, mailbox_pw, cfg, registered=False, on_node=None):
    """已登录目标号→跳过;已知注册过→直接登录;否则注册,撞 exists 转登录。返回 'ok' / 'fail:<reason>'。
    on_node(stage,status)=每个关键节点成功即刻登记(注册/登录/各子步),不做糊涂账,下次据此跳过已完成节点。
    ★开头用【当前页轻量探测】判环境是否已登录(不再用 detect_session 导航到取 Key 页)→ 全新号【直接进注册流程】,不再先跳一趟 API Key 页。"""
    em = _current_logged_in(page)
    if em:
        if em == "logged-in" or em.lower() == email.lower():
            log("环境已登录 %s → 跳过" % em)
            if on_node: on_node("login", "ok")
            return "ok"
        log("环境登录的是别的账号 %s → 登出" % em)
        sign_out(page)
    if registered:
        log("[已注册标记] %s → 直接登录(不再点注册)" % email)
        r = login(page, email, op_pw, mailbox_pw, cfg, on_node=on_node)
        if r == "ok":
            return r
        log("[已注册标记] 登录失败(%s)→ 回退尝试注册" % r)
    r = register(page, email, op_pw, mailbox_pw, cfg, on_node=on_node)
    if r == "exists":
        lr = login(page, email, op_pw, mailbox_pw, cfg, on_node=on_node)
        if lr == "ok":
            if on_node: on_node("register", "ok")   # 能登进=账号确实存在 → 登记,下次跳过注册滑块直奔登录
            return "ok"
        # ★登录没成,但密码错=账号【确实存在】(只是凭证不符)→ 标 registered:再注册无意义且可能触发风控,
        #   下次直接走登录(把"密码不对"这个真问题暴露出来给人工)。
        if lr == "fail:SIGNIN_BAD_PASSWORD":
            if on_node: on_node("register", "ok")
            log("[注册] 已存在但密码不符 → 标已注册(再注册无意义),请人工核对该号密码")
            return lr
        # NO_ACCOUNT(exists 可能是误判=其实新号)/ 滑块等瞬时失败 → 【不】标 registered,
        #   避免把全新号永久锁成"已注册→只登录→永远登不进";容下次/重试重新注册或重登。
        log("[注册] 判为已存在但登录失败(%s)→ 不标已注册(防误判把新号锁死),交由下次/重试再处理" % lr)
        return lr
    return r


__all__ = ["detect_session", "sign_out", "register", "login", "register_or_login"]
