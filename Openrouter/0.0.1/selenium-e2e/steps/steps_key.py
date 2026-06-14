#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 关 onboarding 浮层 + 取 API Key（纯 Selenium，移植自 stages.js apiKey/dismissOnboarding）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/steps_key.py
# ═══════════════════════════════════════════════════════════════════════

import re
import os
import time
import random
import json

from common import log, KEYS_URL, rand_name, rand_address
from common.selectors import sel   # 元素维护页可覆盖关键元素选择器(无覆盖=用各处内置默认,老代码原样不变)


def _wizard_pay_mode():
    """向导支付步用哪种方式:address=填地址露出卡表单 / later=点'I'll do this later'跳过。
    WIZARD_PAY_MODE=address|later|random(默认random:每号随机一种,做对比)。返回 (mode_str)。"""
    m = (os.environ.get("WIZARD_PAY_MODE") or "random").strip().lower()
    if m in ("address", "later"):
        return m
    return "address" if random.random() < 0.5 else "later"


def _wizard_credit_mode():
    """向导积分步:credits=充值(★真实扣款) / skip=跳过。
    WIZARD_CREDIT_MODE=credits|skip|random(默认 skip —— 充值会真实扣款,绝不默认乱扣;要充值/随机须显式开)。"""
    m = (os.environ.get("WIZARD_CREDIT_MODE") or "skip").strip().lower()
    if m in ("credits", "skip"):
        return m
    if m == "random":
        return "credits" if random.random() < 0.5 else "skip"
    return "skip"


def _fill_wizard_address(page):
    """向导'Add a payment method'步:填地址(Address line 1 + 出现的 City/State/ZIP)→ Complete address details to continue。
    露出后续卡表单(卡由 add_card 绑)。返回 True=已填并推进。"""
    addr = rand_address()
    filled = page.js(
        "var a=arguments[0];var n=0;"
        # 【#9】setv 原来固定取 HTMLInputElement.prototype 的 value setter,对 textarea/select 不适用。
        #   按元素类型取对应 prototype 的 setter;select 走专门的 setsel(按 option 文本/值选中 + change)。
        "function protoFor(el){var tn=el.tagName;"
        "  if(tn=='TEXTAREA')return window.HTMLTextAreaElement.prototype;"
        "  if(tn=='SELECT')return window.HTMLSelectElement.prototype;"
        "  return window.HTMLInputElement.prototype;}"
        "function setv(el,v){if(!el)return;var p=Object.getOwnPropertyDescriptor(protoFor(el),'value');"
        "  if(p&&p.set){p.set.call(el,v);}else{try{el.value=v;}catch(e){}}"
        "  el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}"
        "function setsel(el,v){if(!el||!el.options)return false;var vl=String(v).toLowerCase();"
        "  for(var i=0;i<el.options.length;i++){var o=el.options[i];"
        "    if(String(o.value).toLowerCase()==vl||(o.textContent||'').trim().toLowerCase()==vl){el.selectedIndex=i;"
        "      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}}"
        "  return false;}"
        "var ins=[].slice.call(document.querySelectorAll('input,textarea,select'));"
        "ins.forEach(function(el){var lab=((el.getAttribute('placeholder')||'')+' '+(el.getAttribute('name')||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('autocomplete')||'')+' '+(el.id||'')).toLowerCase();"
        "  var pl=(el.closest('label')&&el.closest('label').innerText||'').toLowerCase();var L=lab+' '+pl;"
        "  var isSel=el.tagName=='SELECT';"
        "  if(/address line 1|address1|line1|address-line1|street|^address/.test(L)&&!isSel&&!el.value){setv(el,a.line1);n++;}"
        "  else if(/city|town|address-level2/.test(L)&&!isSel&&!el.value){setv(el,a.city);n++;}"
        "  else if(/country/.test(L)){if(isSel){if(setsel(el,a.country)||setsel(el,'US'))n++;}else if(!el.value){setv(el,a.country);n++;}}"
        "  else if(/state|province|region|address-level1/.test(L)){if(isSel){if(setsel(el,a.state))n++;}else if(!el.value){setv(el,a.state);n++;}}"
        "  else if(/zip|postal|postal-code/.test(L)&&!isSel&&!el.value){setv(el,a.zip);n++;}"
        "});return n;", {"line1": addr.get("line1") or addr.get("address") or "123 Main St",
                          "city": addr.get("city"), "state": addr.get("state"), "zip": addr.get("zip"),
                          "country": addr.get("country") or "United States"})
    time.sleep(0.8)
    # 回读校验:地址行1 真填上没?(选择器没匹配上 / 字段在子 iframe → 填不上)。填不上就别卡在灰着的
    #   "Complete address details to continue",改点 "I'll do this later" 跳过 —— 真绑卡由后面 steps_billing(Fix C,跨iframe填址)做,不受此步限。
    try:
        line1_ok = bool(page.js(
            "var a=Array.from(document.querySelectorAll('input,textarea')).find(function(e){"
            "var L=((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('name')||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('autocomplete')||'')+' '+(e.id||'')+' '+((e.closest('label')&&e.closest('label').innerText)||'')).toLowerCase();"
            "return /address line 1|address1|line1|address-line1|^address/.test(L);});"
            "return !!(a&&a.value&&String(a.value).trim());"))
    except Exception:
        line1_ok = False
    if not line1_ok:
        log("[向导支付] 地址行1 没填上(选择器没匹配/在子iframe)→ 改点 I'll do this later 跳过,交后面真绑卡步")
        _click_later(page)
        return False
    _native_click_el(page, _TEXTBTN_JS, r"Complete address details|Continue|Save")
    log("[向导支付] 方式=填地址(填了%s个字段,zip=%s)→ 推进露出卡表单" % (filled, addr.get("zip")))
    return True


