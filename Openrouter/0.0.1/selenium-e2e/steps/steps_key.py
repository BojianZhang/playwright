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

from common import log, KEYS_URL, rand_name, rand_address, fast_mode
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


# ── 一劳永逸:从网络响应抓 key(UI 无关)────────────────────────────────────────
# 注入 fetch/XHR 钩子:后端创建/返回 key 的响应体里一出现明文 sk-or- 就存进 sessionStorage('__or_key')。
# 这样无论新版向导怎么改版 / 掩码 / 只给 Copy 按钮,取 key 都直接读这个值,不再死靠 DOM 抓明文。
# 【边界】hostname 守卫:只在 openrouter.ai 自己的页面挂钩,绝不碰 Stripe/Cloudflare/hCaptcha iframe;只读响应找 sk-or-,不改请求。
KEY_CAPTURE_JS = r"""
(function(){
  try { if (String(location.hostname||'').indexOf('openrouter.ai') < 0) return; } catch(e){ return; }
  if (window.__OR_KEY_HOOK__) return; window.__OR_KEY_HOOK__ = 1;
  var RE = /sk-or-[A-Za-z0-9-]{24,}/;
  var MASK = /sk-or-[A-Za-z0-9]*([•·*]{2,}|\.{3}|…)/;   // 掩码形态 sk-or-••••
  var KW = /api[_-]?key|"key"\s*:|provisioning|secret/i;             // key 相关端点(即便不含明文)
  // save:核心抓取(逐字保留原逻辑)——响应体出现明文 sk-or- 就存 sessionStorage('__or_key')。
  function save(s){ try{ if(!s) return; if(sessionStorage.getItem('__or_key')) return; var m=String(s).match(RE); if(m) sessionStorage.setItem('__or_key', m[0]); }catch(e){} }
  // diag:【只读诊断,零副作用】记录"哪条传输(fetch/xhr/sse/ws)的哪个 URL 出现过 key-ish 内容(明文/掩码/关键词)"。
  //   用于定位 43% 取key 绕 New Key 的号——create-key 的明文到底走哪条路、为啥钩子抓不到。去重 + 上限30条。
  function diag(t){ try{ var a=JSON.parse(sessionStorage.getItem('__or_key_diag')||'[]'); if(a.indexOf(t)<0 && a.length<30){ a.push(t); sessionStorage.setItem('__or_key_diag', JSON.stringify(a)); } }catch(e){} }
  function scan(src,url,s){ try{ if(!s) return; var str=String(s); var ex=RE.test(str); var mk=!ex&&MASK.test(str); var kw=!ex&&!mk&&KW.test(str); if(ex||mk||kw){ var u=String(url||'').replace(/^https?:\/\/[^\/]+/,'').slice(0,70); diag((ex?'EXACT':mk?'MASK':'KW')+' '+src+' '+u); } save(str); }catch(e){} }
  try { var _f=window.fetch; if(_f) window.fetch=function(){ return _f.apply(this,arguments).then(function(r){ try{ var u=r.url; r.clone().text().then(function(t){ scan('fetch',u,t); }).catch(function(){}); }catch(e){} return r; }); }; } catch(e){}
  try { var _op=XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open=function(m,u){ try{ this.__oru=u; }catch(e){} return _op.apply(this,arguments); }; } catch(e){}
  try { var _snd=XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send=function(){ var self=this; try{ self.addEventListener('load', function(){ try{ scan('xhr',self.__oru,self.responseText); }catch(e){} }); }catch(e){} return _snd.apply(this,arguments); }; } catch(e){}
  try { var _ES=window.EventSource; if(_ES){ window.EventSource=function(u,o){ var es=new _ES(u,o); try{ es.addEventListener('message', function(ev){ scan('sse',u,ev.data); }); }catch(e){} return es; }; try{ window.EventSource.prototype=_ES.prototype; }catch(e){} } } catch(e){}
  try { var _WS=window.WebSocket; if(_WS){ var NWS=function(u,p){ var ws=(arguments.length>1)?new _WS(u,p):new _WS(u); try{ ws.addEventListener('message', function(ev){ scan('ws',u,ev.data); }); }catch(e){} return ws; }; NWS.prototype=_WS.prototype; try{ NWS.CONNECTING=_WS.CONNECTING; NWS.OPEN=_WS.OPEN; NWS.CLOSING=_WS.CLOSING; NWS.CLOSED=_WS.CLOSED; }catch(e){} window.WebSocket=NWS; } } catch(e){}
})();
"""


def inject_key_capture(driver):
    """attach 后、goto 前调一次:注入 KEY_CAPTURE_JS(addScriptToEvaluateOnNewDocument,对之后每个文档生效)。
    失败不致命(取 key 仍可回退 DOM 抓取)。"""
    try:
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": KEY_CAPTURE_JS})
        return True
    except Exception:
        return False


def _captured_key(page):
    """读网络钩子抓到的 key(sessionStorage('__or_key')),没有返回 None。"""
    try:
        cap = page.js("try{return sessionStorage.getItem('__or_key')||''}catch(e){return ''}")
        if cap and re.match(r"sk-or-[A-Za-z0-9-]{24,}", str(cap)):
            return cap
    except Exception:
        pass
    return None


def _key_capture_diag(page):
    """读网络钩子的【只读诊断】(sessionStorage('__or_key_diag')):本号 key-ish 内容在哪条传输/URL 出现过。
    用于定位"取key 绕 New Key"的号:create-key 明文走 fetch/xhr/sse/ws 哪条、是 EXACT(明文)/MASK(掩码)/KW(关键词端点)。"""
    try:
        d = page.js("try{return sessionStorage.getItem('__or_key_diag')||''}catch(e){return ''}")
        return str(d)[:400] if d else ""
    except Exception:
        return ""


def _newkey_fail_diag(page):
    """New Key 建key弹窗没开时的【只读诊断】:页面上 New Key 按钮数(总/可见)、dialog/modal 数、可见文本输入数、文案头。
    判 NEWKEY_DIALOG_NOT_OPENED 是【弹窗真没开(点击没生效/被挡/按钮不在)】还是【弹窗开了但 name_visible 没认出来(误报)】。"""
    try:
        return page.js(r"""
          var btns=[].slice.call(document.querySelectorAll('button,[role=button],a'));
          var nk=btns.filter(function(b){var t=(b.innerText||'').trim();return /New Key|Create Key|Create API Key/i.test(t)||t==='Create';});
          var nkVis=nk.filter(function(b){return b.offsetParent!==null;});
          var dlg=document.querySelectorAll('[role=dialog],[aria-modal="true"],[data-state="open"]').length;
          var ins=[].slice.call(document.querySelectorAll('input,textarea')).filter(function(e){return e.offsetParent!==null && (e.type||'')!=='hidden' && (e.type||'')!=='search';});
          return JSON.stringify({nk:nk.length,nkVis:nkVis.length,dlg:dlg,ins:ins.length,head:(document.body.innerText||'').slice(0,110).replace(/\s+/g,' ')});
        """) or ""
    except Exception:
        return ""


