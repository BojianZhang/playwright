#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# z.ai 滑块拼图验证求解 —— 2Captcha Coordinates 取缺口坐标 + 本地可信 CDP 拖拽
#
# 文件定位：GLM/0.0.1/selenium-e2e/services/slider.py
#
# 思路(锁定方案:2Captcha 服务解,本地拖拽):
#   ① 点「Click to start verification」后弹出滑块浮层(背景图含拼图缺口 + 左下角滑块把手 >>);
#   ② CDP Page.captureScreenshot 按浮层 clip 截图(CSS 像素,scale=1) → base64;
#   ③ 2Captcha CoordinatesTask 返回缺口中心 (x,y)(图内像素=浮层内 CSS 像素);
#   ④ 滑动距离 = 缺口X − 拼图块起始X(从 DOM 取块/把手左缘;取不到则估 0)×校准比例 + 偏移;
#   ⑤ driver.execute_cdp_cmd Input.dispatchMouseEvent 拟人拖拽把手(缓入缓出+抖动+过冲回拉);
#   ⑥ 轮询「Verification Passed!/Slide successful!」判成;失败重截图重解(缺口每次会变)。
#
# ★真机首跑务必看日志里的 widget/handle/gap/distance 实测值,按需用环境变量校准:
#   SLIDER_SCALE(距离比例,默认1) / SLIDER_OFFSET(像素偏移,默认0) / SLIDER_ATTEMPTS(重试,默认4)。
#   选择器可在 web「元素维护」页覆盖:slider_popup / slider_handle / slider_piece / slider_image。
# ═══════════════════════════════════════════════════════════════════════

import os
import time
import base64
import math
import random

from common import log, http_post_json, RE_VERIFY_OK, timed, poll_signal
from common.selectors import sel_csv
from common.gap_detect import detect_gap as _detect_gap_py   # 纯Python 饱和度缺口认读(真图离线标定,零依赖)


def _trace(tag, msg):
    """把滑块每步【决策/拖拽/判定】追加到 state/slider-trace.log,供事后审计(每号每次:开没开、缺口取自哪、拖了多少、过没过)。
    与 stdout 日志分开落盘 → 不依赖 web 控制台也能逐行复盘"换个方式就不认识/刷新后不拖"到底卡在哪。出错绝不影响主流程。"""
    try:
        d = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "slider-trace.log"), "a", encoding="utf-8") as f:
            f.write("%s [%s] %s\n" % (time.strftime("%H:%M:%S"), tag, msg))
    except Exception:
        pass


# ★拖拽诊断(写进 slider-trace.log 供我直接复盘):_drag_slider_to 每次填 scale/抓取探测位移/比例,solve 的"拖完"带上它。
_LAST_DRAG_DIAG = {}


# ── 2Captcha Coordinates ────────────────────────────────────────────────
def _solve_coordinates(api_key, b64_png, comment, timeout=120):
    """提交图片 + 指令,返回 [(x,y),...](图内像素坐标)或 None。复用 createTask/getTaskResult 轮询。"""
    if not api_key:
        log("[slider] 2captcha key 未配置 → 跳过求解"); return None
    task = {"type": "CoordinatesTask", "body": b64_png, "comment": comment}
    try:
        cr = http_post_json("https://api.2captcha.com/createTask", {"clientKey": api_key, "task": task}, timeout=30)
    except Exception as e:
        log("[slider] createTask 异常: %s" % str(e)[:80]); return None
    if cr.get("errorId"):
        log("[slider] createTask 错误: %s" % (cr.get("errorCode") or cr.get("errorDescription"))); return None
    tid = cr.get("taskId")
    log("[slider] 2captcha task %s 创建,等待求解…" % tid)
    end = time.time() + timeout
    while time.time() < end:
        time.sleep(5)
        try:
            r = http_post_json("https://api.2captcha.com/getTaskResult", {"clientKey": api_key, "taskId": tid}, timeout=30)
        except Exception as e:
            log("[slider] getTaskResult 异常: %s" % str(e)[:60]); continue
        if r.get("errorId"):
            log("[slider] getTaskResult 错误: %s" % (r.get("errorCode") or r.get("errorDescription"))); return None
        if r.get("status") == "ready":
            sol = r.get("solution") or {}
            coords = sol.get("coordinates") or []
            out = []
            for c in coords:
                try:
                    out.append((float(c.get("x")), float(c.get("y"))))
                except Exception:
                    pass
            return out or None
    log("[slider] 2captcha 求解超时"); return None


# ── CapSolver VisionEngine module=slider_1:喂【拼图块 + 背景】base64 → 直接返回滑动距离 ──
#    适合阿里云这类「通用滑块」(非 GeeTest/DataDome)。比 2captcha 截图点坐标更贴合滑块。
def _cur_url(driver):
    try:
        return driver.current_url
    except Exception:
        return ""


def _grab_slider_images(driver):
    """从 DOM 直接取【背景图(带缺口)+ 拼图块】的 base64(阿里云拼图都是内嵌 data:URL)。
       返回 (piece_b64, bg_b64, scale):scale=背景图【显示宽/原始宽】,用于把 CapSolver 在原图像素空间
       给的 distance 换算成屏幕拖拽像素(原图与显示尺寸不一致时必须);失败 (None, None, 1.0)。"""
    js = r"""
      function strip(src){ if(!src) return null; var i=src.indexOf('base64,'); return i>=0?src.slice(i+7):null; }
      var els=[].slice.call(document.querySelectorAll('img,canvas')), bg=null,bgA=0,bgw=0,bgnw=0;
      for(var k=0;k<els.length;k++){ var e=els[k], r=e.getBoundingClientRect();
        if(r.width<40||r.height<40) continue;
        var src = e.tagName==='CANVAS' ? (function(){try{return e.toDataURL('image/png');}catch(_){return null;}})() : e.src;
        if(!src || src.indexOf('base64,')<0) continue;
        var a=r.width*r.height;
        if(r.width>=120 && a>bgA){ bgA=a; bg=src; bgw=r.width; bgnw=(e.naturalWidth||e.width||r.width); } }   // 最大内嵌图=背景
      var piece=null;
      for(var k=0;k<els.length;k++){ var e=els[k], r=e.getBoundingClientRect();
        var src = e.tagName==='CANVAS' ? null : e.src;
        if(!src || src.indexOf('base64,')<0) continue;
        if(r.width>=20 && r.width < bgw*0.6 && r.height>=60){ piece=src; break; } }  // 窄而高的=滑块块
      var scale = (bgnw>0) ? (bgw/bgnw) : 1;
      return { piece: strip(piece), bg: strip(bg), scale: scale };
    """
    try:
        o = driver.execute_script(js) or {}
        return o.get("piece"), o.get("bg"), float(o.get("scale") or 1.0)
    except Exception:
        return None, None, 1.0


def _solve_capsolver_slider(api_key, piece_b64, bg_b64, website_url="", timeout=120):
    """CapSolver VisionEngine slider_1:image=拼图块, imageBackground=背景。返回滑动距离(px)或 None。
       VisionEngine 多数直接在 createTask 回 solution;个别情况轮询 getTaskResult。"""
    if not api_key:
        log("[slider] capsolver key 未配置 → 跳过"); return None
    task = {"type": "VisionEngine", "module": "slider_1", "image": piece_b64, "imageBackground": bg_b64}
    if website_url:
        task["websiteURL"] = website_url
    try:
        r = http_post_json("https://api.capsolver.com/createTask", {"clientKey": api_key, "task": task}, timeout=40)
    except Exception as e:
        log("[slider] capsolver createTask 异常: %s" % str(e)[:80]); return None
    if r.get("errorId"):
        log("[slider] capsolver 错误: %s" % (r.get("errorCode") or r.get("errorDescription"))); return None
    sol = r.get("solution")
    if not sol and r.get("taskId"):
        end = time.time() + timeout
        while time.time() < end:
            time.sleep(3)
            try:
                rr = http_post_json("https://api.capsolver.com/getTaskResult", {"clientKey": api_key, "taskId": r["taskId"]}, timeout=30)
            except Exception:
                continue
            if rr.get("errorId"):
                log("[slider] capsolver getTaskResult 错误: %s" % (rr.get("errorCode") or rr.get("errorDescription"))); return None
            if rr.get("status") == "ready":
                sol = rr.get("solution"); break
    if not sol:
        return None
    try:
        return float(sol.get("distance"))
    except Exception:
        return None


