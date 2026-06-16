#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 加卡 + 充值（纯 Selenium，重构自已验证的 addcard.py / purchase.py）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/steps_billing.py
#
# hCaptcha：先 captcha.solve_hcaptcha 自动解，失败转 captcha.manual_hcaptcha 人工。
# ═══════════════════════════════════════════════════════════════════════

import re
import os
import time
import random

from common import (log, CREDITS_URL, NUM, EXP, CVC, ZIP, digits,
                    RE_502, RE_DECL, RE_OK, RE_NEEDPHONE, RE_HCAPTCHA)
from services import captcha
import common

ADDR_NAME = ['input[name="name"]', 'input[autocomplete="name"]', 'input[placeholder*="Full name" i]']


def _handle_hcaptcha(page, cfg, manual=True, patcher=None, proxy=None):
    """Save/Purchase 后处理 hCaptcha。返回 (是否可继续, 是否弹过hCaptcha)。
       patcher=跨OOPIF注入;proxy=账号代理(让 2Captcha 走同IP解,token IP=会话IP 防502)。
       策略:2Captcha【走账号代理】解(主)→ 没过则【人工兜底】等手动点(同会话同IP,天然不502)。"""
    time.sleep(2)
    detected = captcha.has_hcaptcha(page.d)
    if not detected:
        # 兜底:有些"I am human / One more step"框外层是自定义壳、框嵌在更深 iframe,
        # has_hcaptcha 的一层 iframe 检测抓不到 → 用主文档可见的壳文案兜底识别,
        # 否则会漏判成 server-error 去切IP(而非该走的 hcaptcha→换卡)。
        try:
            if RE_HCAPTCHA.search(page.all_frames_text() or ""):
                detected = True
                log("⚠ iframe 没抓到但壳文案命中(I am human/Select the checkbox)→ 判定有校验框")
        except Exception:
            pass
    if not detected:
        return True, False
    # 诊断模式:只 dump 集成结构,不解码(不烧2captcha)。用法 HCAP_DUMP=1 跑一次抓结构。
    import os as _os
    if _os.environ.get("HCAP_DUMP"):
        try:
            captcha.dump_hcaptcha_state(page.d, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "state", "_hcap_dump.json"))
        except Exception as _e:
            log("[hcap-dump] 异常: %s" % str(_e)[:60])
        return False, True
    # ① 主路径:2Captcha【走账号同一代理】解(token IP=会话IP)+ 跨 OOPIF 注入。Stripe 后端校验 token
    #    来路一致 → 不再 502(Proxyless 用 2Captcha 自家IP、IP不匹配,被严查会话就 502)。HCAP_2CAPTCHA=0 关掉直走人工。
    import os as _os
    if _os.environ.get("HCAP_2CAPTCHA", "1") != "0":
        log("⚠ 检测到 hCaptcha → 2Captcha【走账号代理】求解(token IP=会话IP,防502)…")
        to = int(cfg.get("captcha_timeout", 120))
        if captcha.solve_hcaptcha(page.d, page.url(), cfg, timeout=to, patcher=patcher, proxy=proxy):
            time.sleep(2)
            log("✓ 2Captcha(走代理)求解+注入通过")
            return True, True
    # ②a 不点人工 · 弹框即换卡模式(HCAP_NO_MANUAL=1,用户实测策略):一弹验证框就【不点人工】、
    #     直接判 hcaptcha → 上层【冻结当前卡(冷却)+ 换另一张卡】重试,看换张卡能否避开框/绑成。
    if _os.environ.get("HCAP_NO_MANUAL", "0") == "1":
        log("🧊 检测到验证框 → 不点人工,直接判 hcaptcha(上层冻结当前卡 + 换卡再试)")
        return False, True
    # ② 人工兜底:自动解没过(或被502)→ 等人在该浏览器窗口手动点 'I am human'(同会话同IP,天然不502)
    to_m = int(cfg.get("manual_hcaptcha_timeout", 180))
    log("🙋 hCaptcha 自动解没过 → 【请在该浏览器窗口手动点 'I am human'】,最多等 %ds…" % to_m)
    def _done_check():
        # 人工点过后立刻判终态:502(unable-to-authenticate)/被拒/绑成/卡表单消失 → 结束等待,
        # 让 add_card 立马处理(尤其 502→换新卡段,不停留)。
        try:
            t = page.all_frames_text() or ""
        except Exception:
            return False
        tl = t.lower()
        if RE_502.search(t) and (("unable to authenticate" in tl) or ("choose a different payment" in tl)):
            return True
        if RE_DECL.search(t) or RE_OK.search(t):
            return True
        if (not page.field_present(NUM)) and ("Card number" not in t) and ("Add a Payment Method" not in t):
            return True   # 卡表单/弹窗消失 = 疑绑成
        return False
    ok = captcha.manual_hcaptcha(page.d, timeout=to_m, done_check=_done_check)
    log("✓ 人工已过 hCaptcha" if ok else "✗ 人工兜底超时仍没过 → 标 hcaptcha")
    return ok, True