def _individual_coords_js():
    """Individual 卡片可点坐标 [x,y](视口CSS像素)或 null:优先描述文字"Build side projects"(冒泡到卡片 onClick),
    兜底含 Individual 且不含 Organization 的可点元素。元素维护 wizard_individual 可覆盖。供 _cdp_trusted_click 用。"""
    _ov = sel('wizard_individual')
    _re = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _ov)) + ",'i')") if _ov
           else "/Build side projects|explore models|prototype ideas/i")
    return (
        "var re=" + _re + ";"
        "var btns=[].slice.call(document.querySelectorAll('button,[role=button],a'));"
        "var t=btns.find(function(b){return b.offsetParent!==null && re.test(b.innerText||'');});"
        "if(!t) t=btns.find(function(b){var x=(b.innerText||'');return b.offsetParent!==null && /\\bIndividual\\b/i.test(x) && !/\\bOrganization\\b/i.test(x);});"
        "if(!t)return null;try{t.scrollIntoView({block:'center'});}catch(e){}"
        "var r=t.getBoundingClientRect();if(r.width<2||r.height<2)return null;"
        "return [r.left+r.width/2, r.top+r.height/2];")


def _textbtn_coords_js(re_src):
    """文本类按钮(button/a/[role=button])可见命中后的中心坐标 [x,y] 或 null。供 _cdp_trusted_click 用。"""
    return ("var re=new RegExp(" + json.dumps(re_src) + ",'i');"
            "var els=[].slice.call(document.querySelectorAll('button,[role=button],a'));"
            "var t=els.find(function(b){return b.offsetParent!==null && re.test((b.innerText||'').trim());});"
            "if(!t)return null;try{t.scrollIntoView({block:'center'});}catch(e){}"
            "var r=t.getBoundingClientRect();if(r.width<2||r.height<2)return null;"
            "return [r.left+r.width/2, r.top+r.height/2];")


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
    # ★放宽 gate(本批 unknown:残留 onboarding 不一定是角色选择屏,常是 Welcome 首屏 / 'Add credits to get started'
    #   积分空态 / 支付步)。识别到【任一 onboarding 浮层文案】就尝试推进露出加卡入口,而非只认 "How will you be using"。
    _is_role = bool(re.search(r"How will you be using OpenRouter", t, re.I))
    _is_welcome = bool(re.search(r"Welcome to OpenRouter", t, re.I)) and not _is_role
    _is_paystep = bool(re.search(r"Add a payment method|billing address is required|Add credits to get started|How much would you like to add", t, re.I))
    if not (_is_role or _is_welcome or _is_paystep):
        return False
    # 【护栏①防误打断加卡】卡表单【真出来可见】才绝不去点 Individual/Continue 做页面导航(否则可能卸载正在填的卡表单)。
    #   ★校正(本批 unknown:残留 onboarding 浮层下页面常已挂了【空 Stripe iframe】但卡表单【没真出】→ 原门"有 js.stripe.com
    #     iframe 就 busy=return False"会在【最需要推浮层时】当成 no-op,浮层清不掉、卡表单永不渲染)。
    #   改:busy 只认【可见的卡号/邮编/cvc 输入框真存在】(card form 真出),不再凭"页面挂了 Stripe iframe"就判 busy。
    try:
        busy = bool(page.js(
            "var ins=document.querySelectorAll('input');for(var i=0;i<ins.length;i++){var e=ins[i];if(e.offsetParent===null)continue;"
            "var m=((e.getAttribute('name')||'')+' '+(e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')).toLowerCase();"
            "if(/card number|cardnumber|cc-number|postal|cvc/.test(m))return true;}"
            "var fr=document.querySelectorAll('iframe[src*=\"js.stripe.com\"],iframe[name*=\"stripe\" i]');"
            "for(var k=0;k<fr.length;k++){var f=fr[k];if(f.offsetParent===null)continue;var r=f.getBoundingClientRect();"
            # 可见且有实尺寸的 Stripe iframe(真卡表单)才算 busy;空/0尺寸残壳不算
            "if(r.width>120&&r.height>40)return true;}"
            "return false;"))
    except Exception:
        busy = False
    if busy:
        return False
    # Welcome 首屏(还没到角色选择)→ 点 Get started/Continue 推进到角色选择(下一轮调用再点 Individual)。
    if _is_welcome and not _is_role:
        moved = bool(_cdp_trusted_click(page, _textbtn_coords_js(r"Get started|Get Started|Continue|Next|Let.?s go"))) \
            or _native_click_el(page, _TEXTBTN_JS, r"Get started|Get Started|Continue|Next|Let.?s go")
        if moved:
            time.sleep(0.6 if fast_mode() else 1.4)
            log("[加卡] 检测到 Welcome 首屏盖住加卡页 → 点 Get started/Continue 推进")
        return moved
    # 支付/积分 onboarding 步盖住加卡页(非角色选择屏)→ 点 'I'll do this later' 跳过,落到 dashboard 露出真加卡入口。
    #   ★绝不在此填地址/充值(避免重复扣款);真绑卡由后续 add_card 卡表单流程做。
    if _is_paystep and not _is_role:
        if _click_later(page):
            time.sleep(0.6 if fast_mode() else 1.3)
            log("[加卡] 检测到向导支付/积分步盖住加卡页 → I'll do this later 跳过(露出真加卡入口,不在此扣款)")
            return True
        return False
    _ind_ov = sel('wizard_individual')                       # [] = 无元素维护覆盖
    _ind_re = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _ind_ov)) + ",'i')") if _ind_ov
               else "/Build side projects|explore models|prototype ideas/i")
    # 【护栏②防 stale 文案误触发】只在【可见】(offsetParent!==null)的 Individual 卡片上动作。
    # 先 CDP 可信点击 Individual(对齐取key配方,React 卡片 div 必触发);取不到坐标/失败再退 Selenium el.click。
    clicked = _cdp_trusted_click(page, _individual_coords_js())
    if not clicked:
        clicked = _native_click_el(page, (
            "var btns=[].slice.call(document.querySelectorAll('button,[role=button],a')).filter(function(b){return b.offsetParent!==null;});"
            "var re=" + _ind_re + ";"
            "var t=btns.find(function(b){return re.test(b.innerText||'');});"
            "if(!t) t=btns.find(function(b){var x=(b.innerText||'');return /\\bIndividual\\b/i.test(x) && !/\\bOrganization\\b/i.test(x);});"
            "return t || null;"))
    if clicked:
        time.sleep(0.5 if fast_mode() else 1.2)   # 提速:等卡片选中态/Continue enable
        if not _cdp_trusted_click(page, _textbtn_coords_js(r"^Continue$|^Get started$|^Next$")):
            _native_click_el(page, _TEXTBTN_JS, r"^Continue$|^Get started$|^Next$")
        time.sleep(0.4 if fast_mode() else 1.0)   # 提速:等推进到下一屏
        log("[加卡] 检测到 Welcome 角色选择浮层盖住加卡页 → 点 Individual+Continue 推过去(CDP 可信点击,露出加卡入口,止 Add Credits 空转)")
    return clicked