def dismiss_onboarding(page):
    """关掉问卷/「You.?re all set!」/个人资料弹层——但【绝不关账单弹窗】。"""
    By = page.By
    # 问卷：Where did you first hear about OpenRouter → Other / Not sure → Continue
    try:
        t = (page.all_frames_text() or "")
        if "hear about OpenRouter" in t or "first hear" in t:
            page.click_text(["Other / Not sure", "Not sure", "Other"], 3)
            page.click_text(["Continue"], 3)
            time.sleep(1.2)
    except Exception:
        pass
    # 「You.?re all set!」/ profile 详情：找弹层里的关闭按钮（不动账单）
    try:
        page.d.execute_script("""
          var dlgs=document.querySelectorAll('[role=dialog],[class*=modal i],[class*=overlay i]');
          for(var i=0;i<dlgs.length;i++){var d=dlgs[i];var tx=(d.innerText||'').toLowerCase();
            if(tx.indexOf('payment')>=0||tx.indexOf('card number')>=0||tx.indexOf('add a payment')>=0||tx.indexOf('billing address')>=0||tx.indexOf('update address')>=0||tx.indexOf('verify your identity')>=0) continue; // 绝不关账单/地址弹窗
            if(tx.indexOf('all set')>=0||tx.indexOf('profile')>=0||tx.indexOf('hear about')>=0){
              var b=d.querySelector('button[aria-label*=lose i],button[aria-label*=ismiss i],button[title*=lose i]');
              if(!b){var bs=d.querySelectorAll('button');for(var j=0;j<bs.length;j++){var bt=(bs[j].innerText||'').trim().toLowerCase();if(['×','✕','x','close','dismiss','maybe later','skip','got it'].indexOf(bt)>=0){b=bs[j];break;}}}
              if(b)b.click();
            }
          }
        """)
    except Exception:
        pass


def _native_click_el(page, find_js, *args):
    """用 JS 定位元素并【返回给 Selenium 做原生 click】。
    【关键】Selenium el.click() 是真实鼠标事件 → 触发 React onClick/onChange;而 execute_script 里的 DOM .click()
    对 React 控件(Individual 卡片 div / 问卷 radio)【不触发】→ Continue 一直灰 → 向导卡死。find_js 须 return 元素或 null。"""
    try:
        el = page.d.execute_script(find_js, *args)
        if el:
            try:
                page.d.execute_script("arguments[0].scrollIntoView({block:'center'})", el)
            except Exception:
                pass
            el.click()
            return True
    except Exception:
        pass
    return False


# 文本类按钮(button/a/[role=button])的原生点击:用 new RegExp(arguments[0]) 匹配可见文本。
_TEXTBTN_JS = r"""
  var re=new RegExp(arguments[0], 'i');
  var els=[].slice.call(document.querySelectorAll('button,[role=button],a'));
  var t=els.find(function(b){return re.test((b.innerText||'').trim());});
  return t || null;
"""

# 「I'll do this later / Skip for now」定位(只取【可见】按钮;撇号兼容直/弯/反引号)。
# 「I'll do this later」匹配 —— 元素维护页 pay_later 可覆盖(留空=内置默认;撇号直/弯/反引号兼容)。运行时构建→覆盖即时生效。
def _later_re_src():
    _ov = sel('pay_later')                                 # [] = 无元素维护覆盖
    if _ov:
        return "|".join(re.escape(s) for s in _ov)
    return "I[\\u2019\\u2018'`]?ll do this later|do this later|Skip for now|Maybe later"


def _later_js(action):
    """定位「I'll do this later」按钮的 JS。action:'el'返回元素 / 'click'点击+bool / 'coords'返回[x,y] / 'has'布尔。
    正则用 new RegExp(json) 兼容覆盖里的特殊字符。"""
    _src = json.dumps(_later_re_src())
    _find = ("var re=new RegExp(" + _src + ",'i');"
             "var els=[].slice.call(document.querySelectorAll('button,[role=button],a'));"
             "var t=els.find(function(b){return b.offsetParent!==null && re.test((b.innerText||'').trim());});")
    if action == 'has':
        return ("var re=new RegExp(" + _src + ",'i');return [].slice.call(document.querySelectorAll('button,[role=button],a'))"
                ".some(function(b){return b.offsetParent!==null && re.test((b.innerText||'').trim());});")
    if action == 'el':
        return _find + "if(t){try{t.scrollIntoView({block:'center'});}catch(e){}}return t||null;"
    if action == 'click':
        return _find + "if(t){try{t.scrollIntoView({block:'center'});}catch(e){}t.click();return true;}return false;"
    return (_find + "if(!t)return null;try{t.scrollIntoView({block:'center'});}catch(e){}"
            "var r=t.getBoundingClientRect();if(r.width<2||r.height<2)return null;return [r.left+r.width/2, r.top+r.height/2];")


def _has_later_btn(page):
    """页面上是否【有可见的 I'll do this later 类按钮】(直接探按钮,不靠 all_frames_text 文案;pay_later 可覆盖)。"""
    try:
        return bool(page.js(_later_js('has')))
    except Exception:
        return False


def _cdp_trusted_click(page, coords_js):
    """CDP 可信鼠标点击(isTrusted=true,和真人手点一模一样地触发 React)——【不杀 chromedriver】
    (取key 阶段 driver 本就挂着,execute_cdp_cmd 复用既有 CDP 通道,见 pipeline.py grantPermissions/cdp_raw)。
    比 Selenium el.click() 可靠:不受"click intercepted/not interactable"影响,直接在坐标上发可信鼠标事件。
    coords_js 须 return [x,y](视口 CSS 像素)或 null。返回是否点了。"""
    try:
        xy = page.js(coords_js)
    except Exception:
        xy = None
    if not (isinstance(xy, (list, tuple)) and len(xy) == 2):
        return False
    try:
        x, y = float(xy[0]), float(xy[1])
        d = page.d
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        time.sleep(0.04)
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
        time.sleep(0.05)
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
        return True
    except Exception:
        return False


