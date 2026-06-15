#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Fix C 原生CDP绑卡【可复用核】—— 从 fixc_bind.py 抽出,供 fixc_bind / fixc_parallel / steps_billing.bind_card_fixc 共用。
# 只依赖 cdp_raw / selenium / common,【不 import steps_billing】(避免循环依赖)。
# 关键:cdp_fill_and_save 会读坐标→杀掉传入 driver 的 chromedriver(脱离)→原生CDP Input 可信注入填卡+取消Link+点Save。
import time, json, os, re
from common import NUM, EXP, CVC, ZIP, fast_mode
from services.cdp_raw import RawCDP
from selenium.webdriver.common.by import By


def _vc(driver, el):
    return driver.execute_script(
        "var b=arguments[0].getBoundingClientRect();return [b.left+b.width/2,b.top+b.height/2];", el)


def _coords_of(driver, sels):
    """卡字段在单层跨域 iframe → 返回【主页面视口坐标】(iframe偏移 + 字段内部位置)。"""
    driver.switch_to.default_content()
    for s in sels:
        for el in driver.find_elements(By.CSS_SELECTOR, s):
            if el.is_displayed():
                return _vc(driver, el)
    for ifr in driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            ir = driver.execute_script("var b=arguments[0].getBoundingClientRect();return [b.left,b.top];", ifr)
            driver.switch_to.frame(ifr)
            for s in sels:
                for el in driver.find_elements(By.CSS_SELECTOR, s):
                    if el.is_displayed():
                        c = _vc(driver, el)
                        driver.switch_to.default_content()
                        return [ir[0] + c[0], ir[1] + c[1]]
            driver.switch_to.default_content()
        except Exception:
            driver.switch_to.default_content()
    return None


class _DeadDriverUAShim(object):
    """cdp_fill_and_save 一开头就 kill 了 chromedriver(脱离躲检测)→ 真 driver 已死,
       它的 Selenium 调用(execute_script/switch_to/find_elements)会失效/抛异常。
       但 captcha.solve_hcaptcha 唯一【真正需要活 driver】的是抓 navigator.userAgent。
       这个壳:① execute_script 抓 UA 返回【CDP 取到的真 UA】(token 才带对的 UA);
               ② 其它一切 Selenium 调用(switch_to.*/find_elements/任意属性)安全失败,
                  逼 solve_hcaptcha 全程走 patcher(CDP 跨 OOPIF)读 sitekey/rqdata+注 token。
       captcha.py 里每个 Selenium 调用都裹了 try/except → 本壳抛异常会被吞掉,不破坏其 CDP 路径。"""
    is_dead_shell = True   # captcha.solve_hcaptcha 据此跳过失明的 has_hcaptcha(壳恒 False),不假报"挑战消失→通过"

    def __init__(self, ua=""):
        self._ua = ua or ""

    def execute_script(self, script, *args):
        if isinstance(script, str) and "navigator.userAgent" in script:
            return self._ua
        raise RuntimeError("driver 已脱离(chromedriver 被 kill),Selenium 调用不可用")

    def find_elements(self, *a, **k):
        return []

    def find_element(self, *a, **k):
        raise RuntimeError("driver 已脱离(chromedriver 被 kill),Selenium 调用不可用")

    @property
    def switch_to(self):
        return self

    def __getattr__(self, name):
        # switch_to.default_content()/parent_frame()/frame() 等任意调用都安全 no-op
        def _noop(*a, **k):
            return None
        return _noop


def _cdp_user_agent(cdp):
    """脱离 chromedriver 后用活着的【原生 CDP】抓 navigator.userAgent(driver 已死,不能再用它抓)。"""
    try:
        return cdp.evaluate("navigator.userAgent") or ""
    except Exception:
        return ""


# 主文档里找 Link 复选框中心视口坐标(在 Stripe iframe 里则返回 null,走 iframe 路)
LINK_JS = r"""
(function(){
  var cbs=document.querySelectorAll('input[type=checkbox]');
  for(var i=0;i<cbs.length;i++){var b=cbs[i].getBoundingClientRect();
    if(b.width>0&&b.height>0&&b.top>0) return JSON.stringify([b.left+b.width/2,b.top+b.height/2]);}
  var all=document.querySelectorAll('label,span,div,p');
  for(var j=0;j<all.length;j++){var t=(all[j].textContent||'');
    if(t.indexOf('Pay faster')>=0 && t.length<80){var r=all[j].getBoundingClientRect();
      if(r.width>0) return JSON.stringify([r.left-12, r.top+r.height/2]);}}
  return null;
})()
"""

# 主文档里找 Save 按钮中心视口坐标(先 scrollIntoView,取实时坐标 → 不会点偏)
SAVE_JS = r"""
(function(){
  var btns=document.querySelectorAll('button');
  for(var i=0;i<btns.length;i++){var b=btns[i];var t=(b.textContent||'').toLowerCase();
    if(t.indexOf('save')>=0){ b.scrollIntoView({block:'center'});
      var x=b.getBoundingClientRect();
      if(x.width>0) return JSON.stringify([x.left+x.width/2, x.top+x.height/2]); }}
  return null;
})()
"""