def _dismiss_survey(page):
    """问卷 "Where did you first hear about OpenRouter?":选一个选项 → 点推进按钮 → 判离开问卷。返回是否过了。
    【2026-06-14 修复老页面问卷卡死(整批 key:False 主因,25/25 取key失败都卡这)】:
      ① 选项是 toggle <button>:原来每轮重复点【同一选项】= 反复选中/取消 → Continue 灰↔亮抖动极难点中。
         改:先选【一个】选项,再【只反复轮询点推进按钮】(不重复点选项,避免取消选中);这个选项推不动才换下一个。
      ② 推进按钮原来只认 ^Continue$:老页面可能是 Submit/Next/Done/Save → 放宽(并尊重 wizard_continue 覆盖)。
    新页面(key 已在问卷前抓到)不受影响;元素维护 wizard_survey_radio / wizard_continue 可覆盖。"""
    _sv_ov = sel('wizard_survey_radio')
    _pref = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _sv_ov)) + ",'i')") if _sv_ov
             else "/Other ?\\/ ?Not sure|Not sure/i")
    _OPT = "/X ?\\/ ?Twitter|LinkedIn|YouTube|Newsletter|Conference|Friend ?\\/ ?Colleague|\\bGoogle\\b|ChatGPT|Perplexity|Claude|Other ?\\/ ?Not sure|Not sure/i"
    # 找全部候选选项(优先项→Google→其它 排序),支持按 idx 取第几个(逐个换着试,治"某个选项不可选")。
    _cs_expr = (
        "var pref=" + _pref + ";var OPT=" + _OPT + ";"
        "var cs=[].slice.call(document.querySelectorAll('button,[role=radio],[role=option],[role=menuitemradio],label'))"
        ".filter(function(b){return b.offsetParent!==null && (b.innerText||'').trim().length<=40 && OPT.test(b.innerText||'');});"
        "cs.sort(function(a,b){function rk(e){var x=e.innerText||'';return pref.test(x)?0:(/\\bGoogle\\b/i.test(x)?1:2);}return rk(a)-rk(b);});")
    def _opt_coords(idx):
        return (_cs_expr + "var row=cs[" + str(int(idx)) + "];if(!row)return null;"
                "try{row.scrollIntoView({block:'center'});}catch(e){}"
                "var r=row.getBoundingClientRect();if(r.width<2||r.height<2)return null;return [r.left+r.width/2,r.top+r.height/2];")
    def _opt_el(idx):
        return (_cs_expr + "var row=cs[" + str(int(idx)) + "];return row?(row.querySelector('input[type=radio],[role=radio]')||row):null;")
    def _opt_count():
        try:
            return int(page.js(_cs_expr + "return cs.length;") or 0)
        except Exception:
            return 0
    # 推进按钮放宽(Continue/Submit/Next/Done/Save/Get started,尊重 wizard_continue 覆盖);仅未禁用才返回坐标。
    _adv_terms = sel('wizard_continue', 'Continue', 'Submit', 'Next', 'Done', 'Save', 'Get started', "Let's go")
    _adv_re = "new RegExp(" + json.dumps("^(" + "|".join(re.escape(s) for s in _adv_terms) + ")$") + ",'i')"
    _adv_coords = (
        "var re=" + _adv_re + ";"
        "var b=[].slice.call(document.querySelectorAll('button,[role=button]')).find(function(x){"
        "return re.test((x.innerText||'').trim()) && !x.disabled && x.getAttribute('aria-disabled')!=='true' && x.offsetParent!==null;});"
        "if(!b)return null;try{b.scrollIntoView({block:'center'});}catch(e){}"
        "var r=b.getBoundingClientRect();if(r.width<2||r.height<2)return null;return [r.left+r.width/2,r.top+r.height/2];")
    # 成功判据 = 离开问卷屏("first hear about OpenRouter"文案消失);选项是纯 button 无可靠 checked,只此判据最稳。
    def _on_survey():
        try:
            return bool(re.search(r"first hear about OpenRouter", page.all_frames_text() or "", re.I))
        except Exception:
            return True
    if not _on_survey():
        return True
    n_opt = max(1, min(_opt_count(), 9))                       # 穷尽问卷全部选项(每个只点一次不会取消选中);老页面问卷9选项原来只试3个会卡死
    for idx in range(n_opt):
        if not _cdp_trusted_click(page, _opt_coords(idx)):    # 选这个选项(只选一次,不重复点)
            _native_click_el(page, _opt_el(idx))
        for _w in range(6):                                   # 只反复轮询点推进按钮,给 React enable Continue 的时间
            time.sleep(0.6)
            if _cdp_trusted_click(page, _adv_coords):
                time.sleep(1.0)
                if not _on_survey():
                    log("[向导问卷] 选项+推进 → 已离开问卷 ✓")
                    return True
                break                                         # 推进点了仍在问卷 → 这个选项不对,换下一个
    # 仍卡:打一次详细探针(选项数 + 推进按钮文本/禁用态 + 页面短按钮),便于下次精确定位
    try:
        _dbg = page.js(
            "var OPT=" + _OPT + ";var adv=" + _adv_re + ";"
            "var cs=[].slice.call(document.querySelectorAll('button,[role=radio],[role=option],label')).filter(function(b){return b.offsetParent!==null && (b.innerText||'').trim().length<=40 && OPT.test(b.innerText||'');});"
            "var advb=[].slice.call(document.querySelectorAll('button,[role=button]')).filter(function(x){return x.offsetParent!==null && adv.test((x.innerText||'').trim());}).map(function(x){return {t:(x.innerText||'').trim(),dis:!!x.disabled||x.getAttribute('aria-disabled')==='true'};});"
            "var allb=[].slice.call(document.querySelectorAll('button,[role=button]')).filter(function(x){return x.offsetParent!==null && (x.innerText||'').trim().length<=20;}).map(function(x){return (x.innerText||'').trim();});"
            "return JSON.stringify({opts:cs.length, adv:advb.slice(0,3), btns:allb.slice(0,8)});")
        log("[向导问卷] ⚠ 试%d选项仍未离开问卷 → 探针: %s" % (n_opt, str(_dbg)[:400]))
    except Exception:
        log("[向导问卷] ⚠ 试%d选项仍未离开问卷 → 交外层(新页面 key 已抓不受影响;老页面取key失败)" % n_opt)
    return False