def _click_later(page):
    """稳健点「I'll do this later / Skip for now」跳过向导支付/积分步 —— 纯 Selenium 多法兜底,最强在前,
    且【每法点完回读按钮是否消失才算真成】(防 CDP dispatch/坐标过期"假成功"挡住后续兜底):
    ① CDP 可信鼠标点击(isTrusted=true,和手点一样、不杀 driver) ② Selenium 原生 click
    ③ JS .click()(button 冒泡) ④ click_text(不含撇号 label,避开 XPath 撇号坑)。
    判定"真点上"=按钮消失(各法都先重新定位可见按钮,按钮没了就 no-op,故不会重复误点)。返回是否点掉。"""
    if not _has_later_btn(page):
        return False                                   # 没这按钮 → 没可点的
    _methods = (
        lambda: _cdp_trusted_click(page, _later_js('coords')),
        lambda: _native_click_el(page, _later_js('el')),
        lambda: page.js(_later_js('click')),
        lambda: page.click_text(["do this later", "Skip for now", "Maybe later"], 3),
    )
    for _m in _methods:
        try:
            _m()
        except Exception:
            pass
        time.sleep(0.7)
        if not _has_later_btn(page):                    # 按钮消失 = 真点上了
            return True
    log("[取Key] ⚠ I'll do this later 四法都没点掉(按钮仍在)→ 交外层重试/刷新")
    return False


# 注:曾有 _copy_key_from_clipboard()(点Copy读剪贴板兜底)已删除 —— navigator.clipboard.readText() 会弹 Chrome
#   权限框把向导页卡死(MEMORY 明令禁止)。明文 key 直接从 workspace-ready 的 fetch 示例 code/pre 抓即可,绝不读剪贴板。

# 进了新向导但没抓到明文 key 的哨兵:caller 据此【快速失败走整号重试】,绝不回落到新页面根本不存在的 New Key 路径
# (老号才有 New Key 按钮;在新向导页上点不存在的按钮→空耗+把新老两套页面动作混在一起)。
WIZARD_NO_KEY = "__WIZARD_NO_KEY__"


def _advance_role_select(page):
    """推进 Welcome「How will you be using OpenRouter?」角色选择步:点 Individual 卡片 → Continue。
    【为什么要单独抽出来给加卡步用】onboarding 没走完时这个浮层会盖住 /settings/credits 的加卡入口
    → 加卡步 dismiss_onboarding 只关问卷/all-set、清不掉它 → 找不到 Add a Payment Method → 退点 Add Credits 空转
    + OpenRouter 前端一直轮询积分余额接口(=用户看到的"一直请求积分/跳链接")。在加卡步也把它推过去,露出加卡入口。
    取key 向导主循环本就处理它;此处复用同一套定位(含 sel('wizard_individual') 覆盖),不改向导逻辑。返回是否点了 Individual。"""
    try:
        t = page.all_frames_text() or ""
    except Exception:
        return False
    if not re.search(r"How will you be using OpenRouter", t, re.I):
        return False
    # 【护栏①防误打断加卡】卡表单/Stripe 账单 iframe 已经开着 → 绝不去点 Individual/Continue 做页面导航
    #   (否则可能卸载正在填的卡表单)。只在「确实卡在 Welcome 角色选择、且卡表单还没开」时才推。
    try:
        busy = bool(page.js(
            "if(document.querySelector('iframe[src*=\"js.stripe.com\"],iframe[name*=\"stripe\" i]'))return true;"
            "var ins=document.querySelectorAll('input');for(var i=0;i<ins.length;i++){var e=ins[i];if(e.offsetParent===null)continue;"
            "var m=((e.getAttribute('name')||'')+' '+(e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase();"
            "if(/card number|cardnumber|cc-number|postal|cvc/.test(m))return true;}return false;"))
    except Exception:
        busy = False
    if busy:
        return False
    _ind_ov = sel('wizard_individual')                       # [] = 无元素维护覆盖
    _ind_re = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _ind_ov)) + ",'i')") if _ind_ov
               else "/Build side projects|explore models|prototype ideas/i")
    # 【护栏②防 stale 文案误触发】只在【可见】(offsetParent!==null)的 Individual 卡片上动作。
    clicked = _native_click_el(page, (
        "var btns=[].slice.call(document.querySelectorAll('button,[role=button],a')).filter(function(b){return b.offsetParent!==null;});"
        "var re=" + _ind_re + ";"
        "var t=btns.find(function(b){return re.test(b.innerText||'');});"
        "if(!t) t=btns.find(function(b){var x=(b.innerText||'');return /\\bIndividual\\b/i.test(x) && !/\\bOrganization\\b/i.test(x);});"
        "return t || null;"))
    if clicked:
        time.sleep(1.2)
        _native_click_el(page, _TEXTBTN_JS, r"^Continue$|^Get started$|^Next$")
        time.sleep(1.0)
        log("[加卡] 检测到 Welcome 角色选择浮层盖住加卡页 → 点 Individual+Continue 推过去(露出加卡入口,止 Add Credits 空转)")
    return clicked


