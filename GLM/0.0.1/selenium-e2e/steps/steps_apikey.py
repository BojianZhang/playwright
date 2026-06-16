#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 创建并抓取 z.ai API Key（纯 Selenium）
#
# 文件定位：GLM/0.0.1/selenium-e2e/steps/steps_apikey.py
#
# 流程:goto z.ai/manage-apikey/apikey-list → Add API Key → 填名称 → Create → 抓 key。
# 抓 key 三路兜底:① 导航前注入的网络钩子(create-key 响应里的明文 key,最可靠)→
#   ② 点复制按钮读剪贴板(已 CDP 预授 clipboardReadWrite)→ ③ DOM 取 key 文本(可能掩码)。
# 创建可【独立于订阅】运行(本步不强制要求已订阅)。
# ═══════════════════════════════════════════════════════════════════════

import os
import time

import common
from common import log, APIKEY_URL, fast_mode
from common.selectors import sel, sel_csv


# ── 登录后 API Key 页常弹推广浮层(「GLM Coding Plan / Value Subscription / Join Now」)盖住 Add 按钮 ──
#    ★只关弹窗(点右上角 X / close),【绝不点 Join Now / Learn More / Subscribe】—— 那会进订阅付费流(花钱风险)。
#    全部坐标取自 getBoundingClientRect(CSS px,与 CDP 点击同坐标系)→ 分辨率/DPR/缩放无关。
_FIND_PROMO_CLOSE_JS = r"""
return (function(promoStr, ctaStr){
  var PROMO=new RegExp(promoStr,'i'), CTA=new RegExp(ctaStr,'i');
  function rect(e){ try{ return e.getBoundingClientRect(); }catch(_){ return null; } }   // 脱离 DOM 的节点会抛 → 容错
  function vis(e){ if(!e) return false; var r=rect(e); if(!r) return false;
    var s; try{ s=getComputedStyle(e); }catch(_){ return false; }
    return r.width>4&&r.height>4&&s.visibility!=='hidden'&&s.display!=='none'&&parseFloat(s.opacity||'1')>0.01; }
  function vtxt(e){ try{ return ((e.innerText||e.textContent||'').replace(/\s+/g,' ')).trim(); }catch(_){ return ''; } }
  function ctxt(e){ try{ return (e.textContent||''); }catch(_){ return ''; } }   // 便宜:不触发 reflow,只用于 PROMO 预筛
  function attrs(e){ try{ return (((e.getAttribute&&e.getAttribute('aria-label'))||'')+' '
      +((e.getAttribute&&e.getAttribute('data-testid'))||'')+' '
      +(typeof e.className==='string'?e.className:((e.className&&e.className.baseVal)||''))).toLowerCase(); }catch(_){ return ''; } }
  function hasClose(s){ return /close|dismiss|关闭/.test(s); }
  // ★CTA 判定(用于"绝不点"):可见文案命中 CTA 必是;属性命中 CTA 但【同时含 close】不算(避免 data-testid="close-upgrade-modal"
  //   / className 含 cta/primary 把【关闭键】误杀成 CTA → 永远关不掉弹窗)。close 语义优先于 CTA 语义。
  function ctaHit(e){ if(!e) return false; var t=vtxt(e), a=attrs(e);
    if(t.length>0 && CTA.test(t)) return true;
    if(CTA.test(a) && !hasClose(a)) return true;
    return false; }
  var vw=window.innerWidth||1, vh=window.innerHeight||1;
  var minW=Math.min(200, vw*0.25), minH=Math.min(160, vh*0.22);   // 尺寸下限随视口缩放(小屏不误杀真弹窗)

  // 在【给定容器】内找关闭键(右上小图标、非 CTA、close 语义优先)。返回 {x,y} 或 null。
  function findClose(modal){
    var mr=rect(modal); if(!mr) return null;
    var x0=mr.left+mr.width*0.40, x1=mr.right-2, y0=mr.top+2, y1=mr.top+mr.height*0.50;
    var cands=[].slice.call(modal.querySelectorAll(
      'button,[role=button],a,svg,i,span,path,[aria-label],[class*=close],[data-testid*=close]'));
    var pick=null, pickScore=-1e15;
    for(var j=0;j<cands.length;j++){ var c=cands[j];
      var cc=(c.tagName==='svg'||c.tagName==='I'||c.tagName==='SPAN'||c.tagName==='path')
              ?(c.closest('button,[role=button],a,div[tabindex],[aria-label]')||c):c;
      if(!vis(cc)) continue;
      if(ctaHit(cc)) continue;                            // ★★绝不点 CTA(close 语义会豁免,见 ctaHit)
      var cr=rect(cc); if(!cr) continue;
      var cx=cr.left+cr.width/2, cy=cr.top+cr.height/2;
      if(cx<x0||cx>x1||cy<y0||cy>y1) continue;            // 严格在弹窗【内】右上区(不越界到页面)
      if(cr.width<6||cr.height<6||cr.width>72||cr.height>72) continue;   // 关闭键是小图标
      var t=vtxt(cc);
      if(t.length>2 && !hasClose(t) && !/×|✕|✖/.test(t)) continue;      // 有较长普通文案的不是关闭键
      var isClose=hasClose(attrs(cc))||t==='×'||t==='✕'||t==='✖'||t==='x'||t==='X'||t==='';
      var score=(isClose?1e6:0)-((mr.right-cx)+(cy-mr.top));            // close 语义优先;否则越靠右上越好
      if(score>pickScore){ pickScore=score; pick={x:cx,y:cy}; }
    }
    return pick;
  }

  // 1) 收集合格 PROMO 容器(尺寸合理、非整页),【按面积升序】→ 找含 X 的【最小】容器=对话框卡片本身。
  //    ★不取最小文字 span(无 X → 跳过)、也不取大包裹层(card 更小且也含 X → 先命中);兼顾审计两面(span / wrapper)。
  var all=[].slice.call(document.querySelectorAll('div,section,aside,[role=dialog],[role=alertdialog]'));
  var cont=[];
  for(var i=0;i<all.length;i++){ var e=all[i];
    if(!PROMO.test(ctxt(e))) continue;                    // 便宜预筛(textContent 不 reflow)
    if(!vis(e)) continue;
    var r=rect(e); if(!r) continue;
    if(r.width<minW||r.height<minH) continue;             // 太小不是弹窗主体(剔除文字 span)
    if(r.width>=vw*0.97&&r.height>=vh*0.97) continue;     // 整页遮罩/定位层
    var a=r.width*r.height;
    if(a>=vw*vh*0.88) continue;                           // 近全屏覆盖层 → 排除(取里面真卡片)
    cont.push({e:e, a:a});
  }
  if(!cont.length) return {found:false};
  cont.sort(function(p,q){ return p.a-q.a; });             // 小 → 大
  // 2) 最小的【能找到关闭键】的容器优先:text span 无 X→跳;button row 只有 CTA→跳;card 含 X→命中(=最贴合对话框)
  var modal=null, pick=null;
  for(var k=0;k<cont.length;k++){ var p=findClose(cont[k].e); if(p){ modal=cont[k].e; pick=p; break; } }
  if(!modal){ modal=cont[cont.length-1].e; }               // 谁都没找到 X → 用最大合格容器做右上角兜底(下有 elementFromPoint 安全闸)
  var mr=rect(modal); if(!mr) return {found:false};
  var out;
  if(pick) out={found:true, kind:'btn', x:pick.x, y:pick.y};
  else {                                                   // 兜底:弹窗右上角内缩(内缩量随弹窗尺寸,夹在 10~24px)
    var ins=Math.max(10, Math.min(24, mr.width*0.05));
    out={found:true, kind:'corner', x:mr.right-ins, y:mr.top+Math.max(10,Math.min(24,mr.height*0.05))};
  }
  out.modal={x:mr.left,y:mr.top,w:mr.width,h:mr.height};
  // 3) ★最终安全闸:点击点用 elementFromPoint 反查,若落在 CTA(Join Now/...) → 标 unsafe,Python 改走 Esc 不硬点(防误进订阅)
  try{
    var hit=document.elementFromPoint(out.x, out.y);
    var hb=(hit&&hit.closest)?(hit.closest('button,[role=button],a')||hit):hit;
    out.safe=!ctaHit(hb);
    if(!out.safe) out.hitText=vtxt(hb).slice(0,24);
  }catch(_){ out.safe=true; }
  return out;
})(arguments[0], arguments[1]);
"""