def _wizard_nokey_diag(page):
    """取key硬失败子诊断(落盘可审计):向导停在哪屏 + key 是否以掩码形态出现过。
      onSel=还停在角色选择屏;onReady=到了 workspace-ready 就绪屏;masked=页面上出现过【掩码形态】的 sk-or-key
      (=key 其实渲染了只是没抓到明文,偏【时序/抓取】问题,或许 Sel 还能救);onReady=false=根本没到就绪屏(更像需 Playwright)。
      head=页面前120字用于人工核对。判 26% WIZARD_KEY_NOT_CAPTURED 到底该继续修 Sel 还是转 split/混合的依据。"""
    try:
        return page.js("var b=document.body.innerText||'';return JSON.stringify({onSel:/How will you be using/i.test(b),onReady:/workspace is ready|Your API Key/i.test(b),masked:/sk-or-[A-Za-z0-9]*[•·*]{2,}/.test(b),head:b.slice(0,120).replace(/\\s+/g,' ')});") or ""
    except Exception:
        return ""


def _handle_onboarding_wizard(page, on_key=None, on_charge=None):
    """新版 onboarding 向导取 key(新号)。返回:明文 key / WIZARD_NO_KEY(进了向导没抓到key→快速失败) / None(老号dashboard→New Key流程)。
    【按页面内容判新老页,绝不按 URL 判】:新版 keys 页 URL 统一 /workspaces/default/keys,老号(已过onboarding)也在这,
    显示带 +New Key 的 dashboard;新号显示 Welcome→Individual→workspace ready→问卷→all set 向导。
    on_key(key):★抓到 key 的【那一刻】(收尾推进/充值之【前】)回调,让调用方立刻把 key 落 checkpoint
      —— 根因(审计 RESUME-01/02):key 只在本函数 return 后才被 pipeline 落盘,而收尾循环可能在 return 前
      就 add-credits 真实扣款;若此刻被杀 → key 没落盘 → 重跑整个向导 → 二次扣款 + 再陷浮层。提前落 key 后
      重跑直接复用 prior_key 跳过向导,不再重扣。默认 None=逐字节不变(hybrid/工具等其它调用方不受影响)。
    on_charge():向导收尾里 add-credits 真实扣款【那一刻】回调,让调用方立刻登记 charge 去重(防杀在 return 前丢信号)。"""
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
        "var m=(document.documentElement.innerText||document.body.innerText||'').match(/sk-or-[A-Za-z0-9-]{24,}/);if(m)return m[0];"
        "var els=document.querySelectorAll('input,textarea,code,pre');for(var i=0;i<els.length;i++){var v=els[i].value||els[i].textContent||'';var mm=String(v).match(/sk-or-[A-Za-z0-9-]{24,}/);if(mm)return mm[0];}return null;")
    def _grab_key():
        cap = _captured_key(page)          # 一劳永逸:优先用网络钩子抓到的 key(UI 无关,掩码/只给Copy也能拿到)
        if cap:
            return cap
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
            try: page._nokey_dbg = "deadline " + str(_wizard_nokey_diag(page))   # 落盘子诊断:卡屏到墙钟死线
            except Exception: pass
            return WIZARD_NO_KEY
        t = page.all_frames_text() or ""
        # 卡死自救:【只在 Welcome 屏】卡过阈值才刷新逃逸(最多2次)。★ready/survey 屏【绝不刷新】——
        #   刷新只会把 onboarding 弹回 Welcome 来回跳、丢进度(用户看到的"跳来跳去"),而 key 是 workspace-ready
        #   服务端自动建的、已由网络钩子(sessionStorage)/DOM 可取,根本不需要靠刷新去"逼出" key。
        _sig = ("welcome" if re.search(r"How will you be using OpenRouter|Welcome to OpenRouter", t, re.I)
                else "ready" if re.search(r"workspace is ready", t, re.I)
                else "survey" if re.search(r"first hear about OpenRouter", t, re.I) else "other")
        if _sig != _stall_sig:
            _stall_sig = _sig; _stall_since = time.time()
        elif _sig == "welcome" and (time.time() - _stall_since) > _STALL_SECS and _stall_refreshed < 2:
            _stall_refreshed += 1
            log("[取Key] 同一屏(%s)卡 >%.0fs 不前进 → 刷新 keys 页自救(第%d/2次)" % (_sig, _STALL_SECS, _stall_refreshed))
            page.goto(KEYS_URL, wait=3)
            _stall_sig = None; _stall_since = time.time()
            continue
        # 【止血:别干等到 150s】onboarding 已走完、落到带 +New Key 的 dashboard → 立刻交回 New Key 流程建 key。
        # ★根因(本批 9/10 取key失败 key_diag 实证:on_dash=True/has_nk=True 但 in_wiz=True → 干转到 150s 死线):
        #   dashboard 常残留 "You're all set"/"workspace is ready" toast 或关掉的 modal → 原 `not 任何向导文案` 守卫
        #   被这些【弱残留】否决 → 落到 dashboard 也不 break。修:① dashboard 信号扩为【强左导航(Guardrails+BYOK+
        #   Presets+Observability 同现,只有真工作台才有,弱残留盖不掉)】OR 原 dashboard 文案;② 否决【只认强向导屏
        #   (Welcome/角色选择)】不再被弱残留误伤;③ break 前先抓一次 key(网络钩子/DOM,这屏可能就有,免建第二把)。
        _on_dash = bool(re.search(r"No API keys yet|Create and manage your API keys|manage your API keys", t, re.I)) or \
                   bool(re.search(r"Guardrails", t) and re.search(r"BYOK", t) and re.search(r"Presets", t) and re.search(r"Observability", t, re.I))
        _strong_wiz = bool(re.search(r"How will you be using OpenRouter|Welcome to OpenRouter", t, re.I))
        if _on_dash and not _strong_wiz \
           and page.js("return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){return /New Key|Create Key|Create API Key/i.test(b.innerText||'');});"):
            key = _grab_key()
            if key:
                log("[取Key] 已落工作台,直接抓到 key ✓(免建第二把)")
                break
            log("[取Key] 向导走完落到带 +New Key 的工作台(key 一闪而过没抓到)→ 交回 New Key 流程建新 key(不再干等到 150s 死线)")
            return None
        # 问卷 "Where did you first hear..." 挡在 workspace-ready【之后】→ 说明 key 早已创建。稳定:先抓 key(网络钩子/DOM),
        #   到手就收工;没到手才 best-effort 推过问卷(已放宽选项选择器),且【绝不刷新】→ 不会弹回 Welcome 来回跳。
        if re.search(r"first hear about OpenRouter", t, re.I):
            key = _grab_key()
            if key:
                break
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
            # ★根治 WIZARD_KEY_NOT_CAPTURED 残留(实测 key_diag onSel:true 卡 "Back Welcome…The unified API" 引导页):
            #   "How will you be using" 文案虽在 DOM(轮播下一步),但号【视觉上还停在 Welcome 引导首屏】,角色卡片不可见。
            #   原代码直接点(隐藏的)Individual → 无效 → 每轮空点 → 卡到死线。先确认 Individual 卡片【真可见】再点;
            #   不可见 = 还在引导页 → 改点可见的 Get started/Continue 推进轮播到角色选择(下一轮再点 Individual)。
            # ★对抗核验改:轮播用 transform:translateX/opacity 隐藏下一屏,offsetParent 不变 null → 旧 offsetParent 判据
            #   把【屏外/透明的角色卡】误判"可见"→ 跳过推进引导页分支→去点屏外卡片→还是卡死。改判【真落在视口内+未透明】:
            #   getBoundingClientRect 与视口相交 + computed visibility/opacity。这样 transform 移出视口的角色卡正确判为不可见。
            _ind_visible = page.js(
                "function _vis(b){if(!b)return false;var cs=getComputedStyle(b);"
                "if(cs.visibility==='hidden'||cs.display==='none'||parseFloat(cs.opacity||'1')<0.1)return false;"
                "var r=b.getBoundingClientRect();"
                "return r.width>2&&r.height>2&&r.bottom>0&&r.right>0&&r.left<(window.innerWidth||9999)&&r.top<(window.innerHeight||9999);}"
                "return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){"
                "return _vis(b) && (/Build side projects|explore models|prototype ideas/i.test(b.innerText||'')"
                "|| (/\\bIndividual\\b/i.test(b.innerText||'') && !/\\bOrganization\\b/i.test(b.innerText||'')));});")
            if not _ind_visible:
                if _native_click_el(page, _TEXTBTN_JS, r"Get started|Get Started|Get going|Continue|Next|Let.?s go"):
                    log("[取Key] onSel 文案在 DOM 但 Individual 卡片不可见(视觉仍在 Welcome 引导页)→ 点 Get started 推进轮播")
                time.sleep(1.8)
                continue
            # 还停在选择步 → 点 Individual 卡片(它是 <button>,innerText 含 "Individual Build side projects…")。
            # 【全卡 Welcome 根因修复】原来 querySelectorAll 含 div/span → els.find 文档序里先命中【包住两张卡的外层容器 div】,
            #   closest('button') 在容器上=null → 退回点了容器 div(无 onClick)→ 页面不前进 → 4 窗全卡 Welcome。
            #   改:【只在可点元素 button/[role=button]/a 里找】→ find 直接返回那个 <button>,不再点到祖先容器。
            # 【元素维护可覆盖 wizard_individual】:有覆盖→用覆盖文本(转义成正则);无覆盖→原样老正则,保证老代码不变。
            _ind_ov = sel('wizard_individual')           # [] = 无覆盖
            _ind_re = (("new RegExp(" + json.dumps("|".join(re.escape(s) for s in _ind_ov)) + ",'i')") if _ind_ov
                       else "/Build side projects|explore models|prototype ideas/i")
            _ind_find = (
                "var btns=[].slice.call(document.querySelectorAll('button,[role=button],a'));"
                "var re=" + _ind_re + ";"
                "var t=btns.find(function(b){return re.test(b.innerText||'');});"
                "if(!t) t=btns.find(function(b){var x=(b.innerText||'');return /\\bIndividual\\b/i.test(x) && !/\\bOrganization\\b/i.test(x);});"
                "return t || null;")
            # 卡片是 div,普通 DOM .click 不触发 React → 先 CDP 可信点击(isTrusted,最稳,对齐 Playwright 工作配方),取不到坐标再退 Selenium el.click。
            if _cdp_trusted_click(page, _individual_coords_js()):
                log("[取Key] 已点 Individual(CDP 可信点击)")
            else:
                _native_click_el(page, _ind_find)
            time.sleep(1.6 if fast_mode() else 2.4)   # ★对齐 PW(~2.8s):ready 屏明文 key 一闪而过,驻留太短(原提速 0.5s)会错过 key 窗口
            # 【关键】选了 Individual 后必须点 "Continue" 才进 workspace-ready 出 key —— 否则一直卡在"Welcome+角色选择"页。
            if _cdp_trusted_click(page, _textbtn_coords_js(r"^Continue$|^Get started$|^Next$")) \
               or _native_click_el(page, _TEXTBTN_JS, r"^Continue$|^Get started$|^Next$"):
                log("[取Key] 选 Individual 后 → 点 Continue 推进到 workspace-ready")
            time.sleep(2.8)   # ★给 workspace-ready 的 code/pre 明文 key 渲染留足时间,随后每轮无条件密集抓
        # workspace-ready 这步 key 一闪而过(onReady=true 但秒切到 dashboard/models)→ 在此【多停留、密集快查】抓住它。
        # 【#7】on_ready 必须用【最新】文本判:上面点完 Individual+Continue 页面已切到 workspace-ready,
        #   循环顶部那次 t 是【过期】的(还停在角色选择步)→ 用旧 t 判会漏掉刚出现的 key。此处重新抓一次。
        t_now = page.all_frames_text() or ""
        on_ready = bool(re.search(r"Your workspace is ready|workspace is ready", t_now, re.I))  # 【去 'Your API Key'】它会误命中空 dashboard(MEMORY 老坑)→ 把 dashboard 当 ready 步、抓不存在的 key 空耗到 150s
        if on_ready:
            log("[取Key] 命中 workspace-ready 文案")
        # ★根因修复(对齐 PW 金标准):【每轮都无条件密集抓】,不再 gate 在 on_ready 文案。
        #   原来密集抓只在 on_ready('workspace is ready')命中后才跑,而 on_ready 靠 all_frames_text 只读 body.innerText 判屏
        #   —— ready 文案常一闪/被问卷·支付盖住/innerText 取不全 → on_ready=False → 密集抓从不触发,只剩每轮一次抓 + sleep(2),
        #   正好错过 key 闪现窗口(失败号日志里"密集轮询抓到 key"从未出现=印证)。且 code/pre 里的明文 key 渲染【晚于】标题文案,
        #   凭文案 gate 会在 key 挂载前就轮询完。改:每轮 8×0.35s 高频抓,抓到立即 break(绝不进入后续支付/all-set 推进分支)。
        for _r in range(8):
            key = _grab_key()
            if key:
                log("[取Key] 密集轮询抓到 key ✓(第%d次)" % (_r + 1))
                break
            time.sleep(0.35)
        if key:
            break
        # 注:不读剪贴板兜底 —— navigator.clipboard.readText() 是 Promise,execute_script 不会等它 resolve(返回 {} 拿不到 key),
        #   且需文档焦点,并发平铺窗口多在后台必 reject。新版明文 key 就在 workspace-ready 的 code/pre 里,上面每轮密集纯文本匹配已足够。
    # WIZARD_NO_KEY 兜底前再多试 2-3 轮密集快查(key 可能在最后一次 sleep 期间才渲染出来)。
    if not key:
        for _r in range(3):
            key = _grab_key()
            if key:
                log("[取Key] WIZARD_NO_KEY 前补抓到 key ✓(第%d轮)" % (_r + 1))
                break
            time.sleep(0.8)
    if not key:
        dbg = _wizard_nokey_diag(page)
        try: page._nokey_dbg = "grabloop " + str(dbg)        # 落盘子诊断:抓取循环跑完仍没抓到明文 key
        except Exception: pass
        log("[取Key] 向导进了但没抓到明文 key → 哨兵(快速失败走整号重试,绝不回落老 New Key 死路) dump=%s" % str(dbg)[:220])
        return WIZARD_NO_KEY
    log("[取Key] 向导抓到 key ✓")
    # ★立刻把 key 交调用方落盘(收尾推进/充值之【前】)——审计 RESUME-01/02:key 原来只在本函数 return 后才落 checkpoint,
    #   而下面收尾循环可能先 add-credits 真实扣款;若此刻被杀,key 没落盘→重跑整个向导→二次扣款。提前落 key 后重跑复用 prior_key 跳过。
    if on_key:
        try:
            on_key(key)
        except Exception:
            pass
    # 3) 把向导剩余步骤【真正推完到干净 dashboard 再返回】(对齐 Playwright 金标准 completeOnboardingIfPresent,
    #    stages.js:826:抓到 key 后仍把 Welcome/角色选择/问卷/支付/all-set 全推完才 return)。
    #   ★根因(本批 7 个 card:unknown):网络钩子(sessionStorage __or_key)可能在【角色选择刚点完、问卷/支付/all-set 还没走】
    #     时就抓到 key → 这里 break 后页面其实还停/回弹在 "How will you be using OpenRouter" 角色选择浮层,而本收尾循环
    #     【原来没有角色选择分支】→ 走到末尾 break 退出 → onboarding 浮层残留到 /credits → 盖住加卡入口、卡表单永不渲染。
    #   修:① 补 "How will you be using OpenRouter"(Welcome 角色选择)+ "Welcome to OpenRouter" 首屏分支,复用取key同一套
    #     CDP 可信点击 Individual+Continue;② 加【落到干净 dashboard 才正常退出】的判据(无任何向导文案)而非走到末尾 break;
    #     ③ 轮数 9→14、整体加墙钟死线,避免极端卡屏时干等。key 已落 sessionStorage,推进 onboarding 不会丢已抓的 key。
    # 【#10/#17】支付/积分模式每号【只决定一次】:进循环前定好存局部变量,循环内复用。
    #   否则在推进循环里每次迭代重新随机(同一步可能被多次进入)→ 模式抖动(这次填地址下次又跳过)。
    pay_mode = _wizard_pay_mode()
    credit_mode = _wizard_credit_mode()
    _fin_deadline = time.time() + float(os.environ.get("WIZARD_FINISH_DEADLINE", "40") or 40)
    # ★抓到 key 后收尾推进【best-effort】:任何一步抛错(stale element/会话抖动/弹窗时序)都【不能丢掉已抓到的 key】。
    #   审计真实日志:收尾循环无异常护栏时,grab 后抛错会让 key 静默丢失 → 整号判 key:false(明明已取到)。
    #   on_key 已在 grab 那刻落 checkpoint(重跑可救);此护栏再让【本次】也照常返回 key、当场进加卡,无需等重跑。
    try:
        for _ in range(14):
            if time.time() > _fin_deadline:
                log("[取Key] onboarding 收尾超墙钟死线 → 停止推进(key 已抓到,交后续 billing 步用 _advance_role_select 兜底清浮层)")
                break
            t = page.all_frames_text() or ""
            # ★【落到干净 dashboard 才算 onboarding 走完】:无任何向导文案 = 浮层已散、会话已干净 → 正常退出。
            #   这是对齐 PW「交付给 billing 的是干净 dashboard 会话」的退出判据,取代原来「无分支可点就 break」的被动退出。
            if not re.search(r"How will you be using OpenRouter|Welcome to OpenRouter|workspace is ready|first hear about OpenRouter|You.?re all set|Add a payment method|billing address is required|Complete address details|Add credits to get started|How much would you like to add", t, re.I):
                log("[取Key] onboarding 已走完 → 落到干净 dashboard,交付 billing(无残留向导浮层)")
                break
            if re.search(r"You.?re all set|Go to Dashboard", t, re.I):
                _native_click_el(page, _TEXTBTN_JS, r"^Go to Dashboard$")
                time.sleep(1)
                continue
            # ★Welcome「How will you be using OpenRouter?」角色选择浮层:本批 unknown 根因屏,原收尾循环缺此分支。
            #   复用取key同一套 CDP 可信点击 Individual+Continue(_advance_role_select 内有 busy 护栏,卡表单/Stripe 已开则 no-op)。
            if re.search(r"How will you be using OpenRouter", t, re.I):
                _advance_role_select(page)
                time.sleep(1.2)
                continue
            # Welcome 首屏(还没到角色选择)→ 点 Get started/Continue 推进。
            if re.search(r"Welcome to OpenRouter", t, re.I) and not re.search(r"How will you be using", t, re.I):
                _native_click_el(page, _TEXTBTN_JS, r"Get started|Get Started|Get going|Continue|Next|Let.?s go")
                time.sleep(1.5)
                continue
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
                    # ★扣款【那一刻】立刻登记 charge 去重(审计 RESUME-01/#3):防杀在 return 前丢信号 → 重跑/billing 二次扣款。
                    if on_charge:
                        try:
                            on_charge()
                        except Exception:
                            pass
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
    except Exception as _fe:
        log("[取Key] onboarding 收尾推进异常 → 终止收尾,直接返回已抓到的 key(残留浮层交 billing complete_onboarding 兜底,绝不丢 key): %s" % str(_fe)[:140])
    return key


