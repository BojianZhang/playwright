#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 关 onboarding 浮层 + 取 API Key（纯 Selenium，移植自 stages.js apiKey/dismissOnboarding）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/steps_key.py
# ═══════════════════════════════════════════════════════════════════════

import re
import time

from common import log, KEYS_URL, rand_name


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


def _handle_onboarding_wizard(page):
    """新版 onboarding 向导取 key(新号)。返回明文 key,或 None(非向导/老号/没抓到 → 交回老 New Key 流程)。
    【按页面内容判新老页,绝不按 URL 判】:新版 keys 页 URL 统一 /workspaces/default/keys,老号(已过onboarding)也在这,
    显示带 +New Key 的 dashboard;新号显示 Welcome→Individual→workspace ready→问卷→all set 向导。"""
    in_wizard = False
    for _ in range(14):
        t = page.all_frames_text() or ""
        # 向导文案【不含 "Your API Key"】(dashboard 的 "manage your API keys" 会误命中→把老号判成向导)
        wiz = bool(re.search(r"How will you be using OpenRouter|Welcome to OpenRouter|Your workspace is ready|workspace is ready|first hear about OpenRouter|You.?re all set", t, re.I))
        has_newkey = bool(re.search(r"New Key|Create Key|Create API Key", t, re.I))
        if wiz:
            in_wizard = True
            break
        if has_newkey:
            return None  # 老号 dashboard → 交回 New Key 流程
        time.sleep(1.5)
    if not in_wizard:
        return None
    log("[取Key] 检测到新号 onboarding 向导 → 走向导抓 key")
    # 1+2) 选 Individual(原生click,div卡片 DOM click 不触发 React)并等明文 key 出现
    key = None
    for _i in range(18):
        t = page.all_frames_text() or ""
        if re.search(r"How will you be using OpenRouter", t, re.I):
            _native_click_el(page, r"""
              var els=[].slice.call(document.querySelectorAll('button,[role=button],div,a'));
              var t=els.find(function(b){var x=(b.innerText||'');return /\bIndividual\b/i.test(x) && /side projects|prototype|Build/i.test(x);});
              if(!t) t=els.find(function(b){return (b.innerText||'').trim()==='Individual';});
              return t ? (t.closest('button,[role=button],a')||t) : null;
            """)
            time.sleep(2.5)
        # 抓完整明文 sk-or-(掩码 ••• 不匹配;明文在 "Your workspace is ready" 的 fetch 示例 code/pre 里)
        key = page.js(
            "var m=(document.body.innerText||'').match(/sk-or-[A-Za-z0-9-]{24,}/);if(m)return m[0];"
            "var els=document.querySelectorAll('input,textarea,code,pre');for(var i=0;i<els.length;i++){var v=els[i].value||els[i].textContent||'';var mm=String(v).match(/sk-or-[A-Za-z0-9-]{24,}/);if(mm)return mm[0];}return null;")
        if key:
            break
        time.sleep(2)
    if not key:
        log("[取Key] 向导内没抓到明文 key → 交回 New Key 流程")
        return None
    log("[取Key] 向导抓到 key ✓")
    # 3) 把向导剩余步骤推完:Continue / payment&credits→I'll do this later / 问卷→原生选radio+Continue / all-set→Go to Dashboard
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
    if wkey:
        log("[取Key] 成功(向导) %s… (%s)" % (wkey[:14], "onboarding"))
        return {"ok": True, "key": wkey, "name": "onboarding"}
    name_visible = "return !!(document.querySelector('#name')&&document.querySelector('#name').offsetParent!==null)"
    # 打开创建弹窗：已开就别再点(再点会切掉)。
    opened = False
    for _ in range(3):
        if page.js(name_visible):
            opened = True
            break
        dismiss_onboarding(page)
        page.click_text(["New Key", "Create Key", "Create API Key"], 6)
        for _w in range(8):
            time.sleep(1)
            if page.js(name_visible):
                opened = True
                break
        if opened:
            break
    if not opened:
        log("[取Key] 创建弹窗没打开"); return {"ok": False, "key": None, "name": key_name}
    page.fill_in_frames(["#name"], key_name)
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