def _promo_pat():
    # 弹窗【独有】文案(不用 "Coding Plan" —— 侧栏导航也有,会误判整页)。可经 ORSEL_PROMO_MODAL_TEXT 覆盖。
    return "|".join(sel("promo_modal_text",
                        "Value Subscription", "Code Beyond Boundaries", "Join Now",
                        "flagship Model", "enjoy high quotas"))


def _cta_pat():
    # 绝不能点的行动按钮(点了会进订阅/付费)。覆盖面尽量全(含变体);可经 ORSEL_PROMO_CTA_TEXT 覆盖。
    return "|".join(sel("promo_cta_text",
                        "Join Now", "Learn More", "Subscribe", "Upgrade", "Get Started", "Buy",
                        "Claim", "Activate", "Enroll", "Redeem", "Recharge", "Checkout", "Pay",
                        "立即", "订阅", "升级", "购买", "开通", "充值"))


def dismiss_promo_modal(page, tries=3, appear_wait=None):
    """判断登录后 API Key 页有没有推广弹窗,有就关掉(只点 X / close,★绝不点 Join Now/订阅),没有则空操作(幂等)。
    返回【页面是否已无该弹窗】(True=干净可继续)。appear_wait:弹窗可能落地后延迟才弹 → 给一小段出现时间
    (出现即处理,没出现早退不空等满;默认 2s,可经 GLM_PROMO_APPEAR_WAIT 调)。"""
    appear_wait = appear_wait if appear_wait is not None else float(os.environ.get("GLM_PROMO_APPEAR_WAIT", "2.0") or 2.0)
    promo, cta = _promo_pat(), _cta_pat()

    def _probe():
        return page.js(_FIND_PROMO_CLOSE_JS, promo, cta) or {}

    # 等弹窗出现(它常在页面稳定后才弹);出现即往下处理,限时内没出现 → 没弹窗,页面已干净
    end = time.time() + appear_wait
    info = _probe()
    while not info.get("found") and time.time() < end:
        time.sleep(0.4); info = _probe()
    if not info.get("found"):
        return True

    for _ in range(tries):
        info = _probe()
        if not info.get("found"):
            log("[apikey] 推广弹窗已关闭"); return True
        x, y, kind = info.get("x"), info.get("y"), info.get("kind")
        # ★安全闸①:点击点反查落在 CTA → 绝不硬点,改 Esc(防误进订阅付费流)
        if info.get("safe") is False:
            log("[apikey] ⚠ 关闭点疑似落在 CTA(%s)→ 不点,改用 Esc 关闭" % (info.get("hitText") or ""))
            page.press_escape(); time.sleep(0.5); continue
        url0 = page.url() or ""
        log("[apikey] 检测到推广弹窗 → 关闭(%s @%.0f,%.0f 弹窗%.0fx%.0f)" % (
            kind, x, y, (info.get("modal") or {}).get("w") or 0, (info.get("modal") or {}).get("h") or 0))
        page.cdp_click(x, y); time.sleep(0.6)
        # ★安全闸②:点 X 不该离开 API Key 页;若跳走(误触订阅/付费)→ 立刻回退,绝不在付费页继续
        if "manage-apikey" not in (page.url() or "") and "manage-apikey" in url0:
            log("[apikey] ⚠⚠ 点击后离开了 API Key 页(%s)→ 疑似误触 → 立即返回 APIKEY 页" % ((page.url() or "")[:80]))
            page.goto(APIKEY_URL, wait=2.0)
    # 多次仍在 → Esc 兜底(零误点风险)
    page.press_escape(); time.sleep(0.5)
    clear = not _probe().get("found")
    if not clear:
        log("[apikey] ⚠ 推广弹窗多次尝试仍未关掉(继续点 Add,可能仍被遮挡)")
    return clear


