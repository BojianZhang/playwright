#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════════
# 指纹自测 / 验收工具(Fingerprint Pro 当「镜子」用)
# ───────────────────────────────────────────────────────────────────────────
# ★这是【验收工具】,不是指纹生成器。
#   · FingerprintJS / Fingerprint Pro 的作用是【识别/追踪】一个浏览器 —— 它读取浏览器属性,
#     算出一个稳定的 visitor_id 来认出"是不是同一台设备"。它【不会】给你随机指纹,
#     随机指纹是 AdsPower 在 services/adspower_env._random_fingerprint() 里做的。
#   · 我们反过来用它:在每个 AdsPower 环境里跑一次 fp.get(),拿回 visitor_id + 服务端 Smart Signals,
#     用来回答两个问题:
#       (1) 不同环境 → 不同 visitor_id 吗?(碰撞 = 你的号会被关联到一起 → 坏)
#       (2) 同一环境重开 → 同一个 visitor_id 吗?(变了 = 过度随机化,稳定检测器会判"篡改" → 坏)
#     外加 Smart Signals 的 bot / tampering / vpn / proxy / vm 判定(需 secret key,服务端取)。
#
# ★两条必须记住的边界(否则会误用):
#   · 过这个自测 ≠ 过 Stripe Radar。Radar 打的是交易层(卡历史/IP信誉/速度/行为)1000+ 信号,
#     浏览器指纹只是其中一个输入。这工具【不能】用来解释/降低加卡 declined。
#   · 绝不要把 FP 脚本塞进真实注册/加卡流程 —— 那等于主动上报你每个号的设备数据给一个顶级识别服务,
#     帮它把你的号串起来,纯属帮倒忙。它只在【这个独立自测工具】里跑。
#
# ★为什么走【原生 CDP】而不是 chromedriver(关键正确性):
#   生产加卡走 Fix C(原生 CDP,从不 Runtime.enable,无 cdc_)。chromedriver 接管会泄漏自动化特征,
#   FP 的 bot/tampering 会因此【假阳性】——测的是 chromedriver,不是你的环境。所以这里复刻 fixc_probe.py
#   的做法:RawCDP 连干净页 → Page.navigate 到中立 https 页 → Runtime.evaluate(awaitPromise)跑 FP。
#   这样 bot/tampering 反映的才是你真实生产会话的样子。
#
# ───────────────────────────────────────────────────────────────────────────
# 配置(优先级:命令行 > 环境变量 > state/fp-config.json > 默认):
#   公钥(浏览器端,可公开)   --api-key   / FP_PUBLIC_KEY
#   密钥(服务端,务必保密!)  --secret-key/ FP_SECRET_KEY   (没有 → 只测 visitor_id,跳过 Smart Signals)
#   区域                      --region    / FP_REGION        默认 ap(必须与你 workspace 区域一致)
#   落地页(跑 FP 的中立页)   --url       / FP_TEST_URL      默认 https://example.com/
#                               ★若你把公钥锁了域名,这里要指到那个被允许的域名的某个页
#   服务端 API 域名           --server-base / FP_SERVER_BASE 默认按区域:ap→https://ap.api.fpjs.io
#
# 用法:
#   python tools/fingerprint_check.py ENV1 ENV2 ENV3       # 逐个环境跑一次,汇总碰撞/判定
#   python tools/fingerprint_check.py --stability ENV1 -n 3 # 同一环境重开 3 次,验稳定(查过度随机化)
#   python tools/fingerprint_check.py --list                # 从 AdsPower 拉环境列表再逐个测
#   python tools/fingerprint_check.py --report              # 只读 state/fingerprint-scores.json 出报告
#
# 结果落 state/fingerprint-scores.json(与 proxy-scores.json 并列,程序/后续可读)。
# ═══════════════════════════════════════════════════════════════════════════
import os, sys, io, json, time, argparse, datetime, urllib.request, urllib.parse

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

# tools/ 下直接跑时让 `import common` / `from services...` 可解析(锚定 selenium-e2e/)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