# ── 浮层/把手/拼图块 定位(跨 iframe;返回 CSS 像素 bbox)──────────────────────
_PROBE_JS = r"""
return (function(popupSel, handleSel, pieceSel, imgSel){
  function box(el){ if(!el) return null; var r=el.getBoundingClientRect();
    return {x:r.left, y:r.top, w:r.width, h:r.height, cx:r.left+r.width/2, cy:r.top+r.height/2}; }
  function pick(sel){ if(!sel) return null;
    try{ var els=document.querySelectorAll(sel);
      for(var i=0;i<els.length;i++){ var e=els[i], r=e.getBoundingClientRect();
        if(r.width>0 && r.height>0) return e; } }catch(e){} return null; }
  // 浮层:优先给定选择器;否则按文案找含「verification / puzzle / 滑块」的可见容器
  var popup = pick(popupSel);
  if(!popup){
    var all=document.querySelectorAll('div,section');
    for(var i=0;i<all.length;i++){ var t=(all[i].innerText||'');
      if(/complete (the )?(security )?verification|drag the (piece|slider)|滑动|拼图|verification/i.test(t)){
        var r=all[i].getBoundingClientRect();
        if(r.width>120 && r.width<700 && r.height>120 && r.height<700){ popup=all[i]; break; } } }
  }
  var handle = pick(handleSel);
  if(!handle && popup){
    // 把手:浮层内最靠左下、可拖拽的小块(class/aria 含 slide/drag/handle/btn;或含 >> 文本)
    var cand=popup.querySelectorAll('[class*="slid" i],[class*="drag" i],[class*="handle" i],[class*="btn" i],[aria-label*="slid" i],[role="slider"],span,div,button');
    var best=null,bestScore=1e9;
    for(var j=0;j<cand.length;j++){ var e=cand[j], r=e.getBoundingClientRect();
      if(r.width>=14 && r.width<=80 && r.height>=14 && r.height<=80){
        var pr=popup.getBoundingClientRect();
        var score=(r.left-pr.left)+(pr.bottom-r.bottom); // 越靠左下越优
        if(score<bestScore){ bestScore=score; best=e; } } }
    handle=best;
  }
  var piece = pick(pieceSel);
  var img = pick(imgSel);
  if(!img){
    // 选页面上【最大】的 canvas/img(滑块拼图通常是个大 canvas)→ 排除 56x56 这类 logo/图标。
    var media=document.querySelectorAll('canvas,img'), bestA=0;
    for(var m=0;m<media.length;m++){ var e=media[m], rr=e.getBoundingClientRect();
      if(rr.width>=120 && rr.width<=600 && rr.height>=60 && rr.height<=600){
        var a=rr.width*rr.height*(e.tagName==='CANVAS'?1.5:1.0);  // 同面积优先 canvas
        if(a>bestA){ bestA=a; img=e; } } }
  }
  return { popup: box(popup), handle: box(handle), piece: box(piece), img: box(img),
           dpr: (window.devicePixelRatio||1) };
})(arguments[0], arguments[1], arguments[2], arguments[3]);
"""


def _probe(driver):
    """跨主文档 + 每个 iframe 找滑块几何;返回 (geom, frame_switched) —— geom 坐标已是【视口 CSS 像素】。"""
    from selenium.webdriver.common.by import By
    popup_sel = sel_csv("slider_popup", "")
    handle_sel = sel_csv("slider_handle", "")
    piece_sel = sel_csv("slider_piece", "")
    img_sel = sel_csv("slider_image", "")
    args = [popup_sel or None, handle_sel or None, piece_sel or None, img_sel or None]

    def _try_here():
        try:
            g = driver.execute_script(_PROBE_JS, *args)
            if g and g.get("popup") and g.get("handle"):
                return g
        except Exception:
            pass
        return None

    driver.switch_to.default_content()
    g = _try_here()
    if g:
        return g, None
    # 钻 iframe(滑块可能在跨域 iframe;注意:截图仍用 CDP clip 主视口坐标,故 iframe 内坐标需加 iframe 偏移)
    for fr in driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            off = driver.execute_script(
                "var r=arguments[0].getBoundingClientRect();return {x:r.left,y:r.top};", fr) or {"x": 0, "y": 0}
            driver.switch_to.frame(fr)
            g = _try_here()
            driver.switch_to.default_content()
            if g:
                # 把 iframe 内的 CSS 坐标平移到主视口(截图与 CDP 拖拽都用主视口坐标)
                for k in ("popup", "handle", "piece", "img"):
                    if g.get(k):
                        g[k]["x"] += off["x"]; g[k]["y"] += off["y"]
                        g[k]["cx"] += off["x"]; g[k]["cy"] += off["y"]
                return g, None
        except Exception:
            try: driver.switch_to.default_content()
            except Exception: pass
    return None, None


def _capture_clip(driver, box, scale=1):
    """CDP Page.captureScreenshot 按 CSS 像素 clip 截浮层背景图 → base64 PNG(不含 data: 前缀)。"""
    try:
        r = driver.execute_cdp_cmd("Page.captureScreenshot", {
            "format": "png",
            "clip": {"x": float(box["x"]), "y": float(box["y"]),
                     "width": float(box["w"]), "height": float(box["h"]), "scale": scale},
            "captureBeyondViewport": False,
        })
        return r.get("data")   # 已是 base64(无前缀)
    except Exception as e:
        log("[slider] 截图失败: %s" % str(e)[:80])
        return None


# ── 触发「Click to start verification」打开拼图浮层(根因:Selenium click 不触发 z.ai React 控件)──
_TRIGGER_LABELS = ["click to start verification", "start verification", "开始验证",
                   "click to verify", "verify you are human", "i'm not a robot", "点击进行验证", "点击验证"]
MIN_PUZZLE_W = float(os.environ.get("SLIDER_MIN_PUZZLE_W", "120") or 120)


def _find_trigger(driver):
    """找「点击开始验证」触发按钮中心(视口 CSS 像素)。返回 {x,y,w} 或 None。"""
    js = r"""
      var labs = arguments[0];
      var els = document.querySelectorAll('button,[role=button],div,span,a,label');
      for (var i=0;i<els.length;i++){
        var t=((els[i].innerText||els[i].textContent||'')).toLowerCase().replace(/\s+/g,' ').trim();
        if(!t || t.length>60) continue;
        for (var j=0;j<labs.length;j++){
          if(t.indexOf(labs[j])>=0){
            var r=els[i].getBoundingClientRect();
            if(r.width>40 && r.width<700 && r.height>10 && r.height<120)
              return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width};
          }
        }
      }
      return null;
    """
    try:
        return driver.execute_script(js, _TRIGGER_LABELS)
    except Exception:
        return None


def _cdp_click(driver, x, y):
    """CDP 可信点击(z.ai 验证控件是 React,Selenium .click()/JS click 可能不触发其 onClick)。"""
    try:
        driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": float(x), "y": float(y)})
        time.sleep(random.uniform(0.04, 0.10))
        driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": float(x), "y": float(y), "button": "left", "clickCount": 1})
        time.sleep(random.uniform(0.05, 0.12))
        driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": float(x), "y": float(y), "button": "left", "clickCount": 1})
        return True
    except Exception as e:
        log("[slider] CDP 点击触发异常: %s" % str(e)[:80])
        return False


def _selenium_click_trigger(driver):
    """兜底:Selenium 原生点击触发按钮(CDP 不行时另试一条)。"""
    from selenium.webdriver.common.by import By
    for lab in ("Click to start verification", "start verification", "开始验证"):
        try:
            els = driver.find_elements(By.XPATH,
                "//button[contains(normalize-space(.), '%s')] | //*[@role='button'][contains(normalize-space(.), '%s')]" % (lab, lab))
            for el in els:
                if el.is_displayed():
                    el.click(); return True
        except Exception:
            pass
    return False


def _find_refresh(driver):
    """找阿里云【刷新按钮】(拼图右上角圈箭头)中心坐标 → 用 CDP 可信点击换新拼图。
    先试选择器;找不到就按【拼图背景图右上角内缩 ~16px】算位置(用户实测刷新就在那)。返回 {x,y,by} 或 None。"""
    js = r"""
      function ctr(e){var r=e.getBoundingClientRect(); if(r.width<=0||r.height<=0) return null; return {x:r.left+r.width/2, y:r.top+r.height/2}; }
      var sels=['#aliyunCaptcha-refresh','[id*="refresh" i]','[class*="refresh" i]','[class*="reload" i]',
                '[aria-label*="refresh" i]','[aria-label*="刷新" i]','[title*="refresh" i]','[title*="刷新" i]'];
      for(var s=0;s<sels.length;s++){ try{ var es=document.querySelectorAll(sels[s]);
        for(var i=0;i<es.length;i++){ var c=ctr(es[i]); if(c) return {x:c.x, y:c.y, by:'sel'}; } }catch(e){} }
      var pz=document.querySelector('#aliyunCaptcha-img, img.puzzle');   // 兜底:按拼图图右上角内缩算
      if(pz){ var r=pz.getBoundingClientRect(); if(r.width>120) return {x:r.right-16, y:r.top+16, by:'corner'}; }
      return null;
    """
    try:
        return driver.execute_script(js)
    except Exception:
        return None