def _card_attached(page):
    """刷新 Credits 页,核验账户【是否其实已挂上支付方式】—— 绑卡成功的权威信号,
       即使弹窗没自动关 / 同时弹了 502 toast(用户实测 2026-06-11:有的号其实绑成了,
       卡进了账户,但弹窗不关、还可能带 Error 502 → 旧逻辑看弹窗没关就误判 502 失败,把真绑成的号扔了)。
       判定(避免误判成功不可逆,要求强信号):刷新后【无 need-a-payment-method 文案】且
       (出现已保存卡形态 / 有 Auto Top-Up 且无 Add-a-Payment-Method 入口)。"""
    try:
        page.goto(CREDITS_URL, wait=3)
        time.sleep(2.5)
        try:
            from steps import steps_key
            steps_key.dismiss_onboarding(page)
        except Exception:
            pass
        t = page.all_frames_text() or ""
        tl = t.lower()
        # need_pm 不可靠:账户挂了卡、但该卡不支持【离线扣费】时,Auto Top-Up 区块照样提示
        # "need a payment method that supports offline charging" → 不能拿它当"没卡"。仅作弱信号参考。
        need_pm = "need a payment method" in tl
        has_addpm = bool(page.js(
            "return !!Array.from(document.querySelectorAll('button,[role=button],a')).find(function(b){return /Add a Payment Method|Add Payment Method/i.test(b.innerText||'');})"))
        auto_topup = bool(re.search(r"Auto\s*Top-?Up", t, re.I))
        # 已保存卡形态(刷新后无输入框,出现这些=账户里挂着卡,这是权威信号):
        #   掩码卡 '•••• 1234' / 'ending in 1234' / 'VISA …1234'
        saved_card = (
            bool(re.search(r"[•·*•‧∙.]{2,}\s*\d{4}\b", t))
            or bool(re.search(r"ending\s*(?:in)?\s*\d{4}", t, re.I))
            or bool(re.search(r"(visa|mastercard|amex|discover)\b[^\n]{0,14}\d{4}\b", t, re.I))
        )
        # ★onboarding 前置门(收紧,严守 card-bound 铁律):页面仍有任一 onboarding 向导文案(Welcome/角色选择/问卷/
        #   积分空态)时,has_addpm=False 很可能只是【向导浮层盖住了 Add-PM 按钮、按钮没渲染】,而非账户真挂了卡。
        #   此时绝不靠 auto_topup 弱信号判已绑(否则把"其实没卡的 onboarding 态"误判 card-bound → 删环境+扣 BIN 用量,
        #   不可逆)。强信号(已存卡掩码尾号)不受此门影响——真挂了卡才认。
        # ★校正:onboarding_up 只认【真向导文案】——绝不含 "Add credits to get started"/"How much would you like to add",
        #   后两句在【合法已绑老号】的 /credits 购买区也常驻,计入会把"尾号未渲染的已绑老号"误判未绑 → precheck 重绑 + 二次扣 BIN。
        onboarding_up = bool(re.search(
            r"How will you be using OpenRouter|Welcome to OpenRouter|first hear about OpenRouter|You.?re all set",
            t, re.I))
        # 检测到已存卡 → 直接算已绑(与 need_pm 无关);较弱的 auto_topup 信号仍需无加卡入口且无 need_pm 且【无 onboarding 残留】才算
        attached = saved_card or (auto_topup and not has_addpm and not need_pm and not onboarding_up)
        log("[加卡] 绑卡核验: saved_card=%s auto_topup=%s has_addpm=%s need_pm=%s onboarding=%s → %s" % (
            saved_card, auto_topup, has_addpm, need_pm, onboarding_up, "已绑✓" if attached else "未绑"))
        return attached
    except Exception as _e:
        log("[加卡] 绑卡核验异常(保守按未绑处理): %s" % str(_e)[:70])
        return False


# 页面内卡片选择器浮层(自安装,仅顶层 frame;CSP 安全:不用 innerHTML 内联事件,全 createElement+addEventListener)。
# 读 window.__cardList([{id,last4,bin,bound,used,max,current}])渲染右上角浮层,点一行 → window.__manualCardPick=id。
CARD_PANEL_JS = r"""
(function(){
  if (window.top !== window) return;                 // 只在顶层文档画,Stripe iframe 不画
  if (window.__cardPanelRender){ window.__cardPanelRender(); return; }   // 已装过 → 直接重渲染
  var box=document.createElement('div');
  box.id='__card_panel';
  box.style.cssText='position:fixed;top:8px;right:8px;z-index:2147483647;width:252px;max-height:82vh;overflow:auto;background:#1e1e1e;color:#eee;font:12px/1.45 monospace;border:2px solid #4a90d9;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.5);padding:8px;';
  (document.body||document.documentElement).appendChild(box);
  window.__cardPanelRender=function(){
    var list=window.__cardList||[], picked=window.__manualCardPick;
    box.innerHTML='';
    var head=document.createElement('div');
    head.style.cssText='font-weight:bold;color:#4a90d9;margin-bottom:6px;';
    head.textContent='🃏 可用卡 — 点一张改用';
    box.appendChild(head);
    if(window.__cardPanelHint){var h=document.createElement('div');h.style.cssText='color:#f5a623;margin-bottom:6px;white-space:normal;';h.textContent=window.__cardPanelHint;box.appendChild(h);}
    list.forEach(function(c){
      var row=document.createElement('div');
      var isCur=!!c.current, isPick=(picked&&picked===c.id), cooling=!!c.cooling;
      row.style.cssText='cursor:pointer;padding:4px 6px;border-radius:4px;margin:2px 0;opacity:'+(cooling?'0.55':'1')+';background:'+(isPick?'#2d6a2d':(isCur?'#33415e':'transparent'))+';';
      var coolTag = cooling ? ('  ❄'+(c.coolMin||0)+'m') : '';
      row.textContent='••'+c.last4+'  段'+c.bin+'  已绑'+c.bound+'  余'+(c.max-c.used)+'/'+c.max+coolTag+(isPick?'  ✅选中':(isCur?'  ◀当前':''));
      row.addEventListener('click',function(){ window.__manualCardPick=c.id; window.__cardPanelRender(); });
      box.appendChild(row);
    });
  };
  window.__cardPanelRender();
})();
"""


def _manual_card_pick(page, card, cfg):
    """页面内卡片面板:注入浮层(列出 active 卡+已绑次数,高亮当前卡),留几秒窗口让用户点别的卡改用。
       不点 → 返回原 card;点了别的 active 卡 → 返回那张。MANUAL_CARD_WAIT=0 则只显示不阻塞。"""
    import os as _os
    try:
        wait_s = float(_os.environ.get("MANUAL_CARD_WAIT", cfg.get("manual_card_wait", 6)))
    except Exception:
        wait_s = 6.0
    cur_id = card.get("id") or card.get("number")
    cur4 = str(card.get("last4") or "")[-4:]

    def _hint(txt):
        try:
            page.js("window.__cardPanelHint=arguments[0]; window.__cardPanelRender&&window.__cardPanelRender();", txt)
        except Exception:
            pass

    try:
        cards = common.list_active_cards()
        for c in cards:
            c["current"] = (c["id"] == cur_id)
        hint0 = ("👉 点一张卡填它;不点 %d 秒后自动用 ••%s" % (int(wait_s), cur4)) if wait_s > 0 else ("当前 ••%s(只展示)" % cur4)
        page.js("window.__cardList=arguments[0]; window.__cardPanelHint=arguments[1]; window.__manualCardPick=null;", cards, hint0)
        page.js(CARD_PANEL_JS)
    except Exception as _e:
        log("[加卡] 卡片面板注入失败(忽略,走自动): %s" % str(_e)[:60])
        return card
    if wait_s <= 0:
        return card
    deadline = time.time() + wait_s
    last_shown = -1
    while time.time() < deadline:
        try:
            pick = page.js("return window.__manualCardPick || '';") or ""
        except Exception:
            pick = ""
        if pick and pick != cur_id:
            nc = common.get_card_by_id(pick)
            if nc:
                n4 = str(nc.get("last4") or "")[-4:]
                log("[加卡] 人工改用 ••%s(段%s)替代 ••%s" % (n4, (nc.get("number") or "")[:6], cur4))
                _hint("✅ 已选 ••%s,正在填卡…" % n4)
                return nc
            try:
                page.js("window.__manualCardPick=null;")   # pick 无效(被禁/用完)→ 清掉继续等
            except Exception:
                pass
        # 活的倒计时:每秒刷新提示,让你清楚还能点多久(消除"6秒可改"过期误导)
        remain = int(deadline - time.time()) + 1
        if remain != last_shown:
            last_shown = remain
            _hint("⏳ 还剩 %ds 可点卡改用(当前 ••%s)" % (max(0, remain), cur4))
        time.sleep(0.25)
    # 窗口结束、没改 → 锁定提示(不再显示"可改卡")
    _hint("🔒 已锁定 ••%s,提交中 — 改卡请等下一次" % cur4)
    return card