SCORES_FILE = os.path.join(HERE, "state", "fingerprint-scores.json")
CONFIG_FILE = os.path.join(HERE, "state", "fp-config.json")

# 区域 → 服务端 API 域名(Server API v4)。ap=亚洲(孟买),eu=欧洲,其余走全局。
REGION_SERVER = {
    "ap": "https://ap.api.fpjs.io",
    "eu": "https://eu.api.fpjs.io",
    "us": "https://api.fpjs.io",
    "global": "https://api.fpjs.io",
}


def log(*a):
    print("[fp]", *a, flush=True)


def _now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ════════════════ 纯逻辑(无网络/无副作用 → test_fingerprint.py 离线测) ════════════════

def _dig(d, *path):
    """安全逐层取 dict,中途断了返回 None。"""
    cur = d
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def summarize_signals(resp):
    """从 Server API 响应里抽关键信号 —— 容错 v4(扁平 snake_case)与 v3(products.*.data)两种结构。
       返回扁平 dict:{visitor_id, confidence, bot, vpn, proxy, tampering, virtual_machine,
                      incognito, developer_tools, ip_blocklist:{...}}。取不到的为 None。"""
    if not isinstance(resp, dict):
        return {}
    prod = resp.get("products") if isinstance(resp.get("products"), dict) else None
    out = {}
    out["visitor_id"] = (_dig(resp, "identification", "visitor_id")
                         or _dig(prod or {}, "identification", "data", "visitorId"))
    out["confidence"] = (_dig(resp, "identification", "confidence", "score")
                         or _dig(prod or {}, "identification", "data", "confidence", "score"))
    # bot:v4 顶层 'bot' 是枚举字符串(bad/good/not_detected);v3 是 products.botd.data.bot.result
    bot = resp.get("bot") if isinstance(resp.get("bot"), str) else None
    if bot is None:
        bot = _dig(prod or {}, "botd", "data", "bot", "result")
    out["bot"] = bot
    # 布尔类信号:先取 v4 扁平键,没有再回退 v3 products.<key>.data.result
    for flat, v3key in (("vpn", "vpn"), ("proxy", "proxy"), ("tampering", "tampering"),
                        ("virtual_machine", "virtualMachine"), ("incognito", "incognito"),
                        ("developer_tools", "developerTools"), ("mitm_attack", None),
                        ("privacy_settings", "privacySettings")):
        val = resp.get(flat)
        if val is None and prod and v3key:
            val = _dig(prod, v3key, "data", "result")
        out[flat] = val
    # IP 黑名单 / Tor
    ipb = resp.get("ip_blocklist")
    if ipb is None:
        ipb = _dig(prod or {}, "ipBlocklist", "data")
    if isinstance(ipb, dict):
        out["ip_blocklist"] = {k: ipb.get(k) for k in ("email_spam", "attack_source", "tor_node") if k in ipb}
    return out


def classify_env(sig, stable, is_collision, ok=True):
    """给单个环境定档 + 列原因。sig=summarize_signals 结果(无 secret key 时为 {})。
       stable: True=重开稳定 / False=变了(坏) / None=没测过稳定。"""
    if not ok:
        return {"tier": "⚠未取到", "reasons": ["FP 没返回 visitor_id(代理/网络/被域名白名单拦)"], "notes": []}
    reasons, notes = [], []
    bad = False
    if is_collision:
        reasons.append("指纹碰撞(与其他环境 visitor_id 相同→可被关联)"); bad = True
    if stable is False:
        reasons.append("重开后 visitor_id 变了(过度随机化→稳定检测器判篡改)"); bad = True
    bot = sig.get("bot")
    if isinstance(bot, str) and bot.lower() == "bad":
        reasons.append("被判定为机器人(bot=bad)"); bad = True
    if sig.get("tampering") is True:
        reasons.append("被判定为指纹篡改(tampering)"); bad = True
    if sig.get("virtual_machine") is True:
        reasons.append("被判定为虚拟机(VM)"); bad = True
    if sig.get("incognito") is True:
        notes.append("incognito=true(异常:正常号不该是无痕)")
    if sig.get("proxy") is True:
        notes.append("proxy=true(用代理→预期内,不算坏)")
    if sig.get("vpn") is True:
        notes.append("vpn=true")
    return {"tier": ("❌差" if bad else "✅好"), "reasons": reasons, "notes": notes}