# 导航前注入:包住 fetch / XHR,把 create-key 响应里的明文 key 落 sessionStorage(window.__glmKey)。
KEY_CAPTURE_JS = r"""
(function(){
  if(window.__glmKeyHook) return; window.__glmKeyHook=true;
  function looksKey(s){ return typeof s==='string' && s.length>=20 && /^[A-Za-z0-9._-]+$/.test(s) && /[A-Za-z]/.test(s) && /[0-9]/.test(s); }
  function scan(obj, depth){
    if(depth>4||obj==null) return null;
    if(typeof obj==='string'){ return looksKey(obj)?obj:null; }
    if(typeof obj==='object'){
      // 优先认 key/apiKey/api_key/secret/token 字段
      var pref=['key','apiKey','api_key','apikey','secret','token','value'];
      for(var i=0;i<pref.length;i++){ var v=obj[pref[i]]; if(looksKey(v)) return v; }
      for(var k in obj){ try{ var r=scan(obj[k], depth+1); if(r) return r; }catch(e){} }
    }
    return null;
  }
  function take(url, text){
    try{
      if(!/key/i.test(url||'')) return;
      var data; try{ data=JSON.parse(text); }catch(e){ data=text; }
      var k=scan(data,0);
      if(k){ window.__glmKey=k; try{ sessionStorage.setItem('__glmKey',k); }catch(e){} }
    }catch(e){}
  }
  var of=window.fetch;
  if(of){ window.fetch=function(){ var args=arguments;
    return of.apply(this,args).then(function(resp){ try{ var u=(args[0]&&args[0].url)||args[0];
      resp.clone().text().then(function(t){ take(String(u),t); }).catch(function(){}); }catch(e){} return resp; }); }; }
  var oo=XMLHttpRequest.prototype.open, os=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){ this.__glmU=u; return oo.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(){ var x=this;
    x.addEventListener('load',function(){ try{ take(String(x.__glmU||''), x.responseText); }catch(e){} }); return os.apply(this,arguments); };
})();
"""


