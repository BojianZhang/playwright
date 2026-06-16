#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# AdsPower 环境生命周期：建 / 启 / 停 / 删 + 分组 + 代理池映射
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/services/adspower_env.py
#
# 每账号【新建一个干净环境】→ 用完【删掉】，保证账号状态干净（不会因残留登录态短路全流程）。
# API 字段已在本机 AdsPower 实测通过（group/create、user/create、user/delete，code=0）。
#
# 自测：  python selenium-e2e/services/adspower_env.py --selftest        (建无代理环境→启→接管→停→删)
#        python selenium-e2e/services/adspower_env.py --selftest --proxy socks5://user:pass@host:port
# ═══════════════════════════════════════════════════════════════════════

import sys
import os
import time
# 本文件在 services/ 包内,但 --selftest 时会被当脚本直接跑(python services/adspower_env.py) →
# 把父目录 selenium-e2e/ 插进 sys.path,让 `import common` 解析得到(被入口 import 时这步是 no-op)。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import common
from common import ads_call, ads_get, log
from common.fingerprint_bridge import build_adspower_fingerprint_config


def load_proxies(path):
    """解析代理池文件，每行一个。支持：
       host:port:user:pass / host:port / socks5://user:pass@host:port / http://host:port
       返回 [{type,host,port,user,pass}, ...]
    """
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            p = _parse_one(line)
            if p:
                out.append(p)
    return out


def _parse_one(line):
    line = line.strip()
    ptype = "socks5"
    if "://" in line:
        scheme, line = line.split("://", 1)
        ptype = (scheme or "socks5").lower()
        if ptype in ("socks", "socks5h"):
            ptype = "socks5"
    user = pwd = ""
    if "@" in line:
        cred, hostport = line.rsplit("@", 1)
        if ":" in cred:
            user, pwd = cred.split(":", 1)
        host, _, port = hostport.partition(":")
    else:
        parts = line.split(":")
        host = parts[0] if len(parts) > 0 else ""
        port = parts[1] if len(parts) > 1 else ""
        user = parts[2] if len(parts) > 2 else ""
        pwd = parts[3] if len(parts) > 3 else ""
    return {"type": ptype, "host": host, "port": str(port), "user": user, "pass": pwd} if host and port else None


def proxy_config(proxy):
    """代理 dict → AdsPower user_proxy_config。proxy=None → 不用代理。"""
    if not proxy:
        return {"proxy_soft": "no_proxy"}
    return {
        "proxy_soft": "other",
        "proxy_type": proxy.get("type", "socks5"),
        "proxy_host": proxy["host"],
        "proxy_port": str(proxy["port"]),
        "proxy_user": proxy.get("user", ""),
        "proxy_password": proxy.get("pass", ""),
    }


def ensure_group(name="selpipe"):
    """找到同名分组的 group_id；没有就创建。"""
    try:
        j = ads_get("/api/v1/group/list?page=1&page_size=200", timeout=10)
        for g in ((j.get("data") or {}).get("list") or []):
            if g.get("group_name") == name:
                return str(g.get("group_id"))
    except Exception:
        pass
    j = ads_call("/api/v1/group/create", {"group_name": name}, timeout=15)
    if j.get("code") != 0:
        raise RuntimeError("建分组失败: %s" % j.get("msg"))
    return str((j.get("data") or {}).get("group_id"))


# Windows Chrome 138 UA（与 AdsPower 内核 138 一致；Win10 x64 是最常见 UA，海量真人共用 → 不显眼）。
# 不指定的话 AdsPower 会随机到 Linux/Mac，住宅 IP 上配 Linux 桌面是 Radar 红旗。
import random as _random

# Windows Chrome UA 池：每建一个环境随机挑一个(配合 AdsPower 每环境重随 canvas/webgl/字体等,
# 让每次重试都是【不同浏览器指纹】——失败号换 IP+指纹再试,绕开 Radar 的 IP/设备关联)。
WIN_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
]
WIN_UA = WIN_UAS[0]   # 兼容旧引用

# 每环境随机的指纹维度(配合 canvas/webgl/audio 噪声,让每个 AdsPower 浏览器都是【不同设备】,
# 降低 Stripe Radar 的设备/会话关联——这是"别触发 hCaptcha"的关键一环)。
SCREEN_RES = ["1920_1080", "1536_864", "1366_768", "1440_900", "1600_900", "2560_1440", "1280_720", "1680_1050"]
CPU_CORES = ["4", "8", "12", "16"]           # navigator.hardwareConcurrency
DEV_MEM = ["4", "8"]                          # navigator.deviceMemory(Chrome 上限 8)

# 不随机选分辨率(用户要求 2026-06-12):统一=本机屏幕分辨率 → 平铺的窗口位置/大小都落在 screen 内,
# 指纹自洽(不会 screenX>screen.width)、且每个窗口尺寸统一。可用 ENV_SCREEN_RES 覆盖。
import os as _os
try:
    _SW, _SH = common.screen_size()
    FIXED_RES = _os.environ.get("ENV_SCREEN_RES") or ("%d_%d" % (int(_SW), int(_SH)))
