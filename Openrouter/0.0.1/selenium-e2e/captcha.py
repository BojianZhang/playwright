#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# Turnstile + hCaptcha（纯 Selenium）：CDP 注入 hook + 2captcha 求解 + 注回 + 人工兜底
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/captcha.py
#
# 关键：Playwright 用 route 改 api.js + addInitScript 注 hook；Selenium 用 CDP
#   Page.addScriptToEvaluateOnNewDocument 注同样的 hook（接管后、首次 goto 前注入一次，
#   对后续所有导航/iframe 生效，等价 addInitScript）。wrapper 是自安装轮询器，api.js 一定义
#   render 就包住，抓 sitekey/cdata/pagedata/action(Turnstile) 与 sitekey/rqdata(hCaptcha) + callback。
# ═══════════════════════════════════════════════════════════════════════

import time
import json

from common import http_post_json, log

# ── 与 Node 端逐字一致的 wrapper（openrouter-turnstile.js RENDER_WRAPPER / openrouter-hcaptcha.js HC_RENDER_WRAPPER）──
WRAPPER_TURNSTILE = r""";(function(){function w(){try{if(window.turnstile&&window.turnstile.render&&!window.turnstile.__w){var o=window.turnstile.render.bind(window.turnstile);window.turnstile.render=function(c,p){try{window.__cfParams={sitekey:p.sitekey,cdata:p.cData,pagedata:p.chlPageData,action:p.action};window.tsCallback=p.callback;}catch(e){}return o(c,p);};window.turnstile.__w=true;}}catch(e){}}w();var i=setInterval(w,5);setTimeout(function(){clearInterval(i);},30000);})();"""

WRAPPER_HCAPTCHA = r""";(function(){function g(p){try{if(!p)return;window.__hcParams=window.__hcParams||{};if(p.sitekey||p.siteKey)window.__hcParams.sitekey=p.sitekey||p.siteKey;if(p.rqdata)window.__hcParams.rqdata=p.rqdata;if(p.size)window.__hcParams.size=p.size;if(typeof p.callback==='function')window.hcCallback=p.callback;}catch(e){}}
function w(){try{if(!window.hcaptcha)return;if(window.hcaptcha.render&&!window.hcaptcha.__wr){var o=window.hcaptcha.render.bind(window.hcaptcha);window.hcaptcha.render=function(c,p){g(p);return o(c,p);};window.hcaptcha.__wr=true;}if(window.hcaptcha.execute&&!window.hcaptcha.__we){var oe=window.hcaptcha.execute.bind(window.hcaptcha);window.hcaptcha.execute=function(a,b){try{var opt=(a&&typeof a==='object')?a:b;if(opt&&opt.rqdata){window.__hcParams=window.__hcParams||{};window.__hcParams.rqdata=opt.rqdata;}}catch(e){}return oe(a,b);};window.hcaptcha.__we=true;}}catch(e){}}
w();var i=setInterval(w,5);setTimeout(function(){clearInterval(i);},60000);})();"""

WEBDRIVER_HIDE = "try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});}catch(e){}"


def inject_hooks(driver):
    """接管后、首次导航前注入：等价 Playwright 的 addInitScript，对所有 frame/导航生效。"""
    try:
        driver.execute_cdp_cmd("Page.enable", {})
    except Exception:
        pass
    ok = 0
    for src in (WEBDRIVER_HIDE, WRAPPER_TURNSTILE, WRAPPER_HCAPTCHA):
        try:
            driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": src})
            ok += 1
        except Exception as e:
            log("注入 captcha hook 失败: %s" % str(e)[:60])
    log("captcha hook 已注入(%d/3, CDP addScriptToEvaluateOnNewDocument)" % ok)
    return ok == 3


