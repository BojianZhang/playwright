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
from common import log, SIGNUP_URL, SIGNIN_URL, KEYS_URL, clear_input, fast_mode
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
                clear_input(el, Keys)   # 跨平台全选清空(Mac Ctrl+A=移到行首≠全选 → 重填残值拼脏邮箱/密码)
                el.send_keys(str(value))
                return True
    except Exception:
        pass
    return False


def _check(page, css):
    # 勾选复选框(同意条款)。★实测 LEGAL_NOT_CHECKED:表单已填好但勾不上 —— Clerk 的真 input(#legalAccepted-field)
    #   常被自定义样式框遮住/隐藏 → 原 `if el.is_displayed()` 直接跳过从不点击,或 el.click() 在 React 受控框上不生效。
    #   现:① 先 scrollIntoView(防 below-fold 点不中)+ 常规点击;② 仍没勾上 → 点关联 <label for> + 用 native checked
    #   setter 派发 click/input/change(React 受控复选框正解,与本文件 _fill_native 同套路)。只在【没勾上】时动,勾上即 no-op。
    from selenium.webdriver.common.by import By
    try:
        for el in page.d.find_elements(By.CSS_SELECTOR, css):
            try:
                if el.is_selected():
                    return True
            except Exception:
                pass
            try:
                page.d.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
            except Exception:
                pass
            if el.is_displayed() and not el.is_selected():
                try:
                    el.click()
                except Exception:
                    try: page.d.execute_script("arguments[0].click()", el)
                    except Exception: pass
            # 兜底:真 input 被隐藏 / React 没认上一击 → 点 label + native setter 派发事件(幂等:已勾上则 JS 内直接 return)
            try:
                page.d.execute_script(r"""
                    var inp=arguments[0]; if(inp.checked) return;
                    var id=inp.id; var lab=id?document.querySelector('label[for="'+id+'"]'):null;
                    if(lab){ try{ lab.click(); }catch(e){} }
                    if(!inp.checked){
                      var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'checked').set;
                      set.call(inp,true);
                      inp.dispatchEvent(new Event('click',{bubbles:true}));
                      inp.dispatchEvent(new Event('input',{bubbles:true}));
                      inp.dispatchEvent(new Event('change',{bubbles:true}));
                    }
                """, el)
            except Exception:
                pass
            try:
                if el.is_selected():
                    return True
            except Exception:
                pass
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
        # 提速:开了 fast_mode 只在【失败标签】截图(成功路径省每号最多 8 张同步截图的 I/O);文字诊断始终保留。
        if (not fast_mode()) or any(k in tag for k in ("fail", "noform", "unconfirmed")):
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
            if fast_mode():
                # 提速:解出后轮询离场,一进 exit_url 立即返回(典型 <1s);仍停留才点一次 Continue 再轮询(慢时兜到 ~5.6s)
                for _ in range(8):
                    if any(s in page.url() for s in exit_url_substrs):
                        return True
                    time.sleep(0.4)
                page.click_text(["Continue"], 3)
                for _ in range(6):
                    if any(s in page.url() for s in exit_url_substrs):
                        return True
                    time.sleep(0.4)
                return True
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


def _maybe_auto_block_domain(email):
    """可选·默认关:某 @域 逐邮箱坏号数 ≥ MAILBOX_DOMAIN_BAD_MAX(默认5)且 MAILBOX_DOMAIN_AUTO_BLOCK=on → 整域拉黑。
       默认关=不自动整域(防一个域里有好号被连坐);默认只在 web 给「建议+一键」。"""
    try:
        if str(os.environ.get("MAILBOX_DOMAIN_AUTO_BLOCK", "off")).strip().lower() not in ("1", "on", "true", "yes"):
            return
        if "@" not in (email or ""):
            return
        dom = "@" + email.split("@", 1)[1]
        thresh = max(2, int(os.environ.get("MAILBOX_DOMAIN_BAD_MAX", "5") or 5))
        n = common.count_bad_in_domain(dom)
        if n >= thresh:
            common.mark_bad_mailbox(dom, "domain-auto:%dx(整域坏号达阈值)" % n)
            log("[验证] 域 %s 已有 %d 个坏号 ≥ %d → 整域自动拉黑" % (dom, n, thresh))
    except Exception:
        pass