# ── 监听【背景拼图图】的加载状态:src 内容签名 + 是否真加载完成(complete && naturalWidth>0)──
#    ★换图(刷新)后必须等【新图】真加载完成再干活(用户:不监听加载完成会拖旧图/拖空 → 掉成功率)。
_BG_SIG_JS = r"""
return (function(){
  var els=[].slice.call(document.querySelectorAll('img,canvas')), bg=null,bgA=0;
  for(var k=0;k<els.length;k++){ var e=els[k], r=e.getBoundingClientRect();
    if(r.width<120||r.height<40) continue;
    var loaded=(e.tagName==='CANVAS')?true:(e.complete && e.naturalWidth>0);
    if(!loaded) continue;                                   // 只在【已加载完成】的图里挑最大背景
    var a=r.width*r.height; if(a>bgA){ bgA=a; bg=e; } }
  if(!bg) return { loaded:false, sig:'' };                  // 当前无已加载完成的背景图(刷新换图加载中)
  var src = bg.tagName==='CANVAS' ? (function(){try{return bg.toDataURL('image/png');}catch(_){return '';}})() : (bg.src||'');
  var i=src.indexOf('base64,'); var tail = i>=0 ? src.slice(i+7, i+7+80) : src.slice(-120);
  return { loaded:true, sig: (src.length + '|' + (bg.naturalWidth||bg.width||0) + '|' + tail) };
})();
"""


def _bg_sig(driver):
    """返回 (loaded, sig):loaded=当前是否有【加载完成】的背景拼图图;sig=该图内容签名(换图必变)。
       供刷新后【监听新图真加载完成】:sig 变了 且 loaded=True → 新图就绪。"""
    try:
        o = driver.execute_script(_BG_SIG_JS) or {}
        return (bool(o.get("loaded")), str(o.get("sig") or ""))
    except Exception:
        return (False, "")


# ★轻量签名:只读 img.src 长度/尾巴/naturalWidth(不取整张 base64、不 toDataURL)→ 极便宜,可高频轮询不堵 CDP。
#   选块/背景口径与 _slider_metrics 一致(背景=最大 base64 图;块=更小那张)。稳定判据=这俩 src 都不再变。
_PUZZLE_LIGHTSIG_JS = r"""
return (function(){
  var imgs=[].slice.call(document.querySelectorAll('img'));
  var bg=null,bgA=0,bw=0;
  for(var i=0;i<imgs.length;i++){var e=imgs[i],r=e.getBoundingClientRect();
    if(!e.src||e.src.indexOf('base64,')<0)continue;
    if(!(e.complete&&e.naturalWidth>0))continue;
    var a=r.width*r.height; if(r.width>=120&&a>bgA){bgA=a;bg=e;bw=r.width;}}
  if(!bg) return '';
  var piece=null,pw=1e9;
  for(var i=0;i<imgs.length;i++){var e=imgs[i],r=e.getBoundingClientRect();
    if(!e.src||e.src.indexOf('base64,')<0)continue;
    if(!(e.complete&&e.naturalWidth>0))continue;
    if(r.width>=20&&r.width<bw*0.6&&r.height>=60&&r.width<pw){pw=r.width;piece=e;}}
  if(!piece) return '';
  function sig(e){var s=e.src;return s.length+':'+s.slice(-40)+':'+(e.naturalWidth||0);}
  return sig(bg)+'|'+sig(piece);
})();
"""


def _wait_puzzle_stable(driver, settle=None, timeout=None):
    """等【拼图块+背景都加载完成且 src 连续 settle 秒不变】(=真正定型),稳了再【抓一次】真数据返回。
    ★关键(治上一版引入的「整个滑块卡死不拖」):轮询用【轻量签名】(_PUZZLE_LIGHTSIG_JS,只读 src 长度/尾巴,
      不取整张 base64)→ 高频轮询也不堵 CDP;只在判定稳定后调【一次】昂贵的 _slider_metrics。原来每 0.35s 抓整张
      base64(并发多窗时)把 CDP 打爆 → execute_script 排队 → 浮层开着却迟迟不拖 = 卡死。
    超时:抓最后一次(缺口位置不随动效变仍可用);全程没块/背景 → None。"""
    settle = settle if settle is not None else float(os.environ.get("SLIDER_IMG_SETTLE", "0.6") or 0.6)
    timeout = timeout if timeout is not None else float(os.environ.get("SLIDER_IMG_STABLE_WAIT", "8") or 8)
    end = time.time() + timeout
    prev = None; prev_t = 0.0; seen = False
    while time.time() < end:
        try:
            sig = driver.execute_script(_PUZZLE_LIGHTSIG_JS) or ""
        except Exception:
            sig = ""
        if sig:
            seen = True; now = time.time()
            if sig == prev:
                if now - prev_t >= settle:
                    return _slider_metrics(driver)   # src 连续 settle 秒不变 → 稳定,抓一次真数据
            else:
                prev = sig; prev_t = now            # src 又变了(还在 swap/加载)→ 重新计时
        else:
            prev = None                             # 块或背景还没就绪 → 继续等
        time.sleep(0.25)
    if seen:
        log("[slider] 拼图图限时内未完全定型(疑慢加载/动效)→ 抓最后一帧解(缺口位置不随动效变,仍可用)")
        return _slider_metrics(driver)
    return None


def _refresh_puzzle(driver, tag=""):
    """换一张【新拼图】:CDP 点刷新(React 控件 .click() 不触发)+ ★监听【新图真加载完成】再返回(不是旧图还在就返回)。
    失败重试 与 CapSolver 垃圾值 都走它(统一一处,不重复)。返回是否拿到【新】可解拼图。"""
    _, before_sig = _bg_sig(driver)        # ★记录刷新【前】的图签名,用于判断"是不是真换了新图"
    rf = _find_refresh(driver)
    if rf:
        log("[slider][%s] 点刷新 @%.0f,%.0f(%s)" % (tag, rf["x"], rf["y"], rf.get("by")))
        _cdp_click(driver, rf["x"], rf["y"])
    else:
        log("[slider][%s] ⚠ 没定位到刷新按钮 → 靠 _ensure_open 重新触发" % tag)
    # ★监听新图:①背景图签名变了(确实换了新图)②块+背景可提取(可解)→ 返回让上层进入【稳定等待+抓取】。
    #   不在这里死等"稳定"(由下轮 solve 的 _wait_puzzle_stable 统一把关);这里只确认"换了新图、可解"。
    #   ★若刷新把控件【塌回「点击开始验证」触发态】(阿里云有时直接重置)→ 别干等满 8s,立刻交 _ensure_open 重新触发。
    wait = float(os.environ.get("SLIDER_REFRESH_WAIT", "8") or 8)
    _rend = time.time() + wait
    while time.time() < _rend:
        # 塌回触发态判据用【拼图图是否还在】(_puzzle_geom 视觉判据,稳),不用 _puzzle_ready(base64 提取偶发性失败会误判塌陷)。
        _g0, _vis0 = _puzzle_geom(driver)
        if not _vis0 and _find_trigger(driver):
            log("[slider][%s] 刷新后控件塌回触发态(无拼图图)→ 交 _ensure_open 重新触发(不干等)" % tag)
            return False
        loaded, sig = _bg_sig(driver)
        changed = (sig != before_sig) if before_sig else loaded   # 没旧签名(首开)→ 只要 loaded 即可
        if loaded and changed and _puzzle_ready(driver):
            log("[slider][%s] 新拼图已换上(可解)→ 交下轮稳定等待+抓取" % tag)
            return True
        time.sleep(0.3)
    log("[slider][%s] 等新拼图换上超时(%.0fs)→ 交下轮 _ensure_open 兜底" % (tag, wait))
    return False


def _puzzle_geom(driver):
    """探针 + 真拼图判据。返回 (g, ok);ok=True 仅当找到尺寸够大的拼图图(排除 logo/图标)。"""
    g, _ = _probe(driver)
    if not g:
        return None, False
    img = g.get("img") or {}
    return g, ((img.get("w") or 0) >= MIN_PUZZLE_W)