def analyze(envs):
    """全集层面找碰撞:哪些 visitor_id 被多于一个环境共用。
       返回 {total, distinct_visitor_ids, collisions:{visitor_id:[env...]}}。"""
    vid_map = {}
    for eid, rec in (envs or {}).items():
        vid = rec.get("visitor_id")
        if vid:
            vid_map.setdefault(vid, []).append(eid)
    collisions = {v: es for v, es in vid_map.items() if len(es) > 1}
    return {"total": len(envs or {}),
            "distinct_visitor_ids": len(vid_map),
            "collisions": collisions}


def render_report(scores):
    """把 state/fingerprint-scores.json 渲染成可读报表(纯字符串,便于测试/打印)。"""
    envs = scores.get("envs", {}) if isinstance(scores, dict) else {}
    info = analyze(envs)
    coll = info["collisions"]
    out = []
    out.append("═" * 76)
    out.append("  指纹自测报告  ——  %d 个环境, %d 个不同 visitor_id" % (info["total"], info["distinct_visitor_ids"]))
    out.append("═" * 76)
    if not envs:
        out.append("  (还没有数据。先跑:python tools/fingerprint_check.py ENV1 ENV2 …)")
        out.append("═" * 76)
        return "\n".join(out)
    if coll:
        out.append("  ⚠ 指纹碰撞(多个环境算出同一个 visitor_id → 会被关联成同一设备):")
        for vid, es in coll.items():
            out.append("     %s…  ←  %s" % ((vid or "")[:14], ", ".join(es)))
    else:
        out.append("  ✅ 无碰撞:每个环境 visitor_id 都唯一(彼此不会被 FP 关联)")
    out.append("  " + "-" * 72)
    out.append("  %-16s %-10s %-5s %-7s %s" % ("环境", "visitor", "稳定", "判定", "原因 / 备注"))
    out.append("  " + "-" * 72)
    for eid, rec in envs.items():
        is_coll = any(eid in es for es in coll.values())
        sig = rec.get("signals") or {}
        cls = classify_env(sig, rec.get("stable"), is_coll, rec.get("ok", False))
        vid = (rec.get("visitor_id") or "")[:8]
        st = {True: "稳", False: "变!", None: "-"}.get(rec.get("stable"), "-")
        why = "; ".join(cls["reasons"] + cls["notes"])
        if not why and not rec.get("ok"):
            why = "FP失败:" + str(rec.get("error", ""))[:42]
        out.append("  %-16s %-10s %-5s %-7s %s" % (eid[:16], vid, st, cls["tier"], why[:58]))
    out.append("  " + "-" * 72)
    conf_seen = [rec.get("confidence") for rec in envs.values() if rec.get("confidence") is not None]
    if not any((rec.get("signals") for rec in envs.values())):
        out.append("  注:未配 secret key → 只测了 visitor_id 唯一性/稳定性,没取 bot/tampering 等 Smart Signals。")
    out.append("═" * 76)
    return "\n".join(out)


# ════════════════ 网络 / CDP(有副作用:启停浏览器、发请求) ════════════════

def _fp_eval_js(public_key, region):
    """构造在页面里跑的 JS:动态 import FP agent(CDN,公钥在 URL)→ start({region}) → get()。
       返回 JSON 字符串({ok, visitor_id, event_id} 或 {ok:false, error})。键/区域用 JSON 字面量内嵌防注入。"""
    key = json.dumps(public_key)
    reg = json.dumps(region)
    return (
        "(async () => {"
        "  try {"
        "    const M = await import('https://fpjscdn.net/v4/' + %s);"
        "    const start = (M && (M.start || (M.default && M.default.start)));"
        "    if (!start) return JSON.stringify({ ok:false, error:'agent 无 start 导出' });"
        "    const fp = await start({ region: %s });"
        "    const r = await fp.get();"
        "    return JSON.stringify({ ok:true,"
        "      visitor_id: (r && (r.visitor_id || r.visitorId)) || null,"
        "      event_id:   (r && (r.event_id   || r.requestId)) || null });"
        "  } catch (e) { return JSON.stringify({ ok:false, error:String((e && e.message) || e) }); }"
        "})()"
    ) % (key, reg)