def _click_link_save(page):
    """点 Stripe Link 的 "Save card?" 弹窗里的 "Save"(把卡存进 Link,方便用户后续在该环境手动测试)。
       与主按钮 "Save payment method" 区分:Link 弹窗文案含 'Save card?' / 'save your card and encrypted'。"""
    try:
        clicked = page.js(r"""
          try {
            var blocks = Array.from(document.querySelectorAll('div,section,aside,[role=dialog]'))
              .filter(function(el){ return /Save card\?|save your card and encrypted/i.test(el.innerText||''); });
            for (var i=0;i<blocks.length;i++){
              var btn = Array.from(blocks[i].querySelectorAll('button')).find(function(b){
                var t=(b.innerText||'').trim(); return /^Save$/i.test(t); });
              if (btn){ btn.click(); return true; }
            }
            return false;
          } catch(e){ return false; }
        """)
        if clicked:
            log("[加卡] ✓ 已点 Link 'Save card?' 的 Save(卡存进 Link,供你后续手动测试)")
        return bool(clicked)
    except Exception:
        return False


def _fill_save_cdp(page, card, address, save_timeout=60, cfg=None, patcher=None, proxy=None, solve_hcap=False):
    """Fix C:卡表单已开好 → 原生CDP Input 填卡+取消Link+点Save(脱离chromedriver、零检测)→ 重连核验。
       返回与 add_card 同契约的 {result, detail, hcaptcha}。失败偏【换卡/换卡段】(FixC 失败基本是卡/Radar 非IP)。
       solve_hcap=True 时遇图片hcaptcha当场用 2captcha 解(需 patcher 已注 hcaptcha hook;★可能破坏免检会话)。"""
    from cardbind import fixc_core
    forced = os.environ.get("FIXC_FORCE_CARD")   # "卡号 MMYY CVC [ZIP]" → 强制用这张卡(测好卡用,绕过 load_card)
    if forced:
        p = forced.split()
        if len(p) >= 3:
            card = {"number": p[0], "expMonth": p[1][:2], "expYear": p[1][2:], "cvc": p[2],
                    "zip": (p[3] if len(p) > 3 else "59601"), "last4": p[0][-4:], "id": "forced-" + p[0][-4:]}
            log("[加卡FixC] 强制用指定好卡 ••%s(zip=%s)" % (p[0][-4:], card["zip"]))
    # 规范成 MMYY(月补2位、年取后2位)——FixC 填卡后会【回读校验值必须相等】,年份给成4位(2030)
    # 会和字段显示的2位(30)对不上→死循环重填。
    exp = "%s%s" % (str(card["expMonth"]).zfill(2)[-2:], str(card["expYear"])[-2:])
    # ZIP 候选(declined 时按顺序切换、重试【同一张卡】):卡自带有效US邮编优先(AVS匹配),后接【免税州ZIP】(实测成功率高)
    TAXFREE_ZIPS = ["59601", "97301", "03301", "19711", "99501", "59718", "97401", "19901"]  # MT/OR/NH/DE/AK 免税州
    _cz = "".join(ch for ch in str(card.get("zip") or "") if ch.isdigit())
    _cz = _cz if len(_cz) == 5 else ""                   # 卡自带 zip 仅当是有效5位美国邮编才用(过滤 999077 这种无效值)
    _zlist = ([_cz] if _cz else []) + TAXFREE_ZIPS
    _seen = set(); _zlist = [z for z in _zlist if not (z in _seen or _seen.add(z))]
    zipc = _zlist[0]
    alt_zips = _zlist[1:1 + int(os.environ.get("ZIP_RETRY", "3"))]   # declined 后最多再切几个ZIP重试(默认3)
    cap = None; declined_seen = False; bound_seen = False; used_zip = zipc
    port = fixc_core.port_from_driver(page.d)
    try:
        out = fixc_core.cdp_fill_and_save(page.d, str(card["number"]), exp, str(card["cvc"]), zipc, log=log, alt_zips=alt_zips,
                                          cfg=cfg, patcher=patcher, proxy=proxy, solve_hcap=solve_hcap, page_url=page.url())
        cap = out.get("captcha"); port = out.get("port") or port
        declined_seen = bool(out.get("declined"))
        bound_seen = bool(out.get("bound_seen"))
        used_zip = out.get("used_zip") or zipc
    except Exception as e:
        log("[加卡FixC] 填卡/Save 异常: %s" % str(e)[:90])
    # 必须先把 page.d 重连回活 driver:declined/hcaptcha/card-502 都要【回到 while 循环重试】(retry 会 page.goto,
    # 没活 driver 就炸)。先探活端口:不通=浏览器被外部关了(AdsPower回收/资源/并发GC)→ 别傻等9分钟重连,
    # 抛"session deleted"让上层【就地重启环境重试】(走 _is_browser_crash 路径,且不消耗卡)。
    if not port or not common._port_ready(port, 6):
        log("[加卡FixC] 调试端口不通=浏览器已被外部关闭 → 抛崩溃交上层就地重启(不消耗卡)")
        raise RuntimeError("session deleted: 加卡后调试端口 %s 不通(浏览器被外部关闭)" % port)
    try:                                            # 快速重连(2次足矣,别用默认 8×~66s 把死浏览器干等9分钟)
        page.d = common.attach_chrome(port, common.resolve_chromedriver(port), retries=2, delay=2)
    except Exception as e:
        log("[加卡FixC] 重连失败 → 抛崩溃交上层就地重启: %s" % str(e)[:60])
        raise RuntimeError("session deleted: 加卡后重连失败(%s)" % str(e)[:40])
    if declined_seen:                               # 刷新前在卡iframe抓到"被拒"——最可靠,直接禁卡换卡(别让刷新冲掉文案误判成card-502→复用)
        try: common.mark_zip_result(used_zip, "declined")
        except Exception: pass
        return {"result": "declined", "detail": "FixC卡被拒(刷新前抓到)", "hcaptcha": bool(cap), "used_zip": used_zip}
    bound = False
    if bound_seen:
        # CDP 内部轮询已见 Auto Top-Up 强信号=绑成(fixc_core 注释:此信号"调用方不必再重连核验")→
        #   跳过 _card_attached 的整页 goto(/credits) 刷新,省那次"页面刷新"(用户报的另一半症状)。
        #   配合 fixc_core 默认关 Save card? 弹窗:弹窗一关→露出 Auto Top-Up→bound_seen=True→此处不再 reload。
        #   declined/弱态(bound_seen=False)仍走 _card_attached 权威核验,不动。
        log("[加卡FixC] ✓ CDP 内部已确认绑成(Auto Top-Up 强信号)→ 跳过刷新核验(省一次 /credits 重载)")
    else:
        try:
            bound = _card_attached(page)
        except Exception:
            pass
    if bound or bound_seen:                         # 核验已挂卡 / 内部轮询已见 Auto Top-Up 绑成
        log("[加卡FixC] ✓ 账户已挂卡(核验=%s 轮询=%s,ZIP=%s)" % (bound, bound_seen, used_zip))
        try: common.mark_zip_result(used_zip, "card-bound")
        except Exception: pass
        return {"result": "card-bound", "detail": "FixC原生CDP绑成", "hcaptcha": bool(cap), "used_zip": used_zip}
    txt = ""
    try:
        txt = page.all_frames_text() or ""
    except Exception:
        pass
    if cap:
        return {"result": "hcaptcha", "detail": "FixC后弹验证框未过(换卡)", "hcaptcha": True, "used_zip": used_zip}
    if RE_DECL.search(txt):
        try: common.mark_zip_result(used_zip, "declined")
        except Exception: pass
        return {"result": "declined", "detail": "FixC后卡被拒", "hcaptcha": False, "used_zip": used_zip}
    return {"result": "card-502", "detail": "FixC后未绑→换卡段", "hcaptcha": False, "used_zip": used_zip}