def _verify_email_link(page, email, mailbox_pw, cfg, op_password="", since_ts=0):
    """注册邮箱验证 = Clerk 魔法链接（非验证码）：读链接 → 同浏览器打开 → 回 keys 确认。
    收不到链接时点页面上的 'Resend' 让 OpenRouter 重发再轮询(最多3轮),应对首封邮件丢失/晚到。
    op_password:改过密的号(登录失败回退重注册时)邮箱真实密码已是统一密码 → 旧密码读不到链接就用统一密码读。
    since_ts:本次注册提交时刻(毫秒)→ 透传给 wait_verify_link 过滤掉上一轮残留的旧验证链接。"""
    log("[验证] 到验证页，读邮箱 %s 的 Clerk 注册验证链接…" % email)
    link = None
    # 【可前端调:高级参数页 邮箱验证组】默认 3轮×12次×3s(+Resend)≈196s。收信慢/想快失败时把这几个调小;
    #   不设=用内置默认(逐字节同原行为)。MAIL_VERIFY_CYCLES=1 即只读不重发。
    _v_cycles = max(1, int(os.environ.get("MAIL_VERIFY_CYCLES", "3") or 3))         # 重发轮数(1 次初始 + 其余重发)
    _v_attempts = max(1, int(os.environ.get("MAIL_VERIFY_ATTEMPTS", "12") or 12))   # 每轮读链接轮询次数
    _v_interval = float(os.environ.get("MAIL_VERIFY_INTERVAL", "3") or 3)           # 每次轮询间隔(秒)
    # ★【软坏邮箱·治"重发空转"】信箱能登录(200)但永远收不到 OpenRouter 验证邮件的号 → 现状永不拉黑、每批烧~180s。
    #   跨批累计 MAILBOX_SOFT_BAD_MAX(默认3)次仍收不到 → 自动登记坏邮箱永久跳过;且【重复犯快速失败】:
    #   上批已记过(prior≥1)的号这批只试 1 轮(≈60s),不再耗满 3 轮。MAILBOX_SOFT_BAD=off 整体关回老行为。
    _soft_bad_on = str(os.environ.get("MAILBOX_SOFT_BAD", "on")).strip().lower() not in ("0", "off", "false", "no")
    _soft_bad_max = max(1, int(os.environ.get("MAILBOX_SOFT_BAD_MAX", "3") or 3))
    if _soft_bad_on:
        try:
            _soft_prior = int((common.load_verify_fails().get(email) or {}).get("count", 0))
        except Exception:
            _soft_prior = 0
        if _soft_prior >= 1:
            _v_cycles = 1   # 重复犯:不再耗满 3 轮重发,这批 1 轮没读到就放弃(省~120s)
            log("[验证] %s 上批已记「收不到信」%d 次 → 本批快速失败(只试 1 轮)" % (email, _soft_prior))
    _mailbox_ok = False; _bad_mail_seen = False; _bad_reason = ""   # 坏邮箱判据:跨轮累计(任一轮读到信=邮箱可用;多次404=邮箱不存在/连续401=密码错→坏)
    # 【开关·可前端调:邮箱验证组】总死线(墙钟秒):>0 时整段验证超时即快速放弃,砍掉「收不到信」的 200-517s 长尾、
    #   释放并发槽给别的号。默认 0=关=逐字节同原行为(不影响老流程)。
    _v_deadline = float(os.environ.get("MAIL_VERIFY_DEADLINE", "0") or 0)
    _v_t0 = time.time()
    for _cycle in range(_v_cycles):                  # 1 次初始 + (cycles-1) 次重发
        if _v_deadline > 0 and (time.time() - _v_t0) > _v_deadline:
            log("[验证] 超总死线 %ss(开关 MAIL_VERIFY_DEADLINE)→ 快速放弃" % _v_deadline)
            break
        _mst = {}
        link = firstmail.wait_verify_link(email, mailbox_pw, cfg.get("mail_key"), cfg.get("mail_base"),
                                          attempts=_v_attempts, interval=_v_interval, alt_password=op_password, status=_mst, since_ts=since_ts)
        if _mst.get("bad_mailbox") is False:
            _mailbox_ok = True
        elif _mst.get("bad_mailbox"):
            _bad_mail_seen = True
            _bad_reason = _mst.get("bad_reason") or _bad_reason
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
        # 坏邮箱判定:轮询【过程中】确认多次 404(邮箱不存在/不可访问)且全程读不到任何信 → 登记永久跳过。
        # 不再靠"事后补一次请求恰好复现 404"(住宅代理抖动那一次易 timeout/连不上→漏登记→重复浪费整轮注册)。
        if _bad_mail_seen and not _mailbox_ok:
            common.mark_bad_mailbox(email, _bad_reason or "mailbox-404(收不到验证邮件)")
            log("[验证] 该邮箱坏(%s)→ 登记坏邮箱,后续永久跳过" % (_bad_reason or "多次404收不到"))
        elif _soft_bad_on and _mailbox_ok:
            # ★软坏:信箱可达(200)但这批仍没收到验证信 → 跨批累加计数;达阈值升级成坏邮箱永久跳过(治"重发空转")。
            _n = common.mark_verify_fail(email, "no-verify-mail")
            if _n >= _soft_bad_max:
                common.mark_bad_mailbox(email, "no-verify-mail:%dx(可达但收不到验证信)" % _n)
                log("[验证] %s 连续 %d 批可达但收不到验证信 → 升级坏邮箱,后续永久跳过" % (email, _n))
                _maybe_auto_block_domain(email)
            else:
                log("[验证] %s 可达但收不到验证信(第 %d/%d 批)→ 记一次,达 %d 批自动拉黑" % (email, _n, _soft_bad_max, _soft_bad_max))
        return False
    log("[验证] 打开验证链接(同浏览器,使邮箱验证生效)…")
    if _soft_bad_on:
        common.clear_verify_fail(email)   # 收到信=信箱其实能用 → 清掉累计,防误升级成坏邮箱
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
    # 【时序竞态 + 跨平台 + 观感修复】先把【四个字段】填好并【回读确认粘住】,字段没粘住绝不勾选/提交;
    #   字段确认后【再】勾"同意条款"。根治:① Clerk hydrate 重渲染清值的竞态;② 用户在 Mac 看到的
    #   "字段空着却先勾上了复选框"(原来 _check 与填字段在同一轮 _fill_form,字段填失败/被清时复选框却已勾)。
    # ★【已回滚 native-setter 实验】:native value setter 虽消了 FORM_NOT_FILLED,但 Clerk 拿不到真实交互 →
    #   下游"同意条款"复选框步骤 74% 失败(LEGAL_NOT_CHECKED,实测 06:10 批 14/19)。退回【经验证的 send_keys 路】
    #   (FORM_NOT_FILLED ~10% 但可续跑,远好于 74% 死);FORM_NOT_FILLED 待真机验证过的更稳填法再治,绝不再上未验证改动。
    def _fill_fields():
        _set_value(page, "#firstName-field", (local[:6] or "John").capitalize())
        _set_value(page, "#lastName-field", "M")
        _set_value(page, "#emailAddress-field", email)
        _set_value(page, "#password-field", op_password)

    def _fill_native():
        # ★native value setter + dispatch input/change(React 受控正确填法,值能扛住 hydrate 清值粘住)。【只补设值,不 focus/不 blur】
        #   —— 上次纯 native 74% LEGAL 失败的两大嫌疑(无真实交互 + blur 触发重渲染)都避开:此函数【只在 send_keys 已失败的轮次补打】,
        #   send_keys 已给过真实键盘交互→Clerk 表单状态/legal 正常,native 仅让值粘住。正常号第1轮 send_keys 就 stuck、根本到不了这。
        try:
            page.d.execute_script(
                "var a=arguments;"
                "function _pf(el){return (el.tagName||'')==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;}"
                "function _sv(s,v){var el=document.querySelector(s);if(!el)return;"
                "var p=Object.getOwnPropertyDescriptor(_pf(el),'value');if(p&&p.set){p.set.call(el,v);}else{try{el.value=v;}catch(e){}}"
                "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}"
                "_sv('#firstName-field',a[0]);_sv('#lastName-field',a[1]);_sv('#emailAddress-field',a[2]);_sv('#password-field',a[3]);",
                (local[:6] or "John").capitalize(), "M", email, op_password)
        except Exception:
            pass

    def _fields_stuck():
        d = page.js("return {em:((document.querySelector('#emailAddress-field')||{}).value||''),"
                    "pw:(((document.querySelector('#password-field')||{}).value||'').length)};") or {}
        return bool(d.get("em")) and (d.get("pw") or 0) >= 8

    def _legal_on():
        return bool(page.js("return !!((document.querySelector('#legalAccepted-field')||{}).checked);"))

    # ① 填四个字段 → 回读确认粘住(【时间预算内】多轮重填;字段没粘住快速失败,绝不空提交)。
    #   ★根因(高并发 FORM_NOT_FILLED):AdsPower 同时多开(如并发20)→ Clerk hydrate/重渲染慢,原【固定3轮≈5s】
    #     预算跑不赢"刚填就被清值"→ 字段始终没粘住 → FORM_NOT_FILLED(实测 13/16 注册成功、仅慢 hydrate 的 3 个中招)。
    #   改时间预算(默认15s,REGISTER_FILL_BUDGET 可调):快页面第1轮就 stuck 立即 break(不拖慢成功路径);
    #     慢 hydrate 给足重填机会到预算用尽才放弃。hydrate 一旦渲染完成值就粘住、立即 break,不会多等。
    stuck = False
    # 默认 20s(原15s):实测大批/高并发下 Clerk hydrate 更慢,15s 预算对少数号仍跑不赢清值(24号批 3 个 FORM_NOT_FILLED)。
    #   20s 给慢 hydrate 更多机会;成功路径 stuck 即 break 不受影响。仍可 REGISTER_FILL_BUDGET 调大 / 或下调并发兜底。
    _fill_budget = time.time() + float(os.environ.get("REGISTER_FILL_BUDGET", "20") or 20)
    _fa = 0
    while time.time() < _fill_budget:
        _fa += 1
        _fill_fields()
        time.sleep(0.8)   # 留窗口给 React:要清值就在这 0.8s 内清掉,之后回读才反映真实状态
        if _fields_stuck():
            stuck = True
            break
        # ★send_keys 这轮没粘住(hydrate 清值)→ 第2轮起【补一遍 native value setter】让值粘住(React 受控,抗清)。
        #   加法式兜底:只对 send_keys 已失败的号生效(send_keys 已给真实交互→legal 正常);正常号第1轮就 stuck、到不了这。
        if _fa >= 2:
            _fill_native()
            time.sleep(0.8)
            if _fields_stuck():
                stuck = True
                log("[注册] native value setter 兜底后字段粘住 ✓(send_keys 输给了 hydrate 清值)")
                break
        log("[注册] 字段没粘住(第%d次,表单疑似刚 hydrate 重渲染)→ 整体重填(含 native 兜底)" % _fa)
        time.sleep(1.0)
    if not stuck:
        log("[注册] 填表预算(%ss)内字段(email/password)仍没粘住 → 快速失败,不空提交(省 2captcha + 不卡死)"
            % os.environ.get("REGISTER_FILL_BUDGET", "20"))
        _diag(page, "fill_stuck_fail")
        return "fail:FORM_NOT_FILLED"
    # ② 字段粘住后【才】勾"同意条款"并回读确认(没勾上再点,最多3次)
    for _lc in range(3):
        if _legal_on():
            break
        _check(page, "#legalAccepted-field")
        time.sleep(0.4)
    if not _legal_on():
        log("[注册] 同意条款没勾上(回读确认失败)→ 快速失败,不空提交")
        _diag(page, "legal_fail")
        return "fail:LEGAL_NOT_CHECKED"
    log("[注册] 填表完成(顺序:先填字段回读确认 → 再勾同意条款回读确认)")
    _diag(page, "filled")
    since = time.time() * 1000
    # 提交 + 解 Turnstile + 等到验证页;若提交后仍停在 /sign-up(Turnstile widget 在但没提交成功),
    # 再点一次 Sign Up 并必要时重解 Turnstile,最多重试 2 次(共 3 次提交)再判 UNCONFIRMED。
    for _submit in range(3):
        # ★防「页面弹页面」(page-over-page)兜底:检测到【重复 sign-up 表单 / Clerk 模态里也有 sign-up 字段】
        #   (底层页 + 模态各一套表单叠加)→ 刷新 /sign-up 塌回【单一表单】再填,绝不在叠加表单上填错层/提交空模态。
        #   ★只在【真检测到】才刷(不白刷、不无谓重触 Turnstile);单一表单(正常)时此分支不可达。配合"绝不点导航Sign Up"双保险。
        try:
            # ★只认【真重复表单】(同 id 出现>1=确凿的 page-over-page/两套表单叠加)。不再用 [role=dialog]/[aria-modal] 判——
            #   Clerk 内联 sign-up 也可能被包在 dialog 角色里→那会误命中→每次重试都刷新→重置 Turnstile=白烧一次 2captcha 解。
            _dup = page.js("try{return document.querySelectorAll('#emailAddress-field').length>1;}catch(e){return false;}")
        except Exception:
            _dup = False
        if _dup:
            log("[注册] 检测到页面弹页面(重复 sign-up 表单/模态内表单)→ 刷新 /sign-up 塌回单一表单再填")
            page.goto(SIGNUP_URL, wait=2.5)
            page.wait_field_present(["#emailAddress-field"], 15, "注册表单(刷新塌模态后)")
        # ★防空表单提交(用户实测「Please fill out this field」频发根因):readback 通过后 Clerk hydrate 可能在【提交前】
        #   又把值清掉 → 点 Continue 提交空表单 → 触发浏览器 required 校验、空耗重试。每次提交前【重验字段还粘着,
        #   没粘住就重填 + 重勾同意条款再提交】,绝不在空表单上点提交。★纯增量:仅在字段被清时动作(填着=no-op),
        #   不改默认填法、不碰正常号、不影响 Windows 默认成功路径(填着的号此分支不可达)。
        if not _fields_stuck():
            log("[注册] 提交前发现字段被 hydrate 清空 → 重填 + 重勾同意条款再提交(防空表单 required 报错)")
            _fill_fields()
            time.sleep(0.8)
            for _lc2 in range(3):
                if _legal_on():
                    break
                _check(page, "#legalAccepted-field")
                time.sleep(0.4)
        if _submit == 0:
            page.click_text(["Continue"], 8)
            time.sleep(2)
            _diag(page, "after_continue")
            _solve_turnstile_if_present(page, SIGNUP_URL, cfg, ["/verify-email"])
            _diag(page, "after_turnstile")
        else:
            log("[注册] 提交后仍停在 /sign-up(没进 /verify-email)→ 第 %d 次重试提交 + 重解 Turnstile" % _submit)
            page.click_text(["Continue"], 8)   # ★只点表单提交「Continue」;绝不点导航栏「Sign Up」(那是 Clerk SignUpButton→弹出模态盖在原页上=页面弹页面,两套表单叠加→填底层/模态空→"Please fill out this field")
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
        if not _verify_email_link(page, email, mailbox_pw, cfg, op_password=op_password, since_ts=since):
            _diag(page, "verify_fail")
            return "fail:VERIFY_LINK"
    # 确认登录。★验证链接已成功打开(否则上面已 VERIFY_LINK 返回),但 Clerk 会话有时要几秒 + 一次导航才落地
    #   (高并发下尤甚)→ 一次 detect_session 没查到就判 REGISTER_UNCONFIRMED 是误杀。多试几次(goto 刷新让 Clerk 重读会话)。
    # ★对抗核验补:必须校验 em==目标email,绝不"查到任意登录会话就判 ok"——否则环境残留【别号会话】会被误判成功,
    #   pipeline 据此推进给【错号】取key/加卡(与 register_or_login:404 口径对齐)。当前每号全新 env 暂不触发,补此防御纵深。
    def _is_target(_e):
        return bool(_e) and str(_e).lower() == email.lower()
    em = detect_session(page)
    for _rc in range(2):
        if _is_target(em):
            break
        log("[注册] 验证已开但目标会话未落地(em=%s,第%d次)→ 刷新 keys 重查(给 Clerk 会话时间)" % (em, _rc + 1))
        time.sleep(2)
        page.goto(KEYS_URL, wait=2)
        em = detect_session(page)
    if _is_target(em):
        log("[注册] 成功，已登录 %s" % em)
        return "ok"
    # ★实测 _reg_unconfirmed.png:验证链接已开(到这=已开,否则上面 VERIFY_LINK 返回),但浏览器落到【登出/Sign in 页】
    #   ——账号其实已注册+已验证,只差没保持登录(Clerk 会话没落地)。前面已 3 次 detect_session 确认非登录态,
    #   直接用 email+op_password【登一次】把号救回(号已存在,不重注册、不重验证)。登录失败再判 UNCONFIRMED(不比现在差);
    #   NOT_ALLOWED 透传给编排登记永久跳过。仅对本会到 UNCONFIRMED 的号生效,不碰成功快路径。
    _lr = None
    try:
        _lr = login(page, email, op_password, mailbox_pw, cfg)
    except Exception as _le:
        log("[注册] 验证后直登异常(忽略,判 UNCONFIRMED): %s" % str(_le)[:80])
    if _lr == "ok":
        log("[注册] 验证后会话登出 → 用凭证直登成功,救回 %s" % email)
        return "ok"
    if _lr and "NOT_ALLOWED" in _lr:
        return _lr
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
    if fast_mode():
        page.wait_field_present(["#password-field"], 8, "登录密码框")   # 提速:密码框一出现就继续(慢网才等满)
    else:
        time.sleep(2)
    _set_value(page, "#password-field", op_password)
    page.click_text(["Continue"], 6)
    time.sleep(1.2 if fast_mode() else 2.5)
    t = (page.all_frames_text() or "").lower()
    if "not allowed to access" in t or "is not allowed" in t:
        # OpenRouter 直接封禁/拒绝该邮箱 → 上报 NOT_ALLOWED,编排层会登记并永久跳过
        log("[登录] %s 被 OpenRouter 拒绝(not allowed to access this application)" % email)
        return "fail:NOT_ALLOWED"
    if any(s in t for s in ["couldn't find", "no account", "not found", "isn't right", "incorrect", "password is incorrect", "invalid credentials"]):
        # 密码不对/无账号 → 【就地返回】,不再白解 Turnstile + 等 OTP(那是纯浪费 2captcha 余额 + 干耗墙钟,
        #   账号根本进不去)。模糊文案("isn't right")保守归为密码错(不致永久跳过);明确"找不到账号"归 NO_ACCOUNT。
        if "incorrect" in t or "isn't right" in t:
            log("[登录] %s 密码不正确 → 就地返回" % email)
            return "fail:SIGNIN_BAD_PASSWORD"
        log("[登录] %s 账号不存在(couldn't find/no account)→ 就地返回" % email)
        return "fail:SIGNIN_NO_ACCOUNT"
    since = time.time() * 1000
    _solve_turnstile_if_present(page, SIGNIN_URL, cfg, ["/factor-two", "/verify", "/settings"])
    u = page.url()
    if "/factor-two" in u or "/verify" in u:
        # 传 op_password 作备用密码:改过密的号邮箱真实密码=统一密码,旧 mailbox_pw 读不到 OTP(fail:OTP 根因)。
        if not _enter_otp(page, email, mailbox_pw, cfg, since, op_password=op_password):
            return "fail:OTP"
    # 确认(同 register:校验登录的就是目标号,防残留别号会话误判 ok → 给错号取key/加卡)
    em = detect_session(page)
    if em and str(em).lower() == email.lower():
        log("[登录] 成功，已登录 %s" % em)
        return "ok"
    if em:
        log("[登录] 会话邮箱(%s)≠目标(%s)→ 不算成功" % (em, email))
    return "fail:SIGNIN_UNCONFIRMED"


def register_or_login(page, email, op_password, mailbox_pw, cfg, registered=False):
    """先看是否已登录(干净环境不会)；【已知注册过(registered=True)→优先直接登录;登录成功即返回,
    登录失败才回退试注册(标记可能有误/密码不符;register 撞 exists 会自动转登录,不会卡死)】;否则正常注册,撞 exists 转登录。
    返回 'ok' / 'fail:<reason>'。registered 来自历史标记(state/results.jsonl 该号有过 auth=ok)——
    主要解决"已注册号重跑【上来就】点注册→账号已存在→卡 verify→REGISTER_UNCONFIRMED";登录失败的回退注册是
    对【误标 registered】的兜底(真号会在 register 处得到 exists→转登录),不是无脑重注册。"""
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