def complete_onboarding(page, max_iters=12, deadline_s=None):
    """进 /credits 之前把残留 onboarding 向导【就地推完】到干净 dashboard,成功置 page._onboarding_done=True。
    【根因(审计 R1)】落 /credits 时若向导浮层还在 → 盖住加卡入口 → OpenRouter 前端【持续轮询积分接口】
      → 用户看到的"一直刷积分 + 页面跳来跳去 + 阻塞"。正解=进 /credits 之【前】先推完向导(对齐"单选过了才访问 credits"),
      而非落了 /credits 再反应式清(那样首次落地仍会触发一轮轮询)。
    【覆盖】① 取key收尾撞墙钟死线留下的残留向导;② 续跑复用 key(根本没走取key阶段=onboarding 从没走过,审计 R2)。
    复用已放宽的 _advance_role_select(角色选择/Welcome首屏/支付步,内有 busy 护栏:真卡表单已出则 no-op)+ 补问卷屏;
    【只推浮层,绝不在此填地址/充值】(真绑卡仍由 add_card 卡表单流程做,避免重复扣款)。
    幂等:已 _onboarding_done 直接返回 True。死线/推不动兜底:返回 False(交 add_card 落地后既有反应式兜底,不致回归)。"""
    if getattr(page, "_onboarding_done", False):
        return True
    _dl = time.time() + (deadline_s if deadline_s is not None else float(os.environ.get("ONBOARDING_COMPLETE_DEADLINE", "40") or 40))
    _WIZ = r"How will you be using OpenRouter|Welcome to OpenRouter|workspace is ready|first hear about OpenRouter|You.?re all set"
    for _ in range(max(1, max_iters)):
        if time.time() > _dl:
            break
        try:
            t = page.all_frames_text() or ""
        except Exception:
            t = ""
        # 判"向导是否还在":无歧义向导文案 + 可见的「I'll do this later」按钮(该按钮只存在于向导,
        #   不会误命中正常 /credits 账单页的 "Add a Payment Method")→ 即便误在 /credits 调用也安全。
        on_wiz = bool(re.search(_WIZ, t, re.I))
        has_later = _has_later_btn(page)
        if not on_wiz and not has_later:
            try:
                page._onboarding_done = True
            except Exception:
                pass
            log("[onboarding] 向导已走完(无残留浮层)→ 可安全进 /credits,不会触发前端持续刷积分")
            return True
        # all set 收尾屏 → Go to Dashboard
        if re.search(r"You.?re all set|Go to Dashboard", t, re.I):
            _native_click_el(page, _TEXTBTN_JS, r"^Go to Dashboard$")
            time.sleep(1.0); continue
        # 问卷屏(_advance_role_select 不处理它)→ 选项+推进
        if re.search(r"first hear about OpenRouter", t, re.I):
            _dismiss_survey(page); time.sleep(1.0); continue
        # 角色选择/Welcome首屏/支付步 → 复用已放宽的 _advance_role_select(它按屏内部分流)
        if _advance_role_select(page):
            time.sleep(0.6 if fast_mode() else 1.0); continue
        # 兜底:仍有 later 按钮(支付/积分残留)→ 点跳过
        if has_later and _click_later(page):
            time.sleep(1.0); continue
        break
    log("[onboarding] 残留向导未在死线内推完 → 交 add_card 落地后反应式兜底(不影响绑卡)")
    return False