def _navigate_and_wait(cdp, url, timeout=30):
    """不开 Page.enable 的导航:Page.navigate 后轮询 document.readyState=='complete'。"""
    cdp.send("Page.navigate", {"url": url}, timeout=timeout)
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cdp.evaluate("document.readyState", timeout=5) == "complete":
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def fetch_server_signals(event_id, cfg):
    """用 secret key 调 Server API v4 GET /v4/events/<event_id> 取 Smart Signals。
       ★直连(不走 per-profile 代理):这是运营机到 FP 的服务端调用,与浏览器会话无关。
       ★secret key 绝不打印/落盘到结果里。"""
    base = (cfg.get("server_base") or REGION_SERVER.get(cfg.get("region", "ap"), REGION_SERVER["global"])).rstrip("/")
    url = "%s/v4/events/%s" % (base, urllib.parse.quote(event_id, safe=""))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + cfg["secret_key"]})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 直连
    with opener.open(req, timeout=cfg.get("server_timeout", 25)) as r:
        body = json.loads(r.read().decode("utf-8", "replace"))
    return summarize_signals(body)


def probe_env(env_id, cfg):
    """对一个 AdsPower 环境跑一次指纹自测:启动→原生CDP连→跳中立页→跑FP→(可选)取Smart Signals→关。
       返回一条记录 dict。绝不抛(异常都收进 rec.error),保证 finally 关环境。"""
    import common
    from services.cdp_raw import RawCDP

    rec = {"env_id": env_id, "ts": _now(), "ok": False}
    log("环境 %s 启动中…" % env_id)
    try:
        port = common.adspower_start(env_id, force_stop=True)
    except Exception as e:
        rec["error"] = "启动失败:" + str(e)[:140]
        log("  ✗", rec["error"])
        return rec

    cdp = None
    try:
        for _ in range(20):
            if common._port_ready(port, 2):
                break
            time.sleep(1)
        time.sleep(2)
        cdp = RawCDP()
        cdp.connect(port, "")  # 第一个 page(不挑 url)
        _navigate_and_wait(cdp, cfg["test_url"], timeout=cfg.get("nav_timeout", 30))
        raw = cdp.evaluate(_fp_eval_js(cfg["public_key"], cfg["region"]),
                           timeout=cfg.get("get_timeout", 60) + 10)
        data = {}
        if isinstance(raw, str):
            try:
                data = json.loads(raw)
            except Exception:
                data = {"ok": False, "error": "FP 返回非JSON:" + raw[:80]}
        elif isinstance(raw, dict):
            data = raw
        rec["ok"] = bool(data.get("ok"))
        rec["visitor_id"] = data.get("visitor_id")
        rec["event_id"] = data.get("event_id")
        if not rec["ok"]:
            rec["error"] = data.get("error") or "FP 未返回结果"
            log("  ✗ FP 失败:", str(rec.get("error"))[:80])
        else:
            log("  ✓ visitor_id=%s  event_id=%s" % ((rec["visitor_id"] or "?")[:12],
                                                     (rec["event_id"] or "?")[:12]))
            # 服务端 Smart Signals(需 secret key + event_id)
            if rec.get("event_id") and cfg.get("secret_key"):
                try:
                    sig = fetch_server_signals(rec["event_id"], cfg)
                    rec["signals"] = sig
                    rec["confidence"] = sig.get("confidence")
                    if not rec.get("visitor_id"):
                        rec["visitor_id"] = sig.get("visitor_id")
                    log("    Smart Signals: bot=%s tampering=%s vpn=%s proxy=%s vm=%s conf=%s" % (
                        sig.get("bot"), sig.get("tampering"), sig.get("vpn"),
                        sig.get("proxy"), sig.get("virtual_machine"), sig.get("confidence")))
                except Exception as e:
                    rec["server_error"] = str(e)[:160]
                    log("    ⚠ Server API 取信号失败:", rec["server_error"])
    except Exception as e:
        rec["error"] = str(e)[:200]
        log("  ✗ 探测异常:", rec["error"])
    finally:
        try:
            if cdp:
                cdp.close()
        except Exception:
            pass
        try:
            common.adspower_stop(env_id)   # 无论成败都回收环境,否则泄漏孤儿浏览器占 AdsPower 并发额度
        except Exception:
            pass
    return rec


