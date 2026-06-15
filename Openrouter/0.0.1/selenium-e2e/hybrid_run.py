#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 混合方案编排器（一号一IP一环境，跑完即删）：
#   每账号：建干净 AdsPower 环境(配代理) → 启动
#     → Node Playwright(hybrid-pw-stage.js) 接管: register→magicLink→取Key→绑地址
#     → Python Selenium 接管同一环境: 加卡(地址已绑,直接卡表单,一号一专属卡)
#     → 删环境
#
# 用法: python hybrid_run.py --accounts accounts.hybrid.txt --proxies proxies.local.txt --op-pw '<OP_PW>' [--limit 1]
# ═══════════════════════════════════════════════════════════════════════
import os, sys, json, time, argparse, subprocess, threading, re
import concurrent.futures

# 角色分包(commit d77aca2)后 cleanup_envs/flag_accounts/proxy_score 迁到 tools/;入口需把 tools/ 加入 sys.path,
# 否则后文 `import cleanup_envs` 等会 ModuleNotFoundError 被广义 except 静默吞掉 →
# 环境GC/账号打标/IP评分全不跑(孤儿 AdsPower 环境无限堆积、最终耗尽配额)。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))

import common
from services import adspower_env
from steps import steps_billing
from steps import steps_auth
from services import captcha
from services import cdp_fetch
from services import firstmail
from common import log, log_stage

_WRITE_LOCK = threading.Lock()   # 并发写 results.jsonl 用

# ── 批级 solve 熔断 ──────────────────────────────────────────────────────
# 本批 2captcha "解了但框仍过不去(result=hcaptcha)" 累计次数:超阈值就【本批后续号一律改 swap】(弹框直接换卡),
# 别再每张卡烧 ~120s 求解零产出(实测一批 13/13 解成功也没把框关掉时,纯属浪费算力/2captcha 费用)。
_SOLVE_FUTILE = {"n": 0}
_SOLVE_FUTILE_LOCK = threading.Lock()
_SOLVE_FUTILE_CAP = int(os.environ.get("FIXC_SOLVE_FUTILE_CAP", "3"))

ROOT = os.path.normpath(os.path.join(common.HERE, ".."))
NODE_CLI = os.path.join(ROOT, "playwright", "hybrid-pw-stage.js")

# Fix C:绑卡默认走【原生CDP Input】(脱离 chromedriver 躲 Stripe 检测,实测能绑成);FIXC=0 回退旧 Selenium add_card。
FIXC = os.environ.get("FIXC", "1") != "0"

# OpenRouter 直接封禁/拒绝该邮箱:"… is not allowed to access this application"。
# 撞这个就【登记并永久跳过】——重试也没用,只会白白烧环境/IP/试错。
# 判定统一走 common.is_banned_reason(hybrid_run/hyb_loop/cleanup_envs 三处同一口径)。
def _is_not_allowed(s):
    """判断 PW reason / Selenium auth 结果是否为"账号被 OpenRouter 拒绝"。"""
    return common.is_banned_reason(s)


def _is_browser_crash(e):
    """Selenium 报的是不是"浏览器会话崩了"(session deleted/窗口关了/内核不可达)——可就地重启救回。"""
    t = str(e).lower()
    return any(s in t for s in ("invalid session id", "session deleted", "no such window",
                                "target window already closed", "not reachable", "disconnected",
                                "session id is null", "unable to connect", "cannot connect to chrome",
                                "10053", "10054"))


FRESH_FP = os.environ.get("FRESH_FP", "1") != "0"   # 默认开:每次开浏览器前刷新指纹(分辨率固定)=每次打开新指纹

_PROGRESS_FILE = os.path.join(common.HERE, "state", "account_progress.json")
_PROGRESS_LOCK = threading.Lock()