def inject_key_capture(driver):
    """接管后、首次导航前注入(等价 Playwright addInitScript,对所有导航生效)。"""
    try:
        driver.execute_cdp_cmd("Page.enable", {})
    except Exception:
        pass
    try:
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": KEY_CAPTURE_JS})
        log("[apikey] key 网络抓取钩子已注入")
        return True
    except Exception as e:
        log("[apikey] 注入 key 钩子失败: %s" % str(e)[:60])
        return False


def _read_hooked_key(page):
    try:
        return page.js("return window.__glmKey || sessionStorage.getItem('__glmKey') || null")
    except Exception:
        return None


def _read_clipboard_key(page):
    """点过复制按钮后读剪贴板(已预授 clipboardReadWrite)。返回 key 或 None。"""
    try:
        v = page.d.execute_async_script(
            "var cb=arguments[arguments.length-1];"
            "try{navigator.clipboard.readText().then(function(t){cb(t||'');}).catch(function(){cb('');});}catch(e){cb('');}")
        v = (v or "").strip()
        if v and len(v) >= 20 and any(c.isalpha() for c in v) and any(c.isdigit() for c in v):
            return v
    except Exception:
        pass
    return None


def _dom_key(page):
    """从列表里抓最新一行的 API Key 文本(可能掩码;作为最后兜底)。"""
    try:
        return page.js(
            "var t=document.body.innerText||'';"
            "var m=t.match(/\\b[A-Za-z0-9_.-]{24,}\\b/);return m?m[0]:null;")
    except Exception:
        return None