def _dismiss_survey(page):
    """问卷 "Where did you first hear about OpenRouter?":选一个 radio(优先 Other/Not sure)→ 回读确认【真选中】→ 等 Continue 可点再点。
    关键:点【真正的 radio input / [role=radio]】并回读 :checked 确认——只点文本/外层 div 不会触发选中 → Continue 一直灰、
    空点 Continue 无效 → 外层循环只能反复重来(用户看到的"得刷新好几次")。返回是否点到了可用的 Continue。"""
    picked = False
    for _q in range(4):
        # 【元素维护可覆盖 wizard_survey_radio】:有覆盖→按覆盖文本选行;无覆盖→原样老逻辑(Other/Not sure→Google→第一行),老代码不变。
        _sv_ov = sel('wizard_survey_radio')
        _sv_find = (("var re=new RegExp(" + json.dumps("|".join(re.escape(s) for s in _sv_ov)) + ",'i');var row=rows.find(function(b){return re.test(b.innerText||'');})||rows[0];")
                    if _sv_ov else
                    "var row=rows.find(function(b){return /Other \\/ Not sure|Not sure/i.test(b.innerText||'');})||rows.find(function(b){return /\\bGoogle\\b/i.test(b.innerText||'');})||rows[0];")
        _native_click_el(page, (
            "var rows=[].slice.call(document.querySelectorAll('label,[role=radio]'));"
            + _sv_find +
            "if(!row) return null;"
            "return row.querySelector('input[type=radio],[role=radio]') || row;"))
        time.sleep(0.4)
        try:
            picked = bool(page.js("return !!document.querySelector('input[type=radio]:checked,[role=radio][aria-checked=true],[role=radio][data-state=checked]');"))
        except Exception:
            picked = False
        if picked:
            break
        time.sleep(0.5)
    for _c in range(6):   # radio 选中后 Continue 才 enable → 等它可点再点,别点到 disabled 的空按钮
        if _native_click_el(page, r"""
            var b=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(x){
              return /^Continue$/i.test((x.innerText||'').trim()) && !x.disabled && x.getAttribute('aria-disabled')!=='true';});
            return b||null;"""):
            log("[向导问卷] radio 选中=%s → 点 Continue 推进" % picked)
            return True
        time.sleep(0.5)
    log("[向导问卷] radio 选中=%s 但 Continue 仍不可点(交外层兜底)" % picked)
    return False