def _puzzle_ready(driver):
    """★真·可解判据:拼图块 + 背景的 base64 都能提取到(与解题步同口径)。
    用它做"是否打开"的统一标准——失败残留的旧图(提不出 base64)蒙混不过去 → _ensure_open 会重新触发新拼图,
    根治"_ensure_open 说开着、解题步却没取到拼图块/背景"的不一致(重试白废)。"""
    m = _slider_metrics(driver)
    return bool(m and m.get("piece") and m.get("bg"))


def _captcha_sdk_present(driver):
    """阿里云验证码 SDK / 容器 / 脚本是否已在页面(=控件还在异步加载,别急着刷页 —— 刷页会把没加载完的冲掉重来,
       慢代理上永远加载不完;用户实证"页面元素经常不加载全")。判:全局对象 / aliyunCaptcha 容器 / 第三方验证码脚本。"""
    try:
        return bool(driver.execute_script(r"""return (function(){
          try{
            if (window.AliyunCaptcha||window.aliyunCaptcha||window.AWSC||window.initAliyunCaptcha||window.NoCaptcha) return true;
            if (document.querySelector('[id*="aliyunCaptcha" i],[class*="aliyunCaptcha" i],[id*="captcha" i],[class*="captcha" i],[class*="nc_" i],[class*="nocaptcha" i]')) return true;
            var ss=document.querySelectorAll('script[src]');
            for (var i=0;i<ss.length;i++){var s=(ss[i].src||'').toLowerCase();
              if(s.indexOf('aliyun')>=0||s.indexOf('awsc')>=0||s.indexOf('captcha')>=0) return true;}
            return false;
          }catch(e){return false;}
        })();"""))
    except Exception:
        return False


def _force_captcha_render(driver):
    """★强制催渲染(控件 SDK 在、但触发器迟迟不出时):【不刷页、不重载】,只派发几个常能唤醒懒加载/重排的无害事件——
       给密码框 focus/blur(很多表单在交互后才初始化验证码)、滚动到底再回顶、派发 window resize/scroll。
       尽力而为(吞异常),不影响已填表单值,失败也不影响主流程。"""
    try:
        driver.execute_script(r"""(function(){
          try{
            var pw=document.querySelector('input[type=password]'); if(pw){pw.focus(); pw.blur(); pw.focus();}
            window.scrollTo(0, document.body.scrollHeight); window.scrollTo(0,0);
            window.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('scroll'));
          }catch(e){}
        })();""")
        return True
    except Exception:
        return False


def _ensure_open(driver, total_wait=None):
    """确保【真正可解的】拼图浮层已打开(base64 块+背景就绪),否则触发按钮一出现就点(0.4s 轮询、节流 1.5s、CDP/Selenium 交替)。
    ★判据用 _puzzle_ready(与解题同口径)→ 失败后旧残留图蒙不过去,会重新触发新拼图,重试才真生效。
    ★耗时≈阿里云控件真实异步加载时间,不在固定边界白等(实测把"打开"从 ~24s 压到 ~8s)。total_wait 上限(env SLIDER_OPEN_WAIT)。"""
    total_wait = total_wait if total_wait is not None else float(os.environ.get("SLIDER_OPEN_WAIT", "30") or 30)
    if _puzzle_ready(driver):
        return True
    end = time.time() + total_wait
    last_click = 0.0
    n = 0
    vis_since = 0.0   # 拼图图【可见】起始时刻 —— 可见但 base64 迟迟取不到时,别干等满 22s(=卡死),给 grace 后就当开着放行
    _vis_grace = float(os.environ.get("SLIDER_OPEN_VIS_GRACE", "4") or 4)
    no_ctrl_since = 0.0   # 连续【无触发元素也无浮层】起始时刻
    _no_ctrl_grace = float(os.environ.get("SLIDER_NO_CONTROL_GRACE", "12") or 12)      # ★SDK 都不在(脚本真没加载)→ 超此即快速失败刷页(原8s太短=刷太快)
    _no_ctrl_hardcap = float(os.environ.get("SLIDER_NO_CONTROL_HARDCAP", "25") or 25)  # ★SDK 在(还在加载)→ 耐心等到此硬上限再放弃,别刷页把加载冲掉
    _forced = False       # 是否已催过一次渲染(强制加载)
    while time.time() < end:
        if _puzzle_ready(driver):
            log("[slider] 拼图浮层已打开(块+背景 base64 就绪)")
            return True
        # ★浮层已可见(有拼图图)→ 等它 base64 就绪;但【可见超过 grace 秒仍取不到 base64】= 别再死等(治 22s 卡死)→
        #   当作"开着"放行,交给解题步的 _wait_puzzle_stable 去稳定抓取(它有自己的兜底)。绝不在可见时再点触发(防点没)。
        _gg, _vis = _puzzle_geom(driver)
        if _vis:
            now = time.time()
            if vis_since == 0.0:
                vis_since = now
            elif now - vis_since >= _vis_grace:
                log("[slider] 拼图图可见但 base64 久未就绪(%.0fs)→ 当作已开放行,交稳定抓取兜底(不再死等)" % _vis_grace)
                return True
            time.sleep(0.4); continue
        vis_since = 0.0
        tr = _find_trigger(driver)
        if tr:
            no_ctrl_since = 0.0                          # 有触发元素=控件在加载 → 重置"无控件"计时
            if (time.time() - last_click) >= 1.5:        # 仅在【无可见浮层】时点触发(节流防重复点;CDP 优先,交替 Selenium 兜底)
                if n % 2 == 0:
                    log("[slider] CDP 可信点击触发 @%.0f,%.0f" % (tr["x"], tr["y"])); _cdp_click(driver, tr["x"], tr["y"])
                else:
                    log("[slider] Selenium 点击触发"); _selenium_click_trigger(driver)
                last_click = time.time(); n += 1
        else:
            # ★没触发器也没浮层 → 分两种,别一律就刷(用户:"刷太快,把没加载完的冲掉重来,永远加载不全"):
            #   (a)验证码 SDK/容器/脚本【在】= 还在异步加载 → 耐心等到 hardcap,中途【强制催一次渲染】(不刷页);
            #   (b)SDK 都【不在】= 脚本真没加载(代理挂/页面没渲染)→ 干等也没用,grace 秒快速失败交上层刷当前页重载。
            now = time.time()
            if no_ctrl_since == 0.0:
                no_ctrl_since = now
            _elapsed = now - no_ctrl_since
            if _captcha_sdk_present(driver):
                if (not _forced) and _elapsed >= max(3.0, _no_ctrl_grace * 0.5):
                    log("[slider] 验证码 SDK 在但触发器未出(%.0fs)→ 强制催渲染(聚焦/滚动/resize,不刷页)" % _elapsed)
                    _force_captcha_render(driver); _forced = True
                if _elapsed >= _no_ctrl_hardcap:
                    log("[slider] 验证码 SDK 在但 %.0fs 仍没出触发器(超硬上限)→ 放弃,交上层刷当前页" % _no_ctrl_hardcap)
                    return False
                # SDK 在、未超硬上限 → 继续等(绝不刷页把加载冲掉)
            elif _elapsed >= _no_ctrl_grace:
                log("[slider] %.0fs 无触发/无浮层/无验证码SDK=脚本真没加载 → 快速失败,交上层刷当前页重载" % _no_ctrl_grace)
                return False
        time.sleep(0.4)
    log("[slider] 等触发/可解拼图渲染超时(%.0fs)" % total_wait)
    return False