# Save 后探测是否弹了验证框(hCaptcha/Turnstile)
CAPTCHA_JS = r"""(function(){var f=document.querySelectorAll('iframe');
  for(var i=0;i<f.length;i++){var s=(f[i].src||'').toLowerCase();
    if(s.indexOf('hcaptcha')>=0||s.indexOf('captcha')>=0||s.indexOf('turnstile')>=0)return true;}
  var t=(document.body.innerText||'').toLowerCase();
  return /i am human|are human|hcaptcha|select all|verify you/.test(t);})()"""


def _uncheck_link_cdp(cdp):
    """取消「Pay faster next time with Link」勾选(在 Stripe iframe 里)。
       优先【按元素会话派发点击】(分辨率/窗口无关);失败再退回旧的主文档/iframe偏移法。"""
    try:                                            # tries=2/gap=0.4:Link没勾时最多 ~0.8s 就返回,别用默认 tries=10×1.2s 拖死点Save
        sid = _click_in_frame(cdp, "stripe", 'input[type=checkbox]:checked', tries=2, gap=0.4)
        if sid:
            return "session派发取消勾选"
    except Exception:
        pass
    try:
        lk = cdp.evaluate(LINK_JS)
        if lk:
            xy = json.loads(lk); cdp.mouse_click(xy[0], xy[1]); time.sleep(1.0)
            return "main %s" % xy
    except Exception:
        pass
    try:
        ifs = json.loads(cdp.evaluate(r"""(function(){var o=[];var a=document.querySelectorAll('iframe');
          for(var i=0;i<a.length;i++){var b=a[i].getBoundingClientRect();o.push([a[i].src||'',b.left,b.top]);}
          return JSON.stringify(o);})()""") or "[]")
    except Exception:
        ifs = []

    def offset_for(url):
        for src, l, t in ifs:
            if src and (src == url or (len(src) > 30 and url.startswith(src[:30]))):
                return l, t
        for src, l, t in ifs:                       # 退而求其次:第一个 stripe iframe
            if "stripe" in (src or "").lower():
                return l, t
        return None

    for tg in cdp.get_targets():
        if tg.get("type") == "iframe" and "stripe" in (tg.get("url") or "").lower():
            try:
                sid = cdp.attach_target(tg["targetId"])
                rect = cdp.evaluate(r"""(function(){var c=document.querySelectorAll('input[type=checkbox]');
                  for(var i=0;i<c.length;i++){if(c[i].checked){var b=c[i].getBoundingClientRect();
                    return JSON.stringify([b.left+b.width/2,b.top+b.height/2]);}} return null;})()""",
                                   session_id=sid)
                if rect:
                    r = json.loads(rect); off = offset_for(tg.get("url") or "")
                    if off:
                        cx, cy = off[0] + r[0], off[1] + r[1]
                        cdp.mouse_click(cx, cy); time.sleep(1.0)
                        return "iframe @ (%.0f,%.0f)" % (cx, cy)
            except Exception:
                pass
    return None


# hcaptcha iframe 里【是不是图片九宫格挑战】(被动点不掉、只能 2captcha/换卡)——出现就别再傻等 checkbox
_IMG_CHALLENGE_JS = r"""(function(){
  var t=document.body.innerText||'';
  if(/select all|please click|click each|pick the|choose all|images? (with|containing|of)/i.test(t)) return 1;
  if(document.querySelector('.task-grid,.challenge-view,.task-image,.image-grid,canvas.image')) return 1;
  return 0;})()"""


def click_i_am_human(cdp, log=print, tries=int(os.environ.get("FIXC_IAMHUMAN_TRIES", "30")), gap=0.8):
    """弹 hCaptcha → 进 hcaptcha 的 checkbox iframe,【经该 iframe 的 CDP 会话派发 Input 点击】点「I am human」。
       关键(实测验证):getContentQuads 给的是【frame本地坐标】(如31,38),不是主视口——所以不能在主会话点,
       要把点击事件经【该 iframe 的会话】派发,CDP 自动路由到该 frame。这样:① 不用算多层嵌套偏移
       ② 跟窗口大小/位置/并发数全无关(frame本地坐标恒定)。带重试等 OOPIF 目标加载出来(它比框文案晚 1-3 秒)。
       返回:"I-am-human @..."=点到复选框;"image-challenge"=出现图片九宫格(被动点不掉→交 2captcha/换卡,别空转);
             None=预算内没找到框(慢/坏代理上 checkbox 一直没渲染)。"""
    last_urls = []
    for attempt in range(tries):
        hc = [t for t in cdp.get_targets()
              if t.get("type") == "iframe" and "hcaptcha" in (t.get("url") or "").lower()]
        last_urls = [(t.get("url") or "")[:42] for t in hc]
        for tg in hc:
            try:
                sid = cdp.attach_target(tg["targetId"])
                # ① 先看是不是图片挑战 → 是就立刻 bail(不再等满预算,修"图片认证时瞪很久")
                try:
                    if cdp.evaluate(_IMG_CHALLENGE_JS, session_id=sid):
                        log("   检测到图片九宫格挑战(被动点不掉)→ 第%d次,立即转 2captcha/换卡" % (attempt + 1))
                        return "image-challenge"
                except Exception:
                    pass
                # ② 否则点 checkbox/anchor(干净会话多半被动直接过)
                c = cdp.node_center("#checkbox, #anchor, [role=checkbox]", session_id=sid)
                if c:
                    cdp.session_click(sid, c[0], c[1])
                    return "I-am-human @ frame本地(%.0f,%.0f) 会话派发(第%d次)" % (c[0], c[1], attempt + 1)
            except Exception:
                pass
        time.sleep(gap)
    log("   (诊断)点框失败:当前 hcaptcha iframe targets=%s" % (last_urls or "无"))
    return None