def _fill_billing_address(page, address):
    """账单地址(新账号才有;地址已存则跳过)。地址表单在 → 填+提交并返回 True;不在 → 返回 False。
       抽成函数:刷新兜底重开后若地址表单又回来了,可复用这同一段重新填(否则卡表单永不出 → 纯空耗)。"""
    if not page.field_present(ADDR_NAME):
        return False
    log("[加卡] 填账单地址")
    page.wait_and_fill(ADDR_NAME, address["name"], 12, "姓名")
    page.wait_and_select(['select[name="country"]', 'select[autocomplete="country"]'], address["country"], 10, "国家")
    page.wait_and_fill(['input[name="addressLine1"]', 'input[name="line1"]', 'input[autocomplete="address-line1"]'], address["line1"], 12, "地址行1")
    # 新版账单 UI 常【只有 Address line 1】(无独立 city/state/zip);老版 Stripe Address Element 才有这几个。
    # → 这几个【存在才填 + 短超时4s】,避免在不存在的字段上各死等12s(~34s白费,既拖慢又可能误判超时)。
    _city = ['input[name="locality"]', 'input[name="city"]', 'input[autocomplete="address-level2"]']
    _state = ['select[name="administrativeArea"]', 'select[autocomplete="address-level1"]']
    _zip = ['input[name="postalCode"]', 'input[autocomplete="postal-code"]']
    if page.field_present(_city):
        page.wait_and_fill(_city, address["city"], 4, "城市")
    if page.field_present(_state):
        page.wait_and_select(_state, address["state"], 4, "州")
    if page.field_present(_zip):
        page.wait_and_fill(_zip, address["zip"], 4, "邮编")
        # 关键：Stripe Address Element 里最后填的 ZIP 不失焦→不算 complete→卡表单不出现。发 TAB 失焦触发校验。
        page.tab_blur(_zip)
    time.sleep(2)
    log("[加卡] 提交账单地址")
    page.click_text(["Complete address details", "Update Address", "Save address", "Add address", "Continue"], 8)
    time.sleep(2)
    return True


