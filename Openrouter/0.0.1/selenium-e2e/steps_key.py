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
    """关掉问卷/「You're all set!」/个人资料弹层——但【绝不关账单弹窗】。"""
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
    # 「You're all set!」/ profile 详情：找弹层里的关闭按钮（不动账单）
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


def get_api_key(page, name=None, expiration="No expiration"):
    """取 API Key。返回 {ok, key, name} 。"""
    page.goto(KEYS_URL, wait=3)
    dismiss_onboarding(page)
    By = page.By
    key_name = name or ("auto-" + rand_name(6))
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