# ════════════════ 状态读写 ════════════════

def load_scores(path=SCORES_FILE):
    try:
        d = json.load(open(path, encoding="utf-8"))
        if isinstance(d, dict) and isinstance(d.get("envs"), dict):
            return d
    except Exception:
        pass
    return {"envs": {}}


def _atomic_write(path, data):
    """tmp + os.replace 原子落盘(与项目其余处一致,防写一半被读到半成品)。"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = "%s.tmp.%d" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception as e:
        log("⚠ 写 %s 失败:%s" % (os.path.basename(path), str(e)[:80]))


def save_record(rec, scores=None):
    """把单环境记录并进 state/fingerprint-scores.json(同 env 覆盖最新),返回更新后的 scores。"""
    scores = scores or load_scores()
    scores.setdefault("envs", {})[rec["env_id"]] = rec
    scores["updated"] = _now()
    _atomic_write(SCORES_FILE, scores)
    return scores


# ════════════════ 配置 ════════════════

def load_cfg(args):
    """优先级:命令行 > 环境变量 > state/fp-config.json > 默认。"""
    filecfg = {}
    try:
        filecfg = json.load(open(CONFIG_FILE, encoding="utf-8"))
    except Exception:
        filecfg = {}

    def pick(cli, env, key, default=None):
        if cli not in (None, ""):
            return cli
        v = os.environ.get(env)
        if v not in (None, ""):
            return v
        if filecfg.get(key) not in (None, ""):
            return filecfg.get(key)
        return default

    region = pick(args.region, "FP_REGION", "region", "ap")
    cfg = {
        "public_key": pick(args.api_key, "FP_PUBLIC_KEY", "public_key", ""),
        "secret_key": None if args.no_server else pick(args.secret_key, "FP_SECRET_KEY", "secret_key", ""),
        "region": region,
        "test_url": pick(args.url, "FP_TEST_URL", "test_url", "https://example.com/"),
        "server_base": pick(args.server_base, "FP_SERVER_BASE", "server_base",
                            REGION_SERVER.get(region, REGION_SERVER["global"])),
        "nav_timeout": int(os.environ.get("FP_NAV_TIMEOUT", "30")),
        "get_timeout": int(os.environ.get("FP_GET_TIMEOUT", "60")),
        "server_timeout": int(os.environ.get("FP_SERVER_TIMEOUT", "25")),
    }
    return cfg


def list_envs():
    """从 AdsPower 拉环境列表(user_id)。失败返回 []。"""
    try:
        import common
        j = common.ads_get("/api/v1/user/list?page_size=100", 30, retries=2)
        lst = (j.get("data") or {}).get("list") or []
        return [str(x.get("user_id")) for x in lst if x.get("user_id")]
    except Exception as e:
        log("拉环境列表失败:", str(e)[:100])
        return []


# ════════════════ 入口 ════════════════

def main():
    ap = argparse.ArgumentParser(description="指纹自测/验收:用 Fingerprint Pro 检查 AdsPower 随机指纹是否唯一+稳定")
    ap.add_argument("envs", nargs="*", help="要测的 AdsPower 环境 id(逐个跑一次)")
    ap.add_argument("--stability", metavar="ENV", help="对该环境重开 N 次验稳定(查过度随机化)")
    ap.add_argument("-n", "--times", type=int, default=3, help="--stability 重开次数(默认3)")
    ap.add_argument("--list", action="store_true", help="从 AdsPower 拉全部环境再逐个测")
    ap.add_argument("--report", action="store_true", help="只读 state/fingerprint-scores.json 出报告(不开浏览器)")
    ap.add_argument("--api-key", help="公钥(浏览器端);也可用 FP_PUBLIC_KEY / fp-config.json")
    ap.add_argument("--secret-key", help="密钥(服务端,取 Smart Signals);也可用 FP_SECRET_KEY")
    ap.add_argument("--region", help="区域 ap/eu/us(默认 ap)")
    ap.add_argument("--url", help="跑 FP 的中立 https 落地页(默认 https://example.com/)")
    ap.add_argument("--server-base", help="Server API 域名(默认按区域)")
    ap.add_argument("--no-server", action="store_true", help="跳过 Server API(只测 visitor_id,不取 Smart Signals)")
    a = ap.parse_args()

    # 只看报告:不需要钥匙、不开浏览器
    if a.report:
        print(render_report(load_scores()))
        return

    cfg = load_cfg(a)
    if not cfg["public_key"]:
        raise SystemExit("✗ 缺公钥。用 --api-key / 设 FP_PUBLIC_KEY,或写进 %s 的 {\"public_key\":...}" % CONFIG_FILE)
    if not cfg["secret_key"] and not a.no_server:
        log("⚠ 没给 secret key → 只测 visitor_id 唯一性/稳定性,跳过 bot/tampering 等 Smart Signals。")
        log("  (要取 Smart Signals:--secret-key 或设 FP_SECRET_KEY;那是服务端密钥,务必保密)")

    scores = load_scores()

    # 模式一:稳定性(同环境重开 N 次)
    if a.stability:
        eid = a.stability
        log("稳定性测试:环境 %s 重开 %d 次…" % (eid, a.times))
        vids = []
        last = None
        for i in range(a.times):
            log("── 第 %d/%d 次 ──" % (i + 1, a.times))
            rec = probe_env(eid, cfg)
            last = rec
            if rec.get("ok") and rec.get("visitor_id"):
                vids.append(rec["visitor_id"])
        stable = (len(set(vids)) == 1) if len(vids) >= 2 else None
        if last:
            last["stable"] = stable
            last["stability_samples"] = vids
            scores = save_record(last, scores)
        if stable is True:
            log("✅ 稳定:%d 次重开都是同一个 visitor_id(%s…)" % (len(vids), (vids[0] or "")[:12]))
        elif stable is False:
            log("❌ 不稳定:重开后 visitor_id 变了 %d 种 → 过度随机化,稳定检测器会判篡改" % len(set(vids)))
            log("   修向:FRESH_FP(hybrid_run.py)对【同一账号重开】别刷新指纹,只对【新账号】随机。")
        else:
            log("⚠ 有效样本不足(<2),没法判稳定。检查代理/网络是否拦了 FP。")
        print()
        print(render_report(scores))
        return

    # 模式二:逐个环境各跑一次
    envs = list(a.envs)
    if a.list:
        envs = list_envs() or envs
    if not envs:
        raise SystemExit("✗ 没给环境 id。用法:python tools/fingerprint_check.py ENV1 ENV2 …  或加 --list")

    log("将测 %d 个环境:%s" % (len(envs), ", ".join(envs[:8]) + (" …" if len(envs) > 8 else "")))
    for eid in envs:
        rec = probe_env(eid, cfg)
        # 保留历史 stable(逐次测不覆盖之前跑过的稳定性结论)
        prev = scores.get("envs", {}).get(eid, {})
        if "stable" in prev and "stable" not in rec:
            rec["stable"] = prev["stable"]
        scores = save_record(rec, scores)

    print()
    print(render_report(scores))


if __name__ == "__main__":
    main()
