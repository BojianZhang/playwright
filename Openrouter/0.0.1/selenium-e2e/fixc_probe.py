#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Fix C 机制 A/B 探针(不烧卡)——【顺序很重要】:
#   先用【原生CDP】连一个 chromedriver 从没碰过的【干净页】跑检测器(否则会测到 chromedriver Runtime.enable
#   残留的污染,假阳性),再上 chromedriver 跑同一段对比。
# 检测器:Runtime 被 enable 时 console.debug(obj) 会让 inspector 急切序列化 → 触发 stack getter。
# 预期:原生CDP(不开enable) leak=False;chromedriver leak=True。leak True⇔False = Fix C 能否绕过。
import sys, time
import common
from cdp_raw import RawCDP

ENV = sys.argv[1] if len(sys.argv) > 1 else "k1dfjybg"

PROBE_JS = r"""
(function(){
  var fired=false;
  try{
    var e=new Error('x');
    Object.defineProperty(e,'stack',{configurable:true,get:function(){fired=true;return '';}});
    console.debug(e);
  }catch(_){}
  var wd=(navigator.webdriver===true);
  var cdc=false;
  try{
    var n=Object.getOwnPropertyNames(window).concat(Object.getOwnPropertyNames(document));
    for(var i=0;i<n.length;i++){ if(/cdc_|\$cdc/.test(n[i])){cdc=true;break;} }
  }catch(_){}
  return JSON.stringify({leak:fired, webdriver:wd, cdc:cdc});
})()
"""


def main():
    print("启动环境 %s ..." % ENV, flush=True)
    port = common.adspower_start(ENV, force_stop=True)
    for _ in range(25):
        if common._port_ready(port, 2):
            break
        time.sleep(1)
    time.sleep(2)

    # A) 原生 CDP 先测【干净页】(chromedriver 还没碰过任何页)
    try:
        cdp = RawCDP()
        u = cdp.connect(port, "")          # 取第一个 page,不挑 url
        print("原生CDP 已连干净页:", (u or "")[:55], flush=True)
        ra = cdp.evaluate(PROBE_JS)
        print("【原生CDP 不开enable·干净页】", ra, flush=True)
        cdp.close()
    except Exception as e:
        print("原生CDP 探针异常:", str(e)[:140], flush=True)

    # B) 再上 chromedriver(它会 Runtime.enable)对比
    try:
        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
        rb = driver.execute_script("return " + PROBE_JS.strip())
        print("【chromedriver+FixA隐身  】", rb, flush=True)
        try:
            driver.service.process.kill()
        except Exception:
            pass
    except Exception as e:
        print("chromedriver 探针异常:", str(e)[:100], flush=True)

    print("--- 判读:原生CDP leak=false 而 chromedriver leak=true → Fix C 机制成立 ---", flush=True)


if __name__ == "__main__":
    main()
