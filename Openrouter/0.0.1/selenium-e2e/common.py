#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 纯 Python Selenium 流水线 — 共享 helper（单一来源）
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/common.py
#
# 抽自已实测可用的 addcard.py/purchase.py/verify_card.py。内容：
#   · AdsPower 本地 API（GET/POST，走 127.0.0.1 + 不走系统代理，修过的 502 坑）
#   · chromedriver 自动按浏览器主版本匹配 + Selenium 接管（带重试）
#   · Page 类：跨 iframe 钻取填表/选择/点击/读文本（Stripe 跨域 iframe 必需）
#   · 卡池读取、随机账单地址、配置读取（config.local.json）、结果判定正则
# ═══════════════════════════════════════════════════════════════════════

import sys
import os
import json
import time
import random
import re
import threading
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
# 127.0.0.1（不是 local.adspower.net）：后者不在系统代理绕过名单，开了本地代理(VPN/clash)会被转走→502。
API_BASE = os.environ.get("OPENROUTER_ADSPOWER_API", "http://127.0.0.1:50325")
_NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 强制不走系统代理
POOL_FILE = os.path.join(ROOT, "account-state", "card-pool.json")
CONFIG_LOCAL = os.path.join(ROOT, "config.local.json")
CONFIG_JSON = os.path.join(ROOT, "config.json")

CREDITS_URL = "https://openrouter.ai/settings/credits"
KEYS_URL = "https://openrouter.ai/settings/keys"
SIGNUP_URL = "https://openrouter.ai/sign-up"
SIGNIN_URL = "https://openrouter.ai/sign-in"

# Stripe 卡字段选择器（跨 iframe）
NUM = ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput"]']
EXP = ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput"]']
CVC = ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput"]']
ZIP = ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput"]']

# 结果判定
RE_502 = re.compile(r"error\s*5\d\d|unable to authenticate|bad gateway", re.I)
RE_DECL = re.compile(r"card was declined|insufficient funds|declined|payment failed|could not complete|do not honor|expired", re.I)
RE_OK = re.compile(r"payment is processing|credits will be added|check back shortly|payment method added|succeeded|payment successful|purchase complete", re.I)
RE_NEEDPHONE = re.compile(r"provide a mobile phone|provide a phone number", re.I)
# 可见人机验证框的【外壳文案】(在主文档,iframe 检测抓不到时靠它兜底识别)——
# 实测 OpenRouter 加卡弹的是 "One more step before you're done / Select the checkbox below / I am human"。
RE_HCAPTCHA = re.compile(r"I am human|Select the checkbox below|One more step before you'?re done", re.I)

_LOG_PREFIX = "[sel]"


def set_log_prefix(p):
    global _LOG_PREFIX
    _LOG_PREFIX = p


def log(*a):
    # 行首带 HH:MM:SS —— 没时间戳就量不出每步耗时(注册/取key/绑地址/Save/切IP各几秒)
    print("%s %s" % (time.strftime("%H:%M:%S"), _LOG_PREFIX), *a, flush=True)


def digits(s):
    return "".join(ch for ch in str(s if s is not None else "") if ch.isdigit())


# ── AdsPower 本地 API ───────────────────────────────────────────────────
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


def http_post_json(url, body, headers=None, timeout=30):
    """通用 POST JSON（走不走代理都用本机 → 不走系统代理，直连，与 Node fetch 行为一致）。
       用于 firstmail / 2captcha 等外网 API。"""
    h = {"Content-Type": "application/json", "accept": "application/json"}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with _NOPROXY.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


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


# ── chromedriver 匹配 + Selenium 接管 ──────────────────────────────────
def resolve_chromedriver(port):
    """chromedriver 必须匹配 AdsPower Chromium 主版本：查 /json/version → SeleniumManager 按主版本取。"""
    dp = os.environ.get("OPENROUTER_CHROMEDRIVER") or ""
    if dp:
        return dp
    major = ""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%s/json/version" % port, timeout=5) as resp:
            info = json.loads(resp.read().decode("utf-8"))
        ver = info.get("Browser", "").split("/")[-1]
        major = ver.split(".")[0] if ver else ""
    except Exception:
        major = ""
    try:
        from selenium.webdriver.common.selenium_manager import SeleniumManager
        args = ["--driver", "chromedriver"] + (["--browser-version", major] if major else [])
        return SeleniumManager().binary_paths(args).get("driver_path") or ""
    except Exception:
        return ""