def _handle_onboarding_wizard(page):
    """新版 onboarding 向导取 key(新号)。返回:明文 key / WIZARD_NO_KEY(进了向导没抓到key→快速失败) / None(老号dashboard→New Key流程)。
    【按页面内容判新老页,绝不按 URL 判】:新版 keys 页 URL 统一 /workspaces/default/keys,老号(已过onboarding)也在这,
    显示带 +New Key 的 dashboard;新号显示 Welcome→Individual→workspace ready→问卷→all set 向导。"""
    in_wizard = False
    for _ in range(14):
        t = page.all_frames_text() or ""
        # 向导文案【不含 "Your API Key"】(dashboard 的 "manage your API keys" 会误命中→把老号判成向导)
        wiz = bool(re.search(r"How will you be using OpenRouter|Welcome to OpenRouter|Your workspace is ready|workspace is ready|first hear about OpenRouter|You.?re all set", t, re.I))
        # 【区分新旧页的关键判据】老号 dashboard 的标志是【真·存在 New Key 按钮】(element,不是文本):
        #   新向导后续步里也可能出现 "New Key" 字样,用文本会误判;必须查 <button> 实体才能把新旧两页区分开。
        has_newkey_btn = bool(page.js("return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){return /New Key|Create Key|Create API Key/i.test(b.innerText||'');});"))
        if wiz:
            in_wizard = True
            break
        if has_newkey_btn:
            return None  # 有真·New Key 按钮且无向导文案 → 老号 dashboard → 交回 New Key 流程
        time.sleep(1.5)
    if not in_wizard:
        return None
    log("[取Key] 检测到新号 onboarding 向导 → 走向导抓 key")
    # 两套分流『秒关/快速失败』:检测到新版向导即立即放弃(交混合引擎跑,Playwright 能过新页面),不在此磨 150s 死线。
    #   仅 engine-runner 在 split+crossHandoff 第一轮给纯 Selenium 组注 OPENROUTER_FAST_HANDOFF_KEY=1;第二轮/单引擎不注 → 不受影响。
    if os.environ.get("OPENROUTER_FAST_HANDOFF_KEY"):
        log("[取Key] ⚡ 快速衔接(两套分流):新版向导 → 立即放弃,交混合引擎(不在此磨向导)")
        return WIZARD_NO_KEY
    # ★ 墙钟死线:即便每次 page.js 都卡满 script_timeout,20 轮也能拖到 ~10 分钟才退出(看着就是"卡死")。
    #   给向导取 key 整体一个上限,到点直接快速失败 → 整号重试,绝不长时间干挂在向导页。
    wiz_deadline = time.time() + float(os.environ.get("WIZARD_KEY_DEADLINE", "150"))
    # 抓完整明文 sk-or-(掩码 ••• 不匹配;明文在 "Your workspace is ready" 的 fetch 示例 code/pre 里)。
    # 提成局部 JS 复用:主循环、workspace-ready 多轮快查、WIZARD_NO_KEY 前补抓都用它。
    _GRAB_KEY_JS = (
        "var m=(document.body.innerText||'').match(/sk-or-[A-Za-z0-9-]{24,}/);if(m)return m[0];"
        "var els=document.querySelectorAll('input,textarea,code,pre');for(var i=0;i<els.length;i++){var v=els[i].value||els[i].textContent||'';var mm=String(v).match(/sk-or-[A-Za-z0-9-]{24,}/);if(mm)return mm[0];}return null;")
    def _grab_key():
        try:
            return page.js(_GRAB_KEY_JS)
        except Exception:
            return None
    # 1+2) 选 Individual(原生click,div卡片 DOM click 不触发 React)并等明文 key 出现
    key = None
    # 卡死自救:记录"当前在哪屏",同一屏卡过阈值不前进 → 刷新 keys 页逃逸(刷新关 onboarding 浮层 → 落 dashboard → New Key 建 key)。
    _stall_sig = None
    _stall_since = time.time()
    _stall_refreshed = 0
    _STALL_SECS = float(os.environ.get("WIZARD_STALL_REFRESH", "30") or 30)
    for _i in range(20):
        if time.time() > wiz_deadline:
            log("[取Key] 向导取 key 超过墙钟死线(%.0fs) → 放弃,快速失败走整号重试"
                % float(os.environ.get("WIZARD_KEY_DEADLINE", "150")))
            return WIZARD_NO_KEY
        t = page.all_frames_text() or ""
        # 卡死自救:同一屏(Welcome/ready/问卷)卡过阈值且没前进 → 刷新逃逸(最多2次),别在一屏上反复跳到 150s 死线。
        _sig = ("welcome" if re.search(r"How will you be using OpenRouter|Welcome to OpenRouter", t, re.I)
                else "ready" if re.search(r"workspace is ready", t, re.I)
                else "survey" if re.search(r"first hear about OpenRouter", t, re.I) else "other")
        if _sig != _stall_sig:
            _stall_sig = _sig; _stall_since = time.time()
        elif _sig in ("welcome", "ready", "survey") and (time.time() - _stall_since) > _STALL_SECS and _stall_refreshed < 2:
            _stall_refreshed += 1
            log("[取Key] 同一屏(%s)卡 >%.0fs 不前进 → 刷新 keys 页自救(第%d/2次)" % (_sig, _STALL_SECS, _stall_refreshed))
            page.goto(KEYS_URL, wait=3)
            _stall_sig = None; _stall_since = time.time()
            continue
        # 【止血:别干等到 150s】onboarding 已走完、落到带 +New Key 的空 dashboard(无任何向导文案)→ 立刻交回 New Key 流程建 key。
        if not re.search(r"How will you be using OpenRouter|Welcome to OpenRouter|workspace is ready|first hear about OpenRouter|You.?re all set", t, re.I) \
           and re.search(r"No API keys yet|Create and manage your API keys|manage your API keys", t, re.I) \
           and page.js("return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){return /New Key|Create Key|Create API Key/i.test(b.innerText||'');});"):
            log("[取Key] 向导走完落到空 dashboard → 交回 New Key 流程建 key(不再干等到 150s 死线)")
            return None
        # 问卷 "Where did you first hear..." 可能挡在 workspace-ready 之后(掩码 key 抓不到时尤其卡这)→ grab 循环也处理它,别等人工刷新
        if re.search(r"first hear about OpenRouter", t, re.I):
            _dismiss_survey(page)
            time.sleep(1.2)
            continue
        # 【关键修复:卡在「Add a payment method」要人工点 I'll do this later 的根因】
        #   支付/积分步会挡在 workspace-ready【之后】;本主循环原本【没有这俩 handler】,且它们的 _sig=other 又不在
        #   stall-refresh 名单(只 welcome/ready/survey 会刷)→ 整步无人处理、干等到 150s 死线 = 用户看到的
        #   「卡在 Add a payment method 不动、要手动点 I'll do this later」。这里点跳过 → 落到带 +New Key 的
        #   dashboard → 下面 dashboard-break 接管走 New Key 建 key(真绑卡由后续 card 步做,不靠这步)。
        if re.search(r"Add a payment method|billing address is required|Complete address details|Add credits to get started|How much would you like to add", t, re.I) or _has_later_btn(page):
            _sk = _click_later(page)
            log("[取Key] 命中支付/积分步 → I'll do this later 点击=%s,点后按钮仍在=%s" % (_sk, _has_later_btn(page)))
            time.sleep(1.6)
            continue
        # 「You're all set!」收尾屏也挡在 ready 之后(主循环原本不处理它,同样会干等死线)→ 点 Go to Dashboard 落 dashboard。
        if re.search(r"You.?re all set|Go to Dashboard", t, re.I):
            if _native_click_el(page, _TEXTBTN_JS, r"Go to Dashboard"):
                log("[取Key] 向导收尾「You're all set」→ 点 Go to Dashboard 落 dashboard 走 New Key")
            time.sleep(1.5)
            continue
        # Welcome 首步(还没到角色选择)→ 点 Get started/Continue 推进,否则一直卡在欢迎页、抓不到 key。
        if re.search(r"Welcome to OpenRouter", t, re.I) and not re.search(r"How will you be using", t, re.I):
            if _native_click_el(page, _TEXTBTN_JS, r"Get started|Get Started|Get going|Continue|Next|Let.?s go"):
                log("[取Key] Welcome 步 → 点 Continue/Get started 推进")
            time.sleep(1.8)
            continue
        if re.search(r"How will you be using OpenRouter", t, re.I):
            # 还停在选择步 → 点 Individual 卡片(它是 <button>,innerText 含 "Individual Build side projects…")。
            # 【全卡 Welcome 根因修复】原来 querySelectorAll 含 div/span → els.find 文档序里先命中【包住两张卡的外层容器 div】,
            #   closest('button') 在容器上=null → 退回点了容器 div(无 onClick)→ 页面不前进 → 4 窗全卡 Welcome。
            #   改:【只在可点元素 button/[role=button]/a 里找】→ find 直接返回那个 <button>,不再点到祖先容器。
            # 【元素维护可覆盖 wizard_individual】:有覆盖→用覆盖文本(转义成正则);无覆盖→原样老正则,保证老代码不变。
            _ind_ov = sel('wizard_individual')           # [] = 无覆盖
            _ind_re = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _ind_ov)) + ",'i')") if _ind_ov
                       else "/Build side projects|explore models|prototype ideas/i")
            _native_click_el(page, (
                "var btns=[].slice.call(document.querySelectorAll('button,[role=button],a'));"
                "var re=" + _ind_re + ";"
                "var t=btns.find(function(b){return re.test(b.innerText||'');});"
                "if(!t) t=btns.find(function(b){var x=(b.innerText||'');return /\\bIndividual\\b/i.test(x) && !/\\bOrganization\\b/i.test(x);});"
                "return t || null;"))
            time.sleep(1.4)
            # 【关键】选了 Individual 后必须点 "Continue" 才进 workspace-ready 出 key —— 否则一直卡在"Welcome+角色选择"页。
            if _native_click_el(page, _TEXTBTN_JS, r"^Continue$|^Get started$|^Next$"):
                log("[取Key] 选 Individual 后 → 点 Continue 推进到 workspace-ready")
            time.sleep(2.2)
        # workspace-ready 这步 key 一闪而过(onReady=true 但秒切到 dashboard/models)→ 在此【多停留、密集快查】抓住它。
        # 【#7】on_ready 必须用【最新】文本判:上面点完 Individual+Continue 页面已切到 workspace-ready,
        #   循环顶部那次 t 是【过期】的(还停在角色选择步)→ 用旧 t 判会漏掉刚出现的 key。此处重新抓一次。
        t_now = page.all_frames_text() or ""
        on_ready = bool(re.search(r"Your workspace is ready|workspace is ready", t_now, re.I))  # 【去 'Your API Key'】它会误命中空 dashboard(MEMORY 老坑)→ 把 dashboard 当 ready 步、抓不存在的 key 空耗到 150s
        if on_ready:
            for _r in range(6):
                key = _grab_key()
                if key:
                    log("[取Key] workspace-ready 密集轮询抓到 key ✓(第%d次)" % (_r + 1))
                    break
                time.sleep(0.6)
            if key:
                break
        # 常规一次抓取(非 ready 步也试,fetch 示例 code/pre 里可能已有明文)
        key = _grab_key()
        if key:
            break
        # 注:不读剪贴板兜底 —— navigator.clipboard.readText() 会弹 Chrome 权限框("…wants to see clipboard")把向导页卡死。
        #   新版向导的明文 key 就在 "workspace is ready" 的 fetch 示例 code/pre 里,上面的纯文本匹配已足够。
        time.sleep(2)
    # WIZARD_NO_KEY 兜底前再多试 2-3 轮密集快查(key 可能在最后一次 sleep 期间才渲染出来)。
    if not key:
        for _r in range(3):
            key = _grab_key()
            if key:
                log("[取Key] WIZARD_NO_KEY 前补抓到 key ✓(第%d轮)" % (_r + 1))
                break
            time.sleep(0.8)
    if not key:
        try:
            dbg = page.js("var b=document.body.innerText||'';return JSON.stringify({onSel:/How will you be using/i.test(b),onReady:/workspace is ready|Your API Key/i.test(b),masked:/sk-or-[A-Za-z0-9]*[•·*]{2,}/.test(b),head:b.slice(0,160).replace(/\\s+/g,' ')});")
        except Exception:
            dbg = ""
        log("[取Key] 向导进了但没抓到明文 key → 哨兵(快速失败走整号重试,绝不回落老 New Key 死路) dump=%s" % str(dbg)[:220])
        return WIZARD_NO_KEY
    log("[取Key] 向导抓到 key ✓")
    # 3) 把向导剩余步骤推完:Continue / payment&credits→I'll do this later / 问卷→原生选radio+Continue / all-set→Go to Dashboard
    # 【#10/#17】支付/积分模式每号【只决定一次】:进循环前定好存局部变量,循环内复用。
    #   否则在推进循环里每次迭代重新随机(同一步可能被多次进入)→ 模式抖动(这次填地址下次又跳过)。
    pay_mode = _wizard_pay_mode()
    credit_mode = _wizard_credit_mode()
    for _ in range(9):
        t = page.all_frames_text() or ""
        if re.search(r"You.?re all set|Go to Dashboard", t, re.I):
            _native_click_el(page, _TEXTBTN_JS, r"^Go to Dashboard$")
            time.sleep(1)
            break
        if re.search(r"first hear about OpenRouter", t, re.I):
            _dismiss_survey(page)
            time.sleep(1.0)
            continue
        # 支付/地址步:两种方式(填地址 / I'll do this later),记录到 page._pay_method
        if re.search(r"Add a payment method|billing address is required|Complete address details", t, re.I):
            if pay_mode == "address":
                _fill_wizard_address(page)
                try: page._pay_method = "wizard-address"
                except Exception: pass
            else:
                _click_later(page)
                try: page._pay_method = "later-skip"
                except Exception: pass
                log("[向导支付] 方式=I'll do this later(跳过,卡走后续 billing)")
            time.sleep(1.4)
            continue
        # 积分/充值步:两种方式(充值 / 跳过),★充值真实扣款默认关,记录到 page._credit_method
        if re.search(r"Add credits to get started|How much would you like to add|Add credits to your account", t, re.I):
            if credit_mode == "credits":
                # 【#10/#17】$10 预设按钮文本不一定是纯 "$10"(可能 "$10""$10.00""10"等)→ 放宽匹配。
                #   注意:credit_mode 默认 skip 不进此分支,不会误触发充值。
                _native_click_el(page, _TEXTBTN_JS, r"\$\s?10(\.0+)?\b|^\s*10\s*$")  # 选最小预设 $10
                time.sleep(0.6)
                _native_click_el(page, _TEXTBTN_JS, r"^Add credits$")    # ★真实扣款
                try: page._credit_method = "add-credits"
                except Exception: pass
                log("[向导积分] 方式=充值 $10(★真实扣款)")
            else:
                _click_later(page)
                try: page._credit_method = "skip"
                except Exception: pass
                log("[向导积分] 方式=跳过(不扣款)")
            time.sleep(1.4)
            continue
        if _click_later(page):
            time.sleep(1.3)
            continue
        if _native_click_el(page, _TEXTBTN_JS, r"^Continue$"):
            time.sleep(1.3)
            continue
        break
    return key