def port_from_driver(driver):
    """从 Selenium driver 的 debuggerAddress 取调试端口(attach_chrome 接管用的就是它)。"""
    try:
        da = (driver.capabilities.get("goog:chromeOptions", {}) or {}).get("debuggerAddress", "")
        if da and ":" in da:
            return int(da.rsplit(":", 1)[1])
    except Exception:
        pass
    return None


def _click_in_frame(cdp, url_match, selector, tries=10, gap=1.2):
    """在 url 含 url_match 的 iframe 里找 selector 元素,【经该 iframe 会话派发点击】(frame本地坐标,
       跟分辨率/窗口大小/位置/滚动全无关)。带重试等元素渲染。返回点中的 sessionId 或 None。"""
    for _ in range(tries):
        for tg in cdp.get_targets():
            u = (tg.get("url") or "").lower()
            if tg.get("type") == "iframe" and url_match in u:
                try:
                    sid = cdp.attach_target(tg["targetId"])
                    c = cdp.node_center(selector, session_id=sid)
                    if c:
                        cdp.session_click(sid, c[0], c[1])
                        return sid
                except Exception:
                    pass
        time.sleep(gap)
    return None


def _dismiss_link_dialog(cdp, log=print):
    """关掉 Stripe Link 的 "Save card? / Pay faster" 弹窗(点 No thanks/Not now/Skip)——
       它盖住表单、抢走焦点 → 后续有效期/CVC/ZIP 串位或填不进。无弹窗则空操作。"""
    try:
        for tg in cdp.get_targets():
            u = (tg.get("url") or "").lower()
            if tg.get("type") == "iframe" and "stripe" in u:
                sid = cdp.attach_target(tg["targetId"])
                hit = cdp.evaluate(r"""(function(){
                  var bs=document.querySelectorAll('button,[role=button],a');
                  for(var i=0;i<bs.length;i++){var t=(bs[i].textContent||'').trim().toLowerCase();
                    if(/^(no thanks|not now|skip|maybe later|continue without|close)$/.test(t)){bs[i].click();return t;}}
                  return '';})()""", session_id=sid)
                if hit:
                    log("  关 Link 弹窗: %s" % hit)
                    return hit
    except Exception:
        pass
    return None


def _savecard_present_and_dismiss(cdp, log=print):
    """★一劳永逸根治「Save card? 弹窗逗留」:专门检测 Stripe Link 的【存卡弹窗】(文案含 'save your card'/'Save card?')。
       它【只在 Stripe 已收卡成功后才弹】(declined 不弹;图片验证更早一环就早返回,根本到不了这)→ 检测到=绑成强信号。
       顺手点 No thanks/Skip 关掉它(绝不点 Save——点 Save 要手机号 Error 400);找不到关闭按钮也返回 True
       (检测到即判绑成,残留弹窗交环境回收时关,不影响绑卡结果)。返回 True=确是存卡弹窗(绑成)。
       与 _dismiss_link_dialog 区别:那个泛关任意 Link 屏(填卡期用);这个【只认存卡弹窗】并作为绑成判据,绝不误判别的 pending 态。"""
    try:
        for tg in cdp.get_targets():
            if tg.get("type") != "iframe":
                continue
            u = (tg.get("url") or "").lower()
            if "stripe" not in u and "link" not in u:          # Link 存卡弹窗 iframe(stripe/link 域)
                continue
            try:
                sid = cdp.attach_target(tg["targetId"])
                r = cdp.evaluate(r"""(function(){
                  var t=(document.body.innerText||'');
                  /* ★只认存卡弹窗的【专属文案】(与 steps_billing._click_link_save 同口径),不碰填卡期的 "save your information" 勾选项 → 杜绝误判绑成 */
                  if(!/Save card\?|save your card and encrypted/i.test(t)) return 0;
                  var bs=document.querySelectorAll('button,[role=button],a');
                  for(var i=0;i<bs.length;i++){var x=(bs[i].textContent||'').trim().toLowerCase();
                    if(/^(no thanks|not now|skip|maybe later|continue without|close)$/.test(x)){bs[i].click();return 2;}}
                  return 1;})()""", session_id=sid)
                if r:
                    log("  Save card? 存卡弹窗 %s" % ("已关(No thanks)" if r == 2 else "检测到(没找到关闭按钮,不影响绑成判定)"))
                    return True
            except Exception:
                pass
    except Exception:
        pass
    return False