def _port_ready(port, timeout=8):
    """轮询调试端口 /json/version,通了就返回(通常 <1s),取代盲 sleep。"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%s/json/version" % port, timeout=2) as r:
                if getattr(r, "status", 200) == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


# 隐身脚本(Page.addScriptToEvaluateOnNewDocument 在页面脚本前注入,每次导航生效):
# 删 navigator.webdriver 属性(让 'webdriver' in navigator 为 False)+ 删残留 cdc_ 变量(二进制改名的双保险)。
STEALTH_JS = r"""
(function(){
  try { delete Navigator.prototype.webdriver; } catch(e){}
  try { delete navigator.webdriver; } catch(e){}
  try {
    var ks = Object.getOwnPropertyNames(window);
    for (var i=0;i<ks.length;i++){ if (ks[i].indexOf('cdc_')===0){ try{ delete window[ks[i]]; }catch(e){} } }
  } catch(e){}
})();
"""

_PATCHED_DRIVER = {}   # {原路径: 改好路径} 缓存,避免每次接管都改

def _patch_chromedriver(orig_path):
    """二进制改 chromedriver:把 'cdc_adoQpoasnfa76pfcZLmcfl_' 这串 Selenium 招牌名整体替换成
       【同长度随机串】,让 hCaptcha 扫不到已知 cdc_ 特征(undetected-chromedriver 核心招)。
       返回改好的副本路径;失败/无此串则原样返回。STEALTH=0 时上层不调用。"""
    if not orig_path or not os.path.exists(orig_path):
        return orig_path
    if orig_path in _PATCHED_DRIVER and os.path.exists(_PATCHED_DRIVER[orig_path]):
        return _PATCHED_DRIVER[orig_path]
    try:
        data = open(orig_path, "rb").read()
        sig = b"cdc_adoQpoasnfa76pfcZLmcfl_"
        if sig not in data:
            _PATCHED_DRIVER[orig_path] = orig_path
            log("[stealth] chromedriver 里没找到 cdc_ 招牌串(可能已改/别版本)→ 用原版")
            return orig_path
        import random as _r, string as _s
        repl = ("".join(_r.choice(_s.ascii_lowercase) for _ in range(len(sig) - 1)) + b"_".decode()).encode()
        out = data.replace(sig, repl)
        base = orig_path[:-4] if orig_path.lower().endswith(".exe") else orig_path
        patched = base + "_stealth" + (".exe" if orig_path.lower().endswith(".exe") else "")
        with open(patched, "wb") as f:
            f.write(out)
        try:
            os.chmod(patched, 0o755)
        except Exception:
            pass
        _PATCHED_DRIVER[orig_path] = patched
        log("[stealth] chromedriver cdc_ 招牌名已替换 → %s" % os.path.basename(patched))
        return patched
    except Exception as e:
        log("[stealth] chromedriver 改写失败(忽略,用原版): %s" % str(e)[:60])
        _PATCHED_DRIVER[orig_path] = orig_path
        return orig_path


def attach_chrome(port, driver_path="", retries=8, delay=4):
    """经 debuggerAddress 接管 AdsPower 浏览器（刚启动可能没就绪 → 先轮询端口就绪,再重试接管）。
       STEALTH=1(默认)时:用改过 cdc_ 名的 chromedriver + 接管后注入隐身脚本(删 webdriver/cdc_),
       降低被 Stripe/hCaptcha 检测为自动化的概率(实测纯接管会泄漏 cdc_/webdriver)。"""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    stealth = os.environ.get("STEALTH", "1") != "0"
    if stealth and driver_path:
        driver_path = _patch_chromedriver(driver_path)
    opts = Options()
    opts.add_experimental_option("debuggerAddress", "127.0.0.1:%s" % port)
    if not _port_ready(port, 8):
        log("调试端口 %s 8s 内未就绪,仍尝试接管" % port)   # 取代固定 sleep(4):就绪即走,通常省 ~3s
    last = None
    for i in range(retries):
        try:
            d = (webdriver.Chrome(service=Service(executable_path=driver_path), options=opts)
                 if driver_path else webdriver.Chrome(options=opts))
            log("Selenium 已接管(debuggerAddress 127.0.0.1:%s)%s" % (port, " [stealth]" if stealth else ""))
            if stealth:
                try:
                    d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": STEALTH_JS})
                except Exception as _e:
                    log("[stealth] 注入隐身脚本失败(忽略): %s" % str(_e)[:50])
            return d
        except Exception as e:
            last = e
            log("接管重试 %d/%d: %s" % (i + 1, retries, str(e)[:55]))
            time.sleep(delay)
    raise RuntimeError("接管失败: %s" % (str(last)[:100]))


def _atomic_write_json(path, data):
    """原子写 JSON:写临时文件→fsync→os.replace(同盘原子替换)。
       防进程被杀(尤其本轮超时 SIGKILL)写到一半把 card-pool.json/bin-usage.json 等关键状态
       留成损坏的半截文件 → 下次 load 全员炸。失败兜底退回直接写,绝不让上层抛。"""
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = "%s.tmp.%d.%d" % (path, os.getpid(), threading.get_ident())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)   # Windows/POSIX 同盘原子替换
        return True
    except Exception:
        try:
            json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        except Exception:
            pass
        return False


# ── 代理质量:切代理前验通/测速 + per-proxy 成功率追踪/退役 ────────────────────
PROXY_STATS_FILE = os.path.join(HERE, "state", "proxy-stats.json")   # {h:p:{card-bound,server-error,unknown,dead,fail_streak,last}}
_PROXY_LOCK = threading.Lock()


def proxy_ok(proxy, timeout=6):
    """切代理前快速验:经该代理 HEAD js.stripe.com(正是加载不出的那个)。返回 (通不通, 延迟秒)。
       连不通/超时=坏代理→跳过,省掉一次 ~20s 的浏览器重启白费。
       【健壮】没装 requests 或 PySocks(requests 走 socks5h 必需)→ 没法验,不拦(返回 True),
       绝不能因缺依赖把【所有】代理误判 dead → 切不动IP、好代理被刷退役、全局瘫痪。"""
    try:
        import requests
        import socks  # PySocks:缺它 requests.head(socks5h) 会抛 InvalidSchema/'Missing dependencies for SOCKS'
    except Exception:
        return True, None
    try:
        u = proxy.get("user", "")
        auth = ("%s:%s@" % (u, proxy.get("pass", ""))) if u else ""
        purl = "socks5h://%s%s:%s" % (auth, proxy["host"], proxy["port"])   # socks5h: DNS 也走代理
        t0 = time.time()
        r = requests.head("https://js.stripe.com/v3/", proxies={"http": purl, "https": purl},
                          timeout=timeout, allow_redirects=False)
        return (r.status_code < 500), round(time.time() - t0, 1)
    except Exception as e:
        # SOCKS 依赖缺失这类是【环境问题】不是【代理坏】→ 不拦(返回 True);其余=真连不通=dead
        m = str(e).lower()
        if "socks" in m and ("missing" in m or "dependenc" in m):
            return True, None
        return False, None


def mark_proxy_result(proxy, result):
    """加卡结果回写 per-proxy 战绩(并发安全)。card-bound→清失败连击;dead/unknown→失败连击++
       (代理可归因);server-error 只记数不计连击(那是卡velocity非代理问题)。"""
    if not proxy:
        return
    key = "%s:%s" % (proxy.get("host"), proxy.get("port"))
    with _PROXY_LOCK:
        try:
            stats = json.load(open(PROXY_STATS_FILE, encoding="utf-8"))
        except Exception:
            stats = {}
        s = stats.setdefault(key, {})
        s[result] = s.get(result, 0) + 1
        s["last"] = result
        if result == "card-bound":
            s["fail_streak"] = 0
        elif result in ("dead", "unknown"):
            s["fail_streak"] = s.get("fail_streak", 0) + 1
        _atomic_write_json(PROXY_STATS_FILE, stats)


def proxy_retired(proxy):
    """连续失败(dead/unknown)≥阈值(PROXY_RETIRE_STREAK 默认5)的代理→退役,选IP时跳过。"""
    key = "%s:%s" % (proxy.get("host"), proxy.get("port"))
    try:
        stats = json.load(open(PROXY_STATS_FILE, encoding="utf-8"))
    except Exception:
        return False
    return stats.get(key, {}).get("fail_streak", 0) >= int(os.environ.get("PROXY_RETIRE_STREAK", "5"))


ZIP_STATS_FILE = os.path.join(HERE, "state", "zip-stats.json")   # {zip:{card-bound,declined,last}}
_ZIP_LOCK = threading.Lock()


def mark_zip_result(zipcode, result):
    """记录每个 ZIP 的加卡战绩(card-bound/declined)→ 分析哪个 ZIP 成功率高(免税州 vs 其它)。并发安全。"""
    if not zipcode or result not in ("card-bound", "declined"):
        return
    z = str(zipcode)
    with _ZIP_LOCK:
        try:
            stats = json.load(open(ZIP_STATS_FILE, encoding="utf-8"))
        except Exception:
            stats = {}
        s = stats.setdefault(z, {})
        s[result] = s.get(result, 0) + 1
        s["last"] = result
        _atomic_write_json(ZIP_STATS_FILE, stats)


# 免税州 ZIP → 州名(分析报表里标出来,验证"免税州成功率高")
_TAXFREE_ZIP_STATE = {"59601": "Montana", "59718": "Montana", "59101": "Montana",
                      "97301": "Oregon", "97401": "Oregon", "97201": "Oregon",
                      "03301": "NewHampshire", "03063": "NewHampshire",
                      "19711": "Delaware", "19901": "Delaware",
                      "99501": "Alaska", "99701": "Alaska"}


def zip_report(log=print):
    """打印各 ZIP 加卡成功率(card-bound/总),高→低,并标出是否免税州。返回 rows。"""
    try:
        stats = json.load(open(ZIP_STATS_FILE, encoding="utf-8"))
    except Exception:
        log("[ZIP] 暂无 ZIP 战绩(还没跑过带 ZIP 记录的加卡)"); return []
    rows = []
    for z, s in stats.items():
        b = int(s.get("card-bound", 0)); d = int(s.get("declined", 0))
        if b + d == 0:
            continue
        rows.append((z, b, d, b + d, b / (b + d)))
    rows.sort(key=lambda r: (-r[4], -r[3]))
    log("[ZIP成功率] 绑成率 高→低(★=免税州):")
    for z, b, d, t, rate in rows:
        st = _TAXFREE_ZIP_STATE.get(z, "")
        log("  ZIP %-7s %3.0f%%  绑成%d/拒%d/共%d  %s" % (z, rate * 100, b, d, t, ("★" + st) if st else ""))
    return rows


# OpenRouter 直接封禁/拒绝该邮箱:"… is not allowed to access this application"。
# 撞这个就【登记并永久跳过】。三处(hybrid_run/hyb_loop/cleanup_envs)共用此判定,口径必须一致 ——
# 否则 'access denied' 类被拒号在某处算 banned、另一处不认 → 反复空转重试。
_BANNED_RE = re.compile(r"not[\s_]*allowed|NOT_ALLOWED|access[\s_]*denied|not[\s_]*permitted", re.I)


def is_banned_reason(*parts):
    """传入若干 reason 片段(pw_reason/auth/steps 文本),任一含'账号被 OpenRouter 拒绝'字样即 True。"""
    s = " ".join(str(p) for p in parts if p)
    return bool(s) and bool(_BANNED_RE.search(s))


# ── 卡池 / 地址 / 配置 ──────────────────────────────────────────────────
CARD_ASSIGN_FILE = os.path.join(HERE, "state", "card-assign.json")
BIN_USAGE_FILE = os.path.join(HERE, "state", "bin-usage.json")   # {日期: {BIN: 当日加卡号数}} —— 控同 BIN velocity
_CARD_LOCK = threading.Lock()


def _bin_of(c):
    """卡的 BIN(发卡行前 6 位)。同 BIN 一天铺太多号会撞 Stripe Radar velocity。"""
    return (c.get("number") or "")[:6]


def _read_bin_usage():
    """bin-usage.json = {日期:{BIN:{assigned,bound,declined,server-error,unknown,hcaptcha}}}。兼容旧 {BIN:int}。"""
    try:
        d = json.load(open(BIN_USAGE_FILE, encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _bin_today(usage, today):
    t = usage.setdefault(today, {})
    for b, v in list(t.items()):
        if isinstance(v, int):          # 旧格式 {BIN:计数} → 规整成 {BIN:{assigned:计数}}
            t[b] = {"assigned": v}
    return t


def _save_bin_usage(usage):
    keep = sorted(usage.keys())[-7:]   # 只留最近7天,别无限涨
    _atomic_write_json(BIN_USAGE_FILE, {k: usage[k] for k in keep})


def load_card(account=None, exclude=None, count_bin=True, exclude_bins=None):
    """取一张可用卡。给了 account(邮箱) → 给该号分配卡(持久化)。并发安全。
       exclude=已试过的卡id集合 → 排除它们另选一张(校验框/被拒时换【不同的卡】用,优选不同BIN)。
       exclude_bins=已试过的卡段(BIN前6位)集合 → 强制跳过这些段,换【新卡段】用(502 不能验证此卡时,
                 即便设了 CARD_PREFER_BIN 也会越过它去别的段;用户规则 2026-06-11)。
       count_bin=False(换卡场景用):不自增 BIN 当日额度、不覆盖原分配 —— 换卡不是新号,
                 否则一个号换 2 张卡=给 3 个 BIN 各 +1,把 CARD_BIN_DAILY_CAP 虚高刷穿、摊匀失效。
       策略由环境变量 CARD_STRATEGY 控:
         random(默认)        —— 每个号【随机取】一张可用卡(仍守 maxUses<10、跳黑名单/禁用,且尊重 BIN 当日限量防velocity)。
         spread              —— 轮流摊匀到各卡(确定性最均),稳。
         concentrate(容量测试)—— 集中灌【同一张卡】直到它被拒(disable),再换下一张。"""
    strategy = os.environ.get("CARD_STRATEGY", "random").strip().lower()
    exclude = set(exclude or [])
    exclude_bins = set(str(b) for b in (exclude_bins or []))
    # 永久拉黑卡段:card-blacklist-bins.txt(每行一个BIN前6位)——用户标记"频繁不让绑"的段,
    # 每次取卡都强制跳过(即便卡是 active、即便被救活),真·一劳永逸。
    try:
        _blf = os.path.join(HERE, "card-blacklist-bins.txt")
        if os.path.exists(_blf):
            for _ln in open(_blf, encoding="utf-8"):
                _ln = _ln.strip()
                if _ln and not _ln.startswith("#"):
                    exclude_bins.add(_ln[:6])
    except Exception:
        pass
    with open(POOL_FILE, "r", encoding="utf-8") as f:
        pool = json.load(f)
    import datetime as _dt
    _now_iso = _dt.datetime.utcnow().isoformat() + "Z"

    def _cooled(c):
        cu = c.get("cooldownUntil")
        return bool(cu and cu > _now_iso)   # ISO 时间串可直接字典序比较

    base_active = [c for c in (pool if isinstance(pool, list) else [])
                   if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)
                   and (c.get("id") or c.get("number")) not in exclude
                   and _bin_of(c) not in exclude_bins]
    if not base_active:
        raise RuntimeError("卡池无可用卡(account-state/card-pool.json 没有 active 且有余次的卡)")
    # 优先用【没在冷却】的卡(延迟复用刚出错的卡,自动轮到别的);全在冷却→退回挑冷却快结束的,别阻塞
    active = [c for c in base_active if not _cooled(c)]
    if not active:
        active = sorted(base_active, key=lambda c: c.get("cooldownUntil") or "")
    if not account:
        return active[0]

    def _cid(c):
        return c.get("id") or c.get("number")

    # 读-选-写要原子(并发时两个号别抢到同一张/写花文件)
    with _CARD_LOCK:
        assign = {}
        if os.path.exists(CARD_ASSIGN_FILE):
            try:
                assign = json.load(open(CARD_ASSIGN_FILE, encoding="utf-8"))
            except Exception:
                assign = {}
        # 已分配且该卡还可用且没被 exclude → 复用(重试同一号还用同一张卡;换卡时跳过已试的)
        if account in assign and assign[account] not in exclude:
            for c in active:
                if _cid(c) == assign[account]:
                    return c
        bin_picked = None
        import collections, datetime, random as _rnd
        counts = collections.Counter(assign.values())              # 每张卡已分配给几个号(守 maxUses)
        cap = int(os.environ.get("CARD_BIN_DAILY_CAP", "20"))       # 每个 BIN 当日加卡号数上限(防 velocity)
        today = datetime.date.today().isoformat()
        binusage = _read_bin_usage()
        today_use = _bin_today(binusage, today)                     # {BIN:{assigned,bound,declined,...}}  三策略共用

        def _assigned(b):
            return (today_use.get(b) or {}).get("assigned", 0)
        # 候选:仍有 maxUses 余量的 active 卡;CARD_PREFER_BIN 给定则优先该段
        cands = [c for c in active if counts.get(_cid(c), 0) < c.get("maxUses", 1)] or active
        prefer = os.environ.get("CARD_PREFER_BIN", "").strip()
        if prefer:
            pcands = [c for c in cands if _bin_of(c) == prefer]
            if pcands:
                cands = pcands
        if strategy == "concentrate":
            # 容量测试：一直灌【已用次数最多、仍 active】的那张卡 → 灌到被拒为止,接力下一张。
            best = max(active, key=lambda c: (c.get("usedCount", 0), c.get("successCount", 0)))
        elif strategy == "random":
            # 每个号【随机取】一张卡——但仍尊重 BIN 当日限量:优先从"当日没超额的 BIN"里随机,
            # 避免随机大量命中独大的 BIN(如 436120 占一大半)→撞 Stripe Radar velocity。
            under = [c for c in cands if _assigned(_bin_of(c)) < cap]
            best = _rnd.choice(under or cands)
            bin_picked = _bin_of(best)
            if count_bin:
                slot = today_use.setdefault(bin_picked, {})
                slot["assigned"] = slot.get("assigned", 0) + 1
                _save_bin_usage(binusage)
        else:
            # spread:轮流摊匀(确定性最均)——按「该 BIN 当日已发号数最少」再「该卡已分配最少」。
            under = [c for c in cands if _assigned(_bin_of(c)) < cap]
            pick_from = under or cands
            best = min(pick_from, key=lambda c: (_assigned(_bin_of(c)), counts.get(_cid(c), 0)))
            bin_picked = _bin_of(best)
            if count_bin:   # 换卡(count_bin=False)不是新号 → 不重复占该 BIN 当日额度
                slot = today_use.setdefault(bin_picked, {})
                slot["assigned"] = slot.get("assigned", 0) + 1
                _save_bin_usage(binusage)
        if count_bin:       # 换卡不覆盖原分配:续跑/重试仍复用最初分配的卡,而非最后那张没绑成的
            assign[account] = _cid(best)
            _atomic_write_json(CARD_ASSIGN_FILE, assign)
        # 本卡已分配到的号数(两种策略都从 assign 现算,避免引用某分支才有的局部变量)
        import collections as _c
        nbound = _c.Counter(assign.values()).get(_cid(best), 0)
    binnote = (" BIN%s今日第%d" % (bin_picked, (today_use.get(bin_picked) or {}).get("assigned", 0))) if bin_picked else ""
    log("[卡] 给 %s 分配卡 ••%s(%s,该卡已分配 %d 个号%s)" % (
        account, str(best.get("last4") or best.get("number", ""))[-4:],
        {"concentrate": "集中测容量", "random": "随机取", "spread": "摊匀"}.get(strategy, "摊匀"), nbound, binnote))
    return best


def screen_size():
    """屏幕分辨率(Windows 取真实值,失败回退 1920x1080;环境变量 SCREEN_W/SCREEN_H 可覆盖)。"""
    w = os.environ.get("SCREEN_W")
    h = os.environ.get("SCREEN_H")
    if w and h:
        return int(w), int(h)
    try:
        import ctypes
        u = ctypes.windll.user32
        u.SetProcessDPIAware()
        return int(u.GetSystemMetrics(0)), int(u.GetSystemMetrics(1))
    except Exception:
        return 1920, 1080


def grid_rect(slot, total, taskbar=48):
    """把 total 个窗口平铺成网格,返回第 slot 个窗口的 (x, y, w, h)。
    列数=ceil(sqrt(total)),尺寸=屏幕/网格——并发越多每个窗口越小,正好铺满屏。"""
    import math
    sw, sh = screen_size()
    sh = max(360, sh - taskbar)
    total = max(1, int(total))
    # 宽屏感知:列数按屏幕宽高比放大(宽屏多列→每个窗口更【高】,卡表单 Save 按钮装得下,免"没取到Save坐标")
    aspect = max(1.0, sw / float(max(1, sh)))
    cols = min(total, max(1, int(math.ceil(math.sqrt(total * aspect)))))
    rows = int(math.ceil(total / float(cols)))
    w = max(480, sw // cols)
    h = max(360, sh // rows)
    col = slot % cols
    row = (slot // cols) % rows
    return (col * w, row * h, w, h)


def place_window(driver, rect):
    """把 Selenium 接管的窗口移到/缩放到 rect=(x,y,w,h)。"""
    try:
        x, y, w, h = rect
        driver.set_window_rect(x=int(x), y=int(y), width=int(w), height=int(h))
        return True
    except Exception as e:
        log("置窗失败: %s" % str(e)[:60])
        return False


def mark_card_result(card, result):
    """加卡结果回写卡池(并发安全)：
       declined→【立即禁用】该卡(坏卡,不再用)；server-error/unknown→errorCount++,连续≥5次才禁(Radar限频非卡问题)；
       card-bound→successCount++。禁用后 load_card 不再选它,已分配该卡的号会自动改派。"""
    if not card:
        return
    cid = card.get("id") or card.get("number")
    with _CARD_LOCK:
        try:
            pool = json.load(open(POOL_FILE, encoding="utf-8"))
        except Exception:
            return
        import datetime
        now = datetime.datetime.utcnow().isoformat() + "Z"
        # per-BIN 当日结果直方图(看哪个 BIN 被刷穿:server-error 占比飙→该停用该 BIN)
        binn = (card.get("number") or "")[:6]
        if binn:
            try:
                bu = _read_bin_usage()
                t = _bin_today(bu, datetime.date.today().isoformat()).setdefault(binn, {})
                t[result] = t.get(result, 0) + 1
                _save_bin_usage(bu)
            except Exception:
                pass
        for c in pool:
            if (c.get("id") or c.get("number")) != cid:
                continue
            c["lastResult"] = result
            c["lastUsedAt"] = now
            if result == "card-bound":
                c["successCount"] = c.get("successCount", 0) + 1
                c["usedCount"] = c.get("usedCount", 0) + 1
                # 绑成就清 502 计数:能绑成=卡是好的,之前的 502 是 velocity/限频不算卡的账。
                # 这样 errorCount 变成"连续未绑成次数",只有【一直】502 的真坏卡才会累到 5 被禁。
                c["errorCount"] = 0
                c["declineCount"] = 0          # 绑成=好卡 → 清掉之前的环境性 declined 计数,别让它累到阈值被误禁
                c.pop("cooldownUntil", None)   # 绑成=好卡 → 清掉冷却,立即可再用
            elif result == "declined":
                # 用户(2026-06-12)新认知:declined 多是【环境因素】(ZIP/AVS、IP),不一定卡坏、更不是号坏
                # (实测一个号能连拒3个不同好段,换IP/ZIP 就过)。所以单次 declined 只【冷却(还能复用)】,
                # declineCount 累到阈值(在多个会话都被拒=大概率真坏卡)才禁用。CARD_DECLINE_DISABLE_AT 可调
                # (默认2;要回'一拒就禁'设成1)。ZIP重试在填卡层已先试过多个ZIP,到这=换ZIP也没救。
                c["declineCount"] = c.get("declineCount", 0) + 1
                last4 = str(c.get("last4") or "")[-4:]
                dis_at = int(os.environ.get("CARD_DECLINE_DISABLE_AT", "2"))
                if c.get("declineCount", 0) >= dis_at:
                    c["status"] = "disabled"; c["disabledReason"] = "declined"; c["disabledAt"] = now
                    log("[卡] ••%s declined 第%d次(≥%d=多会话都拒,大概率真坏卡)→ 禁用(此前绑成 %d)" % (
                        last4, c["declineCount"], dis_at, c.get("successCount", 0)))
                else:
                    _m = float(os.environ.get("CARD_DECLINE_COOLDOWN_MIN", "30"))
                    c["cooldownUntil"] = (datetime.datetime.utcnow() + datetime.timedelta(minutes=_m)).isoformat() + "Z"
                    log("[卡] ••%s declined 第%d次(疑环境/AVS非卡坏)→ 冷却%d分钟、不禁用(还能复用)" % (
                        last4, c["declineCount"], int(_m)))
            elif result == "hcaptcha":
                # 弹出【可见】人机验证框。实测确认:这多为【账号/会话/IP 级】风控 —— 同一个号上
                # 换任何卡、任何 BIN、任何 IP 都照样弹,不是这张卡的质量问题。所以:
                #   · 生产 spread 模式【绝不禁卡】(只计数),换卡/切IP/弃号交由上层 escalation 处理,
                #     避免把无辜好卡 captchaCount 刷到禁用(曾实测一轮误禁多张新卡)。
                #   · 只有 concentrate(容量测试)模式才按阈值禁,用于"灌到弹验证框为止"测单卡容量。
                c["captchaCount"] = c.get("captchaCount", 0) + 1
                last4 = str(c.get("last4") or "")[-4:]
                if os.environ.get("CARD_STRATEGY", "spread").strip().lower() == "concentrate":
                    lim = int(os.environ.get("CARD_CAPTCHA_LIMIT", "3"))
                    if c.get("captchaCount", 0) >= lim:
                        c["status"] = "disabled"
                        c["disabledReason"] = "too-many-captcha"
                        c["disabledAt"] = now
                        log("[卡] ••%s 弹验证框 %d 次(≥%d,concentrate)→ 禁用本卡" % (last4, c.get("captchaCount", 0), lim))
                    else:
                        log("[卡] ••%s 弹验证框第 %d/%d 次(concentrate)" % (last4, c.get("captchaCount", 0), lim))
                else:
                    # 用户规则(2026-06-11):弹验证框也【冻结该卡(冷却)】——弹框即换卡策略下,
                    # 让 load_card 立刻轮到没弹过框的别的卡(不禁用,绑成会清零)。冷却时长同错误规则。
                    _base = float(os.environ.get("CARD_ERR_COOLDOWN_MIN", "20"))
                    _mins = min(_base * max(1, c.get("captchaCount", 1)), _base * 4)
                    c["cooldownUntil"] = (datetime.datetime.utcnow() + datetime.timedelta(minutes=_mins)).isoformat() + "Z"
                    log("[卡] ••%s 弹验证框第%d次 → 冻结(冷却 %d 分钟,换卡试)(spread 不禁卡)" % (
                        last4, c.get("captchaCount", 0), int(_mins)))
            elif result in ("server-error", "unknown", "card-502"):
                # 用户规则:server-error/unknown/card-502(后端 unable-to-authenticate) 都【不是卡坏】→ 只计数,
                # 绝不禁卡(唯一禁卡条件是 declined)。实测同一张卡在 A 会话 502、在 B 会话能绑成 ——
                # 502 是【会话/段+会话组合】级,不是这张卡报废;禁了就白白浪费好卡。card-502 只让上层换段重绑。
                c["errorCount"] = c.get("errorCount", 0) + 1
                # 用户规则(2026-06-11):错误后【延迟该卡复用】(冷却,不是禁用)——让 load_card 轮到别的卡,
                # 别老拿同几张卡撞同一面墙、降单卡 velocity。冷却随连续错误次数递增(有上限),绑成会清零。
                _base = float(os.environ.get("CARD_ERR_COOLDOWN_MIN", "20"))
                _mins = min(_base * c["errorCount"], _base * 4)
                c["cooldownUntil"] = (datetime.datetime.utcnow() + datetime.timedelta(minutes=_mins)).isoformat() + "Z"
                log("[卡] ••%s 错误(%s)第%d次 → 冷却 %d 分钟(延迟复用,非禁用)" % (
                    str(c.get("last4") or "")[-4:], result, c["errorCount"], int(_mins)))
            break
        _atomic_write_json(POOL_FILE, pool)


def list_active_cards():
    """给页面内卡片面板用:列出所有 active 且有余次的卡的【展示字段】(不含 PAN,安全)。
       返回 [{id,last4,bin,bound,used,max}, …](按已绑次数倒序,再按段)。"""
    try:
        pool = json.load(open(POOL_FILE, encoding="utf-8"))
    except Exception:
        return []
    import datetime as _dt
    now = _dt.datetime.utcnow()
    now_iso = now.isoformat() + "Z"
    out = []
    for c in (pool if isinstance(pool, list) else []):
        if c.get("status") != "active" or c.get("usedCount", 0) >= c.get("maxUses", 1):
            continue
        cu = c.get("cooldownUntil")
        cooling = bool(cu and cu > now_iso)
        cool_min = 0
        if cooling:
            try:
                dt = _dt.datetime.fromisoformat(cu.replace("Z", ""))
                cool_min = max(0, int((dt - now).total_seconds() / 60) + 1)
            except Exception:
                cool_min = 0
        out.append({
            "id": c.get("id") or c.get("number"),
            "last4": str(c.get("last4") or c.get("number", ""))[-4:],
            "bin": (c.get("number") or "")[:6],
            "bound": c.get("successCount", 0),
            "used": c.get("usedCount", 0),
            "max": c.get("maxUses", 1),
            "cooling": cooling,
            "coolMin": cool_min,
        })
    # 没冷却的在前(按已绑次数倒序),冷却中的排后面(按剩余时间)
    out.sort(key=lambda x: (x["cooling"], -x["bound"] if not x["cooling"] else x["coolMin"], x["bin"]))
    return out


def get_card_by_id(cid):
    """按 id(或卡号)返回【完整】卡对象,仅当它 active 且有余次;否则 None。
       手动选卡后用它取真卡去填(含 PAN,只在 Python 侧用、不进 DOM)。"""
    if not cid:
        return None
    try:
        pool = json.load(open(POOL_FILE, encoding="utf-8"))
    except Exception:
        return None
    for c in (pool if isinstance(pool, list) else []):
        if (c.get("id") or c.get("number")) == cid:
            if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1):
                return c
            return None
    return None


def rand_address():
    first = random.choice(["Mark", "Karen", "Thomas", "Laura", "Brian", "Nancy", "Kevin", "Susan"])
    last = random.choice(["Lopez", "Robinson", "Flores", "Bennett", "Sanders", "Hughes", "Coleman"])
    # 免税州 + 配套真实城市/邮编（city/state/zip 错配会被 Radar 加分）
    state, city, zc = random.choice([
        ("Montana", "Billings", "59101"), ("Montana", "Helena", "59601"),
        ("Oregon", "Salem", "97301"), ("Oregon", "Portland", "97201"),
        ("New Hampshire", "Nashua", "03063"), ("New Hampshire", "Concord", "03301"),
        ("Delaware", "Dover", "19901"), ("Delaware", "Wilmington", "19801"),
    ])
    return {"name": "%s %s" % (first, last),
            "line1": "%d %s" % (random.randint(100, 9000), random.choice(["E 5th Ave", "Birch Ter", "S Cedar Way", "Pine St", "Oak Dr", "Maple Ln"])),
            "city": city, "country": "United States", "state": state, "zip": zc}


def load_config():
    """读 config.local.json(优先) + config.json，取 2captcha key / firstmail key。"""
    cfg = {}
    for f in (CONFIG_JSON, CONFIG_LOCAL):  # local 后读 → 覆盖
        try:
            with open(f, "r", encoding="utf-8") as fp:
                _deep_merge(cfg, json.load(fp))
        except Exception:
            pass
    cap = cfg.get("captcha", {}) or {}
    mb = cfg.get("mailbox", {}) or {}
    return {
        "captcha_key": cap.get("apiKey", ""),
        "captcha_provider": cap.get("provider", "twocaptcha"),
        "mail_key": mb.get("apiKey", ""),
        "mail_base": mb.get("apiBaseUrl", "https://firstmail.ltd"),
        "mail_timeout": mb.get("apiTimeoutMs", 30000) / 1000.0,
    }


def _deep_merge(dst, src):
    for k, v in (src or {}).items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def rand_name(n=10):
    import string
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


# ── Page：跨 iframe 钻取（Stripe 跨域 iframe 必需） ─────────────────────
class Page:
    def __init__(self, driver):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support.ui import Select
        self.d = driver
        self.By = By
        self.Keys = Keys
        self.Select = Select

    def goto(self, url, wait=2.0):
        self.d.get(url)
        self.wait_loaded()
        if wait:
            time.sleep(wait)

    def url(self):
        try:
            return self.d.current_url
        except Exception:
            return ""

    def js(self, script, *a):
        try:
            return self.d.execute_script(script, *a)
        except Exception:
            return None

    def wait_loaded(self, timeout=25):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.d.execute_script("return document.readyState") == "complete":
                    return True
            except Exception:
                pass
            time.sleep(0.5)
        return False

    def shot(self, path):
        try:
            self.d.save_screenshot(path)
            log("已截图 %s" % path)
        except Exception:
            pass

    def all_frames_text(self):
        By = self.By
        txt = []
        try:
            self.d.switch_to.default_content()
            for f in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
                try:
                    if f is not None:
                        self.d.switch_to.frame(f)
                    txt.append(self.d.find_element(By.TAG_NAME, "body").text or "")
                except Exception:
                    pass
                finally:
                    self.d.switch_to.default_content()
        except Exception:
            pass
        return "\n".join(txt)

    def click_text(self, labels, timeout=8):
        By = self.By
        end = time.time() + timeout
        while time.time() < end:
            for lab in labels:
                try:
                    els = self.d.find_elements(By.XPATH, "//button[contains(normalize-space(.), '%s')] | //*[@role='button'][contains(normalize-space(.), '%s')]" % (lab, lab))
                    for el in els:
                        if el.is_displayed() and el.is_enabled():
                            el.click()
                            return True
                except Exception:
                    pass
            time.sleep(0.6)
        return False

    def click_card_tab(self, timeout=8):
        """OpenRouter「Add a Payment Method」有时弹支付方式选择器(Cash App Pay/Card/Bank/Klarna),
        默认选中 Cash App Pay → 卡表单不出。这里跨 iframe(含一层嵌套)找并点【Card】这块。
        click_text 只在当前 frame 找,够不到 Stripe iframe 里的 tab,所以单写一个跨帧版。返回是否点到。"""
        By = self.By
        JS = r"""
          var els=[].slice.call(document.querySelectorAll(
            'button,[role=button],[role=tab],[role=radio],label,div[tabindex],a'));
          function norm(b){return ((b.innerText||b.textContent||'').replace(/\s+/g,' ')).trim();}
          // 1) 文本精确等于 Card / Credit Card(避免误中 "Card number" 这类标签)
          var t=els.find(function(b){var x=norm(b);return x==='Card'||x==='Credit Card'||x==='Debit or Credit Card'||x==='Credit or debit card';});
          // 2) 兜底:Stripe tab 的 id/data-testid 含 card
          if(!t) t=els.find(function(b){var id=((b.id||'')+' '+((b.getAttribute&&b.getAttribute('data-testid'))||'')).toLowerCase();
                 return /(^|[-_ ])card($|[-_ ])|tab-card|item-card/.test(id);});
          if(t){try{t.scrollIntoView({block:'center'});}catch(e){} t.click(); return true;}
          return false;
        """
        end = time.time() + timeout
        while time.time() < end:
            frames = [None] + self.d.find_elements(By.TAG_NAME, "iframe")
            for f in frames:
                try:
                    self.d.switch_to.default_content()
                    if f is not None:
                        self.d.switch_to.frame(f)
                    if self.d.execute_script(JS):
                        self.d.switch_to.default_content()
                        return True
                    # 再下钻一层(Stripe 常是 iframe 里还有 iframe)
                    if f is not None:
                        for ifr in self.d.find_elements(By.TAG_NAME, "iframe"):
                            try:
                                self.d.switch_to.frame(ifr)
                                if self.d.execute_script(JS):
                                    self.d.switch_to.default_content()
                                    return True
                                self.d.switch_to.parent_frame()
                            except Exception:
                                self.d.switch_to.default_content()
                                if f is not None:
                                    self.d.switch_to.frame(f)
                except Exception:
                    pass
            self.d.switch_to.default_content()
            time.sleep(0.5)
        self.d.switch_to.default_content()
        return False

    def _try_fill(self, sels, value, want):
        By, Keys = self.By, self.Keys
        for s in sels:
            try:
                for el in self.d.find_elements(By.CSS_SELECTOR, s):
                    if el.is_displayed():
                        el.click()
                        el.send_keys(Keys.CONTROL, "a"); el.send_keys(Keys.DELETE)
                        # 逐字符敲 + 随机间隔(拟人化):整串 0ms 粘贴是机器特征,Stripe Radar 的行为遥测
                        # 会看填卡节奏(填卡耗时<人类下限=高风险)。卡号16位约 ~1.3s,代价小、压风险分。
                        for ch in str(value):
                            el.send_keys(ch)
                            time.sleep(random.uniform(0.04, 0.13))
                        time.sleep(0.2)
                        got = digits(el.get_attribute("value"))
                        if not want or len(got) >= len(want):
                            return True
            except Exception:
                continue
        return False

    def fill_in_frames(self, sels, value):
        By = self.By
        if not value:
            return None
        want = digits(value)
        for _ in range(2):
            self.d.switch_to.default_content()
            if self._try_fill(sels, value, want):
                return True
            for fr in self.d.find_elements(By.TAG_NAME, "iframe"):
                try:
                    self.d.switch_to.default_content(); self.d.switch_to.frame(fr)
                    if self._try_fill(sels, value, want):
                        return True
                    for ifr in self.d.find_elements(By.TAG_NAME, "iframe"):
                        try:
                            self.d.switch_to.frame(ifr)
                            if self._try_fill(sels, value, want):
                                return True
                            self.d.switch_to.parent_frame()
                        except Exception:
                            try: self.d.switch_to.parent_frame()
                            except Exception: pass
                except Exception:
                    continue
            time.sleep(0.5)
        self.d.switch_to.default_content()
        return False

    def select_in_frames(self, sels, label):
        By = self.By
        self.d.switch_to.default_content()
        for f in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                if f is not None:
                    self.d.switch_to.frame(f)
                for s in sels:
                    for el in self.d.find_elements(By.CSS_SELECTOR, s):
                        try:
                            self.Select(el).select_by_visible_text(label)
                            self.d.switch_to.default_content(); return True
                        except Exception:
                            pass
            except Exception:
                pass
            finally:
                self.d.switch_to.default_content()
        return False

    def field_present(self, sels):
        By = self.By
        self.d.switch_to.default_content()
        try:
            for fr in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
                try:
                    if fr is not None:
                        self.d.switch_to.frame(fr)
                    for s in sels:
                        for el in self.d.find_elements(By.CSS_SELECTOR, s):
                            if el.is_displayed():
                                return True
                except Exception:
                    pass
                finally:
                    self.d.switch_to.default_content()
        except Exception:
            pass
        return False

    def wait_field_present(self, sels, timeout=30, label="字段"):
        end = time.time() + timeout
        while time.time() < end:
            if self.field_present(sels):
                return True
            time.sleep(0.6)
        log("  ✗ 等【%s】出现超时(%ss)" % (label, timeout))
        return False

    def wait_and_fill(self, sels, value, timeout=15, label="字段"):
        if value is None or value == "":
            return None
        end = time.time() + timeout
        while time.time() < end:
            if self.field_present(sels) and self.fill_in_frames(sels, value):
                log("  ✓ %s 已填" % label)
                return True
            time.sleep(0.6)
        log("  ✗ %s 超时未填上" % label)
        return False

    def wait_and_select(self, sels, label_text, timeout=12, label="下拉"):
        end = time.time() + timeout
        while time.time() < end:
            if self.field_present(sels) and self.select_in_frames(sels, label_text):
                log("  ✓ %s 已选(%s)" % (label, label_text))
                return True
            time.sleep(0.6)
        log("  ✗ %s 超时未选上" % label)
        return False

    def tab_blur(self, sels):
        """给匹配到的输入框发 TAB 使其失焦——触发 Stripe Address/Payment Element 字段校验。跨帧。
        Stripe 元件只在 blur 后才把字段算 complete，否则 Update Address/Save 点了不动。"""
        By, Keys = self.By, self.Keys
        self.d.switch_to.default_content()
        for fr in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                if fr is not None:
                    self.d.switch_to.frame(fr)
                for s in sels:
                    for el in self.d.find_elements(By.CSS_SELECTOR, s):
                        if el.is_displayed():
                            try:
                                el.send_keys(Keys.TAB)
                            except Exception:
                                pass
                            self.d.switch_to.default_content()
                            return True
            except Exception:
                pass
            finally:
                self.d.switch_to.default_content()
        return False

    def uncheck_all_frames(self):
        """跨 2 层 iframe 取消所有勾选（Stripe Link 复选框在 iframe 里）。返回取消个数。"""
        By = self.By
        def here():
            cnt = 0
            for cb in self.d.find_elements(By.CSS_SELECTOR, "input[type=checkbox]"):
                try:
                    if cb.is_selected():
                        try:
                            cb.click()
                        except Exception:
                            self.d.execute_script("arguments[0].click()", cb)
                        cnt += 1
                except Exception:
                    pass
            return cnt
        nu = 0
        self.d.switch_to.default_content()
        nu += here()
        for fr in self.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                self.d.switch_to.default_content(); self.d.switch_to.frame(fr)
                nu += here()
                for ifr in self.d.find_elements(By.TAG_NAME, "iframe"):
                    try:
                        self.d.switch_to.frame(ifr); nu += here(); self.d.switch_to.parent_frame()
                    except Exception:
                        try: self.d.switch_to.parent_frame()
                        except Exception: pass
            except Exception:
                pass
        self.d.switch_to.default_content()
        return nu
