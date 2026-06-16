#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# z.ai 订阅 GLM Coding Plan + 信用卡支付（纯 Selenium）
#
# 文件定位：GLM/0.0.1/selenium-e2e/steps/steps_subscribe.py
#
# 流程:goto z.ai/subscribe → 选计费周期(Monthly/Quarterly/Yearly) → 点目标套餐
#   (Lite/Pro/Max)的 Subscribe → z.ai/payment 填卡(号/有效期/CVC)+ 持卡人 + 账单地址 →
#   勾同意 → (real_charge 才点 Confirm) → 轮询 Payment Success/Failed/Invalid amount。
# ★dry-run(real_charge=False):走到 Confirm 前停手,绝不真扣 → result="dryrun"。
# 卡字段可能在 Stripe 跨 iframe → 用 Page.fill_in_frames(主文档→iframe 逐层兜底)。
# ═══════════════════════════════════════════════════════════════════════

import time

from common import (log, SUBSCRIBE_URL, NUM, EXP, CVC,
                    RE_OK, RE_DECL, RE_INVALID_AMT, RE_502)
from common.selectors import sel


_CYCLE_LABEL = {"monthly": "Monthly", "quarterly": "Quarterly", "yearly": "Yearly"}
_PLAN_LABEL = {"lite": "Lite", "pro": "Pro", "max": "Max"}


def _click_plan_subscribe(page, plan):
    """在套餐页定位【目标套餐列】并点它的 Subscribe 按钮(按列头文案匹配,避免点错套餐)。
    返回 'matched'(按套餐名命中其列内 Subscribe,高置信)/ 'fallback'(仅按整页按钮顺序兜底,低置信,
    可能点错套餐)/ False(没找到)。★置信度供调用方在真扣前做防扣错金额的闸门。"""
    label = _PLAN_LABEL.get(plan, "Pro")
    js = r"""
      var want = arguments[0].toLowerCase();
      // 找含套餐名作为标题、且内部有 Subscribe 按钮的卡片/列
      var nodes = document.querySelectorAll('div,section,article,li');
      var best = null;
      for (var i=0;i<nodes.length;i++){
        var el = nodes[i];
        var head = (el.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="plan" i]')||{}).innerText||'';
        var txt = (el.innerText||'');
        var hasBtn = false, btns = el.querySelectorAll('button,[role=button],a');
        for (var j=0;j<btns.length;j++){ if(/subscribe/i.test(btns[j].innerText||'')){ hasBtn=true; } }
        if (hasBtn && (head.toLowerCase().indexOf(want)>=0 || new RegExp('(^|\\b)'+want+'(\\b|$)','i').test(txt.split('\n')[0]||''))){
          // 选最贴近的(文本最短=最像单个套餐列)
          if (!best || (el.innerText||'').length < (best.innerText||'').length) best = el;
        }
      }
      if (!best) return false;
      var bs = best.querySelectorAll('button,[role=button],a');
      for (var k=0;k<bs.length;k++){ if(/subscribe/i.test(bs[k].innerText||'')){
        try{ bs[k].scrollIntoView({block:'center'}); }catch(e){}
        bs[k].click(); return true; } }
      return false;
    """
    try:
        if page.js(js, label):
            return "matched"
    except Exception:
        pass
    # 兜底:整页第 N 个 Subscribe(lite=0,pro=1,max=2)—— ★仅按位置,无法确认点中的就是目标套餐。
    order = {"lite": 0, "pro": 1, "max": 2}.get(plan, 1)
    try:
        if page.js(
            "var bs=[].slice.call(document.querySelectorAll('button,[role=button],a'))"
            ".filter(function(b){return /subscribe/i.test(b.innerText||'');});"
            "var i=arguments[0];if(bs[i]){bs[i].click();return true;}return false;", order):
            return "fallback"
    except Exception:
        pass
    return False