def _dump_debug(driver, tag):
    """整页截图 + 所有 canvas/img 尺寸 + 触发按钮/疑似浮层 DOM 落 state/slider-debug/,供真机定位 z.ai 滑块 DOM。"""
    try:
        import json as _json
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "slider-debug")
        os.makedirs(base, exist_ok=True)
        safe = "".join(ch if (ch.isalnum() or ch in "-_.") else "_" for ch in str(tag))[:60]
        try:
            shot = driver.execute_cdp_cmd("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
            if shot.get("data"):
                with open(os.path.join(base, safe + ".png"), "wb") as f:
                    f.write(base64.b64decode(shot["data"]))
        except Exception:
            pass
        info = driver.execute_script(r"""
          function rect(e){var r=e.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left),y:Math.round(r.top)};}
          var media=[].slice.call(document.querySelectorAll('canvas,img')).map(function(e){var o=rect(e);o.tag=e.tagName;o.cls=(e.className||'').toString().slice(0,80);o.src=(e.src||'').slice(0,90);return o;});
          var btns=[].slice.call(document.querySelectorAll('button,[role=button],div,span,a')).filter(function(e){return /verif|验证|robot/i.test(e.innerText||'');}).slice(0,10).map(function(e){var o=rect(e);o.txt=(e.innerText||'').replace(/\s+/g,' ').trim().slice(0,40);o.cls=(e.className||'').toString().slice(0,80);return o;});
          var host=document.querySelector('#aliyunCaptcha-float-wrapper,[id*="aliyunCaptcha" i],[class*="aliyun" i],[class*="captcha" i],[class*="slid" i],[class*="puzzle" i],[class*="geetest" i],[id*="captcha" i]');
          // 候选可拖手柄/滑块按钮(阿里云真正要拖的那个元素),供定位拖拽起点
          var handles=[].slice.call(document.querySelectorAll('[class*="slid" i],[class*="drag" i],[class*="handle" i],[class*="btn" i],[id*="slid" i],[id*="drag" i],[class*="move" i],[class*="track" i],[class*="nc_" i],[role=slider]')).map(function(e){var o=rect(e);o.tag=e.tagName;o.id=e.id||'';o.cls=(e.className||'').toString().slice(0,90);return o;}).filter(function(o){return o.w>0&&o.h>0;}).slice(0,24);
          return {url:location.href, media:media, btns:btns, handles:handles, host: host?host.outerHTML.slice(0,8000):null};
        """)
        with open(os.path.join(base, safe + ".json"), "w", encoding="utf-8") as f:
            f.write(_json.dumps(info, ensure_ascii=False, indent=2))
        log("[slider] 诊断快照已存 state/slider-debug/%s.{png,json}" % safe)
    except Exception as e:
        log("[slider] 诊断快照失败: %s" % str(e)[:80])


def _save_b64_png(b64, name):
    """把一张 base64 PNG 落到 state/slider-debug/<name>.png(诊断用:看 CapSolver 实际收到的图)。"""
    try:
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "slider-debug")
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, name + ".png"), "wb") as f:
            f.write(base64.b64decode(b64))
    except Exception:
        pass


def build_drag_path(x0, y0, distance, steps=None):
    """生成拟人拖拽轨迹 [(x,y),...]:缓入缓出 + 纵向抖动 + 过冲后回拉到位。distance 可负。"""
    distance = float(distance)
    steps = steps or random.randint(44, 68)   # 多步=小增量=滑块跟得上(治「鼠标快滑块跟不上」)
    overshoot = (8 + random.uniform(0, 10)) * (1 if distance >= 0 else -1) if abs(distance) > 30 else 0
    peak = distance + overshoot
    path = [(x0, y0)]
    for i in range(1, steps + 1):
        t = i / steps
        ease = 0.5 - 0.5 * __import__("math").cos(3.14159265 * t)   # cos 缓入缓出
        x = x0 + peak * ease
        y = y0 + random.uniform(-2, 2)
        path.append((x, y))
    if overshoot:                       # 过冲后回拉到精确终点(人手过头再修正)
        for _ in range(random.randint(2, 4)):
            path.append((x0 + distance + random.uniform(-1.2, 1.2), y0 + random.uniform(-1, 1)))
    path.append((x0 + distance, y0))
    return path


def _drag(driver, path):
    """CDP 可信鼠标拖拽。★关键:拖拽途中的 mouseMoved 必须带 buttons:1(左键按住位掩码),
       否则页面的拖拽处理器(阿里云滑块靠 e.buttons===1 判定)认为没按住 → 滑块跟一下就停
       (用户实测「鼠标快、滑块跟不上」的根因)。mousePressed=buttons:1, mouseReleased=buttons:0。"""
    def ev(typ, x, y, buttons):
        p = {"type": typ, "x": float(x), "y": float(y), "buttons": int(buttons)}
        if typ in ("mousePressed", "mouseReleased"):
            p.update({"button": "left", "clickCount": 1})
        else:
            p["button"] = "none"     # mouseMoved 的 button 应为 none,按住状态由 buttons 位表达
        driver.execute_cdp_cmd("Input.dispatchMouseEvent", p)
    x0, y0 = path[0]
    ev("mouseMoved", x0, y0, 0); time.sleep(random.uniform(0.06, 0.14))     # 悬停到把手(未按)
    ev("mousePressed", x0, y0, 1); time.sleep(random.uniform(0.12, 0.22))   # 按下,稍停(人手抓住再动)
    for (x, y) in path[1:]:
        ev("mouseMoved", x, y, 1); time.sleep(random.uniform(0.012, 0.035)) # ★按住拖(buttons:1)
    xe, ye = path[-1]
    time.sleep(random.uniform(0.10, 0.20))                                  # 到位后停顿再松(人手停稳)
    ev("mouseReleased", xe, ye, 0)


_DETECT_GAP_JS = r"""
return (function(){
  function pieces(){
    var imgs=[].slice.call(document.querySelectorAll('img')), bg=null,bgA=0,piece=null;
    for(var i=0;i<imgs.length;i++){var e=imgs[i],r=e.getBoundingClientRect();
      if(!e.src||e.src.indexOf('base64,')<0)continue; if(r.width<40||r.height<40)continue;
      var a=r.width*r.height; if(r.width>=120&&a>bgA){bgA=a;bg=e;}}
    if(!bg)return null; var bw=bg.getBoundingClientRect().width;
    for(var i=0;i<imgs.length;i++){var e=imgs[i],r=e.getBoundingClientRect();
      if(!e.src||e.src.indexOf('base64,')<0)continue;
      if(r.width>=20&&r.width<bw*0.6&&r.height>=60){piece=e;break;}}
    return {bg:bg,piece:piece};
  }
  var P=pieces(); if(!P||!P.bg||!P.piece) return null;
  function px(img){ try{ var c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
    var x=c.getContext('2d',{willReadFrequently:true}); if(!x)return null; x.drawImage(img,0,0);
    return {w:c.width,h:c.height,d:x.getImageData(0,0,c.width,c.height).data}; }catch(e){return null;} }
  var B=px(P.bg), PC=px(P.piece); if(!B||!PC||B.w<60||PC.w<10) return null;
  // 拼图块 alpha 轮廓点(降采样):opaque 像素紧邻 transparent = 轮廓
  var pts=[],step=2;
  for(var y=1;y<PC.h-1;y+=step){ for(var x=1;x<PC.w-1;x+=step){
    var i=(y*PC.w+x)*4+3;
    if(PC.d[i]>120 && (PC.d[i-4]<=120||PC.d[i+4]<=120||PC.d[((y-1)*PC.w+x)*4+3]<=120||PC.d[((y+1)*PC.w+x)*4+3]<=120)) pts.push([x,y]);
  }}
  if(pts.length<12) return {gapLeftX:-1, reason:'no-alpha', ptCount:pts.length, bgNatW:B.w, bgDispW:P.bg.getBoundingClientRect().width};
  function gx(x,y){ if(x<1)x=1; if(x>=B.w-1)x=B.w-2; var l=(y*B.w+(x-1))*4, r=(y*B.w+(x+1))*4;
    var gl=0.299*B.d[l]+0.587*B.d[l+1]+0.114*B.d[l+2], gr=0.299*B.d[r]+0.587*B.d[r+1]+0.114*B.d[r+2];
    return Math.abs(gr-gl); }
  var minShift=Math.floor(PC.w*0.5), maxShift=B.w-PC.w, best=-1,bestS=-1,sum=0,cnt=0;
  for(var sx=minShift; sx<=maxShift; sx++){
    var s=0; for(var k=0;k<pts.length;k++){ var by=pts[k][1]; if(by<0||by>=B.h)continue; s+=gx(sx+pts[k][0], by); }
    sum+=s; cnt++; if(s>bestS){bestS=s;best=sx;}
  }
  var mean=cnt?sum/cnt:0;
  return { gapLeftX:best, score:bestS, ratio:(mean>0?bestS/mean:0), ptCount:pts.length,
           bgNatW:B.w, bgDispW:P.bg.getBoundingClientRect().width,
           pieceNatW:PC.w, pieceDispW:P.piece.getBoundingClientRect().width };
})();
"""


def _detect_gap_local(driver):
    """★本地认读缺口(不依赖 CapSolver):canvas 读拼图块+背景像素,把块的 alpha 轮廓在背景上滑动,
       找轮廓与背景边缘对齐最强处 = 缺口。返回 {gapLeftX(块左缘要到的背景原图px), ratio(置信=峰值/均值), ...} 或 None。
       全本地、确定性、免费、分辨率无关(gapLeftX 在原图px,后续用实时显示宽换算)。"""
    try:
        return driver.execute_script(_DETECT_GAP_JS)
    except Exception as e:
        log("[slider] 本地认读异常: %s" % str(e)[:80])
        return None


