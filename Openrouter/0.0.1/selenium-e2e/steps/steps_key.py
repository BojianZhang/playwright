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

from common import log, KEYS_URL, rand_name, rand_address


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
        "ins.forEach(function(el){var lab=((el.getAttribute('placeholder')||'')+' '+(el.getAttribute('name')||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.id||'')).toLowerCase();"
        "  var pl=(el.closest('label')&&el.closest('label').innerText||'').toLowerCase();var L=lab+' '+pl;"
        "  var isSel=el.tagName=='SELECT';"
        "  if(/address line 1|address1|line1|street|^address/.test(L)&&!isSel&&!el.value){setv(el,a.line1);n++;}"
        "  else if(/city|town/.test(L)&&!isSel&&!el.value){setv(el,a.city);n++;}"
        "  else if(/country/.test(L)){if(isSel){if(setsel(el,a.country)||setsel(el,'US'))n++;}else if(!el.value){setv(el,a.country);n++;}}"
        "  else if(/state|province|region/.test(L)){if(isSel){if(setsel(el,a.state))n++;}else if(!el.value){setv(el,a.state);n++;}}"
        "  else if(/zip|postal/.test(L)&&!isSel&&!el.value){setv(el,a.zip);n++;}"
        "});return n;", {"line1": addr.get("line1") or addr.get("address") or "123 Main St",
                          "city": addr.get("city"), "state": addr.get("state"), "zip": addr.get("zip"),
                          "country": addr.get("country") or "United States"})
    time.sleep(0.8)
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


# 注:曾有 _copy_key_from_clipboard()(点Copy读剪贴板兜底)已删除 —— navigator.clipboard.readText() 会弹 Chrome
#   权限框把向导页卡死(MEMORY 明令禁止)。明文 key 直接从 workspace-ready 的 fetch 示例 code/pre 抓即可,绝不读剪贴板。

# 进了新向导但没抓到明文 key 的哨兵:caller 据此【快速失败走整号重试】,绝不回落到新页面根本不存在的 New Key 路径
# (老号才有 New Key 按钮;在新向导页上点不存在的按钮→空耗+把新老两套页面动作混在一起)。
WIZARD_NO_KEY = "__WIZARD_NO_KEY__"


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
    for _i in range(20):
        t = page.all_frames_text() or ""
        # Welcome 首步(还没到角色选择)→ 点 Get started/Continue 推进,否则一直卡在欢迎页、抓不到 key。
        if re.search(r"Welcome to OpenRouter", t, re.I) and not re.search(r"How will you be using", t, re.I):
            if _native_click_el(page, _TEXTBTN_JS, r"Get started|Get Started|Get going|Continue|Next|Let.?s go"):
                log("[取Key] Welcome 步 → 点 Continue/Get started 推进")
            time.sleep(1.8)
            continue
        if re.search(r"How will you be using OpenRouter", t, re.I):
            # 还停在选择步 → (反复重)点 Individual。多候选:卡片描述 "Build side projects" 优先(点它冒泡到卡片 onClick),再退 Individual 文本。
            _native_click_el(page, r"""
              var els=[].slice.call(document.querySelectorAll('button,[role=button],div,a,span'));
              var t=els.find(function(b){return /Build side projects|side projects|prototype/i.test(b.innerText||'');});
              if(!t) t=els.find(function(b){var x=(b.innerText||'');return /\bIndividual\b/i.test(x) && /side projects|prototype|Build/i.test(x);});
              if(!t) t=els.find(function(b){return (b.innerText||'').trim()==='Individual';});
              return t ? (t.closest('button,[role=button],a')||t) : null;
            """)
            time.sleep(1.4)
            # 【关键】选了 Individual 后必须点 "Continue" 才进 workspace-ready 出 key —— 否则一直卡在"Welcome+角色选择"页。
            if _native_click_el(page, _TEXTBTN_JS, r"^Continue$|^Get started$|^Next$"):
                log("[取Key] 选 Individual 后 → 点 Continue 推进到 workspace-ready")
            time.sleep(2.2)
        # workspace-ready 这步 key 一闪而过(onReady=true 但秒切到 dashboard/models)→ 在此【多停留、密集快查】抓住它。
        # 【#7】on_ready 必须用【最新】文本判:上面点完 Individual+Continue 页面已切到 workspace-ready,
        #   循环顶部那次 t 是【过期】的(还停在角色选择步)→ 用旧 t 判会漏掉刚出现的 key。此处重新抓一次。
        t_now = page.all_frames_text() or ""
        on_ready = bool(re.search(r"Your workspace is ready|workspace is ready|Your API Key", t_now, re.I))
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
            # 问卷:必须【原生点】一个 radio 选项(否则 Continue 灰),Other/Not sure 优先,再 Continue
            _native_click_el(page, r"""
              var els=[].slice.call(document.querySelectorAll('label,[role=radio],input[type=radio],div,span,button'));
              var t=els.find(function(b){return /Other \/ Not sure/i.test(b.innerText||'');});
              if(!t) t=els.find(function(b){return (b.innerText||'').trim()==='Google';});
              if(!t) t=document.querySelector('[role=radio],input[type=radio]');
              return t ? (t.closest('label,[role=radio]')||t) : null;
            """)
            time.sleep(0.5)
            _native_click_el(page, _TEXTBTN_JS, r"^Continue$")
            time.sleep(1.3)
            continue
        # 支付/地址步:两种方式(填地址 / I'll do this later),记录到 page._pay_method
        if re.search(r"Add a payment method|billing address is required|Complete address details", t, re.I):
            if pay_mode == "address":
                _fill_wizard_address(page)
                try: page._pay_method = "wizard-address"
                except Exception: pass
            else:
                _native_click_el(page, _TEXTBTN_JS, r"I.?ll do this later|do this later|Skip for now|Maybe later")
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
                _native_click_el(page, _TEXTBTN_JS, r"I.?ll do this later|do this later|Skip for now|Maybe later")
                try: page._credit_method = "skip"
                except Exception: pass
                log("[向导积分] 方式=跳过(不扣款)")
            time.sleep(1.4)
            continue
        if _native_click_el(page, _TEXTBTN_JS, r"I.?ll do this later|do this later|Skip for now|Maybe later"):
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
    # 名字框出现=弹窗已开:#name 优先,再兜底任何可见的 name 输入框(新版弹窗 id/占位可能变)。
    name_visible = ("if(document.querySelector('#name')&&document.querySelector('#name').offsetParent!==null)return true;"
                    "return !!Array.from(document.querySelectorAll('input,textarea')).find(function(e){"
                    "return e.offsetParent!==null && /(^|[^a-z])name([^a-z]|$)/i.test((e.id||'')+' '+(e.getAttribute('name')||'')+' '+(e.getAttribute('placeholder')||''));});")
    # 打开创建弹窗：已开就别再点(再点会切掉)。New Key 是 React 按钮→【原生click】更可靠(evaluate点DOM可能不触发onClick)。
    opened = False
    for _ in range(4):
        if page.js(name_visible):
            opened = True
            break
        dismiss_onboarding(page)
        if not _native_click_el(page, _TEXTBTN_JS, r"New Key|Create Key|Create API Key|^Create$"):
            page.click_text(["New Key", "Create Key", "Create API Key"], 6)
        for _w in range(10):
            time.sleep(1)
            if page.js(name_visible):
                opened = True
                break
        if opened:
            break
    if not opened:
        log("[取Key] 创建弹窗没打开"); return {"ok": False, "key": None, "name": key_name}
    page.fill_in_frames(["#name", 'input[name="name"]', 'input[placeholder*="name" i]'], key_name)
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