def get_api_key(page, name=None, expiration="No expiration"):
    """取 API Key。返回 {ok, key, name} 。"""
    page.goto(KEYS_URL, wait=3)
    dismiss_onboarding(page)
    By = page.By
    key_name = name or ("auto-" + rand_name(6))
    # 新号 onboarding 向导:先试走向导直接抓 key(新版强制流程)。抓到就返回;非向导/老号 → 交回下面 New Key 流程。
    wkey = _handle_onboarding_wizard(page)
    if wkey == WIZARD_NO_KEY:
        # 进了向导没抓到 key,两种情况:
        #   ① onboarding 走完落到带 "+New Key" 的 keys dashboard(新号没自动给 key,要手动建)→ 走下面 New Key 流程建key,别空转重试(否则一直循环回 Welcome,看着卡死)。
        #   ② 页面仍卡在向导中途/异常 → 快速失败走整号重试。
        # 【#8】不能只凭"有 New Key 字样按钮"就回落:向导中途某些步也可能出现 New Key 字样按钮 → 误入 New Key 流程空耗。
        #   必须【确认确实在 keys dashboard】:有 dashboard 标志文案(No API keys yet / manage your API keys),且【已离开向导文案】。
        has_nk = page.js("return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){return /New Key|Create Key|Create API Key/i.test(b.innerText||'');});")
        dash_t = page.all_frames_text() or ""
        on_dashboard = bool(re.search(r"No API keys yet|Create and manage your API keys|manage your API keys|Your API Key", dash_t, re.I))
        still_in_wizard = bool(re.search(r"How will you be using OpenRouter|Welcome to OpenRouter|Your workspace is ready|workspace is ready|first hear about OpenRouter|You.?re all set", dash_t, re.I))
        if not (has_nk and on_dashboard and not still_in_wizard):
            log("[取Key] 向导进入但没抓到 key、且未确认在 keys dashboard(has_nk=%s on_dash=%s in_wiz=%s) → 快速失败(整号重试)"
                % (has_nk, on_dashboard, still_in_wizard))
            return {"ok": False, "key": None, "name": "wizard-no-key", "reason": "WIZARD_KEY_NOT_CAPTURED"}
        log("[取Key] 向导没自动给 key,但已确认到带 +New Key 的 keys dashboard → 走 New Key 流程建key(不空转重试)")
        # 不 return:落到下面 New Key 流程建一把 key
    elif wkey:
        log("[取Key] 成功(向导) %s… (%s)" % (wkey[:14], "onboarding"))
        return {"ok": True, "key": wkey, "name": "onboarding"}
    # 名字框出现=弹窗已开。【元素维护可覆盖 key_name_input】:有覆盖→先查覆盖选择器命中可见元素;
    #   无覆盖→ _kn_prefix 为空 → 下面老逻辑【原样】跑(#name + 任意可见 name 框、排搜索框),保证老代码不变。
    _kn_ov = sel('key_name_input')                       # [] = 无页面覆盖
    _kn_prefix = (("var KNS=" + json.dumps(_kn_ov) + ";for(var i=0;i<KNS.length;i++){try{var _kn=document.querySelector(KNS[i]);if(_kn&&_kn.offsetParent!==null)return true;}catch(e){}}") if _kn_ov else "")
    # 【加固「创建弹窗没打开」误报】改版后命名框可能不再含单词 'name'(placeholder 变 "Untitled key"/"e.g. Production"、
    #   浮动 label 致 placeholder 空、或 Radix portal 输入框无 name 元数据)→ 只认 'name' 的老门会把【已打开的弹窗】判否、
    #   空转 6 轮误报。补一个【严格超集】分支:只要【确实打开的 dialog/modal 容器内】有可见非search文本输入就算开。
    #   只放宽不收紧(整段只 return true)、限定 dialog 容器(不误命中 dashboard 外的 'Search by name…' 框)、
    #   排除账单/地址弹窗(payment/card/cvc/zip…)、尺寸+可见性门挡占位框、裹 try/catch 异常静默回落原行为。
    #   位置在 #name return 之后、name 正则 return 之前 → 带 #name 的老号在前面已 return、本分支不可达,老行为逐字不变。
    _dlg_open_js = (
        "try{var _mods=[].slice.call(document.querySelectorAll('[role=dialog],[aria-modal=\"true\"],[data-state=\"open\"][class*=ontent],[class*=modal i],[class*=overlay i],[class*=Dialog i]'));"
        "for(var _i=0;_i<_mods.length;_i++){var _m=_mods[_i];"
        "if(_m.offsetParent===null&&getComputedStyle(_m).position!=='fixed')continue;"
        "var _r=_m.getBoundingClientRect();if(_r.width<40||_r.height<40)continue;"
        "var _tx=(_m.innerText||'').toLowerCase();"
        "if(/payment|card number|add a payment|billing address|update address|verify your identity|cardholder|expiry|cvc|postal code|zip/.test(_tx))continue;"
        "var _ins=[].slice.call(_m.querySelectorAll('input,textarea'));"
        "for(var _j=0;_j<_ins.length;_j++){var _e=_ins[_j];if(_e.offsetParent===null)continue;"
        "var _t=(_e.type||'text').toLowerCase();"
        "if(_t==='search'||_t==='hidden'||_t==='checkbox'||_t==='radio'||_t==='submit'||_t==='button'||_t==='file')continue;"
        "var _em=((_e.id||'')+' '+(_e.getAttribute('name')||'')+' '+(_e.getAttribute('placeholder')||'')+' '+(_e.getAttribute('aria-label')||'')+' '+(_e.getAttribute('role')||'')).toLowerCase();"
        "if(/search|combobox|listbox/.test(_em))continue;"
        "var _ec=getComputedStyle(_e);if(_ec.visibility==='hidden'||_ec.display==='none')continue;"
        "var _br=_e.getBoundingClientRect();if(_br.width<30||_br.height<8)continue;"
        "return true;}}}catch(_e0){}")
    name_visible = (_kn_prefix +
                    "if(document.querySelector('#name')&&document.querySelector('#name').offsetParent!==null)return true;"
                    + _dlg_open_js +
                    "return !!Array.from(document.querySelectorAll('input,textarea')).find(function(e){"
                    "if(e.offsetParent===null)return false;"
                    "var meta=((e.id||'')+' '+(e.getAttribute('name')||'')+' '+(e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase();"
                    "if(e.type==='search'||/search/.test(meta))return false;"
                    "return /(^|[^a-z])name([^a-z]|$)/i.test(meta);});")
    # 打开创建弹窗。【加固「创建弹窗没打开」间歇:落空 dashboard 后页面刚切、按钮/弹窗渲染有时序】:
    #   ① 先等 dashboard 稳(New Key 按钮真出现) ② 点前把按钮【滚进视野】(原生 click 更可靠) ③ 6 轮重试、期间清残留 onboarding 浮层。
    #   已开就别再点(再点会切掉);New Key 是 React 按钮 → 原生 click(evaluate 点 DOM 可能不触发 onClick)。
    # 【元素维护可覆盖 newkey_button】:有覆盖→用覆盖文本(转义拼成正则);无覆盖→原样老表达式,保证老代码不变。
    _nk_ov = sel('newkey_button')                        # [] = 无覆盖
    _nk_test = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _nk_ov)) + ",'i').test(t)") if _nk_ov
                else "(/New Key|Create Key|Create API Key/i.test(t)||t==='Create')")
    _NEWKEY_JS = ("var b=[].slice.call(document.querySelectorAll('button,[role=button],a')).find(function(x){"
                  "var t=(x.innerText||'').trim();return " + _nk_test + ";});"
                  "if(b){try{b.scrollIntoView({block:'center'});}catch(e){}}return b||null;")
    _newkey_present = ("return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(x){"
                      "var t=(x.innerText||'').trim();return " + _nk_test + ";});")
    # ① 等 dashboard 稳:New Key 按钮真出现 或 弹窗已在(最多 ~10s),别在刚切页的空窗里空点。
    for _s in range(10):
        if page.js(name_visible) or page.js(_newkey_present):
            break
        time.sleep(1)
    opened = False
    for _ in range(6):
        if page.js(name_visible):
            opened = True
            break
        dismiss_onboarding(page)                          # 清残留 onboarding 浮层(可能挡着 New Key 按钮)
        if not _native_click_el(page, _NEWKEY_JS):        # 找到 New Key 按钮 + 滚进视野 + 原生 click
            page.click_text(["New Key", "Create Key", "Create API Key"], 6)
        for _w in range(10):
            time.sleep(1)
            if page.js(name_visible):
                opened = True
                break
        if opened:
            break
    if not opened:
        log("[取Key] 创建弹窗没打开(已等dashboard稳+滚动入视+6轮重试仍没开)"); return {"ok": False, "key": None, "name": key_name}
    # 【乱写修复】不能用裸 input[placeholder*=name](会命中 dashboard 的 'Search by name...' 搜索框→把 key 名打进搜索框)。
    # 优先弹窗内 name 字段 → #name / input[name=name] → 最后才退【弹窗内】placeholder=name;绝不裸匹配 placeholder。
    # 【元素维护可覆盖 key_name_input】:有覆盖用覆盖列表,否则用下面老列表(保证老代码不变)。
    # 末尾再追加【弹窗内非search文本框】兜底:配合上面 name_visible 的 dialog-open 超集分支——
    #   当命名框已不叫 #name/无 name-placeholder(改版)时,前面具体选择器全落空才退到这里填弹窗内首个文本框。
    #   全部 dialog 限定且排 search/combobox,且置于列表【最末】→ 带 #name 的老号在前面就命中返回,兜底不可达,老行为不变。
    _DLG_FILL_FALLBACK = ['[role=dialog] input[type=text]:not([role=combobox])',
                          '[aria-modal="true"] input[type=text]:not([role=combobox])',
                          '[role=dialog] input:not([type]):not([role=combobox]):not([type=search])',
                          '[aria-modal="true"] input:not([type]):not([role=combobox]):not([type=search])',
                          '[role=dialog] textarea', '[aria-modal="true"] textarea']
    _kn_fill = (sel('key_name_input') or ['[role=dialog] #name', '[aria-modal="true"] input[placeholder*="name" i]',
                                          '#name', 'input[name="name"]', '[role=dialog] input[placeholder*="name" i]']) + _DLG_FILL_FALLBACK
    page.fill_in_frames(_kn_fill, key_name)
    time.sleep(0.5)
    # 有效期 combobox（默认 No expiration，按需选）
    if expiration and expiration != "No expiration":
        try:
            page.click_text(["No expiration"], 3)
            time.sleep(0.5)
            page.click_text([expiration], 3)
        except Exception:
            pass
    page.click_text(["Create"], 6)
    time.sleep(3)
    # 抓 key：body 或 input/textarea/code
    key = page.js(
        "var m=(document.body.innerText||'').match(/sk-or-[A-Za-z0-9-]{20,}/);if(m)return m[0];"
        "var els=document.querySelectorAll('input,textarea,code');for(var i=0;i<els.length;i++){var v=els[i].value||els[i].innerText||'';var mm=String(v).match(/sk-or-[A-Za-z0-9-]{20,}/);if(mm)return mm[0];}return null;")
    if key:
        log("[取Key] 成功 %s… (%s)" % (key[:14], key_name))
        return {"ok": True, "key": key, "name": key_name}
    log("[取Key] 没抓到明文 key")
    return {"ok": False, "key": None, "name": key_name}