# ── 2captcha ────────────────────────────────────────────────────────────
def _solve_2captcha(api_key, task, timeout=180):
    try:
        cr = http_post_json("https://api.2captcha.com/createTask", {"clientKey": api_key, "task": task}, timeout=30)
    except Exception as e:
        log("2captcha createTask 异常: %s" % str(e)[:80]); return None
    if cr.get("errorId"):
        log("2captcha createTask 错误: %s" % (cr.get("errorCode") or cr.get("errorDescription"))); return None
    tid = cr.get("taskId")
    log("2captcha task %s 创建,等待求解…" % tid)
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(5)
        try:
            r = http_post_json("https://api.2captcha.com/getTaskResult", {"clientKey": api_key, "taskId": tid}, timeout=30)
        except Exception as e:
            log("2captcha getTaskResult 异常: %s" % str(e)[:60]); continue
        if r.get("errorId"):
            log("2captcha getTaskResult 错误: %s" % (r.get("errorCode") or r.get("errorDescription"))); return None
        if r.get("status") == "ready":
            sol = r.get("solution") or {}
            return sol.get("token") or sol.get("gRecaptchaResponse")
    log("2captcha 求解超时"); return None


# ── Turnstile（注册/登录）──────────────────────────────────────────────
def _ts_extract(driver):
    """跨帧兜底抓 Turnstile sitekey/action/cdata：hook(__cfParams) 优先，
       再 DOM [data-sitekey] / .cf-turnstile，再 cf iframe src 里的 0x4… sitekey。"""
    from selenium.webdriver.common.by import By
    out = {"sitekey": None, "action": None, "cdata": None, "pagedata": None}
    driver.switch_to.default_content()
    for fr in [None] + driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            if fr is not None:
                driver.switch_to.frame(fr)
            p = driver.execute_script(
                "var r={};if(window.__cfParams){r.sitekey=window.__cfParams.sitekey;r.action=window.__cfParams.action;r.cdata=window.__cfParams.cdata;r.pagedata=window.__cfParams.pagedata;}"
                "if(!r.sitekey){var el=document.querySelector('.cf-turnstile[data-sitekey],[data-sitekey]');if(el){r.sitekey=el.getAttribute('data-sitekey');r.action=r.action||el.getAttribute('data-action');r.cdata=r.cdata||el.getAttribute('data-cdata');}}"
                "if(!r.sitekey){var ifr=document.querySelector('iframe[src*=\"challenges.cloudflare.com\"],iframe[src*=\"turnstile\"]');if(ifr){var m=(ifr.src||'').match(/0x4[A-Za-z0-9_-]{10,}/);if(m)r.sitekey=m[0];}}return r;") or {}
            for k in ("sitekey", "action", "cdata", "pagedata"):
                if p.get(k) and not out[k]:
                    out[k] = p[k]
        except Exception:
            pass
        finally:
            driver.switch_to.default_content()
        if out["sitekey"]:
            break
    return out


def solve_turnstile(driver, page_url, cfg, timeout=180):
    api_key = cfg.get("captcha_key")
    params = _ts_extract(driver)          # hook + DOM 跨帧兜底
    ua = driver.execute_script("return navigator.userAgent") or ""
    sitekey = params.get("sitekey")
    if not sitekey:
        log("turnstile sitekey 未抓到(hook 没装上/widget 未渲染?)"); return False
    log("turnstile sitekey=%s 求解中…" % sitekey)
    task = {"type": "TurnstileTaskProxyless", "websiteURL": page_url, "websiteKey": sitekey}
    if params.get("action"):
        task["action"] = params["action"]
    if params.get("cdata"):
        task["data"] = params["cdata"]
    if params.get("pagedata"):
        task["pagedata"] = params["pagedata"]
    if ua:
        task["userAgent"] = ua
    token = _solve_2captcha(api_key, task, timeout)
    if not token:
        return False
    log("turnstile token len=%d → 注入" % len(token))
    try:
        had = driver.execute_script(
            "var tok=arguments[0],cb=false;"
            "try{if(typeof window.tsCallback==='function'){window.tsCallback(tok);cb=true;}}catch(e){}"
            "document.querySelectorAll('input[name=\"cf-turnstile-response\"],textarea[name=\"cf-turnstile-response\"],input[id$=\"_response\"],textarea[id$=\"_response\"]')"
            ".forEach(function(el){el.value=tok;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});"
            "return cb;", token)
        log("turnstile 注入完成 hadCallback=%s" % had)
    except Exception as e:
        log("turnstile 注入异常: %s" % str(e)[:60])
    return True