def _drag_slider_to(driver, piece_slide, y_hint=None):
    """★闭环拖拽(早上 trace 实测稳定 PASS、残差≈0 的版本,恢复原样):驱动滑块按钮,每步回读【拼图块】真实位置,
       按钮↔块比例实时自适应,直到块滑动 piece_slide(屏幕px,=CapSolver+本地裁判给的缺口)。
       全程读 getBoundingClientRect 的 CSS px(与 CDP Input 同坐标系)→ 分辨率/DPR/缩放无关。返回残差px 或 None。"""
    def geom():
        try:
            return driver.execute_script(r"""
              function rc(e){var r=e.getBoundingClientRect();return {cx:r.left+r.width/2,cy:r.top+r.height/2,left:r.left,w:r.width};}
              function pick(s){var e=document.querySelector(s);return e?rc(e):null;}
              var b=pick('#aliyunCaptcha-sliding-slider')||pick('.slider-move')||pick('[id*="sliding-slider" i]');
              var imgs=[].slice.call(document.querySelectorAll('img')), bg=null,bgA=0,piece=null,pw=1e9,bw=300;
              for(var i=0;i<imgs.length;i++){var e=imgs[i],r=e.getBoundingClientRect();
                if(!e.src||e.src.indexOf('base64,')<0)continue;
                var a=r.width*r.height; if(r.width>=120&&a>bgA){bgA=a;bw=r.width;}}
              for(var i=0;i<imgs.length;i++){var e=imgs[i],r=e.getBoundingClientRect();
                if(!e.src||e.src.indexOf('base64,')<0)continue;
                if(r.width>=20&&r.width<bw*0.6&&r.height>=60&&r.width<pw){pw=r.width;piece=rc(e);}}
              return {b:b, piece:piece, dpr:(window.devicePixelRatio||1)};
            """)
        except Exception:
            return None

    def ev(typ, x, yy, buttons):
        # CDP Input 用 CSS px(与 getBoundingClientRect 同坐标系,分辨率/DPR 无关)→ 不做任何缩放。
        p = {"type": typ, "x": float(x), "y": float(yy), "buttons": int(buttons)}
        if typ in ("mousePressed", "mouseReleased"):
            p.update({"button": "left", "clickCount": 1})
        else:
            p["button"] = "none"
        try:
            driver.execute_cdp_cmd("Input.dispatchMouseEvent", p)
        except Exception:
            pass

    g = geom()
    if not g or not g.get("b"):
        return None
    b = g["b"]
    piece0 = g.get("piece")
    y = b["cy"] if y_hint is None else float(y_hint)
    def piece_left():
        g2 = geom()
        return (g2.get("piece") or {}).get("left") if g2 else None

    def _btn_cx():
        g2 = geom(); return (g2.get("b") or {}).get("cx") if g2 else None

    use_piece = piece0 is not None
    readpos = piece_left if use_piece else _btn_cx

    # ★闭环拖拽(早上 trace 实测 50 次 PASS、残差≈0 的版本,恢复原样):按下把手后,每步回读【拼图块】真实位置,
    #   按钮↔块比例【实时自适应】,驱动到块滑动 piece_slide 即停。全程读 getBoundingClientRect 的 CSS px(与 CDP Input 同坐标系)
    #   → 分辨率/DPR/缩放怎么变都自收敛 = 一劳永逸。块 rect 不随拖动变化(canvas 重绘)→ 回退按钮位移模式。
    mouse_x = b["cx"]
    ev("mouseMoved", mouse_x, y, 0); time.sleep(random.uniform(0.05, 0.10))
    ev("mousePressed", mouse_x, y, 1); time.sleep(random.uniform(0.12, 0.20))
    ratio = 1.0
    target = (piece0["left"] + float(piece_slide)) if use_piece else (b["cx"] + float(piece_slide))
    stall = 0
    deadline = time.time() + 4.0
    while time.time() < deadline:
        cur = readpos()
        if cur is None:
            break
        rem = target - cur
        if rem <= 1.5:                          # 块到位(从下方逼近,不越过)
            break
        want_piece = min(rem - 0.8, max(1.0, rem * 0.45))          # 缓入缓出:剩得多走得多、收尾走小步,绝不过冲
        step = max(1.0, min(want_piece / max(ratio, 0.3), 14.0))   # 换成鼠标步长(按实时比例),封顶 14
        before = cur
        mouse_x += step
        ev("mouseMoved", mouse_x, y + random.uniform(-1.0, 1.0), 1)
        time.sleep(random.uniform(0.010, 0.024))
        c2 = readpos()
        if c2 is not None and (c2 - before) > 0.4:
            ratio = 0.6 * ratio + 0.4 * ((c2 - before) / step); stall = 0   # 实时更新 按钮↔块 比例
        else:
            stall += 1
            if stall >= 5:
                if use_piece:
                    log("[slider] ⚠ 拼图块 rect 不随拖动变化 → 切按钮位移兜底")
                    use_piece = False; target = b["cx"] + float(piece_slide); readpos = _btn_cx; ratio = 1.0; stall = 0
                else:
                    break
    time.sleep(random.uniform(0.10, 0.20))      # ★前向不可逆:不做"拉回"微调,停稳松手
    ev("mouseReleased", mouse_x, y, 0)
    cur = readpos()
    _LAST_DRAG_DIAG.clear()
    _LAST_DRAG_DIAG.update({"target": round(target, 1),
                            "landed": (round(cur, 1) if cur is not None else None), "mode": "closed-loop"})
    return (target - cur) if cur is not None else None


def _passed(driver, wait=None, residual=None):
    """判定滑块是否通过 —— ★用 common.poll_signal 轮询(阿里云服务端校验有延迟,「Verification Passed!」
       横幅是拖完之后才弹的,只查一次会漏判→误重试)。成功文案→True;失败文案→False(外层刷新重试);
       超时再看拼图浮层是否消失(消失且无失败文案→兜底视为通过)。主文档 + 所有 iframe 文本都看。
       ★默认等待 6→9s(env SLIDER_PASS_WAIT 可调):服务端校验偶 >6s 才弹横幅,等太短=【真过却判没过】→
         误把好号当 SLIDER_FAIL 丢掉(审计 critical 假阴性)。超时仍未定 + 浮层已消失 → 视为通过(兜底)。
       ★residual(本次拖拽残差px,SLIDER-6 修):浮层【消失但无明确成功文案】('gone')时,只有【残差合理】才信任为通过。
         过冲/抓不住(残差极大或 NaN,实测 -105.9)时浮层消失多是被拖散/出错而非真通过 → 不信任,判失败重试。
         残差小(好拖拽)时 'gone' 仍=通过 → 不动假阴性那条兜底(只收紧明显坏拖拽,绝不误丢好号,也更保守不会让坏号往下走)。"""
    if wait is None:
        wait = float(os.environ.get("SLIDER_PASS_WAIT", "9") or 9)
    _gone_tol = float(os.environ.get("SLIDER_GONE_TRUST_TOL", "18") or 18)   # 'gone' 信任的残差上限(px)
    # ★★成功信号【不止文案】(治"明明到位置、绿条已出/弹层已关,却判没过→刷新→毁掉成功"):
    #   阿里云通过时:① 弹「Verification Passed」②滑轨/滑块变【绿色】成功条 ③拼图浮层随即【关闭消失】。
    #   任一出现=PASS(立即,不再刷新)。失败文案=FAIL。三者都没=未定(继续轮询)。
    _OK_JS = r"""
return (function(){
  function txt(){ var s=document.body?document.body.innerText:'';
    var fs=document.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){try{var b=fs[i].contentDocument&&fs[i].contentDocument.body; if(b)s+=' '+b.innerText;}catch(e){}}
    return s; }
  var t=txt();
  if(/verification (passed|success)|slide successful|验证(通过|成功)|校验通过/i.test(t)) return 'ok';
  if(/verification failed|try again|验证失败|重新尝试/i.test(t)) return 'fail';
  // 绿色成功条:阿里云滑轨/滑块/成功层背景变绿(g 明显 > r,b)
  try{
    var els=document.querySelectorAll('[id*="aliyunCaptcha" i] *,[class*="slider" i],[class*="sliding" i],[class*="success" i],[id*="sliding" i]');
    for(var k=0;k<els.length;k++){ var bg=getComputedStyle(els[k]).backgroundColor||'';
      var m=bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if(!m)continue;
      var r=+m[1],g=+m[2],b=+m[3]; if(g>=120 && g>r+35 && g>b+35) return 'ok'; }   // 绿=成功
  }catch(e){}
  // 拼图浮层/缺口图/滑块已【消失】= 验证落地、浮层收起 = 通过
  if(!document.querySelector('#aliyunCaptcha-float-wrapper, #aliyunCaptcha-img, img.puzzle, #aliyunCaptcha-sliding-slider')) return 'gone';
  return '';
})();
"""
    def _check():
        try:
            v = driver.execute_script(_OK_JS) or ""
        except Exception:
            return None
        if v in ("ok", "fail", "gone"):
            return v          # 返回具体信号(不再把 ok/gone 都压成 True)→ 上层据 residual 决定是否信任 'gone'
        return None
    r = poll_signal(_check, timeout=wait, interval=0.4)
    if r == "ok":
        return True
    if r == "fail" or r is None:
        return False
    # r == "gone":浮层消失但无明确成功文案 → 仅在拖拽残差合理时才信任为通过(SLIDER-6)
    _bad = residual is not None and (residual != residual or abs(residual) > _gone_tol)   # NaN 或 |残差|>阈值=坏拖拽
    if _bad:
        try: log("[slider] 浮层消失但拖拽残差=%.1f 异常(>%.0f)→ 不信任'gone'判通过,判失败重试" % (float(residual), _gone_tol))
        except Exception: pass
        return False
    return True