def save_progress(email, **fields):
    """增量 checkpoint:一拿到【注册成功/api_key/绑地址/env_id】就立刻存盘 state/account_progress.json。
       关键:状态原来只在一个号【完整跑完】才写 hybrid_results.jsonl,中途被停(stop)的号进度全丢→下轮当新号
       重注册+重建key。这里一到里程碑就存,下次启动合并进 prior → 直接【登录+复用key】,不再重注册重建key。并发安全。"""
    if not email:
        return
    with _PROGRESS_LOCK:
        try:
            with open(_PROGRESS_FILE, encoding="utf-8") as _f:
                d = json.load(_f)
        except Exception:
            d = {}
        rec = d.setdefault(email, {})
        # _stage=(name, obj):逐阶段状态机,与 run.py(纯Sel)同 schema → 续跑按阶段跳过/复用。
        st = fields.pop("_stage", None)
        if st:
            rec.setdefault("stages", {})[st[0]] = st[1]
        for k, v in fields.items():
            if v not in (None, ""):
                rec[k] = v
        rec["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        # ★F9:_atomic_write_json 失败【返回 False 不抛】→ 查返回值告警(原来 try/except 抓不到,静默丢 charge checkpoint
        #   → 续跑漏判已充 → 重扣风险)。
        try:
            if not common._atomic_write_json(_PROGRESS_FILE, d):
                log("[checkpoint] ⚠⚠ save_progress 落盘失败(续跑可能漏判已充→重扣风险),请人工核对: %s" % email)
        except Exception as _e:
            try: log("[checkpoint] ⚠ save_progress 异常: %s" % str(_e)[:80])
            except Exception: pass


def _start_env_fresh(env_id, proxy, force_stop=False):
    """开浏览器前先给环境刷一套【新随机指纹】(UA/核数/内存/canvas/webgl/audio 噪声全新,【分辨率固定】不破窗口平铺)
       → 实现"每次打开都是新指纹"(不靠 AdsPower 付费开关,用 /user/update)。FRESH_FP=0 关;刷失败退回原指纹不打断。"""
    if FRESH_FP and env_id:
        try:
            adspower_env.refresh_fingerprint(env_id, proxy)
        except Exception as _e:
            log("[混合] 刷新指纹失败(忽略,用原指纹): %s" % str(_e)[:50])
    return common.adspower_start(env_id, force_stop=force_stop)


def _proxy_seg(p, seg_octets=3):
    return ".".join(str(p.get("host") or "").split(".")[:seg_octets])


def _diversify_proxies(proxies, seg_octets=None):
    """重排代理:① 随机打乱 ② 按 IP 段(默认 /24=前3段,PROXY_SEG_OCTETS 可调)轮转交错——
       让相邻(=同批并发)的代理尽量【不同 IP 段】,避开'同段多号→Stripe Radar velocity/设备关联'。
       每次跑都重排,所以每个号每次拿到的 IP 也是随机的(实现"创建浏览器时IP随机选")。"""
    import random as _r, collections as _c
    seg_octets = seg_octets or int(os.environ.get("PROXY_SEG_OCTETS", "3"))
    buckets = _c.defaultdict(list)
    for p in proxies:
        buckets[_proxy_seg(p, seg_octets)].append(p)
    for b in buckets.values():
        _r.shuffle(b)                          # 段内随机
    seglist = list(buckets.keys())
    _r.shuffle(seglist)                         # 段顺序也随机
    out = []
    while any(buckets[s] for s in seglist):     # 每轮各段取一个 → 相邻元素来自不同段
        for s in seglist:
            if buckets[s]:
                out.append(buckets[s].pop())
    return out


def read_accounts(path):
    out = []
    with open(path, "r", encoding="utf-8") as _f:
        for line in _f:
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            em, pw = line.split(":", 1)
            out.append({"email": em.strip(), "mailbox_pw": pw.strip()})
    return out


def _rescue_key(text):
    """从 Node 的 stderr/stdout 里捞已建出的 sk-or- key(stages.js 抓到 key 当场打 [pw] APIKEY_CREATED)。"""
    if not text:
        return ""
    m = re.search(r"sk-or-[A-Za-z0-9\-_]{16,}", text)
    return m.group(0) if m else ""


def run_pw_stage(ep, email, mailbox_pw, op_pw, mode="register", prior_api_key="", win_bounds="", timeout=540):
    """跑 Node Playwright 那半。mode=register|login；prior_api_key 非空→apiKey 阶段复用不另建；
    win_bounds='x,y,w,h' → PW 阶段摆窗(并发平铺)。返回 {ok,apiKey,billingStatus,reason,registered}。
    timeout 默认 540s:必须显著大于 Node 内部所有超时之和(Turnstile 120s+邮件轮询+多次导航),
    让退出/JSON 契约由 Node 主导,而非被 Python SIGKILL 抢断丢掉已建的 key。"""
    try:
        # encoding 必须显式 utf-8：Node 输出含非 GBK 字节,Windows 默认 GBK 解码会在读取线程抛
        # UnicodeDecodeError → 读不到 JSON → PW_NO_JSON 白白重试。errors=replace 兜底任何脏字节。
        r = subprocess.run(["node", "playwright/hybrid-pw-stage.js", ep, email, mailbox_pw, op_pw, mode, prior_api_key or "", win_bounds or ""],
                           cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as e:
        # 即便超时被杀,也从已捕获的输出里抢救已建出的 key,避免重试重建第二把 key、首把成孤儿
        rescued = _rescue_key(getattr(e, "stderr", "") or "") or _rescue_key(getattr(e, "stdout", "") or "")
        if rescued:
            log("   [pw] PW_TIMEOUT 但从输出抢救到已建的 key ••%s,接管续跑" % rescued[-6:])
            return {"ok": False, "reason": "PW_TIMEOUT", "apiKey": rescued}
        return {"ok": False, "reason": "PW_TIMEOUT"}
    # 日志走 stderr，打印出来便于排查
    for ln in (r.stderr or "").splitlines():
        if ln.strip():
            log("   [pw] %s" % ln.strip()[:160])
    # stdout 最后一行是 JSON 结果
    out = None
    for ln in reversed((r.stdout or "").splitlines()):
        ln = ln.strip()
        if ln.startswith("{"):
            try:
                out = json.loads(ln); break
            except Exception:
                pass
    if out is None:
        return {"ok": False, "reason": "PW_NO_JSON", "raw": (r.stdout or "")[:200]}
    return out


def switch_proxy(env_id, proxy):
    """给【已存在的环境】换代理IP:停浏览器→改环境代理→重启浏览器,返回新 debug port。
       调用方负责重新 attach_chrome + 重建 Page。环境 profile 持久,登录态/已绑地址都还在。"""
    common.adspower_stop(env_id)
    time.sleep(1.5)
    adspower_env.update_env(env_id, proxy)
    return common.adspower_start(env_id)


def _pick_live_proxy(proxies, start_idx):
    """从 start_idx 起扫一个【验通(proxy_ok)且未退役】的代理作初始代理。
       全不通才退回 proxies[start_idx](不阻塞,交给后续轮换补救)。
       —— 防新建环境用到死代理,浏览器一开页就 ERR_PROXY_CONNECTION_FAILED 整号白废
       (之前只在切IP轮换时验通,初始/新建没验,实测咬过号)。"""
    n = len(proxies)
    for k in range(n):
        cand = proxies[(start_idx + k) % n]
        if common.proxy_retired(cand):
            continue
        ok, _lat = common.proxy_ok(cand)
        if ok:
            return cand
    return proxies[start_idx % n]


def _rank_rotation_candidates(proxies, start_idx):
    """切IP 时把候选代理按 proxy_score 质量排序(高分在前):A优质/B可用 优先,待测居中,C差/烧热/退役殿后。
       原来纯顺序扫 = 每段随机撞 Radar 门;优先用历史绑成率高、hcaptcha 率低的出口能提高单段抽签命中。
       保持 start_idx 错开起点作为【同分稳定次序】(不同号错开降低撞同IP);已 tried 的过滤仍交调用方循环。"""
    n = len(proxies)
    order = [proxies[(start_idx + k) % n] for k in range(1, n + 1)]   # 原始扫描序(环绕),同分时保持它
    try:
        import proxy_score
        stats = proxy_score.load_stats()
    except Exception:
        stats = None
    if not stats:
        return order

    def _score_key(p):
        key = "%s:%s" % (p.get("host"), p.get("port"))
        try:
            sc = proxy_score.score_proxy(stats.get(key, {}) or {})
        except Exception:
            return 50.0
        if sc.get("retired"):
            return -1.0                                  # 退役殿后(循环里还会被 proxy_retired 再跳过)
        s = sc.get("score")
        return float(s) if s is not None else 50.0       # 待测=中性50,排在 A/B 之后、C(<45) 之前

    return sorted(order, key=_score_key, reverse=True)   # Python sort 稳定:同分保持 order 的错开次序


def _charge_with_gate(page, amount, cfg, manual_hcaptcha, card_id, card_charge_gate, try_batch_charge, res, email):
    """混合引擎充值容量闸(对齐 pipeline.py 充值段;F3-F6 修)。仅 real_charge 真扣时调用。
    原子:reserve(per-card 容量/同卡并发)→ 批N帽 → purchase → commit/release;finally 兜底释放未结清预留。
    card_charge_gate=False 时仅做批N帽(不做 per-card 预留);card_id 缺失(续跑边界)→ 跳过容量闸直接真扣(不误拦合法号)。
    设 res["purchase"]/["charged"]/["balance_after"]/(被拦时)["fail_stage"]/["fail_reason"]。purchase 抛错【向上抛】(调用方决定是否吞)。
    返回 'ok'(真扣已发生,结果在 res["purchase"])/ 'blocked'(被闸拦,未真扣)。"""
    _reserved = False; _resolved = False
    try:
        # ① per-card 原子预留(容量闸开 且 有 card_id 才做;无 id=续跑边界→跳过闸直接真扣)
        if card_charge_gate and card_id:
            try:
                _ok, _reason = common.reserve_charge(card_id, amount)
            except Exception:
                _ok, _reason = True, ""   # 预留异常不拦正常充值(安全:退回旧行为)
            if _ok:
                _reserved = True
            else:
                _rmap = {"capacity": "卡容量用尽", "concurrency": "同卡并发已满", "no-card": "无绑卡", "no-pool": "卡池读失败", "write-fail": "卡池落盘失败(安全起见不真扣)", "lock-degraded": "卡池锁退化(安全起见不真扣)"}
                res["purchase"] = "insufficient-funds"; res["charged"] = 0
                res["fail_stage"] = "charge"; res["fail_reason"] = "钱不够:" + _rmap.get(_reason, str(_reason))
                _resolved = True
                log("[混合] %s 充值预留失败(%s)→ 钱不够,不真扣" % (email, _reason))
                return "blocked"
        elif card_charge_gate:
            log("[混合] %s 容量闸开但无 card_id(续跑边界)→ 跳过容量闸直接真扣" % email)
        # ② 整批最多真充 N 次【测试帽】(reserve 成功后才占名额)
        if try_batch_charge and not try_batch_charge():
            if _reserved:
                try: common.release_charge(card_id)
                except Exception: pass
                _resolved = True
            res["purchase"] = "charge-test-capped"; res["charged"] = 0
            res["fail_stage"] = "charge"; res["fail_reason"] = "整批已达最多真充次数(测试帽)"
            log("[混合] %s 整批真充已达上限(测试帽)→ 不真扣" % email)
            return "blocked"
        # ③ 真实充值(steps_billing.purchase 真实时序一行不改)
        pr = steps_billing.purchase(page, amount, cfg, manual_hcaptcha=manual_hcaptcha)
        res["purchase"] = pr.get("result")
        res["charged"] = amount if pr.get("result") == "success" else 0
        res["balance_after"] = pr.get("balance_after")
        if pr.get("result") == "success":
            if _reserved:
                try: common.commit_charge(card_id, amount)
                except Exception: pass
            _resolved = True
        else:
            if _reserved:
                try: common.release_charge(card_id)
                except Exception: pass
            _resolved = True
        return "ok"
    finally:
        # ★F2/F6:任何未预期异常(purchase 抛错等)使预留没走到 commit/release → 兜底释放,绝不泄漏在飞到 10min reap。
        if _reserved and not _resolved:
            try: common.release_charge(card_id)
            except Exception: pass


def run_account(acct, proxies, start_idx, group_id, op_pw, cfg, delete_env=True,
                prior=None, slot=0, slots_total=1, max_rotations=6, isolate=False, manual_card=False,
                keep_failed_env=False, do_purchase=False, amount=5, do_changepw=False, real_charge=False,
                card_charge_gate=False, try_batch_charge=None):
    email, mailbox_pw = acct["email"], acct["mailbox_pw"]
    # password=当前 OpenRouter 登录密码:设了统一密码就＝统一密码,否则＝原邮箱密码(与纯 Selenium / Playwright 对齐)。
    res = {"email": email, "ok": False, "steps": {}, "timings": {}, "password": op_pw}
    # 隔离模式:每次 Selenium 加卡都是【全新环境】一次尝试,按尝试次数封顶(替代 reopen_count)
    res["attempt_count"] = (prior or {}).get("attempt_count", 0) + 1
    t_start = time.perf_counter()                # per-stage 计时:量出 PW/加卡/总 各几秒(配合日志时间戳)
    env_id = None
    driver = None
    patcher = None
    hc_patcher = None     # 加卡阶段的 hcaptcha CDP patcher(拦 hcaptcha api.js + 跨 OOPIF 注 token)
    success = False
    prior_key = (prior or {}).get("api_key")     # 上次已拿到的 key → 断点续跑只补加卡
    prior_env = (prior or {}).get("env_id")      # 上次没删的环境 → 重开省掉重建+重登
    rect = common.grid_rect(slot, slots_total)   # 并发平铺：本号窗口在网格里的位置/大小
    winarg = "%d,%d,%d,%d" % rect                # 传给 Node Playwright 那半摆窗用
    proxy = proxies[start_idx % len(proxies)]    # 起始代理；卡顿时按 start_idx+rot 轮换下一个

    def _ensure_login(page, port):
        """同环境已登录就跳过登录(省时间);掉了才重登(重登需 Turnstile hook)。返回 'ok'/'fail:...'。"""
        if steps_auth.detect_session(page):
            return "ok"
        captcha.inject_hooks(page.d)
        pat = cdp_fetch.TurnstileApiPatcher(port, captcha.WRAPPER_TURNSTILE, log=log)
        pat.start()
        try:
            return steps_auth.login(page, email, op_pw, mailbox_pw, cfg)
        finally:
            try:
                pat.stop()
            except Exception:
                pass

    def _fresh_selenium_env():
        """隔离架构:为加卡新建一个【全新 AdsPower 环境】(干净指纹,不带注册阶段的 Radar 历史)→ 登录。
           返回 (env_id, serial, proxy, port, driver, page, auth);auth=='ok' 才继续加卡。
           —— 实测:复用注册环境会让加卡阶段每张卡都弹账号级 hCaptcha;全新指纹环境绕开它。"""
        nonlocal env_id   # 关键:env_B 创建成功后立刻写回外层 env_id,使后续 start/login 抛错时 finally 能清掉它
        pxy = _pick_live_proxy(proxies, start_idx)
        eid, serial = adspower_env.create_env_full("hyb-" + email.split("@")[0][:16], pxy, group_id)
        env_id = eid            # 此刻起 finally 的 `if env_id:` 指向 env_B(原 env_A 已在调用前删,跳过重删无害)
        res["env_id"] = eid     # 落盘也记 env_B(真正在用的环境),不再停留在已删的 env_A
        port = common.adspower_start(eid)
        drv = common.attach_chrome(port, common.resolve_chromedriver(port))
        common.place_window(drv, rect)
        captcha.inject_hooks(drv)
        pat = cdp_fetch.TurnstileApiPatcher(port, captcha.WRAPPER_TURNSTILE, log=log)
        pat.start()
        try:
            pg = common.Page(drv)
            pg.goto(common.KEYS_URL, wait=2)
            a = steps_auth.login(pg, email, op_pw, mailbox_pw, cfg)
        finally:
            try:
                pat.stop()
            except Exception:
                pass
        return eid, serial, pxy, port, drv, pg, a

    try:
        log_stage(slot, email, "env")
        res["proxy"] = "%s:%s" % (proxy.get("host"), proxy.get("port"))

        res["reopen_count"] = (prior or {}).get("reopen_count", 0)   # 重开同环境累计次数(给永久放弃判定用)

        # ① 续跑快路径：上次留了环境 + 有 key → 直接重开【同一环境】(已登录、地址已绑),跳过 PW/登录
        #    隔离模式【不走这条】：每次加卡都要全新环境,绝不重开旧环境(旧env留给GC回收)
        if prior_env and prior_key and not isolate:
            try:
                port = common.adspower_start(prior_env)
                env_id = prior_env
                res["env_id"] = env_id
                res["env_serial"] = (prior or {}).get("env_serial")
                res["reopen_count"] = (prior or {}).get("reopen_count", 0) + 1
                res["api_key"] = prior_key
                res["registered"] = True
                res["billing_status"] = (prior or {}).get("billing_status")
                res["steps"]["resume"] = "reopen-env"
                log("[混合] %s 重开旧环境 %s(已登录免重登)→直接加卡" % (email, prior_env))
                driver = common.attach_chrome(port, common.resolve_chromedriver(port))
                common.place_window(driver, rect)
                page = common.Page(driver)
                log_stage(slot, email, "auth")
                auth = _ensure_login(page, port)
                res["steps"]["auth"] = auth
                if auth != "ok":
                    if _is_not_allowed(auth):
                        res["not_allowed"] = True
                        res["steps"]["banned"] = "not-allowed"
                        log("[混合] %s 被 OpenRouter 拒绝(not allowed)→登记永久跳过" % email)
                    else:
                        log("[混合] 重开后登录失败: %s" % auth)
                    return res
            except Exception as e:
                # 重开都失败的旧环境基本是坏环境,没有复用价值 → 停+删,别留成僵尸(否则每次重开失败必泄漏一个)
                log("[混合] 重开旧环境 %s 失败(%s)→删掉它,回退新建" % (prior_env, str(e)[:80]))
                try:
                    if driver:
                        driver.quit()
                except Exception:
                    pass
                driver = None
                try:
                    common.adspower_stop(prior_env)
                    time.sleep(1.0)
                    adspower_env.delete_env(prior_env)
                except Exception:
                    pass
                env_id = None
                res.pop("env_id", None)
                res.pop("env_serial", None)

        # ② 新建环境路径(没有可重开的环境)
        if env_id is None:
            res["reopen_count"] = 0   # 新建环境=重新计数
            proxy = _pick_live_proxy(proxies, start_idx)   # 新建前:初始代理也验通,别用死代理一开页就 ERR_PROXY
            res["proxy"] = "%s:%s" % (proxy.get("host"), proxy.get("port"))
            env_id, serial = adspower_env.create_env_full("hyb-" + email.split("@")[0][:16], proxy, group_id)
            res["env_id"] = env_id
            res["serial"] = serial
            res["env_serial"] = serial

            if prior_key:
                # 已注册+有 key → 新建环境,Selenium 登录→加卡(不走 PW)
                res["api_key"] = prior_key
                res["registered"] = True
                res["billing_status"] = (prior or {}).get("billing_status")
                res["steps"]["resume"] = "card-only"
                log("[混合] %s 已注册有key(续跑)→新建环境,Selenium 登录+加卡" % email)
                port = _start_env_fresh(env_id, proxy)
                driver = common.attach_chrome(port, common.resolve_chromedriver(port))
                common.place_window(driver, rect)
                captcha.inject_hooks(driver)
                patcher = cdp_fetch.TurnstileApiPatcher(port, captcha.WRAPPER_TURNSTILE, log=log)
                patcher.start()
                page = common.Page(driver)
                page.goto(common.KEYS_URL, wait=2)
                log_stage(slot, email, "auth")
                auth = steps_auth.login(page, email, op_pw, mailbox_pw, cfg)
                res["steps"]["auth"] = auth
                try:
                    patcher.stop()
                except Exception:
                    pass
                patcher = None
                if auth != "ok":
                    if _is_not_allowed(auth):
                        res["not_allowed"] = True
                        res["steps"]["banned"] = "not-allowed"
                        log("[混合] %s 被 OpenRouter 拒绝(not allowed)→登记永久跳过" % email)
                    else:
                        log("[混合] 续跑登录失败: %s" % auth)
                    return res
            else:
                # ── 全新号 → Playwright 注册/取Key/绑地址 → 关浏览器 → Selenium 重开同环境 ──
                base_mode = "login" if (prior and (prior.get("registered") or prior.get("billing_status") or prior.get("api_key"))) else "register"
                if prior and prior.get("api_key"):
                    res["api_key"] = prior.get("api_key")
                port1 = common.adspower_start(env_id)
                ep = "http://127.0.0.1:%s" % port1
                # 醒目横幅:这一段是 Playwright(Node)引擎,日志带 [pw] 前缀
                _why = ("本地无注册记录→先试【注册】(Node 若识别账号已存在会自动转登录,所以你会看到'先注册后登录')"
                        if base_mode == "register" else "本地已有注册/key记录→直接【登录】")
                log("┏━━━━━ 引擎① 【Playwright / Node】 模式=%s ━━━━━ %s" % (base_mode.upper(), email))
                log("┃  %s  (此段所有日志带 [pw] 前缀)" % _why)
                log_stage(slot, email, "auth")
                pw = {}
                for tryi in range(3):
                    have_key = res.get("api_key") or ""
                    cur_mode = "login" if have_key else base_mode
                    pw = run_pw_stage(ep, email, mailbox_pw, op_pw, mode=cur_mode, prior_api_key=have_key, win_bounds=winarg)
                    if pw.get("apiKey"):
                        res["api_key"] = pw.get("apiKey")
                    if pw.get("registered"):
                        res["registered"] = True
                    if res.get("api_key") or res.get("registered"):   # 一拿到 key/注册成功就【立刻 checkpoint】,中途被停也不丢→下次直接登录复用key
                        save_progress(email, api_key=res.get("api_key"), registered=res.get("registered"),
                                      env_id=env_id, billing_status=pw.get("billingStatus"))
                        # 逐阶段状态机(与纯Sel同 schema,供续跑跳过 + web 阶段统计)
                        _now = time.strftime("%Y-%m-%d %H:%M:%S")
                        if res.get("registered"):
                            save_progress(email, _stage=("register", {"status": "ok", "at": _now}))
                        if res.get("api_key"):
                            save_progress(email, _stage=("key", {"status": "ok", "at": _now, "api_key": res.get("api_key")}))
                        if pw.get("billingStatus") in ("address-bound", "card-bound", "success"):
                            save_progress(email, _stage=("address", {"status": "ok", "at": _now}))
                    if pw.get("ok"):
                        break
                    log("[混合] Playwright 第 %d/3 次未成(%s, key=%s 地址=%s)→重试" % (
                        tryi + 1, pw.get("reason"), "有" if pw.get("apiKey") else "无", pw.get("billingStatus")))
                    # 基础设施失败(CDP连不上/没产出JSON)= 环境/内核没起来 → 强制重启浏览器换新端口再试,
                    # 别对坏环境白白重试 3 次(每次 connectOverCDP 白等 30s)。已拿到 key 的不重启(避免打断续跑)。
                    # PW_TIMEOUT 也并入(BUG-010):超时多半是浏览器/CDP 挂了,不 force_stop 就会对着同一个
                    # 半挂浏览器再超时一次,且那个浏览器在重试窗口内成孤儿。force_stop=True 会先停旧浏览器再起新端口。
                    if pw.get("reason") in ("CDP_CONNECT_FAILED", "PW_NO_JSON", "PW_TIMEOUT") and not res.get("api_key") and tryi < 2:
                        try:
                            port1 = common.adspower_start(env_id, force_stop=True)
                            ep = "http://127.0.0.1:%s" % port1
                            log("[混合] PW 基础设施失败(%s) → 强制重启环境浏览器(新端口 %s)再试" % (pw.get("reason"), port1))
                        except Exception as _e:
                            log("[混合] 强制重启环境失败: %s" % str(_e)[:60])
                    time.sleep(4)
                res["steps"]["pw"] = pw.get("ok")
                res["billing_status"] = pw.get("billingStatus")
                log("[混合] 关闭 Playwright 浏览器…")
                common.adspower_stop(env_id)
                time.sleep(3)
                if not res.get("api_key"):
                    res["steps"]["pw_reason"] = pw.get("reason")
                    if _is_not_allowed(pw.get("reason")):
                        res["not_allowed"] = True
                        res["steps"]["banned"] = "not-allowed"
                        log("[混合] %s 被 OpenRouter 拒绝(not allowed)→登记永久跳过" % email)
                    else:
                        log("[混合] Playwright 连 key 都没拿到(%s)，放弃" % pw.get("reason"))
                    return res
                if pw.get("ok"):
                    log("[混合] Playwright OK: key=%s 地址=%s" % ((pw.get("apiKey") or "")[:16], pw.get("billingStatus")))
                else:
                    log("[混合] PW 绑地址未成(%s)，但已取到 key → Selenium 兜底填地址+加卡" % pw.get("reason"))
                if isolate:
                    # 隔离架构:PW 用完即删 env_A,加卡换【全新 env_B】(干净指纹,绕开账号级 hCaptcha)
                    log("[混合] %s → 隔离:删 PW 环境 %s,新建全新环境登录+加卡…" % (email, env_id))
                    try:
                        adspower_env.delete_env(env_id)
                    except Exception as _e:
                        log("[混合] 删 PW 环境失败(忽略): %s" % str(_e)[:60])
                    env_id, serial, proxy, port2, driver, page, auth = _fresh_selenium_env()
                    res["env_id"] = env_id
                    res["serial"] = serial
                    res["env_serial"] = serial
                    res["proxy"] = "%s:%s" % (proxy.get("host"), proxy.get("port"))
                    res["steps"]["auth"] = auth
                    res["steps"]["isolate"] = "fresh-env"
                    if auth != "ok":
                        if _is_not_allowed(auth):
                            res["not_allowed"] = True
                            res["steps"]["banned"] = "not-allowed"
                            log("[混合] %s 被 OpenRouter 拒绝(not allowed)→登记永久跳过" % email)
                        else:
                            log("[混合] 隔离·全新环境登录失败: %s" % auth)
                        return res
                else:
                    log("[混合] %s → 重新打开同一 AdsPower 环境, Selenium 加卡…" % email)
                    port2 = _start_env_fresh(env_id, proxy)
                    driver = common.attach_chrome(port2, common.resolve_chromedriver(port2))
                    common.place_window(driver, rect)
                    page = common.Page(driver)

        # ③ 加卡：卡顿(Radar Saving / 卡表单超时)就【对同环境切代理IP、原会话重试】,不重建不重登。
        #    只有真正绑上(card-bound)才算完成→删环境;否则保留环境留给续跑重开。
        log("┗━━━━━ 引擎② 【Selenium + Fix C 原生CDP】 加卡阶段 ━━━━━ %s" % email)
        log("┃  Playwright 已退场;此段所有日志带 [sel] 前缀,填卡走原生CDP(脱chromedriver)")
        ROTATE = {"server-error", "unknown"}
        SE_GIVEUP = 3   # 连续这么多次 server-error → 判定换IP无效(疑卡velocity非IP),早停别白切
        res["timings"]["pre_card"] = round(time.perf_counter() - t_start, 1)   # 到加卡前(建环境+PW/登录)耗时
        t_card = time.perf_counter()
        # ★对齐 pipeline.py:186-190:已绑卡(prior stages.card=ok)→ 绝不 load_card 重绑
        #   (防 --no-resume 对已绑号重绑新卡=消耗卡池/占BIN/触发重复扣款)。充值/改密各走防重 gate 后即返回。
        _card_done = (((prior or {}).get("stages") or {}).get("card") or {}).get("status") == "ok"
        if _card_done:
            res["steps"]["card"] = "card-bound"; res["card_last4"] = (prior or {}).get("card_last4")
            res["ok"] = True; success = True; res["card_skipped"] = True
            log("[混合] %s 已绑卡(prior stages.card=ok)→ 跳过加卡(防重绑/重扣)" % email)
            _charged_before = ((((prior or {}).get("stages") or {}).get("charge") or {}).get("status") == "ok") or ((prior or {}).get("purchase") == "success")
            if do_purchase and not _charged_before and not real_charge:
                # ★真实充值开关【关】= dry-run:走到充值步但【不真点 Purchase】(镜像 pipeline.py:323)。不设 res["purchase"]
                #   → 与 card-bound 同口径成功(下方 finally ok 回算仅 real_charge 时才要求 purchase==success)。修#2:
                #   原来混合/split 选了充值就【无视 realCharge 真扣】→ realCharge=关 的零成本 dry-run 承诺对混合半失效。
                res["charge_dryrun"] = True
                log("[混合] %s 充值 dry-run(未开真实充值):走到充值步不真点 Purchase、不扣款" % email)
            elif do_purchase and not _charged_before:
                log_stage(slot, email, "charge")
                # ★F3:续跑恢复 card_id(prior 卡阶段持久化)→ 容量闸能定位卡;缺失则闸退化为直接真扣(不误拦)。
                _cid1 = (((prior or {}).get("stages") or {}).get("card") or {}).get("card_id") or res.get("card_id")
                if _cid1: res["card_id"] = _cid1
                try:
                    _charge_with_gate(page, amount, cfg, False, _cid1, card_charge_gate, try_batch_charge, res, email)
                    if res.get("purchase") == "success":
                        save_progress(email, _stage=("charge", {"status": "ok", "at": time.strftime("%Y-%m-%d %H:%M:%S"), "amount": amount}))
                except Exception as _pe:
                    res["purchase"] = "error"; log("[混合] %s 补充值异常: %s" % (email, str(_pe)[:80]))
            elif do_purchase:
                res["purchase"] = "success"; res["charged"] = 0; res["skipped_charge"] = True
            _cpw_prior = ((((prior or {}).get("stages") or {}).get("changepw") or {}).get("status") == "ok")
            # ★M1:CHANGEPW_REQUIRE_PURCHASE=on → 只在充值【确认成功】(或续跑已充 skipped_charge)才改邮箱密码;否则跳过保号
            #   (拒付/未充的号留邮箱原密码,续跑仍能取 OTP)。镜像 pipeline.py:326;默认关 → 逐字节不变。
            _cpw_req = (os.environ.get("CHANGEPW_REQUIRE_PURCHASE", "") or "").strip().lower() in ("1", "true", "on", "yes")
            _cpw_block = do_purchase and _cpw_req and not ((res.get("purchase") == "success") or res.get("skipped_charge"))
            if do_changepw and op_pw and not _cpw_prior and _cpw_block:
                res["skipped_changepw"] = True
                res["skipped_changepw_reason"] = "purchase-" + str(res.get("purchase") or "none")
                log("[混合] %s 充值未确认成功(%s)+CHANGEPW_REQUIRE_PURCHASE=on → 跳过改密保号(可续跑取OTP)" % (email, res.get("purchase")))
            elif do_changepw and op_pw and not _cpw_prior:
                log_stage(slot, email, "changepw")
                try:
                    cp_ok = firstmail.change_mailbox_password(email, mailbox_pw, op_pw, cfg.get("mail_key"), cfg.get("mail_base") or firstmail.DEFAULT_BASE)
                    res["steps"]["changepw"] = bool(cp_ok)
                    if cp_ok:
                        save_progress(email, _stage=("changepw", {"status": "ok", "at": time.strftime("%Y-%m-%d %H:%M:%S")}))
                except Exception as _ce:
                    res["steps"]["changepw"] = False
            elif do_changepw and op_pw:
                res["steps"]["changepw"] = True
            return res
        card = common.load_card(email)
        addr = common.rand_address()
        max_rot = max(0, min(max_rotations, len(proxies) - 1))
        rot = 0
        card_swaps = 0
        MAX_CARD_SWAPS = int(os.environ.get("MAX_CARD_SWAPS", "2"))   # declined(卡级)换几张不同卡
        # hcaptcha 是【账号/会话/IP级】风控——换任何卡都照弹,多换纯属浪费(实测一轮白换7-15次)。
        # 只象征性换 1 张(万一 Radar 把卡也算进风险)就【升级切IP】,大幅减少重复试错。
        MAX_HCAPTCHA_CARD_SWAPS = int(os.environ.get("MAX_HCAPTCHA_CARD_SWAPS", "1"))
        tried_cards = {card.get("id") or card.get("number")}
        tried_bins = set()     # 502(unable-to-authenticate)过的卡段 BIN —— 换卡时强制跳过,换【新卡段】重绑(用户规则 2026-06-11)
        seg_swaps = 0
        MAX_SEG_SWAPS = 3      # 502 后最多换几个【不同卡段】重绑(当前可用段:436120/400242/400416)
        consec_se = 0
        crash_restarts = 0
        MAX_CRASH_RESTARTS = 2
        tried = {"%s:%s" % (proxy.get("host"), proxy.get("port"))}   # 已试过的代理(含起始IP),切IP时跳过,别白切回老IP/坏IP
        cur_proxy = proxy   # 当前正在用的代理(切IP后更新),给 per-proxy 战绩记账用

        def _start_hc_patcher(force=False):
            """加卡阶段起带 hcaptcha 规则的 CDP patcher:拦 hcaptcha api.js 把 HC 包装器注进 Stripe 跨域 OOPIF
               (抓 Stripe 真回调/sitekey),并提供跨 OOPIF 的 eval(读 sitekey/注 token 调回调)。
               Stripe 隐形 hCaptcha 能被 2Captcha 关掉,全靠它能进 OOPIF(Selenium 进不去)。
               但它【拦改 hcaptcha api.js + hook render + 往每个 OOPIF 注包装器】=篡改验证环境,hCaptcha 企业版
               可能检测到 → 压低信任分 → Stripe 502。人工模式(HCAP_2CAPTCHA=0)解的是原版验证框、根本不需要它,
               故 HC_PATCHER=0 时不启,让验证环境保持 100% 未篡改(验证'注入码触发风控'假设/降 502)。
               ★force=True(本号选了自动解hcaptcha,_solve_hcap):即便 HC_PATCHER=0 也【必须】起 patcher——
               2Captcha 求解全靠它进 Stripe OOPIF 注 token,没 patcher 求解白走(拿不到回调/sitekey)。"""
            import os as _os
            if _os.environ.get("HC_PATCHER", "1") == "0" and not force:
                log("[混合] HC_PATCHER=0 → 加卡阶段【不启】hCaptcha CDP patcher(人工模式不需要;避免篡改验证环境触发风控)")
                return None
            if _os.environ.get("HC_PATCHER", "1") == "0" and force:
                log("[混合] HC_PATCHER=0 但本号选了自动解hcaptcha(_solve_hcap)→ 仍【强制起】patcher(求解必须靠它进 Stripe OOPIF,否则白走)")
            try:
                dbg = (driver.capabilities.get("goog:chromeOptions") or {}).get("debuggerAddress") or ""
                prt = dbg.rsplit(":", 1)[-1]
                if not prt:
                    return None
                pat = cdp_fetch.TurnstileApiPatcher(
                    prt, captcha.WRAPPER_TURNSTILE, log=log,
                    extra_rules=[(("hcaptcha", "api.js"), captcha.WRAPPER_HCAPTCHA)],
                    init_scripts=[captcha.WRAPPER_HCAPTCHA])   # 把 HC hook 注进每个 OOPIF(含 Stripe,等价 addInitScript)
                pat.start()
                return pat
            except Exception as _e:
                log("[混合] 加卡 hcaptcha patcher 起失败(忽略): %s" % str(_e)[:60])
                return None

        # 图片hcaptcha:每号一次性决定 解/换卡(FIXC_SOLVE_HCAPTCHA= on/off/random,默认random)。
        import random as _rnd_hc
        _hm = (os.environ.get("FIXC_SOLVE_HCAPTCHA") or "random").strip().lower()
        _solve_hcap = (_hm in ("1", "on", "true", "yes", "solve")) or (
            _hm not in ("0", "off", "false", "no", "swap") and _rnd_hc.random() < 0.5)
        # 批级熔断:本批 solve 已多次"解了框仍过不去"→ 本号强制改 swap(弹框直接换卡),不再烧 ~120s 求解零产出。
        if _solve_hcap:
            with _SOLVE_FUTILE_LOCK:
                _futile_n = _SOLVE_FUTILE["n"]
            if _futile_n >= _SOLVE_FUTILE_CAP:
                _solve_hcap = False
                log("[混合] 本批 solve 已累计 %d 次'解了框仍在'零产出(≥%d)→ 熔断,本号改 swap(弹框直接换卡,省2captcha)"
                    % (_futile_n, _SOLVE_FUTILE_CAP))
        res["hcap_mode"] = "solve" if _solve_hcap else "swap"
        # FIXC 默认不启 hcaptcha patcher(怕污染会话);但【本号选了求解】就启它(Selenium 侧实测启了也不 502、能解 2/2)。
        # ★求解模式(_solve_hcap)传 force=True:即便 HC_PATCHER=0 也强制起,保证 2Captcha 有 patcher 进 OOPIF 注 token。
        hc_patcher = _start_hc_patcher(force=_solve_hcap) if (_solve_hcap or not FIXC) else None
        CARD_DEADLINE = int(os.environ.get("FIXC_CARD_DEADLINE", "480"))   # 单号加卡总耗时硬闸(秒),0=不限
        log_stage(slot, email, "card")
        while True:
            # 止损硬闸:加卡阶段总耗时超阈值就放弃,别像之前 hcaptcha 空耗 13-16min 死占并发槽(保留环境进冷却,换全新环境/IP再试)
            if CARD_DEADLINE > 0 and (time.perf_counter() - t_card) > CARD_DEADLINE:
                res["steps"]["giveup"] = "card-deadline"
                log("[混合] %s 加卡阶段超 %ds 止损硬闸 → 放弃(保留环境进冷却,稍后换全新环境/IP再试)" % (email, CARD_DEADLINE))
                break
            # 首次 Save 等 60s;切过IP后只等 45s(换了新IP还不放行基本就是不行了,早返回省时间)
            card_box = {"card": card}   # add_card 把【实际填的卡】(人工可能改过)回写进来,供本地记账用对卡
            try:
                r = steps_billing.add_card(page, card, addr, cfg, manual_hcaptcha=False,
                                           save_timeout=(60 if rot == 0 else 45), patcher=hc_patcher,
                                           proxy=cur_proxy,   # 让 2Captcha 走账号同代理解,token IP=会话IP 防502
                                           manual_card=manual_card,   # 页面内卡片面板:点卡改用(--manual-card)
                                           card_ref=card_box,
                                           fill_mode=("cdp" if FIXC else "selenium"),   # 默认原生CDP绑卡(FIXC=0回退)
                                           solve_hcap=_solve_hcap)   # 图片hcaptcha:本号选解就当场2captcha解,否则换卡
            except Exception as e:
                # 双保险:浏览器中途崩了(session deleted)→【原环境就地重启】接着加卡,而不是整号放弃
                if _is_browser_crash(e) and crash_restarts < MAX_CRASH_RESTARTS:
                    crash_restarts += 1
                    res.setdefault("crash_restarts", 0)
                    res["crash_restarts"] = crash_restarts
                    log("[混合] %s 浏览器崩了(%s)→原环境就地重启(第%d/%d次)接着加卡" % (
                        email, str(e)[:50], crash_restarts, MAX_CRASH_RESTARTS))
                    try:
                        driver.quit()
                    except Exception:
                        pass
                    driver = None
                    try:
                        port = _start_env_fresh(env_id, cur_proxy, force_stop=True)   # 崩了要确保停干净再起+刷新指纹
                        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
                        common.place_window(driver, rect)
                        page = common.Page(driver)
                        auth = _ensure_login(page, port)
                        if auth != "ok":
                            log("[混合] 就地重启后登录没保持(%s)→停" % auth)
                            break
                        try:                              # 端口变了 → 重建 hcaptcha patcher
                            if hc_patcher:
                                hc_patcher.stop()
                        except Exception:
                            pass
                        # 求解模式传 force=_solve_hcap:HC_PATCHER=0 也要为求解强制重建(与初始一致)
                        hc_patcher = _start_hc_patcher(force=_solve_hcap) if (_solve_hcap or not FIXC) else None
                    except Exception as e2:
                        log("[混合] 就地重启失败(%s)→停,保留环境" % str(e2)[:60])
                        break
                    continue   # 重启好了,重试加卡
                raise   # 非崩溃 / 重启够多次 → 抛给外层(保留环境进冷却)
            card = card_box.get("card") or card   # ★人工改卡后,实际填的卡回写给本地;mark_card_result/冷却/换段都用它
            result = r.get("result")
            res["steps"]["card"] = result
            res["card_last4"] = card.get("last4")
            res["card_id"] = card.get("id") or card.get("number")
            res["card_hcaptcha"] = bool(r.get("hcaptcha"))
            common.mark_card_result(card, result)
            common.mark_proxy_result(cur_proxy, result)   # per-proxy 战绩:这个IP上加卡啥结果(给退役/优选用)
            consec_se = consec_se + 1 if result == "server-error" else 0

            if result == "card-bound":
                res["ok"] = True
                success = True
                # 绑成 checkpoint(卡+地址)→ 续跑可判已绑、web 阶段统计可见。
                _now = time.strftime("%Y-%m-%d %H:%M:%S")
                save_progress(email, _stage=("card", {"status": "ok", "at": _now, "card_last4": card.get("last4"), "card_id": card.get("id"), "result": "card-bound"}))  # ★F3:存 card_id(仅id,绝不存PAN)→ 续跑充值容量闸能定位卡
                save_progress(email, _stage=("address", {"status": "ok", "at": _now}))
                # 充值($5):仅 --do-purchase 显式开启才【真扣费】(默认关,防误扣);卡刚绑成、page.d 活着、环境未删,直接复用。
                _charged_before = ((((prior or {}).get("stages") or {}).get("charge") or {}).get("status") == "ok") or ((prior or {}).get("purchase") == "success")   # 双信号:checkpoint 或 上次 results 充值成功 → 防重复扣款
                if do_purchase and _charged_before:
                    # ★止血#2:已充值(prior stages.charge=ok)→ 跳过,绝不重复扣款。
                    res["purchase"] = "success"
                    res["charged"] = 0
                    res["skipped_charge"] = True
                    log("[混合] %s 已充值过,跳过(防重复扣款)" % email)
                elif do_purchase and not real_charge:
                    # ★真实充值开关【关】= dry-run:绑成后走到充值步【不真点 Purchase、不扣款】(镜像 pipeline.py:323;
                    #   修#2:对齐纯Sel,realCharge=关 时混合也只 dry-run,split 整批零成本测全流程)。不设 res["purchase"]=card-bound 成功。
                    res["charge_dryrun"] = True
                    log("[混合] %s 充值 dry-run(未开真实充值):走到充值步不真点 Purchase、不扣款" % email)
                elif do_purchase:
                    log_stage(slot, email, "charge")
                    try:
                        # ★F3-F6:经容量闸真扣(res["card_id"] 刚绑成已设)。原来混合直接 purchase 无 per-card 容量/同卡并发/批N帽。
                        _charge_with_gate(page, amount, cfg, False, res.get("card_id"), card_charge_gate, try_batch_charge, res, email)
                        if res.get("purchase") == "success":
                            save_progress(email, _stage=("charge", {"status": "ok", "at": time.strftime("%Y-%m-%d %H:%M:%S"), "amount": amount}))
                        log("[混合] %s 充值 $%s 结果=%s" % (email, amount, res.get("purchase")))
                    except Exception as e:
                        res["purchase"] = "error"
                        log("[混合] %s 充值异常(不影响绑卡成功): %s" % (email, str(e)[:80]))
                break

            if result == "card-502":
                # 用户规则(2026-06-11):Error 502 "unable to authenticate this payment method" =
                # 这张卡在该会话上【后端拒绝、不能正常绑】→ 换【新卡段(不同 BIN)】的卡重填、人工再点一次绑。
                # 换段零成本;CARD_PREFER_BIN 也会被越过(exclude_bins 强制跳过 502 过的段)。
                cur_bin = (card.get("number") or "")[:6]
                tried_bins.add(cur_bin)
                tried_cards.add(card.get("id") or card.get("number"))
                if seg_swaps < MAX_SEG_SWAPS:
                    try:
                        nc = common.load_card(email, exclude=tried_cards,
                                              exclude_bins=tried_bins, count_bin=False)
                    except Exception:
                        nc = None
                    if nc and (nc.get("number") or "")[:6] not in tried_bins:
                        card = nc
                        seg_swaps += 1
                        log("[混合] %s 502不能验证此卡(段%s)→换【新卡段】••%s(段%s)重填,弹框时请【再点一次 I am human】(第%d次)" % (
                            email, cur_bin, str(nc.get("last4") or "")[-4:],
                            (nc.get("number") or "")[:6], seg_swaps))
                        continue
                # 所有可用卡段都 502 过了 → 这会话绑不上,终止(保留环境留续跑/冷却,换全新环境可能就过)
                res["steps"]["giveup"] = "all-segments-502"
                log("[混合] %s 所有可用卡段都 502 不能验证 → 停(保留环境,稍后/换全新环境再试)" % email)
                break

            if result in ("declined", "hcaptcha"):
                # declined=卡被拒(坏卡已禁用);hcaptcha=校验框过不去(Radar 判这张卡/这次提交风险高)。
                # 两者都【换一张不同的卡(load_card 优选不同BIN)同会话再试】—— 换卡零成本,绑别的卡可能就过了,
                # 比来回切IP/换指纹环境省太多(用户提的思路)。换够 MAX_CARD_SWAPS 张还不行才终止。
                # 批级熔断计数:本号在 solve 模式下仍 hcaptcha=这次 2captcha 求解没把框关掉 → 累加,够阈值后本批弃 solve。
                if result == "hcaptcha" and _solve_hcap:
                    with _SOLVE_FUTILE_LOCK:
                        _SOLVE_FUTILE["n"] += 1
                tried_cards.add(card.get("id") or card.get("number"))
                # hcaptcha=IP级风控→只换 MAX_HCAPTCHA_CARD_SWAPS(默认1)张就切IP;declined=卡级→换 MAX_CARD_SWAPS 张
                swap_limit = MAX_CARD_SWAPS if result == "declined" else MAX_HCAPTCHA_CARD_SWAPS
                if card_swaps < swap_limit:
                    try:
                        # count_bin=False:换卡不是新号,别重复占 BIN 当日额度、别覆盖原分配
                        nc = common.load_card(email, exclude=tried_cards, count_bin=False)
                    except Exception:
                        nc = None
                    if nc and (nc.get("id") or nc.get("number")) not in tried_cards:
                        card = nc
                        card_swaps += 1
                        log("[混合] %s %s→换一张不同的卡(同会话,不切IP)第%d次再试 ••%s" % (
                            email, "卡被拒" if result == "declined" else "校验框过不去",
                            card_swaps, str(nc.get("last4") or "")[-4:]))
                        continue
                # 换够卡仍 declined/hcaptcha → 都【升级切IP+刷指纹】再试(用户 2026-06-12:账号没问题,
                # declined 多是【环境因素】ZIP/AVS/IP,不是号坏、不是卡坏 → 换个出口/ZIP 可能就过,别弃号、别白烧好卡)。
                log("[混合] %s 换 %d 张卡仍%s → 升级:切IP换个出口再试(新IP上重置换卡额度)" % (
                    email, card_swaps, "被拒(declined,疑环境/AVS非号坏)" if result == "declined" else "弹校验框"))

            # 连续多次 server-error = 换IP也没用(疑卡velocity,非IP)→ 早停,别再白切剩下的IP
            if consec_se >= SE_GIVEUP:
                res["steps"]["giveup"] = "consec-server-error"
                log("[混合] %s 连续 %d 次 server-error,换IP无效(疑卡velocity非IP)→早停,保留环境" % (email, consec_se))
                break

            # server-error/unknown 直接切IP;hcaptcha/declined 是【换卡换够仍不行】才落到这里→升级切IP(账号没问题,换环境)
            if (result in ROTATE or result in ("hcaptcha", "declined")) and rot < max_rot:
                # 选下一个代理:从本号 start_idx 往后扫(不同号错开起点降低撞IP),跳过 起始IP/已试过/【已退役】的;
                # 选中后【切之前先验通】(HEAD js.stripe.com,正是加载不出那个)——死/慢代理直接跳过,不浪费~20s重启。
                # 【整体重试】选+切+重接管 绑在一起:切/接管失败 = 这个IP也不行 → 试下一个候选,
                # 绝不 continue 回顶端把已 quit 的死 page 喂给 add_card(那会被误判"浏览器崩"、白吃一次崩溃配额)。
                switched = None   # True=切成功 / "auth-fail"=切成功但登录没保持 / None=没切成
                for cand in _rank_rotation_candidates(proxies, start_idx):   # 按 proxy_score 排:干净IP优先,烧热殿后
                    ckey = "%s:%s" % (cand.get("host"), cand.get("port"))
                    if ckey in tried or common.proxy_retired(cand):
                        continue
                    tried.add(ckey)
                    ok, lat = common.proxy_ok(cand)
                    if not ok:
                        common.mark_proxy_result(cand, "dead")
                        log("[混合] 代理 %s 验不通(dead)→跳过,不浪费重启" % ckey)
                        continue
                    # 验通 → 真切。停旧浏览器后,切/接管任一步失败都【试下一个候选】,不把死 page 留给 add_card
                    try:
                        driver.quit()
                    except Exception:
                        pass
                    driver = None
                    try:
                        port = switch_proxy(env_id, cand)
                        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
                        common.place_window(driver, rect)
                        page = common.Page(driver)
                        try:                              # 切IP=新浏览器端口 → 重建 hcaptcha patcher
                            if hc_patcher:
                                hc_patcher.stop()
                        except Exception:
                            pass
                        # 求解模式传 force=_solve_hcap:HC_PATCHER=0 也要为求解强制重建(与初始一致)
                        hc_patcher = _start_hc_patcher(force=_solve_hcap) if (_solve_hcap or not FIXC) else None
                    except Exception as e:
                        common.mark_proxy_result(cand, "dead")   # 切/接管不起来 = 这个IP不可用
                        log("[混合] 切IP/接管失败(坏代理 %s,已跳过)(%s)→试下一个" % (ckey, str(e)[:60]))
                        continue
                    # 切+接管都成功 → 现在才把战绩归属更新到新代理(#9:之前在切之前就改,切失败会张冠李戴)
                    rot += 1
                    cur_proxy = cand
                    res.setdefault("rotations", []).append(ckey)
                    log("[混合] %s 加卡卡顿(%s)→切第 %d/%d 个IP %s(验通,延迟%ss),同会话重试(不重登)" % (
                        email, result, rot, max_rot, ckey, lat))
                    auth = _ensure_login(page, port)            # 正常会保持登录;掉了才重登
                    if auth != "ok":
                        res["steps"]["auth_after_switch"] = auth
                        if _is_not_allowed(auth):
                            res["not_allowed"] = True
                            res["steps"]["banned"] = "not-allowed"
                        log("[混合] 切IP后登录没保持(%s)→停" % auth)
                        switched = "auth-fail"
                    else:
                        switched = True
                    break
                if switched == "auth-fail":
                    break                       # 切成了但登录掉了 → 终止(保留环境)
                if not switched:
                    res["steps"]["giveup"] = "no-good-proxy"
                    log("[混合] %s 没有可用的新代理可切了(都试过/退役/验不通/切失败)→停,保留环境" % email)
                    break
                # 切到新出口成功 → 重置换卡额度:新IP上可以重新换卡试(你要的"切代理+换卡"escalation)
                card_swaps = 0
                tried_cards = {card.get("id") or card.get("number")}
                continue                         # 切好且登录在 → 回顶端重试 add_card

            break   # needphone/hcaptcha/fill-fail / 轮换用尽 → 终止(保留环境留续跑)
        res["timings"]["card"] = round(time.perf_counter() - t_card, 1)   # 加卡(含切IP轮换)总耗时
        # 改密(最后一步):卡绑成后把 Firstmail 邮箱密码改成统一密码(op_pw)。纯 HTTP 调用,不依赖浏览器/环境。
        #   · 只在【绑成 success】后做:账号已完成、不再需要邮箱 OTP;未绑成的号会续跑,改了密会破坏后续 OTP。
        #   · prior 已改过 → 跳过(旧密码已失效,再改必 fail)。复用 pipeline.py 同一函数与 changepw stage 语义。
        if success and do_changepw and op_pw:
            _cp_done = (((prior or {}).get("stages") or {}).get("changepw") or {}).get("status") == "ok"
            # ★M1:CHANGEPW_REQUIRE_PURCHASE=on → 充值未确认成功(且非续跑已充)则跳过改密保号。镜像 pipeline.py:326;默认关 → 逐字节不变。
            _cpw_req = (os.environ.get("CHANGEPW_REQUIRE_PURCHASE", "") or "").strip().lower() in ("1", "true", "on", "yes")
            if _cp_done:
                res["steps"]["changepw"] = True
                log("[混合] %s 已改密,跳过(防重复改密失败)" % email)
            elif do_purchase and _cpw_req and not ((res.get("purchase") == "success") or res.get("skipped_charge")):
                res["skipped_changepw"] = True
                res["skipped_changepw_reason"] = "purchase-" + str(res.get("purchase") or "none")
                log("[混合] %s 充值未确认成功(%s)+CHANGEPW_REQUIRE_PURCHASE=on → 跳过改密保号(可续跑取OTP)" % (email, res.get("purchase")))
            else:
                log_stage(slot, email, "changepw")
                try:
                    cp_ok = firstmail.change_mailbox_password(email, mailbox_pw, op_pw, cfg.get("mail_key"), cfg.get("mail_base") or firstmail.DEFAULT_BASE)
                    res["steps"]["changepw"] = bool(cp_ok)
                    if cp_ok:
                        save_progress(email, _stage=("changepw", {"status": "ok", "at": time.strftime("%Y-%m-%d %H:%M:%S")}))
                    log("[混合] %s 改邮箱密码 → %s" % (email, "成功" if cp_ok else "失败"))
                except Exception as e:
                    res["steps"]["changepw"] = False
                    log("[混合] %s 改密异常(不影响绑卡成功): %s" % (email, str(e)[:80]))
        return res
    except Exception as e:
        res["error"] = str(e)[:200]
        log("[混合] %s 异常: %s" % (email, str(e)[:160]))
        return res
    finally:
        # ★M2:hybrid 在 card-bound 处提前置 ok=True,若随后 do_purchase 充值没成 → ok 与新成功口径(每个关键节点真成功)矛盾,
        #   且实时面板按 stdout 的 ok= 会把它闪计成功。收尾统一按 purchase 回算 ok(只改上报 ok 字段,不动 success 变量/env/changepw 逻辑)。
        #   失败行 ok 本就 False → no-op;skipped_charge(续跑已充)时 purchase 已是 success → 不误降。覆盖所有 return 路径(finally 在 return 物化前跑、res 可变)。
        try:
            # 修#2:仅【真实充值】时才要求 purchase==success 才算成功(镜像 pipeline.py:_ok 门)。
            #   realCharge=关 的 dry-run(charge_dryrun=True)= card-bound 同口径成功,不因没真扣而误降。
            if do_purchase and real_charge and res.get("ok") and res.get("purchase") != "success":
                res["ok"] = False
        except Exception:
            pass
        # ★失败归因(用户原则「每个失败的运行必须标注好啥错误」):混合原来一个 fail_stage 都不写 → 失败全靠前端反推、
        #   分析页「Z.其它」虚高。这里在 finally(覆盖所有 return 路径,含 not_allowed/取key败/绑卡放弃早返)给失败行补
        #   fail_stage/fail_reason —— 用与 pipeline 同一套 common.attribute_failure(混合恒做 key+card,do_card/do_key 传 True)。
        #   只给【失败行】补(not ok)、且【没归过】才补(幂等);成功行不动。归因不出但有异常 → 落 exception(不做糊涂账)。
        try:
            if not res.get("ok") and not res.get("fail_stage"):
                _attr_opts = {"do_key": True, "do_card": True, "do_purchase": do_purchase, "do_changepw": do_changepw}
                _fs, _fr = common.attribute_failure(res.get("steps"), _attr_opts, res)
                if _fs:
                    res["fail_stage"] = _fs
                    res["fail_reason"] = _fr
                elif res.get("error"):
                    res["fail_stage"] = "exception"
                    res["fail_reason"] = str(res.get("error"))[:160]
        except Exception:
            pass
        log_stage(slot, email, "done", "done")
        try:
            res["timings"]["total"] = round(time.perf_counter() - t_start, 1)   # 整号端到端耗时(秒)
        except Exception:
            pass
        try:
            if patcher:
                patcher.stop()
        except Exception:
            pass
        try:
            if hc_patcher:
                hc_patcher.stop()
        except Exception:
            pass
        try:
            if driver:
                driver.quit()
        except Exception:
            pass
        if env_id:
            # ★清理异常【不能】冒泡:这是 finally 块,裸调 adspower_stop/delete_env 抛错会顶替已算好的 res 返回值→丢整号结果
            #   (与 pipeline.py:302-329 同款修法)。各自 try 包住,清理失败只记日志、不影响 res 返回。
            try:
                common.adspower_stop(env_id)
            except Exception:
                pass
            time.sleep(1.2)
            # 用户测试模式:--keep-failed-env → 绑卡【没成功】的环境【不删】,留着让你在 AdsPower 手动测加卡。
            if keep_failed_env and not success:
                res["kept_for_test"] = True
                log("[混合] ❗❗保留失败环境供你手动测试 → AdsPower 找:env_id=%s  序号serial=%s  名称=hyb-%s  账号=%s" % (
                    env_id, res.get("serial", "?"), email.split("@")[0][:16], email))
            # 复用模式:只成功才删,失败保留留续跑重开(省重登)。
            # 隔离模式:env_B 成败都删 —— 隔离的全部意义就是每次加卡都用全新干净指纹,绝不复用。
            elif delete_env and (success or isolate):
                try:
                    adspower_env.delete_env(env_id)
                except Exception as _e:
                    log("[混合] 删环境失败(忽略): %s" % str(_e)[:60])
                if isolate and not success:
                    log("[混合] 隔离:env_B %s 失败也删(下次重试换全新环境)" % env_id)
            else:
                log("保留环境 %s(success=%s, no-delete=%s)→留给续跑重开,省再次登录" % (
                    env_id, success, not delete_env))


def main():
    ap = argparse.ArgumentParser(description="Playwright+Selenium 混合(注册/取Key/绑地址=PW, 加卡=Selenium)")
    ap.add_argument("--accounts", required=True)
    ap.add_argument("--proxies", required=True)
    ap.add_argument("--op-pw", default="", help="OpenRouter 登录密码(统一密码);留空=用各账号邮箱密码当登录密码(per-账号,与 Selenium 注册一致)")
    ap.add_argument("--do-changepw", action="store_true", help="绑卡成功后把 Firstmail 邮箱密码改成统一密码(--op-pw);需 --op-pw 非空")
    ap.add_argument("--gap", type=int, default=20)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 个(0=全部)")
    ap.add_argument("--proxy-offset", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=1, help="并发数(同时跑几个号,默认1=串行)")
    ap.add_argument("--max-rotations", type=int, default=3, help="单号加卡卡顿时最多切几个IP同会话重试(默认3;连续server-error会更早判非IP问题而停)")
    ap.add_argument("--cooldown-hours", type=float, default=3.0, help="加卡给不上(切IP无效)后进冷却队列,这么多小时内不再重试(默认3h;让Radar velocity消退)")
    ap.add_argument("--max-reopen", type=int, default=3, help="同环境重开补加卡最多几次,超了就永久放弃+删环境回收(默认3;needphone/hcaptcha直接放弃)")
    ap.add_argument("--no-gc", action="store_true", help="开跑前不做环境兜底GC(默认会回收孤儿 hyb-* 环境)")
    ap.add_argument("--gc-min-age", type=int, default=30, help="GC 只删建龄超过这么多分钟的环境(默认30,防误删并发刚建的)")
    ap.add_argument("--no-delete-env", action="store_true", help="即使绑卡成功也不删环境(调试用)")
    ap.add_argument("--do-purchase", action="store_true", help="绑卡成功后走到充值步;★默认 dry-run(不真扣),要真扣须再加 --real-charge(对齐纯Sel run.py 安全模型)")
    ap.add_argument("--amount", type=int, default=5, help="充值金额(美元,默认5;仅 --do-purchase 时生效)")
    ap.add_argument("--real-charge", action="store_true", help="★真实充值开关:不加=dry-run 走到充值步不真点 Purchase(零成本测全流程);加=真扣费。默认关 → 与现状安全口径一致")
    ap.add_argument("--card-charge-gate", action="store_true", help="开卡充值容量账本:充值步【原子预留】per-card 容量(次数/金额)+同卡并发上限;不开=不预留(旧行为)。仅 --real-charge 时有意义")
    ap.add_argument("--charge-count", type=int, default=0, help="整批最多【真扣】N 次(测试帽,0=不限);达 N 后续号到充值步返回 charge-test-capped 不真扣")
    ap.add_argument("--isolate", action="store_true",
                    help="隔离架构:PW 用完即删环境,加卡换【全新 AdsPower 环境】登录(干净指纹绕开账号级 hCaptcha);"
                         "env_B 成败都删、每次重试都换全新环境;hcaptcha 不再永久放弃(换环境可能就不弹)")
    ap.add_argument("--max-attempts", type=int, default=4,
                    help="隔离模式下单号 Selenium 加卡最多尝试几次全新环境,超了永久放弃(默认4)")
    ap.add_argument("--manual-card", action="store_true",
                    help="加卡时在浏览器页面注入卡片浮层(列出可用卡+已绑次数,高亮当前卡);"
                         "填卡前留几秒(MANUAL_CARD_WAIT,默认6)让你点别的卡改用,不点走自动。设0=只展示不阻塞")
    ap.add_argument("--keep-failed-env", action="store_true",
                    help="绑卡【没成功】的 AdsPower 环境【不删除】,保留供你手动测试;日志会打出 env_id/序号/名称。"
                         "(注意:会在 AdsPower 里堆积环境,测完记得手动清)")
    ap.add_argument("--no-resume", action="store_true", help="忽略已绑/被拒/冷却/坏邮箱状态,强制整组重跑(控制台「断点续跑」取消勾选时传入)")
    ap.add_argument("--job-id", default="", help="本次任务 jobId:写进结果行 job_id,供 web 按 job 隔离取结果(防同引擎并发串号)")
    args = ap.parse_args()

    cfg = common.load_config()
    accounts = read_accounts(args.accounts)
    proxies = adspower_env.load_proxies(args.proxies)
    if not accounts or not proxies:
        log("账号或代理为空"); return
    # 创建浏览器时 IP【随机选 + 按IP段交错】:同批并发尽量不同段(防 velocity/设备关联)。PROXY_DIVERSIFY=0 关。
    if os.environ.get("PROXY_DIVERSIFY", "1") != "0" and len(proxies) > 1:
        proxies = _diversify_proxies(proxies)
        nseg = len(set(_proxy_seg(p) for p in proxies))
        log("代理已【随机打乱 + 按IP段(/%d)交错】(%d 段 %d 条)→ 同批并发尽量不同段、每次随机" % (
            int(os.environ.get("PROXY_SEG_OCTETS", "3")) * 8, nseg, len(proxies)))
    if args.limit:
        accounts = accounts[:args.limit]
    log("混合跑 %d 个账号, 代理 %d 条" % (len(accounts), len(proxies)))

    # 开跑前环境兜底 GC:回收孤儿 hyb-* 环境(PW失败没key/崩没记录/没删干净的),防 AdsPower 配额被撑爆。
    # 三护栏:留续跑要重开的、跳过正开着的、跳过建龄<gc_min_age 的。
    if not args.no_gc:
        try:
            import cleanup_envs
            cleanup_envs.gc_envs(min_age_min=args.gc_min_age, dry_run=False, log=log)
        except Exception as e:
            log("环境GC失败(忽略): %s" % str(e)[:80])

    group_id = adspower_env.ensure_group("selpipe")
    state_dir = os.path.join(common.HERE, "state")
    os.makedirs(state_dir, exist_ok=True)
    res_file = os.path.join(state_dir, "hybrid_results.jsonl")
    # 断点续跑：done=已绑卡(card-bound)跳过；banned=账号被OpenRouter拒绝(not allowed)永久跳过防重复试错；
    # latest=每号最近一次进度(含已取的key/地址), 给续跑跳过 PW 用
    done = set()
    banned = set()
    cooldown = {}   # 冷却队列:{email: 冷却到点的 epoch 秒} —— 切IP无效给不上的号,到点前不再重试
    latest = {}
    now = time.time()
    if os.path.exists(res_file):
        with open(res_file, encoding="utf-8") as _rf:
            _res_lines = list(_rf)
        for line in _res_lines:
            try:
                r = json.loads(line)
            except Exception:
                continue
            em = r.get("email")
            if not em:
                continue
            latest[em] = r
            steps = r.get("steps") or {}
            if steps.get("card") == "card-bound":
                done.add(em)
                cooldown.pop(em, None)   # 绑上了就出队
            # 被拒账号 + 永久放弃(needphone/hcaptcha/重开够多次仍给不上)→ 都永久跳过、不再试错
            if r.get("not_allowed") or _is_not_allowed(steps.get("pw_reason")) or _is_not_allowed(steps.get("auth")):
                banned.add(em)
            if r.get("giveup_permanent"):
                banned.add(em)
            cu = r.get("cooldown_until")
            if cu and not r.get("ok"):
                cooldown[em] = cu        # 取该号最近一次的冷却到点(latest 覆盖,自然是最新)

    # 合并增量 checkpoint(account_progress.json):中途被停、还没写进 hybrid_results 的号,从这里补回
    # 【已注册/api_key/env_id】→ 下次直接【登录+复用key】,不再重注册重建key(修"第二次还创建KEY")。
    try:
        with open(_PROGRESS_FILE, encoding="utf-8") as _f:
            _prog = json.load(_f)
        for em, rec in (_prog.items() if isinstance(_prog, dict) else []):
            cur = latest.setdefault(em, {})
            for k in ("registered", "api_key", "env_id", "env_serial", "billing_status"):
                if rec.get(k) and not cur.get(k):
                    cur[k] = rec[k]
            # 逐阶段状态机(charge 防重扣 gate / 续跑跳过都读它);checkpoint 比 results 更全,合并进来
            if rec.get("stages"):
                merged = dict(cur.get("stages") or {})
                merged.update(rec["stages"])
                cur["stages"] = merged
    except Exception:
        pass

    acct_emails = {a["email"] for a in accounts}
    if args.no_resume:
        # 强制整组重跑:清掉所有"跳过"判据(已绑/被拒/冷却/坏邮箱);prior(registered/api_key/env_id)仍保留 → 直接登录+复用key,不重注册。
        done = set(); banned = set(); cooldown = {}
        log("[混合] --no-resume:忽略已绑/被拒/冷却/坏邮箱状态,整组强制重跑")
    bad_mb = {} if args.no_resume else common.load_bad_mailboxes()  # 坏邮箱→永久跳过;--no-resume 时也强制重试
    in_cooldown = {em: t for em, t in cooldown.items() if em in acct_emails and em not in done and em not in banned and t > now}
    pending = [(i, acct) for i, acct in enumerate(accounts)
               if acct["email"] not in done and acct["email"] not in banned and acct["email"] not in in_cooldown
               and not common.is_bad_mailbox(acct["email"], bad_mb)]
    for em in (done & acct_emails):
        log("跳过已绑卡 %s" % em)
    for em in (banned & acct_emails):
        log("跳过被拒账号(not allowed,不再试错) %s" % em)
    for em in acct_emails:
        if common.is_bad_mailbox(em, bad_mb):
            log("跳过坏邮箱(收不到验证邮件,永久) %s" % em)
    for em, t in sorted(in_cooldown.items(), key=lambda kv: kv[1]):
        log("⏳ 冷却队列中(切IP无效),还剩 %d 分钟再试: %s" % (max(0, int((t - now) / 60)), em))
    # 把被拒账号登记到 state/banned_accounts.txt(人看,防重复试错)
    if banned:
        try:
            bf = os.path.join(state_dir, "banned_accounts.txt")
            allbanned = set()
            if os.path.exists(bf):
                with open(bf, encoding="utf-8") as _bf:
                    allbanned = set(l.strip() for l in _bf if l.strip() and not l.startswith("#"))
            allbanned |= banned
            with open(bf, "w", encoding="utf-8") as f:
                f.write("# OpenRouter 拒绝(not allowed to access)的账号——已永久跳过,勿再注册试错\n")
                for em in sorted(allbanned):
                    f.write(em + "\n")
        except Exception as e:
            log("写 banned_accounts.txt 失败: %s" % str(e)[:80])

    conc = max(1, args.concurrency)
    # ★F4/F5:整批最多真充 N 次(测试帽)——跨 worker 线程安全计数(对齐 run.py:188-199)。真扣【前】(reserve 成功后)调一次占名额,达 N 即拒。
    _charge_lock = threading.Lock()
    _charge_used = [0]
    def try_batch_charge():
        n = max(0, int(getattr(args, "charge_count", 0) or 0))
        if n <= 0:
            return True   # 0=不限
        with _charge_lock:
            if _charge_used[0] >= n:
                return False
            _charge_used[0] += 1
            return True
    import queue
    _slots = queue.Queue()
    for s in range(conc):
        _slots.put(s)   # 并发窗口槽位:0..conc-1,平铺成网格

    def worker(i, acct):
        slot = _slots.get()
        start_idx = (i + args.proxy_offset) % len(proxies)   # 起始代理下标;卡顿时按 start_idx+rot 轮换
        proxy0 = proxies[start_idx]
        prior = latest.get(acct["email"])
        reopen = (prior or {}).get("env_id") and (prior or {}).get("api_key")
        log("════ 开始 %s 经代理 %s:%s%s ════" % (
            acct["email"].split("@")[0], proxy0["host"], proxy0["port"],
            "（重开旧环境:免重登,直接加卡）" if reopen else ("（续跑:已有key只补加卡）" if (prior or {}).get("api_key") else "")))
        try:
            _op = args.op_pw or acct["mailbox_pw"]   # 没给 --op-pw 就用各账号邮箱密码当 OpenRouter 登录密码(与 Selenium 注册时一致,登得进per-账号密码的号)
            r = run_account(acct, proxies, start_idx, group_id, _op, cfg,
                            delete_env=not args.no_delete_env, prior=prior, slot=slot,
                            slots_total=conc, max_rotations=args.max_rotations, isolate=args.isolate,
                            manual_card=args.manual_card, keep_failed_env=args.keep_failed_env,
                            do_purchase=args.do_purchase, amount=args.amount, do_changepw=args.do_changepw,
                            real_charge=args.real_charge,
                            card_charge_gate=getattr(args, "card_charge_gate", False),
                            try_batch_charge=try_batch_charge)
        finally:
            _slots.put(slot)
        r["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        nm = acct["email"].split("@")[0]
        card = (r.get("steps") or {}).get("card")
        reopen_count = r.get("reopen_count", 0)
        attempt_count = r.get("attempt_count", 0)
        is_cardfail = (not r.get("ok")) and (not r.get("not_allowed")) and r.get("api_key") and card != "card-bound"
        # 永久放弃(重试无意义)→ 删环境回收+登记,以后像 banned 一样跳过:
        if args.isolate:
            # 隔离模式:hcaptcha【不再永久放弃】—— 整个隔离的意义就是换个全新环境可能就不弹了。
            #   只有 needphone(Link 问题,换环境也没用)或 尝试够 max_attempts 次仍给不上才收手。
            permanent = is_cardfail and (card == "needphone" or attempt_count >= args.max_attempts)
            _preason = card if card == "needphone" else ("隔离试%d个全新环境仍给不上" % attempt_count)
        else:
            # 复用模式:needphone/hcaptcha 换时间重试结果几乎必然一样;重开同环境 ≥max_reopen 次也该收手。
            permanent = is_cardfail and (card in ("needphone", "hcaptcha") or reopen_count >= args.max_reopen)
            _preason = card if card in ("needphone", "hcaptcha") else ("reopen%d次仍给不上" % reopen_count)
        if permanent:
            r["giveup_permanent"] = True
            r["giveup_reason"] = _preason
            # 隔离模式 env_B 已在 run_account finally 删掉,这里不重复删
            if r.get("env_id") and not args.no_delete_env and not args.isolate:
                try:
                    common.adspower_stop(r["env_id"]); time.sleep(0.5); adspower_env.delete_env(r["env_id"])
                    r["env_deleted"] = True
                except Exception as e:
                    log("删放弃环境失败: %s" % str(e)[:60])
            log("🛑 %s 永久放弃(%s)→%s,不再重试" % (nm, r["giveup_reason"], "回收" if not args.isolate else "环境已删"))
        elif is_cardfail:
            # 瞬时给不上 → 进冷却队列。复用模式:环境保留到点重开免重登;隔离模式:env_B已删,下次换全新环境重试。
            r["cooldown_until"] = time.time() + args.cooldown_hours * 3600
            r["cooldown_reason"] = (r.get("steps") or {}).get("giveup") or card or "card-fail"
            log("⏳ %s 加卡给不上(%s)→进冷却队列,%.1fh 后再试(%s)" % (
                nm, r["cooldown_reason"], args.cooldown_hours, "环境已保留" if not args.isolate else "下次换全新环境"))
        # banned 的号若留了环境 → 删掉回收(隔离模式已在 finally 删,这里跳过)
        if r.get("not_allowed") and r.get("env_id") and not args.no_delete_env and not args.isolate and not r.get("env_deleted"):
            try:
                common.adspower_stop(r["env_id"]); time.sleep(0.5); adspower_env.delete_env(r["env_id"]); r["env_deleted"] = True
                log("🛑 %s 被拒→删环境回收" % nm)
            except Exception:
                pass
        if args.job_id:
            r["job_id"] = args.job_id   # web 按 job 隔离取结果(同引擎并发不串号)
        with _WRITE_LOCK:
            with open(res_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
                f.flush(); os.fsync(f.fileno())   # 进程被 SIGKILL 也不丢末尾结果行
        log("════ %s 结果 ok=%s pw=%s key=%s 地址=%s 卡=%s ════" % (
            acct["email"].split("@")[0], r.get("ok"), (r.get("steps") or {}).get("pw"),
            (r.get("api_key") or "")[:14], r.get("billing_status"), (r.get("steps") or {}).get("card")))
        return r

    log("混合跑 %d 个待办账号, 并发 %d (代理 %d 条, 窗口平铺, AdsPower API 已全局限频)" % (len(pending), conc, len(proxies)))
    if conc == 1:
        for i, acct in pending:
            # 串行也包 try/except(与并发路径 f.result() 一致):worker 内记账/写文件抛异常时
            # 只跳过这一个号继续下一个,别让整批待办中断。
            try:
                worker(i, acct)
            except Exception as e:
                log("worker 异常(%s): %s" % (acct.get("email"), str(e)[:150]))
            time.sleep(args.gap)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=conc) as ex:
            futs = [ex.submit(worker, i, acct) for i, acct in pending]
            for f in concurrent.futures.as_completed(futs):
                try:
                    f.result()
                except Exception as e:
                    log("worker 异常: %s" % str(e)[:150])

    log("混合跑完。结果见 %s" % res_file)
    # 跑完自动把所有【有问题的账号】(没绑上卡的)标记到 state/hybrid_flagged.txt
    try:
        import flag_accounts
        flag_accounts.write_flagged(res_file=res_file, log=log)
    except Exception as e:
        log("写 flagged 失败: %s" % str(e)[:80])
    # 跑完【按实时战绩给 IP 打分】→ 打印排名 + 写 state/proxy-scores.json(挑好IP/揪烧热IP)
    try:
        import proxy_score
        proxy_score.after_batch(log=log, proxy_file=args.proxies)
    except Exception as e:
        log("IP评分失败: %s" % str(e)[:80])
    # 跑完打印【ZIP 成功率】(看免税州 vs 其它,哪个ZIP绑成率高)
    try:
        common.zip_report(log=log)
    except Exception as e:
        log("ZIP分析失败: %s" % str(e)[:80])


if __name__ == "__main__":
    main()