def _check_agreement(page):
    """勾选支付页「同意按计划扣款」复选框(跨 iframe;已勾则跳过)。返回勾上的个数。"""
    js = r"""
      var n=0;
      var cbs=document.querySelectorAll('input[type=checkbox]');
      for (var i=0;i<cbs.length;i++){ var c=cbs[i];
        if(!c.checked){ try{ c.click(); }catch(e){}
          if(!c.checked){ try{ var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'checked').set;
            s.call(c,true); c.dispatchEvent(new Event('click',{bubbles:true}));
            c.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){} } }
        if(c.checked) n++;
      }
      return n;
    """
    total = 0
    By = page.By
    page.d.switch_to.default_content()
    try:
        total += page.js(js) or 0
        for fr in page.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                page.d.switch_to.default_content(); page.d.switch_to.frame(fr)
                total += page.js(js) or 0
            except Exception:
                pass
        page.d.switch_to.default_content()
    except Exception:
        pass
    return total


def _accept_alert(page):
    try:
        al = page.d.switch_to.alert
        t = al.text or ""
        al.accept()
        return t
    except Exception:
        return ""


def subscribe(page, plan, cycle, card, addr, cfg, opts, real_charge=False, on_confirm=None):
    """订阅 + 支付。返回 {result, payment_status, card_last4, card_id}。
    result ∈ success | failed | declined | invalid-amount | server-error | dryrun | plan-not-found | plan-unconfirmed | no-payment-form | unknown。
    ★plan-unconfirmed:只在 real_charge 下、套餐仅按位置兜底命中(怕扣错金额)时返回,等价"没真扣的失败"。
    ★on_confirm():可选回调,在【Confirm 已点中、即将进入支付】那一刻【立刻】调用(供上层落"写前 uncertain" checkpoint,
      防轮询期间进程被硬 kill→续跑无凭据→重扣;见 pipeline _on_confirm)。Confirm 没点上则不调用(未扣,可重试)。"""
    res = {"result": "unknown", "payment_status": None,
           "card_last4": card.get("last4"), "card_id": card.get("id") or card.get("number")}
    plan = (plan or "pro").lower(); cycle = (cycle or "monthly").lower()
    log("[订阅] %s / %s" % (plan, cycle))
    page.goto(SUBSCRIBE_URL, wait=3)

    # ① 计费周期
    page.click_text(sel("cycle_" + cycle, _CYCLE_LABEL.get(cycle, "Monthly")), 6)
    time.sleep(1.0)

    # ② 点目标套餐的 Subscribe
    hit = _click_plan_subscribe(page, plan)
    if not hit:
        log("[订阅] 没找到套餐 %s 的 Subscribe 按钮" % plan)
        res["result"] = "plan-not-found"; res["payment_status"] = "plan-not-found"; return res
    if hit == "fallback":
        # 仅按按钮顺序兜底命中,无法确认点中的就是目标套餐。真扣模式下宁可中止也不冒险扣错套餐金额。
        if real_charge:
            log("[订阅] ⚠ 套餐 %s 仅按位置兜底命中,无法确认 → 真扣模式中止(防扣错金额;真机请配 slider_/plan 选择器)" % plan)
            res["result"] = "plan-unconfirmed"; res["payment_status"] = "plan-unconfirmed"; return res
        log("[订阅] ⚠ 套餐 %s 仅按位置兜底命中(dry-run 继续;真机请核验套餐列选择器)" % plan)
    time.sleep(3.5)

    # ③ 支付页:等卡号框出现(可能在 Stripe iframe)
    if not page.wait_field_present(NUM, 25, "支付页卡号框"):
        log("[订阅] 没等到支付页卡号框")
        res["result"] = "no-payment-form"; res["payment_status"] = "no-payment-form"; return res
    # 选信用卡支付方式(默认通常已选;点一下保险)
    page.click_text(sel("pay_card_method", "Credit Card / Debit Card", "Credit Card", "Debit Card"), 4)
    time.sleep(0.6)

    # ④ 填卡 + 持卡人 + 账单地址(跨 iframe 兜底)
    page.fill_in_frames(NUM, card.get("number"))
    page.fill_in_frames(EXP, "%s%s" % (card.get("expMonth", ""), card.get("expYear", "")))
    page.fill_in_frames(CVC, card.get("cvc"))
    page.fill_in_frames(sel("pay_name", 'input[placeholder*="Name on card" i]', 'input[name="name"]', 'input[placeholder*="Name" i]'), addr.get("name"))
    # 国家下拉(<select>)
    page.wait_and_select(sel("pay_country", "select", 'select[name="country"]'), addr.get("country", "United States"), 8, "Country")
    page.fill_in_frames(sel("pay_addr1", 'input[placeholder*="Address line 1" i]', 'input[name*="line1" i]', 'input[autocomplete="address-line1"]'), addr.get("line1"))
    page.fill_in_frames(sel("pay_city", 'input[placeholder*="City" i]', 'input[name="city"]', 'input[autocomplete="address-level2"]'), addr.get("city"))
    page.fill_in_frames(sel("pay_zip", 'input[placeholder*="Postal" i]', 'input[placeholder*="ZIP" i]', 'input[autocomplete="postal-code"]'), addr.get("zip"))
    page.fill_in_frames(sel("pay_state", 'input[placeholder*="State" i]', 'input[autocomplete="address-level1"]'), addr.get("state"))
    time.sleep(0.4)

    # ⑤ 勾同意
    n = _check_agreement(page)
    log("[订阅] 已勾同意复选框 %d 个" % n)

    # ⑥ dry-run:绝不真扣
    if not real_charge:
        log("[订阅] dry-run:已填好支付表单,不点 Confirm(不真扣)")
        res["result"] = "dryrun"; res["payment_status"] = "dryrun"; return res

    # ⑦ 真扣:点 Confirm,轮询终态。★若 Confirm 按钮没点上(选择器没命中/按钮没就绪)→ 根本没扣 →
    #   绝不能让它走到 unknown 被上游当"可能已扣"(会误标已订阅不重试)→ 明确返回 confirm-not-found(=未扣,可重试)。
    _confirmed = page.click_text(sel("pay_confirm", "Confirm", "Pay", "Subscribe", "确认"), 10)
    if not _confirmed:
        log("[订阅] ⚠ 没点上 Confirm 按钮(未扣款)→ confirm-not-found(可重试,不当已扣)")
        res["result"] = "confirm-not-found"; res["payment_status"] = "confirm-not-found"; return res
    # ★Confirm 已点中 = 服务端可能已开始扣款 → 立刻通知上层落【写前 uncertain】checkpoint(防此后硬 kill→续跑重扣)
    if on_confirm:
        try: on_confirm()
        except Exception: pass
    end = time.time() + float(opts.get("payment_wait", 90) if isinstance(opts, dict) else 90)
    outcome = "unknown"
    # ★★money-safety(R2-IDEMPOTENCY-003):Confirm 已点 = 服务端可能已开始扣款。轮询期间任何异常
    #   (all_frames_text/_accept_alert 抛、网络断、超时)【绝不能】让函数抛出去 → 否则上层 res 没赋值、
    #   checkpoint 不落 → 续跑查不到"已扣"凭据 → 重新订阅 = 双扣。捕获后保守归 "server-error"
    #   (上游 _charge_disposition 映射 uncertain:按已扣记账 + 防自动重扣 + 标人工核对),把"已扣未记→重扣"窗口堵死。
    #   注:进程被硬 kill(SIGKILL/OOM)无法在此捕获,需"点 Confirm 前写前置 checkpoint"配合(见报告,待批)。
    try:
        while time.time() < end:
            alert_txt = _accept_alert(page)
            t = (page.all_frames_text() or "") + " " + alert_txt
            if RE_OK.search(t):
                outcome = "success"; break
            if RE_INVALID_AMT.search(t):
                outcome = "invalid-amount"; break
            if RE_DECL.search(t):
                outcome = "declined"; break
            if RE_502.search(t):
                outcome = "server-error"; break
            time.sleep(2)
    except Exception as _e:
        outcome = "server-error"
        log("[订阅] ⚠ Confirm 已点后轮询异常(%s)→ 保守按 uncertain(可能已扣,绝不当未扣重试)" % str(_e)[:80])
    res["result"] = outcome
    res["payment_status"] = outcome
    log("[订阅] 支付结果=%s" % outcome)
    return res


__all__ = ["subscribe"]