def _slider_metrics(driver):
    """一次性读全套滑块几何 —— 全部 getBoundingClientRect()/naturalWidth(CSS px,随分辨率/DPR/缩放自适应):
       背景图 base64+显示宽+原始宽、拼图块 base64+显示宽、滑块按钮(中心+宽)、滑轨显示宽。返回 dict 或 None。
       ★分辨率无关的关键:拖拽距离只由这些【实时比例】算,绝不写死像素/缩放。"""
    js = r"""
      function strip(s){ if(!s) return null; var i=s.indexOf('base64,'); return i>=0?s.slice(i+7):null; }
      function rc(e){ var r=e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}; }
      function pick(sels){ for(var c=0;c<sels.length;c++){ try{ var es=document.querySelectorAll(sels[c]);
        for(var i=0;i<es.length;i++){ var r=es[i].getBoundingClientRect(); if(r.width>0&&r.height>0) return es[i]; } }catch(_){} } return null; }
      var imgs=[].slice.call(document.querySelectorAll('img,canvas')), bgEl=null,bgSrc=null,bgA=0;
      for(var k=0;k<imgs.length;k++){ var e=imgs[k], r=e.getBoundingClientRect();
        if(r.width<120||r.height<40) continue;
        var s=e.tagName==='CANVAS'?(function(){try{return e.toDataURL('image/png');}catch(_){return null;}})():e.src;
        if(!s||s.indexOf('base64,')<0) continue;
        var a=r.width*r.height; if(a>bgA){ bgA=a; bgSrc=s; bgEl=e; } }
      if(!bgEl) return null;
      var bgr=bgEl.getBoundingClientRect();
      var pieceSrc=null, pieceW=0;
      for(var k=0;k<imgs.length;k++){ var e=imgs[k], r=e.getBoundingClientRect();
        var s=e.tagName==='CANVAS'?null:e.src;
        if(!s||s.indexOf('base64,')<0) continue;
        if(r.width>=20 && r.width<bgr.width*0.6 && r.height>=60){ pieceSrc=s; pieceW=r.width; break; } }
      var btn=pick(['#aliyunCaptcha-sliding-slider','.slider-move','[id*="sliding-slider" i]','[class*="slider-move" i]','[class*="btn_slide" i]','[class*="slider-btn" i]']);
      var track=pick(['#aliyunCaptcha-sliding-body','[id*="sliding-body" i]','[class*="sliding-text-box" i]','[class*="slider-track" i]']);
      return {
        piece: strip(pieceSrc), bg: strip(bgSrc),
        bg_dispW: bgr.width, bg_natW: (bgEl.naturalWidth||bgEl.width||bgr.width), piece_dispW: pieceW,
        btn: btn?rc(btn):null, btn_dispW: btn?btn.getBoundingClientRect().width:0,
        track_dispW: track?track.getBoundingClientRect().width:bgr.width,
        track_x: track?track.getBoundingClientRect().left:bgr.left
      };
    """
    try:
        return driver.execute_script(js)
    except Exception:
        return None


def _find_slider_handle(driver):
    """找阿里云【真正的滑块按钮】(底部 >> 那个,拖它;不是拖拼图图)。返回 {cx,cy,x,y,w} 或 None。
    支持 web「元素维护」覆盖 slider_handle;否则按阿里云 DOM:#aliyunCaptcha-sliding-slider / .slider-move。"""
    ov = sel_csv("slider_handle", "")
    js = r"""
      var ov = arguments[0];
      function box(e){ var r=e.getBoundingClientRect();
        return {x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2}; }
      function vis(e){ var r=e.getBoundingClientRect(); return r.width>0&&r.height>0; }
      if(ov){ try{ var es=document.querySelectorAll(ov); for(var i=0;i<es.length;i++) if(vis(es[i])) return box(es[i]); }catch(e){} }
      var cands=['#aliyunCaptcha-sliding-slider','.slider-move','[id*="sliding-slider" i]',
                 '[class*="slider-move" i]','[class*="btn_slide" i]','[class*="slider-btn" i]','[aria-label*="slider" i]'];
      for(var c=0;c<cands.length;c++){ try{ var es=document.querySelectorAll(cands[c]);
        for(var i=0;i<es.length;i++){ var e=es[i], r=e.getBoundingClientRect();
          if(r.width>=18 && r.width<=90 && r.height>=18 && r.height<=90) return box(e); } }catch(e){} }
      return null;
    """
    try:
        return driver.execute_script(js, ov or None)
    except Exception:
        return None