# ── hCaptcha（加卡/付款）──────────────────────────────────────────────
def _frame_has_hc(driver):
    """【当前 frame 内】是否有可见够大且未解的 hCaptcha iframe,或挑战外壳文案。
    壳文案兜底:有些框外层是 OpenRouter 自定义壳('One more step / I am human'),
    纯 iframe 检测可能抓不到 → 文案命中也算。"""
    try:
        return bool(driver.execute_script(
            "var ifr=Array.from(document.querySelectorAll('iframe[src*=\"hcaptcha.com\"]')).find(function(el){var r=el.getBoundingClientRect();var s=getComputedStyle(el);return r.width>100&&r.height>40&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';});"
            "if(ifr){var resp=document.querySelector('textarea[name=\"h-captcha-response\"],textarea[name=\"g-recaptcha-response\"]');"
            "if(!(resp&&resp.value&&resp.value.length>20))return true;}"
            "var t=(document.body&&document.body.innerText)||'';"
            "if(/I am human|Select the checkbox below|One more step before you/i.test(t))return true;"
            "return false;"))
    except Exception:
        return False


def has_hcaptcha(driver, max_depth=3):
    """任一 frame(【递归下钻最多 max_depth 层】)有可见够大、未解的 hCaptcha,或挑战外壳文案。
    关键:OpenRouter 加卡弹的 'I am human' 框常嵌在 2-3 层 iframe 里,只查一层会漏判成 server-error。"""
    from selenium.webdriver.common.by import By
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    def rec(depth):
        if _frame_has_hc(driver):
            return True
        if depth >= max_depth:
            return False
        try:
            n = len(driver.find_elements(By.TAG_NAME, "iframe"))
        except Exception:
            return False
        for i in range(n):
            try:
                frames = driver.find_elements(By.TAG_NAME, "iframe")
                if i >= len(frames):
                    break
                driver.switch_to.frame(frames[i])
            except Exception:
                continue
            try:
                if rec(depth + 1):
                    return True
            finally:
                try:
                    driver.switch_to.parent_frame()
                except Exception:
                    try:
                        driver.switch_to.default_content()
                    except Exception:
                        pass
        return False

    try:
        return rec(0)
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass


def click_hcaptcha_checkbox(driver, max_depth=4):
    """直接点 hCaptcha 的 'I am human' 复选框(【不靠 2captcha 解】)。
    实测(用户截图证实):AdsPower 真实指纹下,点一下 checkbox 多半【被动通过】(不弹九宫格图)
    → 打勾、token 自动写入、卡随之绑上。之前一直想 2captcha 解(sitekey 抓不到)是走错了方向。
    递归下钻(最多 max_depth 层)进 hcaptcha 的 checkbox/anchor iframe,点 #checkbox。返回是否点到。"""
    from selenium.webdriver.common.by import By
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    def _click_here():
        # 当前 frame 内:命中 hcaptcha 复选框元素就点(普通 click 不行就 JS click)
        for sel in ("#checkbox", "#anchor", "div[role='checkbox']", "div.check"):
            try:
                for el in driver.find_elements(By.CSS_SELECTOR, sel):
                    if el.is_displayed():
                        try:
                            el.click()
                        except Exception:
                            try:
                                driver.execute_script("arguments[0].click();", el)
                            except Exception:
                                continue
                        return True
            except Exception:
                pass
        return False

    def rec(depth):
        # 优先:当前若在 hcaptcha 帧里,直接点
        try:
            cur = driver.execute_script("return location.host || ''") or ""
        except Exception:
            cur = ""
        if "hcaptcha" in cur and _click_here():
            return True
        if depth >= max_depth:
            return False
        try:
            n = len(driver.find_elements(By.TAG_NAME, "iframe"))
        except Exception:
            return False
        for i in range(n):
            try:
                frames = driver.find_elements(By.TAG_NAME, "iframe")
                if i >= len(frames):
                    break
                driver.switch_to.frame(frames[i])
            except Exception:
                continue
            try:
                if rec(depth + 1):
                    return True
            finally:
                try:
                    driver.switch_to.parent_frame()
                except Exception:
                    try:
                        driver.switch_to.default_content()
                    except Exception:
                        pass
        return False

    try:
        return rec(0)
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass


_DUMP_JS = r"""
var out={href:(location.href||'').slice(0,160)};
try{out.hcaptchaType=typeof window.hcaptcha;}catch(e){}
try{if(window.hcaptcha){out.hcKeys=Object.keys(window.hcaptcha).slice(0,40);}}catch(e){}
try{out.hcCallbackType=typeof window.hcCallback;}catch(e){}
try{out.hcParams=window.__hcParams||null;}catch(e){}
try{out.grecaptchaType=typeof window.grecaptcha;}catch(e){}
out.textareas=[];
try{document.querySelectorAll('textarea').forEach(function(t){var s=(t.name||'')+'|'+(t.id||'');if(/captcha|h-captcha|g-recaptcha/i.test(s)){out.textareas.push({name:t.name,id:t.id,len:(t.value||'').length});}});}catch(e){}
out.widgets=[];
try{document.querySelectorAll('[data-sitekey],[data-hcaptcha-widget-id],.h-captcha,[data-callback]').forEach(function(el){out.widgets.push({tag:el.tagName,cb:el.getAttribute('data-callback'),sitekey:(el.getAttribute('data-sitekey')||'').slice(0,14),size:el.getAttribute('data-size'),wid:el.getAttribute('data-hcaptcha-widget-id'),cls:(el.className||'').slice(0,50)});});}catch(e){}
out.hcIframes=[];
try{document.querySelectorAll('iframe').forEach(function(f){var s=f.src||'';if(/hcaptcha/i.test(s)){out.hcIframes.push(s.slice(0,110));}});}catch(e){}
out.globals=[];
try{out.globals=Object.keys(window).filter(function(k){return /hcaptcha|captcha|__hc|grecaptcha|onCaptcha|turnstile/i.test(k);}).slice(0,40);}catch(e){}
try{out.bodyText=((document.body&&document.body.innerText)||'').replace(/\s+/g,' ').slice(0,140);}catch(e){}
return out;
"""