def add_card(page, card, address, cfg, manual_hcaptcha=True, save_timeout=60, patcher=None, proxy=None, manual_card=False, card_ref=None, fill_mode="selenium", solve_hcap=False):
    """加卡。返回 {result: card-bound|server-error|declined|needphone|fill-fail|unknown}。
       save_timeout: 点 Save 后等 Radar 出终态的秒数(默认60;切IP重试时调用方传更短如45——
       换了新IP还不放行基本就是不行了,早返回省时间)。"""
    # ★R1/R2 根治:进 /credits 之【前】先把残留 onboarding 向导就地推完(单选/问卷/支付步清干净)→
    #   落 /credits 时无浮层盖加卡入口 → 不触发 OpenRouter 前端持续轮询积分(根治"一直刷积分/跳来跳去/阻塞")。
    #   覆盖续跑复用 key(从没走过取key阶段)与取key收尾撞死线留残留两种情形。幂等:已完成则瞬时返回。
    try:
        from steps import steps_key
        steps_key.complete_onboarding(page)
    except Exception:
        pass
    page.goto(CREDITS_URL, wait=3)
    # 拟人化预热:进页面后先滚两下+停一下(对标人类进表单前的浏览,Stripe 行为遥测看 warmup)
    try:
        page.js("window.scrollBy(0, %d);" % random.randint(180, 420))
        time.sleep(random.uniform(0.6, 1.4))
        page.js("window.scrollBy(0, %d);" % -random.randint(80, 200))
        time.sleep(random.uniform(0.3, 0.8))
    except Exception:
        pass
    # 反应式兜底:complete_onboarding 已在进页【前】清完则此处 no-op(_onboarding_done 置位);
    #   仅当前置清理没成功(撞死线/推不动等)才在 /credits 落地后再清一次,避免重复推浮层放大轮询。
    if not getattr(page, "_onboarding_done", False):
        try:
            from steps import steps_key
            steps_key.dismiss_onboarding(page)
            # Welcome 角色选择/支付步浮层会盖住 /credits 加卡入口 → in-place 推过去露出入口(详见 _advance_role_select)。
            steps_key._advance_role_select(page)
        except Exception:
            pass
    # 已有支付方式时,OpenRouter 把「Add a Payment Method」换成「Auto Top-Up / Enable」。
    # 这时没有加卡入口——说明卡已绑,直接判成功,别傻等卡表单。
    # ★#1 入口门加固:React/Stripe 没渲染完时按钮还没出 → has_addpm=False + 'Auto Top-Up' 常驻文案
    #   会误判"已绑卡"并删环境(不可逆,实测复现 jameshernandez)。所以判 has_addpm 之前先等
    #   "Add a Payment Method" 按钮(按文案探,不被无关导航按钮误命中)或卡/地址表单【渲染出来】(≤10s);
    #   没渲染完别急着判已绑。
    _addpm_js = ("return !!Array.from(document.querySelectorAll('button,[role=button],a'))"
                 ".find(function(b){return /Add a Payment Method|Add Payment Method/i.test(b.innerText||'');})")
    has_addpm = False
    _gate_end = time.time() + 10
    while time.time() < _gate_end:
        try:
            has_addpm = bool(page.js(_addpm_js))
        except Exception:
            has_addpm = False
        if has_addpm or page.field_present(ADDR_NAME + NUM):
            break
        time.sleep(0.6)
    t0 = page.all_frames_text() or ""
    # 卡/地址表单已经渲染出来(新号自动出表单)→ 直接进入填卡流程,绝不在此判"已绑"(有表单可填就不是已绑)。
    _form_present = page.field_present(ADDR_NAME + NUM)
    if (not has_addpm) and (not _form_present) and re.search(r"Auto\s*Top-?Up", t0, re.I):
        # ★#1 弱路径降级:'Auto Top-Up 且无 Add-a-Payment-Method' 不再单独判已绑(按钮可能只是还没渲染)。
        #   只有抓到【强信号】(已保存卡的掩码尾号/卡品牌+尾号 DOM)才认 bound;否则返回 unknown,
        #   让上层切IP/续跑重开,绝不直接 card-bound 删环境。
        strong = (
            bool(re.search(r"[•·*•‧∙.]{2,}\s*\d{4}\b", t0))
            or bool(re.search(r"ending\s*(?:in)?\s*\d{4}", t0, re.I))
            or bool(re.search(r"(visa|mastercard|amex|discover)\b[^\n]{0,14}\d{4}\b", t0, re.I))
        )
        if strong:
            log("[加卡] 页面有【已存卡掩码尾号】强信号 → 该号已有支付方式,视为已绑卡")
            return {"result": "card-bound", "detail": "已有支付方式(已存卡尾号)", "hcaptcha": False}
        log("[加卡] 有 Auto Top-Up 但【无加卡入口又无已存卡强信号】(疑按钮未渲染完)→ 不判已绑,返回 unknown 交上层重试/续跑")
        return {"result": "unknown", "detail": "无加卡入口且无已存卡强信号(疑未渲染完)", "hcaptcha": False}
    log("[加卡] 点 Add a Payment Method")
    if not page.click_text(["Add a Payment Method", "Add Payment Method"], 12):
        # 入口找不到、又不是已有卡 → 退而点「Add Credits」走购买流加卡,别原地不动
        log("[加卡] 没找到 Add a Payment Method 入口 → 点 Add Credits(增加积分)进购买流加卡")
        page.click_text(["Add Credits", "Buy Credits"], 8)
    time.sleep(0.6 if common.fast_mode() else 1.5)   # 提速:等支付方式选择器弹出;点早了由下游 click_card_tab(6) 轮询接住
    # OpenRouter 有时弹支付方式选择器(Cash App Pay/Card/Bank/Klarna)且默认选了 Cash App Pay,
    # 不点 Card 卡表单永不出现(→ unknown)。先把支付方式切到 Card。
    if page.click_card_tab(6):
        log("[加卡] 支付方式选择器→已选 Card")
        time.sleep(0.6 if common.fast_mode() else 1.5)   # 提速:等切到 Card 后表单刷新;下游 wait_field_present(30s) 接住
    # 检查返回(BUG-007:原来忽略返回值盲目继续)。30s 内地址/卡表单都没出 → 告警;
    # 不在此硬失败,因为下面卡号框检测(NUM)带刷新重载 Stripe.js 的兜底恢复,硬失败会越过那段恢复。
    if not page.wait_field_present(ADDR_NAME + NUM, 30, "地址或卡表单"):
        log("[加卡] ⚠ 30s 内地址/卡表单都没出现 → 仍继续(下方卡号框检测会刷新重载 Stripe.js 兜底)")

    # 账单地址（新账号才有；地址已存则跳过）
    _fill_billing_address(page, address)

    # 存完地址后卡表单(Stripe Payment Element: name=number/expiry/cvc/postalCode)会自动出现。
    # 卡号框等不出 = Stripe.js/Payment Element 没初始化出来(累代理上加载慢/半挂)→ 比起重点按钮,
    # 【刷新页面让 Stripe.js 重载】最有效;两次刷新重开都没出才放弃,且单次等待砍短(死等没用)。
    if not page.wait_field_present(NUM, 20, "卡号框"):
        # ★根因修复(对齐 Playwright 金标准:PW 从不刷 /credits,靠"先把 onboarding 走完 + 地址 complete→卡表单自然挂载"的
        #   状态机因果)。本批 7 个 card:unknown = 卡表单不出的真因是【残留 onboarding 浮层盖住入口】,而原来的兜底是
        #   STRIPE_RELOAD_RETRIES 盲目 goto(/credits) 重载——刷新【不清 onboarding 态、反而可能把向导弹回 Welcome】→ 越刷越在
        #   onboarding 态、卡表单永不渲染 = 死循环空转(本批刷 21 次)。物理刷新只对【纯 Stripe.js 半挂】有效。
        #   改:主路径先【in-place 清 onboarding(推角色选择/Welcome/支付步,不整页 goto)+ 重开入口 + 填地址】等卡表单;
        #   只有【确认非 onboarding 态】(无任何向导文案残留)才认定是 Stripe.js 半挂、才用物理 goto 重载——避免弹回起点 thrash。
        from steps import steps_key
        _ONB_RE = re.compile(r"How will you be using OpenRouter|Welcome to OpenRouter|workspace is ready|first hear about OpenRouter|You.?re all set|Add credits to get started|How much would you like to add", re.I)

        def _reopen_form(reloaded):
            """重开加卡入口 + 选 Card + (地址表单又在则重填),再等卡号框。reloaded=本轮是否做过物理刷新。"""
            try:
                steps_key.dismiss_onboarding(page)
                steps_key._advance_role_select(page)   # in-place 推 onboarding 浮层(角色选择/Welcome首屏/支付步→later),露出加卡入口
            except Exception:
                pass
            page.click_text(["Add a Payment Method", "Add Payment Method", "Add card"], 10)
            time.sleep(0.6 if common.fast_mode() else 1.5)
            page.click_card_tab(5)                    # 支付方式选择器→选 Card
            # ★#16:卡表单要先填好账单地址才出。地址表单又在 → 重新走填地址那段(复用同一逻辑),否则卡表单永不出。
            if page.field_present(ADDR_NAME):
                log("[加卡] %s地址表单又在 → 重新填账单地址(否则卡表单不出)" % ("刷新后" if reloaded else "清浮层后"))
                _fill_billing_address(page, address)
            return page.wait_field_present(NUM, 18, "卡号框")

        _reloads = max(2, int(os.environ.get("STRIPE_RELOAD_RETRIES", "3")))
        _form_ok = False
        for attempt in range(_reloads):
            t_now = page.all_frames_text() or ""
            onb = bool(_ONB_RE.search(t_now))
            if onb:
                # 残留 onboarding 态 → 【in-place 清浮层】不刷页(刷页会把向导弹回 Welcome 来回跳 = 原死循环根因)。
                log("[加卡] 卡表单没出 → 第%d/%d次:检出残留 onboarding 态(向导浮层盖住入口)→ in-place 清浮层再开(不刷页,避免弹回 Welcome)" % (attempt + 1, _reloads))
                if _reopen_form(reloaded=False):
                    _form_ok = True
                    break
            else:
                # 非 onboarding 态(无向导文案)→ 确属 Stripe.js 半挂/累代理加载慢 → 此时物理刷新才对症。
                log("[加卡] 卡表单没出 → 第%d/%d次:非 onboarding 态、疑 Stripe.js 半挂 → 刷新重载 Stripe.js 再开" % (attempt + 1, _reloads))
                page.goto(CREDITS_URL, wait=3)
                time.sleep(0.6 if common.fast_mode() else 1.5)
                if _reopen_form(reloaded=True):
                    _form_ok = True
                    break
        if not _form_ok:
            try:
                page.shot("_card_noform.png")
            except Exception:
                pass
            log("[加卡] 清浮层/刷新重开 %d 次仍没等到卡表单(疑 onboarding 未清干净 或 Stripe.js 加载不出)" % _reloads)
            return {"result": "unknown", "detail": "no card form"}

    # 页面内卡片面板:展示所有可用卡+已绑次数,留几秒窗口让用户点别的卡改用(不点走自动)。仅 --manual-card 开。
    if manual_card:
        card = _manual_card_pick(page, card, cfg)
    # 把【实际要填的卡】回写给调用方(人工可能改过)——否则 mark_card_result/冷却/换段都记到原来那张错卡上。
    if card_ref is not None:
        card_ref["card"] = card
    # Fix C:表单已开好,改用原生CDP填卡+Save(零chromedriver躲检测);旧 Selenium 路在下面(fill_mode=selenium)。
    if fill_mode == "cdp":
        return _fill_save_cdp(page, card, address, save_timeout, cfg=cfg, patcher=patcher, proxy=proxy, solve_hcap=solve_hcap)
    log("[加卡] 逐字段填卡")
    n = page.wait_and_fill(NUM, card["number"], 15, "卡号")
    e = page.wait_and_fill(EXP, "%s%s" % (card["expMonth"], card["expYear"]), 12, "有效期")
    c = page.wait_and_fill(CVC, card["cvc"], 12, "CVC")
    page.wait_and_fill(ZIP, card.get("zip") or address["zip"], 12, "卡邮编")
    if not (n and e and c):
        log("[加卡] 卡字段没填全"); return {"result": "fill-fail"}
    # 同地址：卡的最后一个字段(邮编)要失焦,Stripe Payment Element 才算 complete,否则 Save 点了不动
    page.tab_blur(ZIP)
    time.sleep(1.5)
    nu = page.uncheck_all_frames()
    log("[加卡] 取消勾选 %d 个(含 Link)" % nu)

    saw_hcaptcha = False
    # 拟人化:点 Save 前停一下(对标人类提交前的 readingDwell;瞬时填完秒点是机器特征)
    time.sleep(random.uniform(0.8, 2.0))
    log("[加卡] 点 Save")
    page.click_text(["Save payment method", "Save"], 8)
    # Save 后会显示 "Saving"(提交中)，Stripe Radar 审核可能要几十秒——【耐心等，别急着重点】，
    # 只在瞬时 502 或表单复位(按钮重新可点)时才重新 Save。最多等 save_timeout 秒出终态。
    end = time.time() + max(20, save_timeout)
    hc_cooldown_until = 0.0   # 解码后冷却:别每轮都重解(否则每几秒就调一次 2Captcha,烧钱)
    link_saved = False        # Link "Save card?" 弹窗只点一次(把卡存进 Link 供后续手动测试)
    while time.time() < end:
        if not link_saved:
            link_saved = _click_link_save(page)   # 出现 Link 'Save card?' 就点 Save(在 hcaptcha 处理前先点,防 NO_MANUAL 早返回漏点)
            if link_saved:
                # ★一劳永逸(对齐 Fix C):Stripe Link「Save card?」存卡弹窗【只在收卡成功后才弹】(declined/502 不弹、hcaptcha 更早一环就拦下)
                #   → 检测到=card-bound 专属强信号(_click_link_save 只认 'Save card?'/'save your card and encrypted' 专属文案,不会误判)。
                #   已点它的 Save(把卡存进 Link 供手动测试)→ 直接判绑成收口,不再轮询、不走 _card_attached 的 goto(/credits) 刷新核验
                #   → 根治 /credits 上 Save card? 被重新弹出来【逗留】。
                log("[加卡] ✓ 检测到 Save card? 存卡弹窗(收卡成功专属信号)→ 判 card-bound,收口(不再刷新核验)")
                return {"result": "card-bound", "detail": "检测到 Link 存卡弹窗(收卡成功专属信号)", "hcaptcha": saw_hcaptcha}
        if time.time() >= hc_cooldown_until:
            _ok, _hc = _handle_hcaptcha(page, cfg, manual_hcaptcha, patcher=patcher, proxy=proxy)
            saw_hcaptcha = saw_hcaptcha or _hc
            if _hc and _ok:
                # 人工/2Captcha 刚过 hCaptcha。【先立判终态,不停留】(用户规则 2026-06-11:
                # 人工校验过后一弹 502 就立马换卡):已弹 502→当场返回换【新卡段】;已被拒→declined;已绑成→card-bound。
                tt = page.all_frames_text() or ""
                ttl = tt.lower()
                if RE_502.search(tt) and (("unable to authenticate" in ttl) or ("choose a different payment" in ttl)):
                    # 软-502:toast 报错但卡常已挂上账户 → 先刷新核验,真绑上就算成功(救回误判)
                    log("[加卡] 人工过验证后弹 Error 502 → 先刷新核验是否其实已绑…")
                    if _card_attached(page):
                        return {"result": "card-bound", "detail": "人工后502但核验已绑(救回)", "hcaptcha": True}
                    log("[加卡] 核验确认未绑 → 立马换【新卡段】(不停留)")
                    return {"result": "card-502", "detail": "人工后即502 且核验未绑", "hcaptcha": True}
                if RE_DECL.search(tt):
                    return {"result": "declined", "detail": "人工后被拒", "hcaptcha": True}
                if RE_OK.search(tt):
                    return {"result": "card-bound", "detail": "人工后成功文案", "hcaptcha": True}
                # 没出终态 = token 真过了但还没提交结果 → 重点一次 Save 提交 token,延长窗口,28s 内不重解,
                # 给 OpenRouter 后端校验 token + 关模态框 + 出 card-bound 充分时间(别过早换卡/重载冲掉token)。
                end = max(end, time.time() + 55)
                hc_cooldown_until = time.time() + 28
                time.sleep(1.2)
                page.click_text(["Save payment method", "Save"], 4)
                time.sleep(2)
            elif _hc and not _ok:
                # 仅当 2Captcha 真没解出 token 时才算 hcaptcha 失败(交上层换卡/切IP)
                log("[加卡] ⚠ hCaptcha 弹框且 2Captcha 没解出 token → 标记 hcaptcha")
                _click_link_save(page)   # 返回前补点一次 Link 'Save card?'(NO_MANUAL 早返回时也把卡存进 Link)
                return {"result": "hcaptcha", "detail": "弹验证框·2captcha未解出", "hcaptcha": True}
        t = page.all_frames_text() or ""
        if RE_NEEDPHONE.search(t):
            return {"result": "needphone", "detail": "Link 没取消干净，要手机号", "hcaptcha": saw_hcaptcha}
        if RE_DECL.search(t):
            return {"result": "declined", "detail": "卡被拒", "hcaptcha": saw_hcaptcha}
        if RE_OK.search(t):
            return {"result": "card-bound", "detail": "成功文案", "hcaptcha": saw_hcaptcha}
        # 卡号框(iframe内)消失 且 弹窗没了 = 疑似存上 —— 但 Stripe iframe 重渲染会一瞬间误判;
        # 误判成功不可逆(删环境+扣卡用量但卡其实没绑上),所以【隔 2.5s 二次确认】仍消失才认定。
        if (not page.field_present(NUM)) and ("Add a Payment Method" not in t) and ("Card number" not in t):
            # ★#14:未检出的 hCaptcha 模态会【遮住卡 iframe】→ field_present(NUM)=False 但卡根本没绑,
            #   会误判 card-bound(删环境+扣用量)。判成功前先确认没有验证框还在(壳文案/递归 iframe 检测)。
            _hc_up = bool(RE_HCAPTCHA.search(t))
            if not _hc_up:
                try:
                    _hc_up = captcha.has_hcaptcha(page.d)
                except Exception:
                    _hc_up = False
            if _hc_up:
                log("[加卡] 卡表单看似消失,但检出 hCaptcha 验证框仍在(疑遮住 iframe)→ 不判绑成,交回循环处理验证框")
                continue
            time.sleep(2.5)
            t2 = page.all_frames_text() or ""
            if (not page.field_present(NUM)) and ("Add a Payment Method" not in t2) and ("Card number" not in t2):
                # 二次确认前再核一次没有验证框(2.5s 内可能刚弹出来)
                _hc_up2 = bool(RE_HCAPTCHA.search(t2))
                if not _hc_up2:
                    try:
                        _hc_up2 = captcha.has_hcaptcha(page.d)
                    except Exception:
                        _hc_up2 = False
                if _hc_up2:
                    log("[加卡] 二次确认时检出 hCaptcha 验证框仍在 → 不判绑成,交回循环")
                    continue
                return {"result": "card-bound", "detail": "弹窗关闭·卡表单消失(二次确认)", "hcaptcha": saw_hcaptcha}
            continue   # 二次没确认上(iframe 抖动)→ 不算成功,继续等终态
        if RE_502.search(t):
            tl = t.lower()
            if ("unable to authenticate" in tl) or ("choose a different payment" in tl):
                # 软-502:toast 报错但卡常已挂上账户(用户实测)→ 先刷新核验,真绑上就算成功(救回误判);
                # 确实没绑才交上层换【新卡段】重填、人工再点(OpenRouter 文案 choose a different payment)。
                log("[加卡] Error 502 unable-to-authenticate → 先刷新核验是否其实已绑…")
                if _card_attached(page):
                    return {"result": "card-bound", "detail": "502但核验已绑(救回)", "hcaptcha": saw_hcaptcha}
                log("[加卡] 核验确认未绑 → 交上层换【新卡段】重新绑")
                return {"result": "card-502", "detail": "502 unable-to-authenticate 且核验未绑", "hcaptcha": saw_hcaptcha}
            # 泛化网关 5xx/Bad Gateway(无 unable-to-authenticate 文案)→ 可能瞬时,仍按瞬时重 Save
            log("[加卡] Error 5xx/网关(疑瞬时,非卡级)→ 重新 Save"); time.sleep(2)
            page.click_text(["Save payment method", "Save"], 5); time.sleep(2); continue
        # 还在 "Saving"(提交中)就继续等；若按钮复位(不在 Saving 且卡表单还在)→ 再点一次 Save
        saving = "Saving" in t or "saving" in t.lower()
        if (not saving) and page.field_present(NUM):
            page.click_text(["Save payment method", "Save"], 4)
        time.sleep(4)
    # 等满 save_timeout 仍没出终态:可能【已绑成但弹窗没自动关/没出成功文案】(用户实测)→ 刷新核验一次再下结论
    if _card_attached(page):
        return {"result": "card-bound", "detail": "等超时但核验已绑(弹窗没关·救回)", "hcaptcha": saw_hcaptcha}
    return {"result": "server-error", "detail": "Save 等 ~%ds 仍卡在 Saving/未完成" % save_timeout, "hcaptcha": saw_hcaptcha}