def _disable_link_optin(cdp, log=print):
    """关掉 Stripe Link 的所有勾选(\"Save my information for faster checkout\"/\"Pay faster next time with Link\")。
       勾上会触发 Link 注册、要【手机号】→ Save 报 'Please provide a mobile phone number'(Error 400)而绑不上。
       在所有 stripe iframe 里把【勾上的复选框】会话派发点掉,验证到没有勾选为止(最多3轮)。返回是否全关掉。"""
    CHK_CNT = (r"""(function(){var n=0;"""
               r"""document.querySelectorAll('input[type=checkbox]').forEach(function(c){if(c.checked)n++;});"""
               r"""document.querySelectorAll('[role=checkbox]').forEach(function(c){if(c.getAttribute('aria-checked')==='true')n++;});"""
               r"""return n;})()""")
    for _ in range(3):
        any_checked = False
        for tg in cdp.get_targets():
            u = (tg.get("url") or "").lower()
            if tg.get("type") == "iframe" and "stripe" in u:
                try:
                    sid = cdp.attach_target(tg["targetId"])
                    if cdp.evaluate(CHK_CNT, session_id=sid):
                        any_checked = True
                        c = cdp.node_center("input[type=checkbox]:checked, [role=checkbox][aria-checked='true']",
                                            session_id=sid)
                        if c:
                            cdp.session_click(sid, c[0], c[1]); time.sleep(0.25)
                except Exception:
                    pass
        if not any_checked:
            return True
        time.sleep(0.4)
    return False