def dump_hcaptcha_state(driver, path, max_depth=4):
    """诊断:递归每层 frame dump hCaptcha 集成结构(回调/textarea/widget/全局/iframe),写 path。
       用于搞清 OpenRouter 怎么消费 token(回调名?execute promise?response字段在哪frame?)。"""
    import os as _os
    import json as _json
    from selenium.webdriver.common.by import By
    frames = []
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    def rec(depth, fpath):
        try:
            d = driver.execute_script(_DUMP_JS)
            d["_framePath"] = fpath
            frames.append(d)
        except Exception as e:
            frames.append({"_framePath": fpath, "_err": str(e)[:80]})
        if depth >= max_depth:
            return
        try:
            n = len(driver.find_elements(By.TAG_NAME, "iframe"))
        except Exception:
            return
        for i in range(n):
            try:
                fr = driver.find_elements(By.TAG_NAME, "iframe")
                if i >= len(fr):
                    break
                driver.switch_to.frame(fr[i])
            except Exception:
                continue
            try:
                rec(depth + 1, fpath + [i])
            finally:
                try:
                    driver.switch_to.parent_frame()
                except Exception:
                    try:
                        driver.switch_to.default_content()
                    except Exception:
                        pass

    try:
        rec(0, [])
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
    try:
        _os.makedirs(_os.path.dirname(path), exist_ok=True)
        _json.dump(frames, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        log("[hcap-dump] 已写 %s (%d frames)" % (path, len(frames)))
    except Exception as e:
        log("[hcap-dump] 写文件失败: %s" % str(e)[:60])
    return frames


def _extract_in_frame(driver):
    """【当前 frame 内】抓 hCaptcha sitekey/rqdata/size。
       最稳来源:切进 hcaptcha iframe 后,它自己的 location.href 就含 sitekey= 和 rqdata=(企业版)。"""
    try:
        return driver.execute_script(
            "var r={};"
            "if(window.__hcParams){r.sitekey=window.__hcParams.sitekey;r.rqdata=window.__hcParams.rqdata;r.size=window.__hcParams.size;}"
            "var loc=(location.href||'')+' '+(location.hash||'');"
            "if(!r.sitekey){var ms=loc.match(/sitekey=([0-9a-fA-F\\-]{8,})/);if(ms)r.sitekey=ms[1];}"
            "if(!r.rqdata){var mr=loc.match(/rqdata=([^&\\s]+)/);if(mr)r.rqdata=decodeURIComponent(mr[1]);}"
            "if(!r.sitekey){var el=document.querySelector('[data-sitekey],[data-hcaptcha-sitekey]');if(el)r.sitekey=el.getAttribute('data-sitekey')||el.getAttribute('data-hcaptcha-sitekey');}"
            "if(!r.sitekey){var ifrs=document.querySelectorAll('iframe[src*=\"hcaptcha\"]');for(var i=0;i<ifrs.length;i++){var m=(ifrs[i].src||'').match(/sitekey=([0-9a-fA-F\\-]{8,})/);if(m){r.sitekey=m[1];}var m2=(ifrs[i].src||'').match(/rqdata=([^&]+)/);if(m2&&!r.rqdata){r.rqdata=decodeURIComponent(m2[1]);}if(r.sitekey)break;}}"
            "return r;") or {}
    except Exception:
        return {}


def _hc_extract(driver, max_depth=4):
    """递归下钻(最多 max_depth 层)抓 sitekey/rqdata —— 关键修复:'I am human' 框嵌 2-3 层 iframe,
       只查一层抓不到 sitekey → 2captcha 没法提交。递归到 hcaptcha 帧读它的 location.href 最稳。"""
    from selenium.webdriver.common.by import By
    out = {"sitekey": None, "rqdata": None, "invisible": False}
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    def rec(depth):
        p = _extract_in_frame(driver)
        if p.get("sitekey") and not out["sitekey"]:
            out["sitekey"] = p["sitekey"]
        if p.get("rqdata") and not out["rqdata"]:
            out["rqdata"] = p["rqdata"]
        if p.get("size") == "invisible":
            out["invisible"] = True
        if out["sitekey"] and (out["rqdata"] or depth > 0):
            return  # 拿到 sitekey(+尽量rqdata)就够,别多翻
        if depth >= max_depth:
            return
        try:
            n = len(driver.find_elements(By.TAG_NAME, "iframe"))
        except Exception:
            return
        for i in range(n):
            try:
                frs = driver.find_elements(By.TAG_NAME, "iframe")
                if i >= len(frs):
                    break
                driver.switch_to.frame(frs[i])
            except Exception:
                continue
            try:
                rec(depth + 1)
            finally:
                try:
                    driver.switch_to.parent_frame()
                except Exception:
                    try:
                        driver.switch_to.default_content()
                    except Exception:
                        pass
            if out["sitekey"]:
                break

    try:
        rec(0)
    finally:
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
    return out


def solve_hcaptcha(driver, page_url, cfg, timeout=120, patcher=None, proxy=None):
    """2captcha 解 hCaptcha 并注回。成功 True，失败 False。
       patcher!=None(带 hcaptcha 规则的 cdp_fetch)时:用 CDP 跨 OOPIF 读 sitekey/rqdata + 注 token、
       调 Stripe 跨域 iframe 里捕获的真回调——这是 Stripe 隐形 hCaptcha 唯一能注进去的路(Selenium 进不去 OOPIF)。"""
    api_key = cfg.get("captcha_key")
    try:
        ua = driver.execute_script("return navigator.userAgent") or ""
    except Exception:
        ua = ""
    # ① 抓 sitekey/rqdata:优先 patcher 跨 OOPIF 读(hook 在 Stripe iframe 里把 __hcParams 捕获到那个帧),
    #    退回 Selenium _hc_extract(同进程帧)。
    p = {"sitekey": None, "rqdata": None, "invisible": False}
    if patcher:
        cands = []
        try:
            for s in patcher.eval_collect("try{JSON.stringify(window.__hcParams||null)}catch(e){null}"):
                try:
                    hp = json.loads(s) if isinstance(s, str) else s
                except Exception:
                    hp = None
                if hp and hp.get("sitekey"):
                    cands.append(hp)
        except Exception:
            pass
        if cands:
            # 页面常有多个 hcaptcha 实例(Stripe 真实例 vs 旧/外层)。优先选【带 rqdata(企业版)】的,
            # 再优先 invisible —— 那才是 Stripe 隐形 hCaptcha 的真 sitekey;取错会解错挑战、token 无效、框关不掉。
            best = sorted(cands, key=lambda h: (0 if h.get("rqdata") else 1,
                                                0 if h.get("size") == "invisible" else 1))[0]
            p["sitekey"] = best.get("sitekey")
            p["rqdata"] = best.get("rqdata")
            if best.get("size") == "invisible":
                p["invisible"] = True
            log("hcaptcha sitekey(CDP跨OOPIF)=%s rqdata=%s (候选%d个)" % (
                p["sitekey"], "有" if p["rqdata"] else "无", len(cands)))
    if not p["sitekey"]:
        p = _hc_extract(driver)
    if not p["sitekey"]:
        log("hcaptcha sitekey 未抓到"); return False
    # ★ 走账号【同一个代理】解(HCaptchaTask):2Captcha 通过相同代理IP求解 → token 带的 IP = 会话 IP,
    #   Stripe 后端校验 token 来路一致 → 不再 502(Proxyless 用 2Captcha 自己IP,IP不匹配会被严查会话502)。
    if proxy and proxy.get("host"):
        ptype = (proxy.get("type") or "socks5").lower()
        if ptype in ("socks", "socks5h"):
            ptype = "socks5"
        task = {"type": "HCaptchaTask", "websiteURL": page_url, "websiteKey": p["sitekey"],
                "proxyType": ptype, "proxyAddress": proxy["host"], "proxyPort": int(str(proxy["port"]))}
        if proxy.get("user"):
            task["proxyLogin"] = proxy.get("user")
            task["proxyPassword"] = proxy.get("pass", "")
        log("hcaptcha 用账号代理解(HCaptchaTask %s://%s:%s,token IP=会话IP,防502)" % (ptype, proxy["host"], proxy["port"]))
    else:
        task = {"type": "HCaptchaTaskProxyless", "websiteURL": page_url, "websiteKey": p["sitekey"]}
    log("hcaptcha sitekey=%s rqdata=%s invisible=%s 求解中…" % (p["sitekey"], "有(企业版)" if p["rqdata"] else "无", p["invisible"]))
    if ua:
        task["userAgent"] = ua
    if p["invisible"]:
        task["isInvisible"] = True
    if p["rqdata"]:                       # 企业版必须带 rqdata，否则 token 无效→502
        task["enterprisePayload"] = {"rqdata": p["rqdata"]}
    token = _solve_2captcha(api_key, task, timeout)
    if not token:
        log("hcaptcha 2captcha 求解失败 → 转人工"); return False
    log("hcaptcha token len=%d → 注入(CDP跨OOPIF + Selenium兜底)" % len(token))
    # ② 注入 token + 调 Stripe iframe 里捕获的真回调:patcher CDP 跨 OOPIF(关键,Stripe 框就靠这个关)+ Selenium 兜底
    if patcher:
        inject_expr = (
            "(function(){var tok=%s;"
            "try{if(typeof window.hcCallback==='function'){window.hcCallback(tok);}}catch(e){}"
            "try{if(window.hcaptcha&&typeof window.hcaptcha.setResponse==='function'){window.hcaptcha.setResponse(tok);}}catch(e){}"
            "try{document.querySelectorAll('textarea[name=\"h-captcha-response\"],textarea[name=\"g-recaptcha-response\"],textarea[id^=\"h-captcha-response\"],textarea[id^=\"g-recaptcha-response\"]').forEach(function(el){el.value=tok;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});}catch(e){}"
            "return true;})()" % json.dumps(token))
        try:
            n = patcher.eval_all(inject_expr)
            log("hcaptcha token 已 CDP 注入 %d 个 target(含 Stripe 跨域 OOPIF)" % n)
        except Exception as e:
            log("hcaptcha CDP 注入异常: %s" % str(e)[:60])
    from selenium.webdriver.common.by import By
    INJECT = ("var tok=arguments[0],called=false;"
              "try{if(typeof window.hcCallback==='function'){window.hcCallback(tok);called=true;}}catch(e){}"
              "try{if(window.hcaptcha&&typeof window.hcaptcha.setResponse==='function'){window.hcaptcha.setResponse(tok);}}catch(e){}"
              "document.querySelectorAll('textarea[name=\"h-captcha-response\"],textarea[name=\"g-recaptcha-response\"],textarea[id^=\"h-captcha-response\"],textarea[id^=\"g-recaptcha-response\"]')"
              ".forEach(function(el){el.value=tok;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));called=true;});return called;")
    had = [False]
    try:
        driver.switch_to.default_content()
    except Exception:
        pass

    def _inject(depth):
        try:
            if driver.execute_script(INJECT, token):
                had[0] = True
        except Exception:
            pass
        if depth >= 4:
            return
        try:
            n = len(driver.find_elements(By.TAG_NAME, "iframe"))
        except Exception:
            return
        for i in range(n):
            try:
                frs = driver.find_elements(By.TAG_NAME, "iframe")
                if i >= len(frs):
                    break
                driver.switch_to.frame(frs[i])
            except Exception:
                continue
            try:
                _inject(depth + 1)
            finally:
                try:
                    driver.switch_to.parent_frame()
                except Exception:
                    try:
                        driver.switch_to.default_content()
                    except Exception:
                        pass

    _inject(0)
    had = had[0]
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    # token 已注入 + OpenRouter 真回调已调(hook 捕获的 p.callback)。后端校验 token + 关模态框要几秒——
    # 之前只等 2.5s 就判失败 → 上层换卡 → page.goto 重载把 in-flight token 冲掉(用户观察对:页面被过早关闭)。
    # 这里多等几轮看框是否消失;即便框暂未消失也【返回 True(token已注入)】,交 add_card 的 Save 循环看
    # 是否 card-bound,绝不在这里判失败触发换卡(避免重载页面冲掉 token)。
    for _ in range(6):                      # 最多再等 ~15s
        time.sleep(2.5)
        try:
            if not has_hcaptcha(driver):
                log("hcaptcha 注入后挑战消失 → 通过(hadCallback=%s)" % had)
                return True
        except Exception:
            pass
    log("hcaptcha 已注入 token(hadCallback=%s),框暂未消失 → 交 Save 循环判 card-bound(不过早换卡)" % had)
    return True


def _beep():
    """弹框时响铃提醒(Windows),让人工不用一直盯屏。失败静默。"""
    try:
        import winsound
        winsound.MessageBeep(-1)
    except Exception:
        try:
            print("\a", end="", flush=True)   # 终端响铃兜底
        except Exception:
            pass


def manual_hcaptcha(driver, timeout=180, label="", done_check=None):
    """人工兜底：响铃提示用户在有头浏览器里手动点 'I am human'(同会话同IP=高信任分,必过),
       轮询直到挑战消失/出现终态/超时。label=账号标识,便于多窗口时知道点哪个。
       done_check=可选回调,返回 True 表示【已出终态(502/被拒/绑成)】→ 立刻结束等待。
       关键(用户规则 2026-06-11):人工点过后 Stripe 会出终态(尤其 502 unable-to-authenticate),
       但隐形 hCaptcha 残壳仍让 has_hcaptcha=True → 不加这个就会傻等满 timeout、走不到换段。
       一见终态就跳出 → add_card 立马判 502 换【新卡段】,不停留、实时。"""
    _beep()
    log("🙋🔔 ====== 需要人工点验证框%s ======" % (("(%s)" % label) if label else ""))
    log("🙋 请在对应浏览器窗口手动点 'I am human'(最多等 %ds)。人工点=高信任分 token,必过、不会502。" % timeout)
    end = time.time() + timeout
    beeped = 0
    while time.time() < end:
        time.sleep(2)
        # 先查终态:人工点过 Stripe 立刻回 502/被拒/绑成 → 立即结束等待(残壳让 has_hcaptcha 仍为 True)
        try:
            if done_check and done_check():
                log("✓ 检测到终态(502/被拒/绑成)→ 立即结束人工等待,交加卡流程立马处理(换段/绑成)")
                return True
        except Exception:
            pass
        try:
            if not has_hcaptcha(driver):
                log("✓ hCaptcha 已(人工)点过 → 继续加卡")
                return True
        except Exception:
            pass
        # 每 ~30s 再响一次铃催一下(人可能没听见第一声);2s*15≈30s
        beeped += 1
        if beeped % 15 == 0:
            _beep()
            log("🙋 还在等人工点验证框…(剩 %ds)" % max(0, int(end - time.time())))
    log("⏰ hCaptcha 人工等待超时(%ds 没点)。" % timeout)
    return False