def solve(driver, cfg, timeout=120, attempts=None, label=""):
    """★CapSolver 验证交付(用户终极逻辑·绝不换图):页面加载完→直接干活;本地(sat/ncc)当裁判,
       【仅 cap 邻近本地(≤tol)才提交(拖)cap】;成功→上层下一步。
       cap 不邻近本地 / 本地无裁判 / 拖完没过 → 返回 False,交上层 _verify_login_loop 刷【当前页】重来
       (=用户"不成功刷新页面";刷出新页=新拼图重新算 cap/本地再判)。
       ★【禁止 _refresh_puzzle 换图片】(用户:一进页面就换图会卡顿):所有"刷"都是刷【当前页】(外层)。
       注:下面 for 循环现仅跑 1 次(换图分支已改为 return False);_max_verify/兜底分支保留但不再触发,留作一键回换图。"""
    api_key = cfg.get("captcha_key")
    provider = str(cfg.get("captcha_provider") or "twocaptcha").lower()
    tag = str(cfg.get("_env_id") or label or "slider")
    debug = str(os.environ.get("SLIDER_DEBUG", "1")).lower() not in ("0", "", "false", "no")
    try:
        driver.execute_cdp_cmd("Page.enable", {})
    except Exception:
        pass
    _tol = float(os.environ.get("SLIDER_VERIFY_TOL", "8") or 8)
    _max_verify = int(os.environ.get("SLIDER_VERIFY_MAX_REFRESH", "3") or 3)
    _trace(tag, "===== solve(验证交付) 开始 provider=%s tol=%.0f 求一致上限=%d =====" % (provider, _tol, _max_verify))
    _dumped = False
    for _vr in range(_max_verify + 1):
        # ① 开浮层(控件没加载 → 快速失败,交上层刷当前页)
        if not _ensure_open(driver):
            if debug and not _dumped:
                _dump_debug(driver, "%s-noopen" % tag); _dumped = True
            # ★回写"验证码控件没加载"信号给上层(per-account cfg["_diag"])→ run_account 据此【退役该慢IP+换IP重试】
            try:
                _d = cfg.get("_diag")
                if isinstance(_d, dict):
                    _d["no_control"] = int(_d.get("no_control", 0)) + 1
            except Exception:
                pass
            log("[slider][%s] 浮层没开(控件/页面未加载)→ 判失败" % tag); _trace(tag, "浮层没开→失败(交上层刷当前页)")
            return False
        # ② 等稳定拼图 + 按钮就绪
        m = _wait_puzzle_stable(driver)
        if (not m or not (m.get("piece") and m.get("bg"))
                or not m.get("btn") or not (m.get("btn_dispW") and float(m["btn_dispW"]) > 10)):
            log("[slider][%s] 没等到稳定拼图/按钮 → 判失败" % tag); _trace(tag, "无稳定拼图→失败")
            return False
        bg_dispW = float(m["bg_dispW"] or 1); bg_natW = float(m["bg_natW"] or bg_dispW); piece_dispW = float(m["piece_dispW"] or 0)
        _piece_natW = piece_dispW * (bg_natW / bg_dispW) if bg_dispW else (piece_dispW or 50)
        _lo = max(8.0, _piece_natW * 0.85); _hi = bg_natW - _piece_natW * 0.5
        def _ok_geo(v):
            return (v is not None) and (_lo <= float(v) <= _hi)
        # ③ 本地裁判(sat/ncc 免费,先算)
        sat = ncc = None
        try:
            _det = _detect_gap_py(m["piece"], m["bg"]) or {}
            sat = _det.get("sat"); ncc = _det.get("ncc")
        except Exception as _le:
            log("[slider][%s] 本地认读异常: %s" % (tag, str(_le)[:60]))
        sat_g = float(sat[0]) if (sat and _ok_geo(sat[0])) else None
        ncc_g = float(ncc[0]) if (ncc and _ok_geo(ncc[0])) else None
        local_ref = None   # 本地裁判值:双法接近取均值,否则取置信高者
        if sat_g is not None and ncc_g is not None and abs(sat_g - ncc_g) <= 8:
            local_ref = (sat_g + ncc_g) / 2.0
        elif ncc and ncc_g is not None and ncc[1] >= 0.55:
            local_ref = ncc_g
        elif sat and sat_g is not None and sat[1] >= 2.5:
            local_ref = sat_g
        elif ncc_g is not None:
            local_ref = ncc_g
        elif sat_g is not None:
            local_ref = sat_g
        # ④ CapSolver(交付值)
        cap_g = None
        if provider == "capsolver":
            _cap_to = min(float(timeout or 120), float(os.environ.get("SLIDER_CAP_TIMEOUT", "40") or 40))
            _trace(tag, "▶CapSolver求解中(验证交付)")
            with timed("%s.slider.capsolver" % tag):
                _c = _solve_capsolver_slider(api_key, m["piece"], m["bg"], website_url=_cur_url(driver), timeout=_cap_to)
            cap_g = float(_c) if _ok_geo(_c) else None
        # ⑤ 验证交付判定:本地当裁判,【cap 与本地一致才提交 cap】
        _delta = abs(cap_g - local_ref) if (cap_g is not None and local_ref is not None) else None
        _vinfo = "cap=%s 本地=%s Δ=%s tol=%.0f" % (
            ("%.0f" % cap_g) if cap_g is not None else "无",
            ("%.0f" % local_ref) if local_ref is not None else "无",
            ("%.1f" % _delta) if _delta is not None else "-", _tol)
        # ★Opt3(开关 SLIDER_STRICT_CONSENSUS,默认关=逐字节当前行为):严格共识——只在 sat 与 ncc 两个本地法
        #   【互相一致】(都在且|Δ|≤tol)且 cap 与之一致时才拖;否则不拖→刷页。少拖那些"残差≈0却FAIL"的低共识值。
        _strict = str(os.environ.get("SLIDER_STRICT_CONSENSUS", "")).strip().lower() in ("1", "true", "yes", "on")
        _consensus = (sat_g is not None and ncc_g is not None and abs(sat_g - ncc_g) <= _tol)
        # ★本地优先(UI「缺口识别策略=分歧优先本地」/ env SLIDER_LOCAL_FIRST):CapSolver 离群严重时(实测Δ常14~144,
        #   "cap邻近本地才拖"→cap垃圾就永远不拖→一直刷当前页死循环)用它——信本地(sat/ncc),cap 仅在本地无值时兜底。
        #   默认关=当前验证交付行为逐字节不变。trace 证明本地 sat≈ncc 算得准、垃圾的只有 CapSolver。
        _local_first = str(os.environ.get("SLIDER_LOCAL_FIRST", "")).strip().lower() in ("1", "true", "yes", "on")
        _accept = (_delta is not None and _delta <= _tol) and ((not _strict) or _consensus)
        _last = (_vr >= _max_verify)
        if _local_first and local_ref is not None:
            chosen = local_ref; src = "本地优先→交付本地 g=%d(%s)" % (int(local_ref), _vinfo)
        elif _local_first and cap_g is not None:
            chosen = cap_g; src = "本地优先·本地无值→交付Cap g=%d(%s)" % (int(cap_g), _vinfo)
        elif _accept:
            chosen = cap_g; src = "✅Cap经本地验证一致→交付Cap g=%d(%s%s)" % (int(cap_g), _vinfo, "·严格共识" if _strict else "")
        elif (not _strict) and _consensus:
            # ★★治"cap离群空刷"(默认开;SLIDER_STRICT_CONSENSUS=1 可关回严格):CapSolver 返回垃圾值(实测Δ常14~144)但
            #   sat≈ncc【两个本地法自洽、可信】→ 直接拖本地,不再因 cap 垃圾就空刷死循环(trace 实证 cap≈本地必 PASS=本地准)。
            #   只在本地自洽(sat≈ncc)时才信本地 → 安全;cap 离群【且】本地也不自洽时才走下面刷页。
            chosen = (sat_g + ncc_g) / 2.0
            src = "Cap离群(%s)但本地自洽 sat≈ncc(Δ%.0f)→交付本地 g=%d" % (("%.0f" % cap_g) if cap_g is not None else "无", abs(sat_g - ncc_g), int(chosen))
        elif _last and (not _strict) and (local_ref is not None or cap_g is not None):
            chosen = local_ref if local_ref is not None else cap_g
            src = "求一致到上限(%d次)→兜底交付%s g=%d(%s)" % (_max_verify, "本地" if local_ref is not None else "Cap", int(chosen), _vinfo)
        else:
            # ★用户:禁止一进页面就换图 → cap 不邻近本地 / 本地无裁判【绝不换图】,直接返回 False,
            #   交上层 _verify_login_loop 刷【当前页】(=不成功刷新页面);刷出来的新页=新拼图,重新算 cap/本地再判。
            _why = ("Cap无值" if cap_g is None else ("本地无裁判" if local_ref is None else "Cap不邻近本地Δ%.1f>%.0f" % (_delta, _tol)))
            log("[slider][%s] %s → 不换图,交上层刷当前页[%s]" % (tag, _why, _vinfo))
            _trace(tag, "未邻近(%s)→不换图,交上层刷当前页" % _why)
            return False
        # ⑥ 已确定交付值(经本地验证一致 / 上限兜底)→ 拖一次(闭环锚定块)
        _trace(tag, "缺口决策: %s" % src)
        distance = float(chosen) * (bg_dispW / bg_natW)
        distance = distance * float(os.environ.get("SLIDER_SCALE", "1") or 1) + float(os.environ.get("SLIDER_OFFSET", "0") or 0)
        grab = m.get("btn") or _find_slider_handle(driver)
        if not grab or distance <= 2:
            log("[slider][%s] 没按钮或位移≈0 → 判失败" % tag); _trace(tag, "无按钮/位移≈0→失败")
            return False
        log("[slider][%s] [%s] 拖滑块 位移=%.0f" % (tag, src, distance)); _trace(tag, "▶拖拽中 dist=%.0f (%s)" % (distance, src))
        _err = None
        try:
            with timed("%s.slider.drag" % tag):
                _err = _drag_slider_to(driver, distance, y_hint=grab["cy"])
        except Exception as e:
            log("[slider] 拖拽异常: %s" % str(e)[:80]); _trace(tag, "拖拽异常 %s" % str(e)[:40])
            return False
        time.sleep(1.2)
        if debug and not _dumped:
            _dump_debug(driver, "%s-postdrag" % tag); _dumped = True
        _pass = _passed(driver, residual=_err)
        _d = _LAST_DRAG_DIAG
        _diag = (" 目标=%s 落点=%s" % (_d.get("target"), _d.get("landed"))) if _d else ""
        _trace(tag, "拖完 残差=%s 判定=%s%s" % (("%.1f" % _err) if _err is not None else "?", "PASS" if _pass else "FAIL", _diag))
        _trace(tag, "===== solve(验证交付) 结束: %s =====" % ("成功" if _pass else "失败(交上层刷当前页)"))
        if _pass:
            log("[slider][%s] ✓ 通过" % tag)
        return bool(_pass)
    # 求一致循环耗尽(上限分支理论上已兜底交付,不会到这)→ 失败,交上层刷当前页
    _trace(tag, "===== solve(验证交付) 结束: 求一致耗尽未交付 =====")
    return False


__all__ = ["solve", "build_drag_path"]