except Exception:
    FIXED_RES = _os.environ.get("ENV_SCREEN_RES", "1920_1080")


def _random_fingerprint(proxy=None):
    """每建一个环境就生成一套【随机指纹】:随机 UA/分辨率/CPU核数/内存 + canvas/webgl/audio/媒体设备
       全部开噪声(AdsPower 给每个 profile 唯一噪声种子 → 这些向量逐环境不同)。
       时区/语言跟代理 IP 走(美区),WebRTC 走代理防真实 IP 泄漏。"""
    shared_fp, _summary = build_adspower_fingerprint_config(
        proxy=proxy,
        seed="%s:%s:%s" % (
            proxy.get("host", "") if proxy else "no-proxy",
            proxy.get("port", "") if proxy else "",
            int(time.time() // 21600),
        ),
        screen_resolution=FIXED_RES,
    )
    if shared_fp:
        return shared_fp
    return {
        "automatic_timezone": "1",                       # 时区跟代理 IP geo
        "language": ["en-US", "en"],
        "language_switch": "0",
        "ua": _random.choice(WIN_UAS),                   # 随机 Windows Chrome UA
        "screen_resolution": FIXED_RES,                  # 固定=本机屏幕,不随机(尺寸统一+指纹自洽)
        "fonts": ["all"],
        "canvas": "1",                                   # canvas 噪声(逐环境唯一)
        "webgl_image": "1",                              # WebGL 图像噪声
        "webgl": "0",                                    # WebGL 元数据用真实(乱设会出不可能的GPU组合,反成红旗)
        "audio": "1",                                    # 音频指纹噪声
        "media_devices": "1",                            # 媒体设备噪声
        "client_rects": "1",                             # client rects 噪声
        "hardware_concurrency": _random.choice(CPU_CORES),
        "device_memory": _random.choice(DEV_MEM),
        "webrtc": "proxy" if proxy else "disabled",      # WebRTC 走代理(无代理时禁用,都防真实IP泄漏)
        "do_not_track": _random.choice(["default", "true", "false"]),
    }


def create_env_full(name, proxy=None, group_id="0"):
    """新建一个【随机指纹】环境，返回 (user_id, serial_number)。proxy=None → 无代理（仅用于自测）。
       带兜底:若 AdsPower 拒绝某随机指纹字段(code≠0),自动退回最小指纹配置重建,不破流水线。"""
    def _create(fp):
        body = {"name": name, "group_id": str(group_id),
                "user_proxy_config": proxy_config(proxy), "fingerprint_config": fp}
        return ads_call("/api/v1/user/create", body, timeout=30)

    fp = _random_fingerprint(proxy)
    j = _create(fp)
    if j.get("code") != 0:
        # 兜底:全随机指纹被拒 → 退回最小配置(随机UA+时区跟IP),保证建环境不中断
        log("⚠ 随机指纹建环境被拒(%s)→ 退回最小指纹配置重建" % j.get("msg"))
        j = _create({"automatic_timezone": "1", "language": ["en-US", "en"], "ua": fp["ua"]})
    if j.get("code") != 0:
        raise RuntimeError("建环境失败: %s" % j.get("msg"))
    data = j.get("data") or {}
    uid = data.get("id")
    serial = data.get("serial_number")
    if not uid:
        raise RuntimeError("建环境未返回 id: %s" % j)
    log("已建环境 %s (serial=%s, name=%s, res=%s cores=%s mem=%s)" % (
        uid, serial, name, fp["screen_resolution"], fp["hardware_concurrency"], fp["device_memory"]))
    time.sleep(1.5)  # AdsPower ~1 req/s 限频
    return uid, serial


def create_env(name, proxy=None, group_id="0"):
    """新建一个指纹环境，返回 user_id。proxy=None → 无代理（仅用于自测）。"""
    uid, _ = create_env_full(name, proxy, group_id)
    return uid


def update_env(user_id, proxy):
    """改已有环境的代理(不删环境)。POST /api/v1/user/update。改完需 stop→start 浏览器才生效。"""
    body = {"user_id": str(user_id), "user_proxy_config": proxy_config(proxy)}
    j = ads_call("/api/v1/user/update", body, timeout=30)
    if j.get("code") != 0:
        raise RuntimeError("更新代理失败 (env=%s): %s" % (user_id, j.get("msg")))
    log("已更新环境 %s 代理 → %s:%s" % (user_id, proxy.get("host"), proxy.get("port")))
    time.sleep(1.2)  # AdsPower ~1 req/s 限频
    return True


def refresh_fingerprint(user_id, proxy=None):
    """给【已有环境】刷一套全新随机指纹(不删环境)——在 adspower_start 前调用 = "每次打开都是新指纹"。
       不靠 AdsPower 那个付费"随机指纹"开关,用 /user/update 自己刷(免费、API可控)。改完 start 才生效。
       带兜底:某随机字段被拒→退回最小指纹(至少换新UA),失败也不打断流水线(继续用原指纹)。"""
    fp = _random_fingerprint(proxy)
    j = ads_call("/api/v1/user/update", {"user_id": str(user_id), "fingerprint_config": fp}, timeout=30)
    if j.get("code") != 0:
        j = ads_call("/api/v1/user/update",
                     {"user_id": str(user_id),
                      "fingerprint_config": {"automatic_timezone": "1", "language": ["en-US", "en"], "ua": fp["ua"]}},
                     timeout=30)
    if j.get("code") != 0:
        log("⚠ 刷新指纹失败 (env=%s): %s → 忽略,用原指纹" % (user_id, j.get("msg")))
        return False
    log("已刷新环境 %s 指纹(全新 UA/核数/内存/噪声,每次打开新指纹)" % user_id)
    time.sleep(1.2)  # AdsPower ~1 req/s 限频
    return True


def delete_env(user_id):
    """删环境。返回 True=确实删成功(code==0)；False/None=没删成(留孤儿环境,调用方至少能从日志知道)。
       ★坑:AdsPower 删失败时 ads_call 仍正常返回(只是 code!=0,实测 code=-1)——不能只看有没有抛异常,
       必须查 code。失败时 log 警告并重试一次(可能正被占用/限频抖动),仍不成就明确告警,不静默吞成功。"""
    if not user_id:
        return None
    for attempt in range(2):   # 失败重试一次(可能环境正被占用或 AdsPower 限频抖动)
        try:
            j = ads_call("/api/v1/user/delete", {"user_ids": [user_id]}, timeout=20, retries=3)
        except Exception as e:
            log("删环境 %s 异常: %s%s" % (user_id, str(e)[:80], "(重试)" if attempt == 0 else "(放弃,环境可能泄漏)"))
            if attempt == 0:
                time.sleep(1.5)
                continue
            return False
        if j.get("code") == 0:
            log("已删环境 %s (code=0)" % user_id)
            return True
        # code!=0(实测 code=-1)= 删除失败,被当成功就会泄漏环境(出现孤儿环境)
        log("⚠ 删环境 %s 失败 (code=%s, msg=%s)%s" % (
            user_id, j.get("code"), j.get("msg"), "→重试" if attempt == 0 else "→放弃(环境可能泄漏,留待 cleanup_envs GC 回收)"))
        if attempt == 0:
            time.sleep(1.5)
    return False


def _selftest(proxy_spec=None):
    log("=== adspower_env 自测：建→启→接管→停→删 ===")
    proxy = _parse_one(proxy_spec) if proxy_spec else None
    gid = ensure_group("selpipe")
    log("分组 selpipe group_id=%s" % gid)
    uid = create_env("_selftest_%d" % (int(time.time()) % 100000), proxy, gid)
    driver = None
    try:
        port = common.adspower_start(uid)
        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
        fp = driver.execute_script(
            "return {ua:navigator.userAgent, platform:navigator.platform, "
            "webdriver:navigator.webdriver, lang:navigator.language}")
        log("UA       = %s" % (fp.get("ua") or "")[:75])
        log("platform = %s | webdriver = %s | lang = %s" % (fp.get("platform"), fp.get("webdriver"), fp.get("lang")))
        win_ua = "Windows" in (fp.get("ua") or "")
        win_plat = (fp.get("platform") or "") == "Win32"
        log("指纹一致性: UA=Windows %s, platform=Win32 %s, webdriver=false %s"
            % (win_ua, win_plat, fp.get("webdriver") is False))
        time.sleep(2)
    except Exception as e:
        log("启动/接管异常: %s" % str(e)[:120])
    finally:
        try:
            if driver:
                driver.quit()
        except Exception:
            pass
        common.adspower_stop(uid)
        time.sleep(1.5)
        delete_env(uid)
    log("=== 自测结束（环境已删干净）===")


def _cleanup_selftest():
    """删掉所有 `_selftest_` 开头的孤儿环境 —— 自测超时被 SIGKILL(没跑到 finally 删环境)时遗留的【兜底清理】;
       也顺带清历史遗留的同类孤儿。返回删除数。供 web 自测超时后调用,根治"超时残留环境"。"""
    deleted, page = 0, 1
    while True:
        try:
            d = ads_call("/api/v1/user/list?page=%d&page_size=100" % page, method="GET")
        except Exception as e:
            log("[cleanup-selftest] 列环境失败: %s" % str(e)[:80]); break
        lst = (d.get("data") or {}).get("list") or []
        for u in lst:
            if (u.get("name") or "").startswith("_selftest_"):
                uid = u.get("user_id")
                if uid and delete_env(uid):
                    deleted += 1
        if len(lst) < 100:
            break
        page += 1
    log("[cleanup-selftest] 删除孤儿自测环境 %d 个" % deleted)
    return deleted


if __name__ == "__main__":
    if "--cleanup-selftest" in sys.argv:
        _cleanup_selftest()
    elif "--selftest" in sys.argv:
        px = None
        if "--proxy" in sys.argv:
            i = sys.argv.index("--proxy")
            if i + 1 < len(sys.argv):
                px = sys.argv[i + 1]
        _selftest(px)
    else:
        log("用法: python selenium-e2e/services/adspower_env.py --selftest [--proxy …] | --cleanup-selftest")
