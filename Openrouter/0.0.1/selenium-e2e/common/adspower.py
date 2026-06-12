#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · AdsPower 本地 API(127.0.0.1 + 不走系统代理,修过的 502 坑)+ 启动/停止浏览器(并发节流/启动闸)。
import os
import json
import time
import threading
import urllib.request

from .base import log, API_BASE, _NOPROXY
from .driver import _port_ready

# AdsPower 本地网关官方限频 ~1 req/s。并发时必须把【请求起点】错开 ≥1.1s,否则 502/卡死。
# 只锁"节流"(在锁内 sleep 让各请求起点错开),HTTP 调用本身在锁外 → 并发执行不受影响。
_ADS_LOCK = threading.Lock()
_ADS_LAST = [0.0]


def _ads_pace():
    with _ADS_LOCK:
        wait = 1.15 - (time.time() - _ADS_LAST[0])
        if wait > 0:
            time.sleep(wait)
        _ADS_LAST[0] = time.time()


# 【启动浏览器】并发闸:_ads_pace 只节流 API 调用,挡不住"多个号同时切IP→同时 spawn 浏览器内核"
# 把 AdsPower 资源瞬间打满→个别浏览器起来即崩(session deleted)。这里限制【同时启动】的浏览器数
# (默认2),启动并等就绪期间占名额,就绪后放给下一个排队的。浏览器启动后保持开着不占此闸。
_LAUNCH_SEM = threading.Semaphore(int(os.environ.get("ADS_MAX_LAUNCH", "2")))


def ads_call(path, body=None, method=None, timeout=60, retries=5):
    """GET(body=None) 或 POST(body=dict)。本地网关频繁调用会 502/连接重置 → 退避重试。并发时全局节流。"""
    last = None
    data = json.dumps(body).encode("utf-8") if body is not None else None
    m = method or ("POST" if body is not None else "GET")
    for i in range(retries):
        try:
            _ads_pace()
            req = urllib.request.Request(API_BASE + path, data=data,
                                         headers={"Content-Type": "application/json"}, method=m)
            with _NOPROXY.open(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            if i < retries - 1:
                log("AdsPower API 抖动(%s)，%ss 后重试 %d/%d" % (str(e)[:50], 3 + i * 2, i + 1, retries))
                time.sleep(3 + i * 2)
    raise last


def ads_get(path, timeout=60, retries=5):
    return ads_call(path, None, "GET", timeout, retries)


def adspower_start(env_id, force_stop=False):
    """启动浏览器返回 debug_port。默认【不先 stop】(绝大多数场景环境本就没在跑,白 stop 一次要多吃一次
    1.15s 限频锁);只有首次 start 失败(可能"已在运行")才 stop 一次再 start。switch_proxy 已自己显式 stop。
    【并发闸】整段在 _LAUNCH_SEM 内:同时最多 ADS_MAX_LAUNCH 个浏览器在启动+就绪,挡住并发重启挤崩。"""
    with _LAUNCH_SEM:
        if force_stop:
            try:
                ads_get("/api/v1/browser/stop?user_id=%s" % env_id, 10, retries=1)
            except Exception:
                pass
        j = ads_get("/api/v1/browser/start?user_id=%s&headless=0&open_tabs=1" % env_id, 90)
        if not j or j.get("code") != 0:
            # 可能是"已在运行/未干净退出" → 停一次再起
            try:
                ads_get("/api/v1/browser/stop?user_id=%s" % env_id, 10, retries=1)
            except Exception:
                pass
            j = ads_get("/api/v1/browser/start?user_id=%s&headless=0&open_tabs=1" % env_id, 90)
            if not j or j.get("code") != 0:
                raise RuntimeError("AdsPower 启动失败: %s" % (j.get("msg") if j else "无响应"))
        port = (j.get("data") or {}).get("debug_port")
        if not port:
            raise RuntimeError("AdsPower 未返回 debug_port")
        # 在闸内等浏览器内核真就绪(最易崩的窗口);就绪了再放名额给下一个排队的启动
        _port_ready(str(port), 12)
        log("AdsPower 环境 %s 已启动 (debug_port=%s)" % (env_id, port))
        return str(port)


def adspower_stop(env_id):
    try:
        ads_get("/api/v1/browser/stop?user_id=%s" % env_id, 15, retries=2)
    except Exception:
        pass


__all__ = [
    "_ADS_LOCK", "_ADS_LAST", "_LAUNCH_SEM", "_ads_pace",
    "ads_call", "ads_get", "adspower_start", "adspower_stop",
]