def _balance(page):
    m = re.search(r"\$\s*([\d][\d,]*\.?\d*)", page.all_frames_text() or "")
    return m.group(1).replace(",", "") if m else ""


def _accept_alert(page):
    """充值成功后 OpenRouter 弹 window.alert('payment is processing…') → 接受它(否则阻塞 Selenium)。"""
    try:
        al = page.d.switch_to.alert
        txt = al.text or ""
        al.accept()
        return txt
    except Exception:
        return ""


def purchase(page, amount, cfg, manual_hcaptcha=True):
    """充值 amount(美元)。返回 {result: success|server-error|declined|amount-fail|unknown, balance_before, balance_after}。"""
    # 进 /credits 前同样先确保 onboarding 已走完(幂等;正常已绑卡号此处瞬时返回),避免充值页落 /credits 触发前端积分轮询。
    try:
        from steps import steps_key
        steps_key.complete_onboarding(page)
    except Exception:
        pass
    page.goto(CREDITS_URL, wait=3)
    bal0 = _balance(page)
    log("[充值] 充值前余额 ~ $%s" % (bal0 or "?"))
    page.click_text(["Add Credits", "Buy Credits"], 12)
    time.sleep(4)
    # 设金额（金额框在主文档，纯数字 value）
    By = page.By
    page.d.switch_to.default_content()
    set_ok = False
    for inp in page.d.find_elements(By.CSS_SELECTOR, "input[type='number'],input[inputmode='numeric'],input[type='text']"):
        try:
            if not inp.is_displayed():
                continue
            v = (inp.get_attribute("value") or "").strip()
            if re.fullmatch(r"\d+(\.\d+)?", v):
                inp.click()
                common.clear_input(inp, page.Keys)   # 跨平台全选清空(Mac Ctrl+A≠全选 → 金额残值拼脏如 1010)
                inp.send_keys(str(amount))
                time.sleep(0.5)
                nv = (inp.get_attribute("value") or "").strip()
                if nv == str(amount) or nv.startswith(str(amount)):
                    set_ok = True; break
        except Exception:
            continue
    if not set_ok:
        log("[充值] 金额没设成 $%s（防多扣，放弃）" % amount)
        return {"result": "amount-fail", "balance_before": bal0, "balance_after": bal0}
    log("[充值] 金额=$%s，点 Purchase" % amount)
    page.click_text(["Purchase", "Pay now", "Confirm"], 10)
    _handle_hcaptcha(page, cfg, manual_hcaptcha)

    # ★充值结果检测(根治用户报的"付款后等好久/额度显示0/不改密"):
    #   ① 超时从 300s 砍到 FIXC_PURCHASE_WAIT(默认90s)—— 5分钟干等绝大多数是"成功了但没检测到",白堵后续 changepw;
    #   ② 【关键】信用页余额【不在原页实时更新】→ 原来只读当前页 _balance 永远是旧值、永远检测不到充值成功 → 干等满。
    #      改:每 ~10s reload 一次 /credits 取【最新余额】,余额涨了即判 success 立即 break(及时看额度变化)。
    #   ③ success 一旦判定就 break → res["charged"] 写得上(不再显示 0)+ 尽快进 changepw。declined/502 文案命中仍秒判。
    end = time.time() + float(os.environ.get("FIXC_PURCHASE_WAIT", "90") or 90)
    outcome = "unknown"
    decline_code = ""   # ★被拒时分类出的具体原因(insufficient_funds=真没钱 / 其余=环境风控);供卡池决策与失败列表按原因恢复
    _last_reload = time.time()
    while time.time() < end:
        alert_txt = _accept_alert(page)
        t = (page.all_frames_text() or "") + " " + alert_txt
        if RE_OK.search(t) or "processing" in alert_txt.lower():
            outcome = "success"; break
        if RE_502.search(t):
            outcome = "server-error"; break
        if RE_DECL.search(t):
            outcome = "declined"
            # 抓拒付具体原因(余额不足 vs 风控/通用),与 web/billing 同口径;RE_DECL 命中但没归到具体码 → 兜底 generic_decline,保证每个 declined 都有码
            decline_code = common.classify_decline(t) or "generic_decline"
            break
        bn = _balance(page)
        try:
            if bn and bal0 is not None and bn != bal0 and float(bn) > float(bal0 or 0):
                outcome = "success"; break
        except Exception:
            pass
        # ★每 ~10s 刷新 /credits 取最新余额(信用页余额非实时更新,不刷新读不到充值成功)
        if time.time() - _last_reload > 10:
            try:
                page.goto(CREDITS_URL, wait=3)
                _last_reload = time.time()
            except Exception:
                pass
        time.sleep(3)
    page.goto(CREDITS_URL, wait=4)
    bal1 = _balance(page)
    # ★H1 修复(防续跑二次扣款):末尾这次 reload 才是最新余额(信用页非实时更新,真实充值常恰在最后一刷才显现)。
    #   循环内对 bn 涨了即判 success(700-701),但末尾 bal1 之前【从不据此升级 outcome】→ 已扣款的号返回 unknown
    #   → 下游 pipeline.py / run.py 只认 purchase==success 或 charged>0,unknown 不记已扣 → 续跑/AUTO_RETRY 对同号【二次扣款,不可逆】。
    #   对歧义终态(unknown/server-error)观察到余额上涨即判权威 success(余额增加=确已扣款 → 杜绝重扣,与卡侧 RETRY-CARD-01 歧义态保护对称)。
    #   declined 是确定负信号(卡被拒,余额不应增加)不升级,以保留拒付号的正常重试/重绑路径。沿用循环内同一 _balance 信号,不引入新判据。
    if outcome in ("unknown", "server-error"):
        try:
            if bal1 and bal1 != bal0 and float(bal1) > float(bal0 or 0):
                outcome = "success"
                log("[充值] 末尾对账:余额 $%s→$%s 上涨,歧义终态(%s)升级为 success(防续跑重扣)" % (bal0, bal1, "unknown/502"))
        except Exception:
            pass
    if outcome != "declined":
        decline_code = ""   # 末尾若升级为 success(或非拒付终态)→ 清掉拒付码,不误带
    if decline_code:
        log("[充值] 拒付原因=%s" % decline_code)
    log("[充值] 结果=%s 余额 $%s → $%s (等待上限%ss)" % (outcome, bal0, bal1, os.environ.get("FIXC_PURCHASE_WAIT", "90")))
    return {"result": outcome, "balance_before": bal0, "balance_after": bal1, "decline_code": decline_code}