def cdp_fill_and_save(driver, num, exp, cvc, zipc, log=print, alt_zips=None,
                      cfg=None, patcher=None, proxy=None, solve_hcap=False, page_url=""):
    """脱离 chromedriver → 全程原生CDP【按元素点击】填卡(进 Stripe iframe 用会话派发点击,跟分辨率/窗口无关,
       不再算坐标)→ 取消Link → 点Save → 处理验证框 → 等弹框自然关闭。返回 {"captcha","port","bound_seen"}。
       注意:返回后传入的 driver 已失效(chromedriver 进程被杀)。"""
    port = port_from_driver(driver)
    if not port:
        raise RuntimeError("拿不到调试端口(debuggerAddress)")
    log("脱离 chromedriver(端口 %s)→ 全程原生CDP【按元素】点击(分辨率/窗口无关)" % port)
    try:
        driver.service.process.kill()
    except Exception:
        pass
    time.sleep(1.2)

    cdp = RawCDP()
    cdp.connect(port, "openrouter")
    try:

        # 逐字段【各自显式聚焦 + 经该字段会话发键 + 回读校验、不全就清空重填】:
        #   · 不靠"卡号打满自动跳有效期"——并发/慢代理/Link弹窗丢一键就少位→后面全串位(实测卡号只进'1')
        #   · 不靠主文档焦点——经该 iframe 会话发键直达该帧聚焦元素,不被 Link弹窗/重渲染抢焦点
        #   · 每字段打完回读值,位数不够就清空重填(最多3次)→ 杜绝"填不全/CVC空/ZIP截成3位"
        def _read_val(sid, selectors):
            try:
                return cdp.evaluate("(function(){var e=document.querySelector(%s);return e?(e.value||''):'';})()"
                                    % json.dumps(", ".join(selectors)), session_id=sid) or ""
            except Exception:
                return ""

        def _digits(s):
            return re.sub(r"\D", "", str(s))

        def _fill_field(selectors, value, label, tries=3):
            want = _digits(value)                              # 期望的纯数字串
            sid = None
            for attempt in range(tries):
                sid = _click_in_frame(cdp, "stripe", ", ".join(selectors), tries=6)
                if not sid:
                    return None, False
                time.sleep(0.15)
                # 打字前【先清到空】——否则上次残留会和新值拼成乱码(实测卡号变 4400... 报 invalid card)
                for _ in range(3):
                    if _digits(_read_val(sid, selectors)) == "":
                        break
                    cdp.clear_field(sid); time.sleep(0.15)
                cdp.type_digits(str(value), session_id=sid)    # 经该字段会话发键(不靠主焦点)
                time.sleep(0.3)
                got = _digits(_read_val(sid, selectors))
                if got == want:                                # 值必须【完全相等】(不只是位数够)→ 防串位/残留拼成乱码
                    return sid, True
                log("  ⚠ %s 值不对(回读'%s' 期望'%s')→ 清空重填(第%d/%d次)" % (label, got, want, attempt + 1, tries))
                cdp.clear_field(sid); time.sleep(0.2)
            return sid, False

        csid, ok_num = _fill_field(NUM, num, "卡号")
        if not csid:
            cdp.close(); raise RuntimeError("没找到卡号框(Stripe iframe 未渲染出输入框)")
        _dismiss_link_dialog(cdp, log)                        # 关 Link "Save card?" 弹窗(盖表单/抢焦点→后续串位)
        _fill_field(EXP, exp, "有效期")
        _fill_field(CVC, cvc, "CVC")
        _dismiss_link_dialog(cdp, log)
        _fill_field(ZIP, zipc, "ZIP")
        nv = re.sub(r"\D", "", _read_val(csid, NUM))          # 最终再回读卡号,确认没被后续操作冲掉
        log("✓ 逐字段聚焦填卡完(卡号回读 %d 位,会话发键+校验重填,分辨率/窗口无关)%s"
            % (len(nv), "" if ok_num and len(nv) >= len(re.sub(r'\D','',str(num))) else " ⚠卡号疑似没填全"))
        # ① 先等表单稳定(Save 按钮渲染出来)——【先查后睡】,查到就走,别盲等;高并发渲染慢→最多 ~16s
        sv = None
        _save_tries, _save_iv = (46, 0.35) if fast_mode() else (20, 0.8)   # 提速:同 ~16s 死线,只缩轮询间隔(查到即走);默认关=20×0.8 逐字节不变
        for _ in range(_save_tries):
            try:
                sv = cdp.evaluate(SAVE_JS)
            except Exception:
                sv = None
            if sv:
                break
            time.sleep(_save_iv)
        if not sv:
            cdp.close()
            raise RuntimeError("没取到Save坐标(表单未渲染出Save按钮,疑窗口太小/高并发渲染慢)")
        # ② 表单稳了 → 关 Link 弹窗 + 关掉【所有 Link 勾选】并验证(勾上会要手机号→Save 报 400 绑不上)
        _dismiss_link_dialog(cdp, log)
        try:
            linkoff = _disable_link_optin(cdp, log)
            log("关 Link 勾选: %s" % ("已全关" if linkoff else "可能仍有勾选(重试中)"))
        except Exception as _e:
            log("关 Link 勾选异常(忽略): %s" % str(_e)[:50])
        # ③ 关勾选可能让表单重排 → 重取一次 Save 实时坐标再点(不会点偏)
        try:
            sv2 = cdp.evaluate(SAVE_JS)
            if sv2:
                sv = sv2
        except Exception:
            pass
        # 【#8 修】Save 坐标解包加防护:慢代理/中途异常时 SAVE_JS 可能返回 null/""/单元素 → 原裸解包 json.loads(sv)
        #   抛 JSONDecodeError/ValueError/IndexError 崩整个绑卡。这里安全解析,解不出就跳过点击交下游判未绑。
        sx, sy = None, None
        try:
            _xy = json.loads(sv)
            if isinstance(_xy, (list, tuple)) and len(_xy) >= 2:
                sx, sy = _xy[0], _xy[1]
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        cap = None
        if sx is not None and sy is not None:
            cdp.mouse_click(sx, sy); time.sleep(2.8)
            try:
                cap = bool(cdp.evaluate(CAPTCHA_JS))
            except Exception:
                pass
            log("✓ 点Save @ (%.0f,%.0f);弹验证框=%s" % (sx, sy, cap))
        else:
            log("⚠ Save 坐标解析失败(sv=%s),跳过点击 → 交下游判未绑" % str(sv)[:40])
        # 弹框处理
        image_challenge = False
        _fast_card_bail = False   # 两套分流秒关:图片九宫格 + OPENROUTER_FAST_HANDOFF_CARD → 立即弃(跳过2captcha/换卡/等待),交纯Sel
        if cap:
            if os.environ.get("FIXC_MANUAL_CAPTCHA") == "1":
                # 手动解框模式(验证用):停下等人手动点 I am human / 解图片
                secs = int(os.environ.get("FIXC_MANUAL_WAIT", "90"))
                log("👉👉 弹验证框!请【手动点 I am human / 解图片】,我等 %d 秒..." % secs)
                time.sleep(secs)
                try:
                    cap = bool(cdp.evaluate(CAPTCHA_JS))
                except Exception:
                    pass
            else:
                # ① 先原生CDP点 I am human(可见checkbox的话被动过),再点一次 Save 复检验证框是否还在
                hit = click_i_am_human(cdp, log)
                log("⚠ 弹验证框 → 点 I am human: %s" % (hit or "没找到 checkbox iframe(=隐形hcaptcha,需注token)"))
                # 三态分流:图片九宫格(image-challenge)点 Save 毫无意义(框不会因再点 Save 而过)→ 跳过盲点,
                #   直接交下面 solve_hcap(2captcha)/换卡;checkbox 被动过 或 隐形框 才值得再点一次 Save 复检。
                if hit != "image-challenge":
                    try:
                        sv2 = cdp.evaluate(SAVE_JS)
                        if sv2:
                            s2 = json.loads(sv2); cdp.mouse_click(s2[0], s2[1])
                    except Exception:
                        pass
                    # 点框后给"放行"留时间:轮询复检,框一消失即视为过;最多等 FIXC_HC_RECHECK_WAIT 秒(默认5,控制台可配)。
                    # 旧版是睡死 2.5s 再单次判 → 慢放行的 checkbox 框会被误判换卡;改轮询:过了就提前退出,没过才等满。
                    _recheck = float(os.environ.get("FIXC_HC_RECHECK_WAIT", "5") or 5)
                    _rc_end = time.time() + max(0.0, _recheck)
                    cap = True
                    while True:
                        time.sleep(1.0 if _recheck >= 1 else max(0.2, _recheck))
                        try:
                            cap = bool(cdp.evaluate(CAPTCHA_JS))
                        except Exception:
                            pass
                        if not cap or time.time() >= _rc_end:
                            break
                else:
                    # 图片九宫格:点不掉、等也白等 → 单次复检,直接交下面 2captcha/换卡
                    if os.environ.get("OPENROUTER_FAST_HANDOFF_CARD"):
                        # 两套分流『秒关/快速失败』:弹图片九宫格即放弃加卡,交纯 Selenium 引擎(不解码/不换卡/不等)。
                        log("   ⚡ 快速衔接(两套分流):图片九宫格 → 立即放弃加卡,交纯 Selenium(不解码/不换卡)")
                        cap = True
                        _fast_card_bail = True
                    else:
                        try:
                            cap = bool(cdp.evaluate(CAPTCHA_JS))
                        except Exception:
                            pass
                # ② 验证框还在(checkbox点不掉=【Stripe 隐形/图片 hcaptcha】,这才是实际情况)→ 开关ON就 2captcha 求解+注token。
                #    【开关 solve_hcap】开=2captcha 走代理解+跨OOPIF注入(需 patcher 注了 hcaptcha hook;★可能破坏免检会话→502);关=直接交上层换卡。
                if cap and solve_hcap and patcher is not None and not _fast_card_bail:
                    try:
                        from services import captcha as _cap
                        log("   → 验证框解不掉(隐形/图片 hcaptcha)→ 2captcha 走代理求解+跨OOPIF注入…")
                        # ★driver 此刻已死(开头 kill 了 chromedriver)→ 不能把它传进去(execute_script 抓UA/
                        #   _hc_extract 抓sitekey/_inject 注token 全靠活 driver,会失效)。改传【UA壳】:
                        #   壳只用 CDP 取到的真 UA 回答 navigator.userAgent,其余 Selenium 调用安全失败 →
                        #   solve_hcaptcha 全程走 patcher(CDP 跨 OOPIF)读 sitekey/rqdata + 注 token。
                        _ua_drv = _DeadDriverUAShim(_cdp_user_agent(cdp))
                        solved = bool(_cap.solve_hcaptcha(_ua_drv, page_url or "", cfg or {}, timeout=120, patcher=patcher, proxy=proxy))
                        log("   → 2captcha 解hcaptcha=%s" % ("成功,继续Save" if solved else "失败,交上层换卡"))
                        if solved:
                            try:
                                sv3 = cdp.evaluate(SAVE_JS)               # 解了→再点 Save 提交
                                if sv3:
                                    s3 = json.loads(sv3); cdp.mouse_click(s3[0], s3[1]); time.sleep(2.5)
                            except Exception:
                                pass
                            try:
                                cap = bool(cdp.evaluate(CAPTCHA_JS))      # 复检:还有框=没解掉
                            except Exception:
                                pass
                    except Exception as _e:
                        log("   → hcaptcha求解异常: %s" % str(_e)[:70])
                if cap:                                      # 仍有验证框(没开求解/解失败)→ 交上层换卡/换IP
                    image_challenge = True
            log("   解框后仍有验证框=%s%s" % (cap, "(交上层换卡)" if image_challenge else ""))
        if image_challenge:                              # 验证框没过 → 交上层换卡/换IP,别再轮询24s干等
            # ★早返回前先速判一次【强结果信号】:常驻隐形 hcaptcha iframe 会让 cap 恒 True,但卡可能其实已绑成
            #   (页面已切 Auto Top-Up/向导屏)或已被拒。先信强信号,别因残留 iframe 把绑成卡当验证框失败丢掉。
            #   bound 只认正向文本(Auto Top-Up 等),绝不拿 cap=True 当绑成证据 → 不会把真活动框误判成绑成。
            try:
                st0 = cdp.evaluate(r"""(function(){var t=document.body.innerText||'';
                  if(/Auto\s*Top-?Up/i.test(t) && !/Add a Payment Method/i.test(t)) return 'bound';
                  if(/Add credits to get started|You're all set|Go to Dashboard/i.test(t)) return 'bound';
                  return '';})()""")
            except Exception:
                st0 = ''
            try:
                decl0 = bool(csid and cdp.evaluate(
                    "/declined|card was declined|do not honou?r|insufficient|card number is incorrect|expired/i"
                    ".test(document.body.innerText||'')", session_id=csid))
            except Exception:
                decl0 = False
            if st0 == "bound":
                log("   早返回前速判:页面已切 Auto Top-Up/向导屏=绑成(忽略残留 hcaptcha iframe 的 cap)")
                cdp.close()
                return {"captcha": False, "port": port, "bound_seen": True, "declined": False, "used_zip": zipc}
            if decl0:
                log("   早返回前速判:卡被拒(declined,刷新前抓到→将禁用该卡)")
                cdp.close()
                return {"captcha": True, "port": port, "bound_seen": False, "declined": True, "used_zip": zipc}
            cdp.close()
            return {"captcha": True, "port": port, "bound_seen": False, "declined": False}
        # 等结果【出结果即走】(不再盲跑满40s,把"绑成后干等""被拒不处理"的长尾砍掉):
        #   · declined = 卡iframe出现被拒文案(刷新前抓,否则刷新冲掉→误判card-502→复用坏卡)→立即 break
        #   · bound    = 页面已切到 Auto Top-Up 形态(强信号,直接信、调用方不必再重连核验)→ break
        #   · closed   = 弹框关了(Save按钮消失、无验证框)→ break,交调用方快速核验(权威)
        #   · pending/captcha = 继续等
        bound_seen = False
        declined = False
        # 绑卡结果等待上限:点 Save 后轮询绑成/被拒信号的上限,到点转去刷新核验(权威)。
        # 【控制台可配】FIXC_RESULT_WAIT(秒,默认24)→ 引擎配置「绑卡结果等待上限」。调小=遇 Stripe「Save card?」存卡弹窗更快收尾。
        _rw_end = time.time() + max(1.0, float(os.environ.get("FIXC_RESULT_WAIT", "24") or 24))
        while time.time() < _rw_end:     # 原 range(16)≈24s;出结果即 break,通常 3-6s
            try:
                if csid and cdp.evaluate(
                        "/declined|card was declined|do not honou?r|insufficient|card number is incorrect|expired/i"
                        ".test(document.body.innerText||'')", session_id=csid):
                    declined = True
                    log("✗ 卡被拒(declined,刷新前抓到→将禁用该卡)")
                    break
            except Exception:
                pass
            try:
                st = cdp.evaluate(r"""(function(){
                  var t=document.body.innerText||'';
                  if(/Auto\s*Top-?Up/i.test(t) && !/Add a Payment Method/i.test(t)) return 'bound';
                  /* 新版向导:卡保存成功后会切到这些屏(没存上不会到),Fix C 刚点完 Save → 直接信绑成,不退化成 closed 弱信号 */
                  if(/Add credits to get started|You're all set|Go to Dashboard/i.test(t)) return 'bound';
                  var f=document.querySelectorAll('iframe');
                  for(var j=0;j<f.length;j++){var s=(f[j].src||'').toLowerCase();
                    if(s.indexOf('hcaptcha')>=0||s.indexOf('turnstile')>=0) return 'captcha';}
                  var hasSave=false,b=document.querySelectorAll('button');
                  for(var i=0;i<b.length;i++){if(/save/i.test(b[i].textContent||'')){hasSave=true;break;}}
                  return hasSave?'pending':'closed';
                })()""")
                if st == "bound":
                    bound_seen = True
                    log("✓ 卡已绑上(页面已切到 Auto Top-Up 形态,你能看到绑成)")
                    break
                if st == "closed":
                    log("✓ 弹框已关闭(Save按钮消失)→ 交去快速核验是否绑成")
                    break
                if st == "pending" and os.environ.get("FIXC_SAVECARD", "dismiss") != "wait":
                    # ★点 Save 后 Stripe 弹"Save card?"存卡弹窗(它【自带 Save 按钮】→ 被绑成轮询误读成 pending)。
                    #   该弹窗【只在 Stripe 已收卡成功后才出现】(declined 不弹;图片验证更早一环就早返回了,根本到不了这)。
                    #   ★一劳永逸根治「/credits 逗留 + 反复弹 Save card?」:检测到存卡弹窗 = 绑成强信号 → 关掉它(只点 No thanks,绝不点 Save=要手机号 Error400)
                    #   + 【直接置 bound_seen 并 break】→ 调用方据 bound_seen 跳过 _card_attached 的 goto(/credits) 刷新核验。
                    #   根因:旧码只关弹窗、不置 bound_seen → 多半轮到 'closed' 弱信号 → 调用方仍 goto /credits 核验,而 /credits 上 Stripe Link
                    #   会把 Save card? 【重新弹出来】→ 那一步没人关它 → 逗留(用户截图所见)。现在绑成处直接收口,根本不去 /credits 重弹。
                    #   【控制台可配 FIXC_SAVECARD=wait】:不走此路、等满 FIXC_RESULT_WAIT 再核验(对照测试用)。
                    if _savecard_present_and_dismiss(cdp, log):
                        bound_seen = True
                        log("✓ Save card? 存卡弹窗已处理(它只在 Stripe 收卡成功后出现)→ 判绑成,跳过 /credits 刷新核验(根治逗留)")
                        break
                    # 没检测到存卡弹窗的 pending(可能主表单 Save 按钮残留/别的态)→ 退回泛关 Link 屏,继续轮询等明确结果
                    _dismiss_link_dialog(cdp, log)
            except Exception:
                pass
            time.sleep(1.5)
        if not (bound_seen or declined):
            log("(~24s 内没出绑成/被拒结果,转去刷新核验)")
        used_zip = zipc
        # ★ZIP 重试:declined 多半是 AVS(账单ZIP与卡不匹配)→ 不立刻禁卡,先用其它 ZIP 重试【同一张卡】
        #   (卡自带美国ZIP优先,后接免税州ZIP)。过了=卡是好的、只是ZIP问题 → 不烧卡 + 记下成功的 ZIP。
        # 【#4 修】ZIP 重试加总墙钟死线:每个 ZIP 内层 ~18s,ZIP_RETRY 调大(如10)→ 单卡阻塞最坏 ~180s,
        #   远超调用方节奏、把并发槽拖死。主循环有 deadline,这段原来独漏 → 补上(默认 60s,FIXC_ZIP_DEADLINE 可配)。
        _zip_deadline = time.time() + float(os.environ.get("FIXC_ZIP_DEADLINE", "60") or 60)
        for z in (alt_zips or []):
            if not declined or time.time() > _zip_deadline:
                if declined and time.time() > _zip_deadline:
                    log("⏳ ZIP 重试超过 %ss 死线 → 停止重试,交上层" % os.environ.get("FIXC_ZIP_DEADLINE", "60"))
                break
            z = str(z)
            log("✗ declined → 切 ZIP=%s 重试同一张卡(疑 AVS,不烧卡)" % z)
            try:
                zs = _click_in_frame(cdp, "stripe", ", ".join(ZIP), tries=6)
                if not zs:
                    break
                cdp.clear_field(zs); time.sleep(0.15)
                cdp.type_digits(z, session_id=zs); time.sleep(0.35)
                sv = cdp.evaluate(SAVE_JS)
                if sv:
                    s = json.loads(sv); cdp.mouse_click(s[0], s[1]); time.sleep(2.8)
            except Exception:
                break
            declined = False; bound_seen = False
            for _ in range(12):                             # 最多 ~18s 看新 ZIP 结果
                try:
                    if csid and cdp.evaluate(
                            "/declined|card was declined|do not honou?r|insufficient|card number is incorrect|expired/i"
                            ".test(document.body.innerText||'')", session_id=csid):
                        declined = True; break
                except Exception:
                    pass
                try:
                    t = cdp.evaluate("document.body.innerText||''") or ""
                    # 老版:切到 Auto Top-Up 形态 = 绑成
                    if re.search(r"Auto\s*Top-?Up", t) and not re.search(r"Add a Payment Method", t):
                        bound_seen = True; break
                    # 新版向导:卡保存成功后切到这些屏(没存上不会到)→ 同样判绑成(与主循环 L418 区域一致)
                    if re.search(r"Add credits to get started|You're all set|Go to Dashboard", t):
                        bound_seen = True; break
                    if not cdp.evaluate(SAVE_JS):           # Save 按钮消失=弹框关=可能绑成
                        break
                except Exception:
                    pass
                time.sleep(1.5)
            used_zip = z
            if bound_seen or not declined:
                log("✓ 切 ZIP=%s 后过了!(declined 是 AVS,卡是好的)" % z)
                break
            log("   ZIP=%s 仍 declined" % z)
        # 让你【看得到】绑成态再走浏览器(默认4s;FIXC_SUCCESS_HOLD 可调,0=不停)
        if bound_seen:
            try:
                _hold = float(os.environ.get("FIXC_SUCCESS_HOLD", "4"))
            except Exception:
                _hold = 4.0
            if _hold > 0:
                time.sleep(_hold)
        cdp.close()
        return {"captcha": cap, "port": port, "bound_seen": bound_seen, "declined": declined, "used_zip": used_zip}
    finally:
        # ★M11：无论正常返回/抛异常都关 CDP websocket（close 幂等，正常路径已 close 过=无害）；
        #   原来仅显式出口 close，type_digits/mouse_click 等抛错路径会泄漏 ws+socket fd（并发失败累积耗尽句柄）。
        try:
            cdp.close()
        except Exception:
            pass