# ── 创建对话框定位:名称输入框 + Create/确定按钮(★排除打开用的「Add API Key」与 Cancel,坐标供 CDP 可信点击)──
_APIKEY_DIALOG_JS = r"""
return (function(){
  function rect(e){ try{ return e.getBoundingClientRect(); }catch(_){ return null; } }
  function vis(e){ if(!e) return false; var r=rect(e); if(!r) return false; var s; try{ s=getComputedStyle(e); }catch(_){ return false; }
    return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&parseFloat(s.opacity||'1')>0.01; }
  function txt(e){ try{ return ((e.innerText||e.textContent||'').replace(/\s+/g,' ')).trim(); }catch(_){ return ''; } }
  function disabled(e){ try{ return e.disabled===true || e.getAttribute('aria-disabled')==='true'
    || /(^|\s)(disabled|is-disabled)(\s|$)/.test((typeof e.className==='string'?e.className:'')); }catch(_){ return false; } }
  var CRE=/(create|confirm|generate|save|ok|done|submit|创建|生成|确定|保存|完成)/i;
  var BAD=/(add\s*api\s*key|new\s*api\s*key|cancel|close|取消|关闭|learn\s*more|join\s*now|skip)/i;
  function findCreate(sc){ var bs=[].slice.call(sc.querySelectorAll('button,[role=button],a,[type=submit]')).filter(vis);
    for(var k=0;k<bs.length;k++){ var t=txt(bs[k]); if(t && !BAD.test(t) && CRE.test(t)) return bs[k]; } return null; }
  // 1) 名称输入框:placeholder 含 name 优先;否则取最后一个可见文本框(对话框 input 通常最后渲染)
  var inps=[].slice.call(document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit])')).filter(vis);
  var inp=null;
  for(var j=0;j<inps.length;j++){ if(/name/i.test(inps[j].getAttribute('placeholder')||'')){ inp=inps[j]; break; } }
  if(!inp && inps.length) inp=inps[inps.length-1];
  // 2) ★从 input 向上爬,找【含 Create 按钮】的最近祖先 = 真正的对话框作用域。
  //    修真机 bug:旧码取"最小含 input 的 modal 元素"会落到内层包裹(modal-body),其按钮在兄弟 footer 里 → 取不到按钮(实测 allButtons=[] → Create 找不到)。
  var scope=inp, btn=null, dlgFound=false;
  for(var up=0; up<10 && scope && scope!==document.body; up++){ btn=findCreate(scope); if(btn){ dlgFound=true; break; } scope=scope.parentElement; }
  if(!btn){ btn=findCreate(document); }   // 兜底:全页找 Create(BAD 已排除 Add/Cancel/Join/Skip → 基本只剩对话框 Create)
  var bscope=(dlgFound && scope) ? scope : document;
  var out={dialog:dlgFound};
  if(inp){ var ir=rect(inp); out.input={x:ir.left+ir.width/2, y:ir.top+ir.height/2, val:inp.value||'', ph:inp.getAttribute('placeholder')||''}; }
  if(btn){ var br=rect(btn); out.button={x:br.left+br.width/2, y:br.top+br.height/2, text:txt(btn).slice(0,30), disabled:disabled(btn)}; }
  out.allButtons=[].slice.call(bscope.querySelectorAll('button,[role=button],a,[type=submit]')).filter(vis).map(function(b){ return {t:txt(b).slice(0,24), d:disabled(b)}; }).filter(function(x){ return x.t; }).slice(0,24);
  return out;
})();
"""


# React 受控输入:用原生 setter + 派发 input/change(光 .value= 不触发 React onChange → Create 按钮可能一直 disabled)。
_REACT_FILL_JS = r"""
return (function(x,y,val){
  var el=document.elementFromPoint(x,y);
  if(!el) return null;
  if(el.tagName!=='INPUT'){ el=el.closest('label,div,form'); el=el?el.querySelector('input'):null; }
  if(!el) return null;
  try{
    var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    el.focus();
    setter.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true}));
    setter.call(el,val);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true}));
  }catch(e){ return 'ERR:'+e; }
  return el.value;
})(arguments[0],arguments[1],arguments[2]);
"""


def _dump_apikey_debug(page, tag):
    """落 API Key 创建对话框诊断(截图 + 对话框 DOM 快照)到 state/apikey-debug/,供真机定位「填名后不进下一步」根因。"""
    try:
        import json as _json
        d = os.path.join(common.HERE, "state", "apikey-debug")
        os.makedirs(d, exist_ok=True)
        page.shot(os.path.join(d, "%s.png" % tag))
        info = page.js(_APIKEY_DIALOG_JS) or {}
        with open(os.path.join(d, "%s.json" % tag), "w", encoding="utf-8") as f:
            _json.dump(info, f, ensure_ascii=False, indent=2)
        log("[apikey][debug] 已落对话框诊断 %s(对话框=%s 输入=%s 按钮=%s)" % (
            tag, info.get("dialog"), bool(info.get("input")),
            (info.get("button") or {}).get("text") if info.get("button") else None))
    except Exception as _e:
        try: log("[apikey][debug] 落诊断失败: %s" % str(_e)[:80])
        except Exception: pass


