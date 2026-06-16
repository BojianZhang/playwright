#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · AdsPower 本地 API(127.0.0.1 + 不走系统代理,修过的 502 坑)+ 启动/停止浏览器(并发节流/启动闸)。
import os
import json
import time
import threading
import urllib.request

from .base import log, API_BASE, _NOPROXY, ADS_TOKEN, ADS_AUTH_HEADER, ADS_AUTH_PREFIX
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

# ★P2(救批量 invalid-session/no-such-window):_LAUNCH_SEM 只管"启动就绪"那一小段,浏览器起来即释放→
#   全程无"同时开着的浏览器总数"封顶;--concurrency=10 时 10 个浏览器常驻,auth 阶段密集 CDP 截图把 AdsPower 压垮→
#   同秒成簇丢窗口。_ALIVE_SEM 给"同时存活的浏览器总数"硬封顶(默认4,env ADS_MAX_ALIVE):run_account 建环境前 acquire、
#   删环境后 release → 任意时刻在飞浏览器 ≤ ADS_MAX_ALIVE(镜像 OpenRouter 已验证的 maxConcurrency)。
_ALIVE_SEM = threading.Semaphore(int(os.environ.get("ADS_MAX_ALIVE", "4") or 4))


def alive_acquire():
    """占一个"在飞浏览器"名额(阻塞直到有空位);run_account 建环境【前】调。"""
    _ALIVE_SEM.acquire()


def alive_release():
    """释放"在飞浏览器"名额;run_account 删环境【后】在 finally 调。over-release 防御:吞异常。"""
    try:
        _ALIVE_SEM.release()
    except Exception:
        pass


def ads_call(path, body=None, method=None, timeout=60, retries=5):
    """GET(body=None) 或 POST(body=dict)。本地网关频繁调用会 502/连接重置 → 退避重试。并发时全局节流。"""
    last = None
    data = json.dumps(body).encode("utf-8") if body is not None else None
    m = method or ("POST" if body is not None else "GET")
    headers = {"Content-Type": "application/json"}
    if ADS_TOKEN:  # 仅在设了令牌时加鉴权头(本机网关默认无令牌→裸请求,行为不变)
        headers[ADS_AUTH_HEADER] = ADS_AUTH_PREFIX + ADS_TOKEN
    for i in range(retries):
        try:
            _ads_pace()
            req = urllib.request.Request(API_BASE + path, data=data,
                                         headers=headers, method=m)
            with _NOPROXY.open(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
            try:
                obj = json.loads(raw)
            except ValueError:
                # 坏 JSON(本地网关偶发返回 HTML 错误页等):给可诊断错误,仍走外层退避重试(瞬态可恢复)
                raise RuntimeError("AdsPower 返回非 JSON(%s %s):%s" % (m, path, raw[:120]))
            # 约定:调用方一律 j.get(...);把"非对象"响应归一成失败形,避免 list/number 让 .get() 抛 AttributeError
            return obj if isinstance(obj, dict) else {"code": -1, "msg": "非对象响应:%s" % (str(obj)[:80])}
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
    【并发闸】每次 start+就绪检测单独占 _LAUNCH_SEM 名额:同时最多 ADS_MAX_LAUNCH 个浏览器在启动+就绪。
    注:首次失败后的 stop(纯 API、不开浏览器)与两次尝试之间不再霸占名额——否则一个失败的账号会占着
    有限的启动名额做完整个 stop+二次 start,把其他账号的首启全堵住。"""
    def _attempt():
        # 单次启动尝试:只在 start + 就绪检测(最易崩窗口)期间占名额,出闸即释放。
        with _LAUNCH_SEM:
            j = ads_get("/api/v1/browser/start?user_id=%s&headless=0&open_tabs=1" % env_id, 90)
            if not j or j.get("code") != 0:
                return None, (j.get("msg") if j else "无响应")
            port = (j.get("data") or {}).get("debug_port")
            if not port:
                return None, "未返回 debug_port"
            _port_ready(str(port), 12)
            return str(port), None

    if force_stop:
        try:
            ads_get("/api/v1/browser/stop?user_id=%s" % env_id, 10, retries=1)
        except Exception:
            pass
    port, err = _attempt()
    if port:
        log("AdsPower 环境 %s 已启动 (debug_port=%s)" % (env_id, port))
        return port
    # 首次失败(可能"已在运行/未干净退出")→ 停一次(纯 API,不占启动闸)再 gated 重试一次
    try:
        ads_get("/api/v1/browser/stop?user_id=%s" % env_id, 10, retries=1)
    except Exception:
        pass
    port, err = _attempt()
    if port:
        log("AdsPower 环境 %s 已启动 (debug_port=%s)" % (env_id, port))
        return port
    raise RuntimeError("AdsPower 启动失败: %s" % (err or "无响应"))


def adspower_stop(env_id):
    try:
        ads_get("/api/v1/browser/stop?user_id=%s" % env_id, 15, retries=2)
    except Exception:
        pass


__all__ = [
    "_ADS_LOCK", "_ADS_LAST", "_LAUNCH_SEM", "_ALIVE_SEM", "_ads_pace",
    "ads_call", "ads_get", "adspower_start", "adspower_stop",
    "alive_acquire", "alive_release",
]