def get_api_key(page, name=None, expiration="No expiration", on_key=None, on_charge=None):
    """取 API Key。返回 {ok, key, name} 。
    on_key/on_charge:透传给向导,在【抓到 key / 向导内 add-credits 扣款】那一刻回调,让调用方即时落 checkpoint
      防"杀在 return 前→重跑→二次扣款"(审计 RESUME-01/02)。默认 None=逐字节不变。"""
    # 提速:注册收尾(邮箱验证后)已把页面带到 keys,已在 keys/workspaces 页就不重复整页刷新(省用户看到的"连跳3次"的第3跳)。
    #   默认关(OPENROUTER_FAST 未设)=照旧 goto,逐字节不变;hybrid 独立调用/异常态(不在 keys 页)仍正常导航。
    _u = page.url() or ""
    # P3:注册收尾(steps_auth)已 goto KEYS_URL 落到此页;已在 keys/workspaces 就不再二次整页刷新 ——
    #   去掉 fast_mode() 门、提为默认行为,消除 218→708 背靠背重刷导致的"/keys 跳来跳去 + 向导重挂"。
    #   异常态/hybrid 独立调用(不在 keys 页)仍走 else 正常导航。
    if ("/keys" in _u or "workspaces" in _u):
        log("[取Key] 已在 keys 页(注册收尾带到此)→ 跳过重复整页刷新(去重默认,免向导重挂/跳来跳去)")
        # ★不立马开干:跳过整页刷新 ≠ 跳过页面 settle。注册收尾刚落到此页,向导/key 可能还没渲染稳 →
        #   给一段缓冲(等 DOM ready + 短驻留)再驱动取key向导,避免在半加载页上跑导致抓不到 key(WIZARD_KEY_NOT_CAPTURED)。
        #   保留 P3 不刷 /keys 的好处,同时补回原 goto(wait=3) 被一并省掉的那段 settle。OPENROUTER_KEYS_SETTLE 可调(默认3s)。
        try:
            page.wait_loaded()
        except Exception:
            pass
        time.sleep(float(os.environ.get("OPENROUTER_KEYS_SETTLE", "3") or 3))
    else:
        page.goto(KEYS_URL, wait=3)
    dismiss_onboarding(page)
    By = page.By
    key_name = name or ("auto-" + rand_name(6))
    # 新号 onboarding 向导:先试走向导直接抓 key(新版强制流程)。抓到就返回;非向导/老号 → 交回下面 New Key 流程。
    wkey = _handle_onboarding_wizard(page, on_key=on_key, on_charge=on_charge)
    if wkey == WIZARD_NO_KEY:
        # 进了向导没抓到 key,两种情况:
        #   ① onboarding 走完落到带 "+New Key" 的 keys dashboard(新号没自动给 key,要手动建)→ 走下面 New Key 流程建key,别空转重试(否则一直循环回 Welcome,看着卡死)。
        #   ② 页面仍卡在向导中途/异常 → 快速失败走整号重试。
        # 【#8】不能只凭"有 New Key 字样按钮"就回落:向导中途某些步也可能出现 New Key 字样按钮 → 误入 New Key 流程空耗。
        #   必须【确认确实在 keys dashboard】:有 dashboard 标志文案(No API keys yet / manage your API keys),且【已离开向导文案】。
        has_nk = page.js("return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){return /New Key|Create Key|Create API Key/i.test(b.innerText||'');});")
        dash_t = page.all_frames_text() or ""
        # ★on_dashboard 扩入【强左导航(Guardrails+BYOK+Presets+Observability 同现=真工作台)】——弱残留 toast 盖不掉它;
        #   原来只认 dashboard 文案 + 把 "You're all set"/"workspace is ready" 计入 still_in_wizard,会把【已落工作台但残留收尾 toast】
        #   误判"还在向导"→ 否决 New Key 兜底 → 干转到死线(本批 9/10 失败根因)。still_in_wizard 收紧为【只认强向导屏】。
        on_dashboard = bool(re.search(r"No API keys yet|Create and manage your API keys|manage your API keys|Your API Key", dash_t, re.I)) or \
                       bool(re.search(r"Guardrails", dash_t) and re.search(r"BYOK", dash_t) and re.search(r"Presets", dash_t) and re.search(r"Observability", dash_t, re.I))
        still_in_wizard = bool(re.search(r"How will you be using OpenRouter|Welcome to OpenRouter", dash_t, re.I))
        if not (has_nk and on_dashboard and not still_in_wizard):
            log("[取Key] 向导进入但没抓到 key、且未确认在 keys dashboard(has_nk=%s on_dash=%s in_wiz=%s) → 快速失败(整号重试)"
                % (has_nk, on_dashboard, still_in_wizard))
            # ★落盘子诊断(判 26% 该继续修 Sel 还是转 split/混合):向导停在哪屏/key是否以掩码出现过 + 最终态。
            _diag = "%s | final has_nk=%s on_dash=%s in_wiz=%s" % (
                str(getattr(page, "_nokey_dbg", "") or "")[:200], has_nk, on_dashboard, still_in_wizard)
            return {"ok": False, "key": None, "name": "wizard-no-key",
                    "reason": "WIZARD_KEY_NOT_CAPTURED", "key_diag": _diag,
                    "key_capture_diag": _key_capture_diag(page)}
        log("[取Key] 向导没自动给 key,但已确认到带 +New Key 的 keys dashboard → 走 New Key 流程建key(不空转重试)")
        # 不 return:落到下面 New Key 流程建一把 key
    elif wkey:
        log("[取Key] 成功(向导) %s… (%s)" % (wkey[:14], "onboarding"))
        return {"ok": True, "key": wkey, "name": "onboarding", "key_path": "wizard"}
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
    # ★放宽分支(实测 NEWKEY_DIALOG_NOT_OPENED 误报根因:_newkey_fail_diag 显示 dlg:1 ins:1 弹窗其实开了,
    #   但上面 _dlg_open_js 因 [data-state=open] 要求 class 含 ontent / 输入框 combobox 排除 / 尺寸门<30 把它判否)。
    #   这里只认【非账单弹窗 + 含可见文本输入】=创建弹窗已开,放宽尺寸/combobox 门(本阶段唯一带文本输入的非账单弹窗就是建key框)。
    #   只 return true 不收紧;billing/save-card 弹窗(无文本输入或被排除词命中)不会误中。
    # ★对抗核验收紧(去误报风险):① 选择器去掉裸 [data-state=\"open\"]——Radix 下拉/popover/tooltip/accordion/select 全带此属性,
    #   会把【非对话框】的 open 控件误判成"弹窗已开";只认真对话框 [role=dialog]/[aria-modal]。② 输入过滤补 meta 排除
    #   search/combobox/listbox(对齐 _dlg_open_js),避免把"Search models…"占位的 type=text 当成命名框。只收紧不放松。
    _dlg_loose_js = (
        "try{var _m2=[].slice.call(document.querySelectorAll('[role=dialog],[aria-modal=\"true\"]'));"
        "for(var _k=0;_k<_m2.length;_k++){var _mm=_m2[_k];"
        "if(_mm.offsetParent===null&&getComputedStyle(_mm).position!=='fixed')continue;"
        "var _tx2=(_mm.innerText||'').toLowerCase();"
        "if(/payment|card number|add a payment|billing address|update address|verify your identity|cardholder|expiry|cvc|postal code|zip|save card/.test(_tx2))continue;"
        "var _in2=[].slice.call(_mm.querySelectorAll('input,textarea')).filter(function(e){if(e.offsetParent===null)return false;var t=(e.type||'text').toLowerCase();"
        "if(t==='hidden'||t==='search'||t==='checkbox'||t==='radio'||t==='submit'||t==='button'||t==='file')return false;"
        "var _em=((e.id||'')+' '+(e.getAttribute('name')||'')+' '+(e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('role')||'')).toLowerCase();"
        "return !/search|combobox|listbox/.test(_em);});"
        "if(_in2.length)return true;}}catch(_e2){}")
    name_visible = (_kn_prefix +
                    "if(document.querySelector('#name')&&document.querySelector('#name').offsetParent!==null)return true;"
                    + _dlg_open_js + _dlg_loose_js +
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
    for _r in range(6):
        if page.js(name_visible):
            opened = True
            break
        dismiss_onboarding(page)                          # 清残留 onboarding 浮层(可能挡着 New Key 按钮)
        # ★对抗核验改(NEWKEY_DIALOG 实测弹窗真没开根因之一):New Key 是 React 按钮,el.click() 偶尔不触发 onClick →
        #   优先 CDP 可信点击(isTrusted,与 Individual/later 同配方,React 更可靠),取不到坐标再退 native click / click_text。
        if not (_cdp_trusted_click(page, _textbtn_coords_js(r"New Key|Create Key|Create API Key|^Create$"))
                or _native_click_el(page, _NEWKEY_JS)):
            page.click_text(["New Key", "Create Key", "Create API Key"], 6)
        for _w in range(10):
            time.sleep(1)
            if page.js(name_visible):
                opened = True
                break
        if opened:
            break
        # ★恢复(本批 NEWKEY_DIALOG_NOT_OPENED 增多根因):dashboard-break 把"落工作台没抓到key"的号转到这建key,
        #   但此刻可能仍有残留 onboarding 向导浮层(如"Add credits to get started"步)盖在上面 → New Key 按钮点不动/被拦。
        #   第3轮还没开 → 直接 goto /keys 落到【干净的 keys 子页】(导航即关掉残留向导浮层),再继续重试点按钮。
        if _r == 2:
            try:
                log("[取Key] New Key 弹窗 3 轮没开 → goto /keys 落干净页再试(清残留向导浮层)")
                page.goto(KEYS_URL, wait=3); dismiss_onboarding(page)
            except Exception:
                pass
    if not opened:
        # ★零风险恢复:6轮里的 goto /keys 会触发 /workspaces/default/keys 拉取——若本号其实有 auto-key,
        #   网络钩子可能已把明文落进 __or_key。给弹窗没开的号最后兜一次,捞到就当成功返回(免白失败一个已注册号)。
        _cap = _captured_key(page)
        if _cap:
            log("[取Key] 创建弹窗没开,但网络钩子已抓到 key ✓(/keys 拉取暴露的 auto-key)→ 直接用,不算失败")
            return {"ok": True, "key": _cap, "name": "captured", "key_path": "capture-fallback"}
        # ★诊断(判弹窗是【真没开】还是【开了但 name_visible 没认出来=误报】):New Key 按钮数(总/可见)、dialog/modal 数、
        #   可见文本输入数、页面文案头。下批据此精修(改 name_visible 检测 vs 改导航/点击)。
        _nk_diag = _newkey_fail_diag(page)
        log("[取Key] 创建弹窗没打开(已等dashboard稳+滚动入视+6轮重试仍没开) diag=%s" % str(_nk_diag)[:200])
        return {"ok": False, "key": None, "name": key_name, "reason": "NEWKEY_DIALOG_NOT_OPENED",
                "key_diag": _nk_diag, "key_capture_diag": _key_capture_diag(page)}
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
        return {"ok": True, "key": key, "name": key_name, "key_path": "newkey", "key_capture_diag": _key_capture_diag(page)}
    log("[取Key] 没抓到明文 key")
    return {"ok": False, "key": None, "name": key_name, "reason": "NEWKEY_NOT_CREATED"}