def _apikey_content_ready(page):
    """manage-apikey 取Key页【内容是否真渲染出来】(治黑屏:URL 对了但内容没出,只剩 logo+汉堡 → 永远找不到 Add 按钮)。
       判:有 Add/Create 按钮文案 / API key 列表区 / 正文文本够多(黑屏页正文极短)。"""
    try:
        return bool(page.js(r"""return (function(){
          try{
            var bt=((document.body&&document.body.innerText)||'')+'';
            if(/add api key|create api key|new api key|\+\s*add/i.test(bt)) return true;
            if(document.querySelector('table,[class*="apikey" i],[class*="api-key" i],[class*="key-list" i],[class*="api_key" i]')) return true;
            if(bt.replace(/\s+/g,'').length > 60) return true;   // 黑屏=只有 logo+汉堡,正文极短
            return false;
          }catch(e){return false;}
        })();"""))
    except Exception:
        return False


def get_api_key(page, name=None, on_key=None, relogin=None, on_node=None):
    """创建并抓取 API Key。返回 {ok, key, name, reason}。on_key(k) 抓到即回调(供 checkpoint 即时落盘)。
       relogin:可选无参回调,返回 bool —— 取 Key 页发现【未登录】(会话没从 chat.z.ai 带到 z.ai 取Key域,
       落到登出的「Welcome to Z.ai」选择屏)时调用它【重新登录】(点 Continue with Email→填号→滑块→提交),
       成功再继续建 Key。不给则未登录直接判 NOT_LOGGED_IN(老行为)。
       on_node(node,status):逐子步状态(apikey_login/apikey_promo/apikey_add_dialog/apikey_name/apikey_create/apikey_key_capture)→ 供逐节点统计。"""
    name = name or common.rand_name(8)
    def _nd(node, status):
        if on_node:
            try: on_node(node, status)
            except Exception: pass
    log("[apikey] 创建 API Key（名称=%s）" % name)
    # ★已登录态确认 —— 复用 steps_auth.detect_session 的【OAuth 稳定判定】:z.ai/manage-apikey 走 OAuth,
    #   已登录会先闪 chat.z.ai/auth?response_type=code 再跳回取 Key 页;旧码"一看到 /auth 就判 NOT_LOGGED_IN"
    #   会把【刚登录成功的好号】误杀。detect_session 会等跳转稳定 + 顺手关促销弹窗,落在取 Key 页才返回真值。
    from steps.steps_auth import detect_session as _detect_session
    if not _detect_session(page):
        # ★落到登出的「Welcome to Z.ai」选择屏 = 会话没保持 → 不放弃,用 relogin 重新登录后重试(用户:"你都不注册怎么玩")。
        if relogin is None:
            _nd("apikey_login", "fail:NOT_LOGGED_IN")
            return {"ok": False, "key": None, "name": name, "reason": "NOT_LOGGED_IN"}
        log("[apikey] 取 Key 页未登录(落到登录选择屏)→ 重新登录后重试")
        try:
            ok = bool(relogin()) and bool(_detect_session(page))
        except Exception as _e:
            log("[apikey] 重新登录异常: %s" % str(_e)[:80]); ok = False
        if not ok:
            _nd("apikey_login", "fail:NOT_LOGGED_IN")
            return {"ok": False, "key": None, "name": name, "reason": "NOT_LOGGED_IN"}
        log("[apikey] 重新登录成功 → 继续建 Key")
    _nd("apikey_login", "ok")

    # ★登录后先判推广弹窗(GLM Coding Plan / Value Subscription)有没有 → 有就关(只点 X,绝不点 Join Now),再创建
    _nd("apikey_promo", "ok" if dismiss_promo_modal(page) else "fail:PROMO_STUCK")

    # ★Opt1(开关 APIKEY_WAIT_CONTENT 默认开;旋钮 APIKEY_CONTENT_WAIT 默认12s):取Key页常【黑屏/空白】
    #   (URL 对但内容没渲染,只剩 logo+汉堡)→ 旧码无脑等 22s 找不存在的 Add 按钮(实测此环节 0% 成功、纯浪费)。
    #   改:先等【真内容渲染】,好了直接往下(更快);过半还黑屏→强制催渲染(关弹窗+滚动+resize,APIKEY_FORCE_RELOAD 开则硬刷);
    #   仍黑屏→快速失败 APIKEY_PAGE_BLANK(不再干等 22s,且失败原因更准,便于排查)。关掉(=0)则走老逻辑逐字节不变。
    if str(os.environ.get("APIKEY_WAIT_CONTENT", "1")).strip().lower() not in ("0", "false", "no", "off"):
        _cw = float(os.environ.get("APIKEY_CONTENT_WAIT", "12") or 12)
        _cend = time.time() + _cw; _ready = False; _forced = False
        while time.time() < _cend:
            if _apikey_content_ready(page):
                _ready = True; break
            if (not _forced) and (time.time() > _cend - _cw * 0.5):
                log("[apikey] 取Key页内容未渲染(黑屏)→ 强制催渲染")
                try: page.clear_promo()
                except Exception: pass
                try: page.js("try{window.scrollTo(0,document.body.scrollHeight);window.scrollTo(0,0);window.dispatchEvent(new Event('resize'));}catch(e){}")
                except Exception: pass
                if str(os.environ.get("APIKEY_FORCE_RELOAD", "0")).strip().lower() in ("1", "true", "yes", "on"):
                    try: page.js("location.reload(true)"); time.sleep(2.0)
                    except Exception: pass
                _forced = True
            time.sleep(0.5)
        if not _ready:
            if str(os.environ.get("APIKEY_DEBUG", "1")).lower() not in ("0", "", "false", "no"):
                _dump_apikey_debug(page, "%s-blank" % (name or "key"))
            _nd("apikey_add_dialog", "fail:APIKEY_PAGE_BLANK")
            log("[apikey] %.0fs 取Key页内容仍未渲染(黑屏)→ 快速失败 APIKEY_PAGE_BLANK" % _cw)
            return {"ok": False, "key": None, "name": name, "reason": "APIKEY_PAGE_BLANK"}

    # ① 打开「Add API Key」/「Create API key」对话框
    _add = sel("apikey_add", "Add API Key", "Create API key", "Add API key", "New API Key", "+ Add API Key")
    if not page.click_text(_add, 12):
        # 点不到多半是弹窗在落地后才弹出来盖住了按钮 → 再关一次弹窗 + 强清残留遮罩(复用 Page.clear_promo)再点
        dismiss_promo_modal(page, appear_wait=1.5)
        page.clear_promo()
        if not page.click_text(_add, 8):
            # ★落诊断:截图+列出页面所有按钮文案 → 真机看是【弹窗没关干净盖住】还是【Add 按钮文案不符】(实测 ADD_BUTTON_NOT_FOUND 高发,需真页定位)
            if str(os.environ.get("APIKEY_DEBUG", "1")).lower() not in ("0", "", "false", "no"):
                _dump_apikey_debug(page, "%s-add-fail" % (name or "key"))
            _nd("apikey_add_dialog", "fail:ADD_BUTTON_NOT_FOUND")
            return {"ok": False, "key": None, "name": name, "reason": "ADD_BUTTON_NOT_FOUND"}
    _nd("apikey_add_dialog", "ok")
    time.sleep(1.2)

    # ② 填名称(对话框「Please enter a name to identify this API key」)
    #    ★用对话框作用域定位(_APIKEY_DIALOG_JS),先 Selenium 真键入(最稳触发 React),不行再 JS 原生 setter+派发 input/change。
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    debug = str(os.environ.get("APIKEY_DEBUG", "1")).lower() not in ("0", "", "false", "no")
    filled = False
    info = page.js(_APIKEY_DIALOG_JS) or {}
    _inp = info.get("input") or {}
    # (a) Selenium 真键入(优先 placeholder 含 name 的可见框)
    for css in sel("apikey_name", 'input[placeholder*="name" i]', "input[type=text]", "input:not([type=hidden])"):
        try:
            for el in page.d.find_elements(By.CSS_SELECTOR, css):
                if el.is_displayed():
                    el.click(); common.clear_input(el, Keys); el.send_keys(name)
                    filled = True
                    break
        except Exception:
            pass
        if filled:
            break
    # (b) 校验值是否真进了对话框输入框;没进 → JS 原生 setter + 派发事件(React 受控输入,否则 Create 一直 disabled)
    chk = page.js(_APIKEY_DIALOG_JS) or {}
    if _inp.get("x") is not None and not ((chk.get("input") or {}).get("val") or "").strip():
        v = page.js(_REACT_FILL_JS, _inp.get("x"), _inp.get("y"), name)
        log("[apikey] 名称 Selenium 没填进 → JS 受控填值=%s" % str(v)[:30])
        filled = bool(v) and not str(v).startswith("ERR")
    if not filled:
        log("[apikey] ⚠ 名称输入框没找到/没填进(继续尝试 Create;失败归因带 NO_NAME)")
    _nd("apikey_name", "ok" if filled else "fail:NAME_NOT_FILLED")
    time.sleep(0.6)

    # ③ Create —— 对话框作用域找按钮(排除打开用的 Add API Key / Cancel),CDP 可信点击(React 控件 Selenium click 可能不触发)
    info = page.js(_APIKEY_DIALOG_JS) or {}
    _btn = info.get("button") or {}
    _clicked = False
    if _btn.get("x") is not None:
        if _btn.get("disabled"):
            # 按钮 disabled = React 没认到名称 → 再 JS 受控填一次,重探
            if (info.get("input") or {}).get("x") is not None:
                page.js(_REACT_FILL_JS, info["input"]["x"], info["input"]["y"], name); time.sleep(0.4)
            info = page.js(_APIKEY_DIALOG_JS) or {}; _btn = info.get("button") or {}
        log("[apikey] Create 按钮=「%s」disabled=%s → CDP 可信点击 @%.0f,%.0f" % (
            _btn.get("text"), _btn.get("disabled"), _btn.get("x") or 0, _btn.get("y") or 0))
        if not _btn.get("disabled"):
            page.cdp_click(_btn["x"], _btn["y"]); _clicked = True; time.sleep(0.6)
    # 兜底:对话框定位失败 → 老的文本点击(但绝不用「Add」防止误点打开按钮)
    if not _clicked:
        _clicked = page.click_text(sel("apikey_create", "Create API Key", "Create", "Confirm", "Generate", "Save", "确定", "创建", "生成"), 8)
    if not _clicked:
        if debug:
            _dump_apikey_debug(page, "%s-create-fail" % (name or "key"))
        log("[apikey] ⚠ Create 按钮点不动(已落诊断 state/apikey-debug)→ 看 allButtons 定位真实文案/是否 disabled")
        _reason = "CREATE_DISABLED_NO_NAME" if not filled else "CREATE_BUTTON_NOT_FOUND"
        _nd("apikey_create", "fail:" + _reason)
        return {"ok": False, "key": None, "name": name, "reason": _reason}
    _nd("apikey_create", "ok")

    # ④ 抓 key:网络钩子 → 剪贴板(点复制) → DOM
    key = None
    end = time.time() + 12
    while time.time() < end and not key:
        key = _read_hooked_key(page)
        if key:
            log("[apikey] 网络钩子抓到 key")
            break
        time.sleep(0.5)
    if not key:
        # 点列表里的复制按钮再读剪贴板
        try:
            page.d.execute_script(
                "var b=document.querySelector('[class*=copy i],[aria-label*=copy i],[title*=copy i],button svg');"
                "if(b){var c=b.closest('button')||b;c.click();}")
            time.sleep(0.6)
            key = _read_clipboard_key(page)
            if key:
                log("[apikey] 剪贴板读到 key")
        except Exception:
            pass
    if not key:
        key = _dom_key(page)
        if key:
            log("[apikey] DOM 兜底抓到 key（可能掩码,真机需核验）")

    if key:
        _nd("apikey_key_capture", "ok")
        if on_key:
            try: on_key(key)
            except Exception: pass
        return {"ok": True, "key": key, "name": name, "reason": None}
    # 取不到 key:若名称框当初没填上,极可能是 Create 因缺名被拦 → 归因到名称框,便于真机改选择器。
    reason = "KEY_NOT_CAPTURED_NO_NAME" if not filled else "KEY_NOT_CAPTURED"
    _nd("apikey_key_capture", "fail:" + reason)
    return {"ok": False, "key": None, "name": name, "reason": reason}


__all__ = ["inject_key_capture", "get_api_key", "dismiss_promo_modal", "KEY_CAPTURE_JS"]
