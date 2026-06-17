#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 状态账本(state/*.json 的读改写,全部跨进程文件锁保护):
#   代理战绩 / ZIP 战绩 / BIN 当日额度 / 卡池取卡与结果回写 / hCaptcha 命中登记 / 坏邮箱登记。
import os
import json
import time
import random
import threading

from .base import log, _atomic_write_json, _file_lock
# 经 `paths.X` 在【调用时】读取(不是导入期值绑定):路径常量的单一真源在 paths,
# 谁改 paths 里的 POOL_FILE 等(含测试给 common.paths.* 打桩)都能被这里实时读到。
from . import paths


# 环境变量数值转型(防御):未设/空/非数字 → 默认值。
# 这些 CARD_*/PROXY_* 阈值在锁保护的临界区里读,操作员误填(如 ="" 或 ="abc")若直接 int()/float()
# 会抛 ValueError 中断当次加卡/取卡操作;统一走这里兜底,绝不让一个环境变量打挂临界区。
def _envint(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _envfloat(name, default):
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


# ── 代理质量:切代理前验通/测速 + per-proxy 成功率追踪/退役 ────────────────────
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
    with _PROXY_LOCK, _file_lock(paths.PROXY_STATS_FILE):   # ★跨进程锁:两引擎并发 read-modify-write 不丢更新
        try:
            with open(paths.PROXY_STATS_FILE, encoding="utf-8") as _f:
                stats = json.load(_f)
        except Exception:
            stats = {}
        s = stats.setdefault(key, {})
        s[result] = s.get(result, 0) + 1
        s["last"] = result
        if result == "card-bound":
            s["fail_streak"] = 0
        elif result in ("dead", "unknown"):
            s["fail_streak"] = s.get("fail_streak", 0) + 1
        _atomic_write_json(paths.PROXY_STATS_FILE, stats)


def proxy_retired(proxy):
    """连续失败(dead/unknown)≥阈值(PROXY_RETIRE_STREAK 默认5)的代理→退役,选IP时跳过。"""
    key = "%s:%s" % (proxy.get("host"), proxy.get("port"))
    # ★与 mark_proxy_result 一致用同一把锁读:否则两进程并发时可能读到半写文件/陈旧值。
    with _PROXY_LOCK, _file_lock(paths.PROXY_STATS_FILE):
        try:
            with open(paths.PROXY_STATS_FILE, encoding="utf-8") as _f:
                stats = json.load(_f)
        except Exception:
            return False
    return stats.get(key, {}).get("fail_streak", 0) >= _envint("PROXY_RETIRE_STREAK", 5)


_ZIP_LOCK = threading.Lock()


def mark_zip_result(zipcode, result):
    """记录每个 ZIP 的加卡战绩(card-bound/declined)→ 分析哪个 ZIP 成功率高(免税州 vs 其它)。并发安全。"""
    if not zipcode or result not in ("card-bound", "declined"):
        return
    z = str(zipcode)
    with _ZIP_LOCK, _file_lock(paths.ZIP_STATS_FILE):       # ★跨进程锁:两引擎并发 read-modify-write 不丢更新
        try:
            with open(paths.ZIP_STATS_FILE, encoding="utf-8") as _f:
                stats = json.load(_f)
        except Exception:
            stats = {}
        s = stats.setdefault(z, {})
        s[result] = s.get(result, 0) + 1
        s["last"] = result
        _atomic_write_json(paths.ZIP_STATS_FILE, stats)


# 免税州 ZIP → 州名(分析报表里标出来,验证"免税州成功率高")
_TAXFREE_ZIP_STATE = {"59601": "Montana", "59718": "Montana", "59101": "Montana",
                      "97301": "Oregon", "97401": "Oregon", "97201": "Oregon",
                      "03301": "NewHampshire", "03063": "NewHampshire",
                      "19711": "Delaware", "19901": "Delaware",
                      "99501": "Alaska", "99701": "Alaska"}


def zip_report(log=print):
    """打印各 ZIP 加卡成功率(card-bound/总),高→低,并标出是否免税州。返回 rows。"""
    try:
        with open(paths.ZIP_STATS_FILE, encoding="utf-8") as _f:
            stats = json.load(_f)
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


# ── 卡池 / BIN 当日额度 ──────────────────────────────────────────────────
_CARD_LOCK = threading.Lock()


def _bin_of(c):
    """卡的 BIN(发卡行前 6 位)。同 BIN 一天铺太多号会撞 Stripe Radar velocity。"""
    return (c.get("number") or "")[:6]


def _read_bin_usage():
    """bin-usage.json = {日期:{BIN:{assigned,bound,declined,server-error,unknown,hcaptcha}}}。兼容旧 {BIN:int}。"""
    try:
        with open(paths.BIN_USAGE_FILE, encoding="utf-8") as _f:
            d = json.load(_f)
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
    _atomic_write_json(paths.BIN_USAGE_FILE, {k: usage[k] for k in keep})


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
        _blf = os.path.join(paths.HERE, "card-blacklist-bins.txt")
        if os.path.exists(_blf):
            with open(_blf, encoding="utf-8") as _bf:
                for _ln in _bf:
                    _ln = _ln.strip()
                    if _ln and not _ln.startswith("#"):
                        exclude_bins.add(_ln[:6])
    except Exception:
        pass
    import datetime as _dt

    def _cid(c):
        return c.get("id") or c.get("number")

    def _compute_active():
        """读卡池→算 base_active(active 且有余次、未被 exclude/exclude_bins)→优先非冷却卡。
        必须在【持锁】下调用(account 路径),让选卡用的是另一进程刚禁用/冷却/用满后的【实时】卡池快照,
        不再用锁外那份陈旧 pool 漏选。返回 active 列表(或抛卡池无可用卡)。"""
        with open(paths.POOL_FILE, "r", encoding="utf-8") as f:
            pool = json.load(f)
        _now_iso = _dt.datetime.utcnow().isoformat() + "Z"

        def _cooled(c):
            cu = c.get("cooldownUntil")
            return bool(cu and cu > _now_iso)   # ISO 时间串可直接字典序比较

        base_active = [c for c in (pool if isinstance(pool, list) else [])
                       if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)
                       and (c.get("id") or c.get("number")) not in exclude
                       and _bin_of(c) not in exclude_bins]
        if not base_active:
            raise RuntimeError("卡池无可用卡(data/card-pool.json 没有 active 且有余次的卡)")
        # 优先用【没在冷却】的卡(延迟复用刚出错的卡,自动轮到别的);全在冷却→退回挑冷却快结束的,别阻塞
        active = [c for c in base_active if not _cooled(c)]
        if not active:
            active = sorted(base_active, key=lambda c: c.get("cooldownUntil") or "")
        return active

    if not account:
        # 免锁快路径:无 account 不写文件,只读一份选首张(只读,陈旧也无写冲突)
        return _compute_active()[0]

    # 读-选-写要原子(并发时两个号别抢到同一张/写花文件)。★加跨进程文件锁:两个引擎进程也序列化。
    # pool 读取 + base_active/active 计算必须【在锁内重做】(对齐 mark_card_result 全程持锁),
    # 否则用锁外那份陈旧 pool 选卡,会漏掉另一进程刚禁用/冷却/用满的卡(bug #2)。
    with _CARD_LOCK, _file_lock(paths.POOL_FILE):
        active = _compute_active()
        assign = {}
        if os.path.exists(paths.CARD_ASSIGN_FILE):
            try:
                with open(paths.CARD_ASSIGN_FILE, encoding="utf-8") as _f:
                    assign = json.load(_f)
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
        # 每个 BIN 当日加卡号数上限(防 velocity)。clamp ≥1:CARD_BIN_DAILY_CAP=0/负 原来会让 _assigned()<cap 恒假、
        # 撞兜底=静默关闭速率上限;现钳到最严(至少 1),不让一个 0 把 velocity 防护悄悄关掉(要无限放宽就设大数)。
        cap = max(1, _envint("CARD_BIN_DAILY_CAP", 20))
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
            if under:
                best = _rnd.choice(under)
            else:
                # ★所有 BIN 当日都超额 → 不再【random over all】(会偏向卡最多的独大 BIN,正是 436120 一天 200+ 的根因);
                #   改【轮换到当日发号最少的 BIN】再随机取,overflow 也尽量摊匀。仍绝不饿卡:cands 非空必返一张(不因超额返 None)。
                _min_a = min(_assigned(_bin_of(c)) for c in cands)
                best = _rnd.choice([c for c in cands if _assigned(_bin_of(c)) == _min_a])
                log("[卡] 所有 BIN 当日均超额(cap=%d)→ 轮换到发号最少的 BIN(避免独大 BIN 继续堆 Radar velocity)" % cap)
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
            _atomic_write_json(paths.CARD_ASSIGN_FILE, assign)
        # 本卡已分配到的号数(两种策略都从 assign 现算,避免引用某分支才有的局部变量)
        import collections as _c
        nbound = _c.Counter(assign.values()).get(_cid(best), 0)
    binnote = (" BIN%s今日第%d" % (bin_picked, (today_use.get(bin_picked) or {}).get("assigned", 0))) if bin_picked else ""
    log("[卡] 给 %s 分配卡 ••%s(%s,该卡已分配 %d 个号%s)" % (
        account, str(best.get("last4") or best.get("number", ""))[-4:],
        {"concentrate": "集中测容量", "random": "随机取", "spread": "摊匀"}.get(strategy, "摊匀"), nbound, binnote))
    return best


def _hcaptcha_file():
    return os.path.join(paths.HERE, "state", "hcaptcha_hits.json")


def load_hcaptcha_hits():
    """读【撞过图片验证码(hCaptcha)】的号登记(email→{count,last_at,...})。hcaptcha 是环境因素可重试,这是计数追踪不跳过。"""
    try:
        with open(_hcaptcha_file(), encoding="utf-8") as _f:
            return json.load(_f)
    except Exception:
        return {}


def mark_hcaptcha(email, detail=""):
    """登记某号撞了图片验证码(hCaptcha),累加计数。供人查"哪些号反复撞"决定是否换IP/弃用。幂等累加+原子写。"""
    if not email:
        return
    try:
        with _file_lock(_hcaptcha_file()):        # ★跨进程锁:两引擎并发累加计数不丢
            d = load_hcaptcha_hits()
            rec = d.get(email) or {"count": 0}
            rec["count"] = int(rec.get("count", 0)) + 1
            rec["last_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            if detail:
                rec["last_detail"] = str(detail)[:80]
            d[email] = rec
            os.makedirs(os.path.dirname(_hcaptcha_file()), exist_ok=True)
            _atomic_write_json(_hcaptcha_file(), d)
        log("🧩 登记图片验证码(hCaptcha)命中 #%d: %s" % (rec["count"], email))
    except Exception:
        pass


def _bad_mailbox_file():
    return os.path.join(paths.HERE, "state", "bad_mailboxes.json")


def load_bad_mailboxes():
    """读已登记的【坏邮箱】(Firstmail 404 不可访问/收不到 OpenRouter 验证邮件的号)→ run.py/hybrid 据此永久跳过。返回 dict email→info。"""
    try:
        with open(_bad_mailbox_file(), encoding="utf-8") as _f:
            return json.load(_f)
    except Exception:
        return {}


def is_bad_mailbox(email, bad=None):
    """该号是否坏邮箱(永久跳过):整邮箱命中 或 其域(以 @domain 形式登记)命中。"""
    if not email:
        return False
    bad = load_bad_mailboxes() if bad is None else bad
    if email in bad:
        return True
    if "@" in email and ("@" + email.split("@", 1)[1]) in bad:
        return True
    return False


def mark_bad_mailbox(email, reason="mailbox-404"):
    """登记某号邮箱坏(后续永久跳过,不再浪费注册/验证)。幂等+原子写。email 传 '@domain' 可整域登记。"""
    if not email:
        return
    try:
        with _file_lock(_bad_mailbox_file()):     # ★跨进程锁:两引擎并发登记不丢
            d = load_bad_mailboxes()
            if email not in d:
                d[email] = {"reason": reason, "at": time.strftime("%Y-%m-%d %H:%M:%S")}
                os.makedirs(os.path.dirname(_bad_mailbox_file()), exist_ok=True)
                _atomic_write_json(_bad_mailbox_file(), d)
                log("📭 登记坏邮箱(后续永久跳过): %s (%s)" % (email, reason))
    except Exception:
        pass


def _verify_fail_file():
    return os.path.join(paths.HERE, "state", "mailbox_verify_fails.json")


def load_verify_fails():
    """读【信箱可达(200)但收不到 OpenRouter 验证邮件】的跨批累计计数(email→{count,last_at,last_reason})。
       区别于 bad_mailboxes:这些号信箱本身没坏(非 404/401),只是收不到验证信 → 累计到阈值才升级成坏邮箱永久跳过。
       返回 dict email→info。"""
    try:
        with open(_verify_fail_file(), encoding="utf-8") as _f:
            return json.load(_f)
    except Exception:
        return {}


def mark_verify_fail(email, reason="no-verify-mail"):
    """登记某号本批【可达但收不到验证信】,跨批累加计数并返回【累计次数】。幂等累加+原子写+跨进程锁。
       供 steps_auth 据返回值判断是否达阈值升级成坏邮箱。不写 bad_mailboxes(那是升级后才做)。"""
    if not email:
        return 0
    try:
        with _file_lock(_verify_fail_file()):     # ★跨进程锁:两引擎并发累加计数不丢
            d = load_verify_fails()
            rec = d.get(email) or {"count": 0}
            rec["count"] = int(rec.get("count", 0)) + 1
            rec["last_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            if reason:
                rec["last_reason"] = str(reason)[:80]
            d[email] = rec
            os.makedirs(os.path.dirname(_verify_fail_file()), exist_ok=True)
            _atomic_write_json(_verify_fail_file(), d)
        log("📨 收不到验证信累计 #%d: %s" % (rec["count"], email))
        return int(rec["count"])
    except Exception:
        return 0


def clear_verify_fail(email):
    """某号本批【收到了验证信=信箱其实能用】→ 清掉它的累计计数(恢复即清零,防误升级成坏邮箱)。幂等+原子写。"""
    if not email:
        return
    try:
        with _file_lock(_verify_fail_file()):
            d = load_verify_fails()
            if email in d:
                del d[email]
                os.makedirs(os.path.dirname(_verify_fail_file()), exist_ok=True)
                _atomic_write_json(_verify_fail_file(), d)
    except Exception:
        pass


def count_bad_in_domain(domain, bad=None):
    """统计 bad_mailboxes 里属于某 @域 的【逐邮箱】坏号数(不含已登记的整域条目本身)。供可选的「整域自动拉黑」判阈值。"""
    if not domain:
        return 0
    dom = domain if domain.startswith("@") else ("@" + domain.split("@", 1)[-1])
    bad = load_bad_mailboxes() if bad is None else bad
    n = 0
    for k in (bad or {}):
        if k == dom:                                  # 整域条目本身不计
            continue
        if "@" in k and ("@" + k.split("@", 1)[1]) == dom:
            n += 1
    return n


def mark_card_result(card, result):
    """加卡结果回写卡池(并发安全)：
       declined→【立即禁用】该卡(坏卡,不再用)；server-error/unknown→errorCount++,连续≥5次才禁(Radar限频非卡问题)；
       card-bound→successCount++。禁用后 load_card 不再选它,已分配该卡的号会自动改派。"""
    if not card:
        return
    cid = card.get("id") or card.get("number")
    with _CARD_LOCK, _file_lock(paths.POOL_FILE):        # ★跨进程锁:禁用/冷却实时落盘,不被另一引擎进程覆盖
        try:
            with open(paths.POOL_FILE, encoding="utf-8") as _f:
                pool = json.load(_f)
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
                dis_at = _envint("CARD_DECLINE_DISABLE_AT", 2)
                if c.get("declineCount", 0) >= dis_at:
                    c["status"] = "disabled"; c["disabledReason"] = "declined"; c["disabledAt"] = now
                    log("[卡] ••%s declined 第%d次(≥%d=多会话都拒,大概率真坏卡)→ 禁用(此前绑成 %d)" % (
                        last4, c["declineCount"], dis_at, c.get("successCount", 0)))
                else:
                    _m = _envfloat("CARD_DECLINE_COOLDOWN_MIN", 30)
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
                    lim = _envint("CARD_CAPTCHA_LIMIT", 3)
                    if c.get("captchaCount", 0) >= lim:
                        c["status"] = "disabled"
                        c["disabledReason"] = "too-many-captcha"
                        c["disabledAt"] = now
                        log("[卡] ••%s 弹验证框 %d 次(≥%d,concentrate)→ 禁用本卡" % (last4, c.get("captchaCount", 0), lim))
                    else:
                        log("[卡] ••%s 弹验证框第 %d/%d 次(concentrate)" % (last4, c.get("captchaCount", 0), lim))
                else:
                    # 弹框先【冻结冷却】(hcaptcha 多是环境问题,不冤枉好卡);但【撞太多次(默认4)就禁用】——
                    # 否则像 ••6290 撞9次还被反复重用,白烧卡池+一直卡 hcaptcha(用户规则 2026-06-13)。CARD_CAPTCHA_DISABLE=0 关掉禁用。
                    _dislim = _envint("CARD_CAPTCHA_DISABLE", 5)
                    if _dislim > 0 and c.get("captchaCount", 0) >= _dislim:
                        c["status"] = "disabled"
                        c["disabledReason"] = "too-many-captcha"
                        c["disabledAt"] = now
                        log("[卡] ••%s 弹验证框 %d 次(≥%d)→ 禁用本卡(别再反复重用热卡)" % (
                            last4, c.get("captchaCount", 0), _dislim))
                    else:
                        _base = _envfloat("CARD_ERR_COOLDOWN_MIN", 20)
                        _mins = min(_base * max(1, c.get("captchaCount", 1)), _base * 4)
                        c["cooldownUntil"] = (datetime.datetime.utcnow() + datetime.timedelta(minutes=_mins)).isoformat() + "Z"
                        log("[卡] ••%s 弹验证框第%d次 → 冻结(冷却 %d 分钟,换卡试)" % (
                            last4, c.get("captchaCount", 0), int(_mins)))
            elif result in ("server-error", "unknown", "card-502"):
                # 用户规则:server-error/unknown/card-502(后端 unable-to-authenticate) 都【不是卡坏】→ 只计数,
                # 绝不禁卡(唯一禁卡条件是 declined)。实测同一张卡在 A 会话 502、在 B 会话能绑成 ——
                # 502 是【会话/段+会话组合】级,不是这张卡报废;禁了就白白浪费好卡。card-502 只让上层换段重绑。
                c["errorCount"] = c.get("errorCount", 0) + 1
                # 用户规则(2026-06-11):错误后【延迟该卡复用】(冷却,不是禁用)——让 load_card 轮到别的卡,
                # 别老拿同几张卡撞同一面墙、降单卡 velocity。冷却随连续错误次数递增(有上限),绑成会清零。
                _base = _envfloat("CARD_ERR_COOLDOWN_MIN", 20)
                _mins = min(_base * c["errorCount"], _base * 4)
                c["cooldownUntil"] = (datetime.datetime.utcnow() + datetime.timedelta(minutes=_mins)).isoformat() + "Z"
                log("[卡] ••%s 错误(%s)第%d次 → 冷却 %d 分钟(延迟复用,非禁用)" % (
                    str(c.get("last4") or "")[-4:], result, c["errorCount"], int(_mins)))
            break
        _atomic_write_json(paths.POOL_FILE, pool)


def note_decline_code(card_id, code, amount=0):
    """充值【被拒】后把具体拒付码记到卡上(lastDeclineCode);★绝不动 declineCount/不冷却/不禁卡(那是 mark_card_result
       对【绑卡】拒付的职责)—— 充值拒付多为环境/风控,不应据此累计禁掉能正常绑卡的卡。
       仅当 code==insufficient_funds(卡真没钱)且开关 CARD_ZERO_BALANCE_ON_INSUFFICIENT 开 → 才【禁用】该卡(status=disabled
       从可用池剔除;★不清零 balance——置 0 会让金额约束变 ∞,enable 后反成无限可充);默认关 → 只记录,不擅自改用户填的余额/状态。
       与 Node card-pool.js noteDeclineCode 同口径。"""
    if not card_id or not code:
        return
    import datetime
    zero_on_insuff = (os.environ.get("CARD_ZERO_BALANCE_ON_INSUFFICIENT", "") or "").strip().lower() in ("1", "true", "on", "yes")
    with _CARD_LOCK, _file_lock(paths.POOL_FILE):
        try:
            with open(paths.POOL_FILE, encoding="utf-8") as _f:
                pool = json.load(_f)
        except Exception:
            return
        now = datetime.datetime.utcnow().isoformat() + "Z"
        for c in pool:
            if (c.get("id") or c.get("number")) != card_id:
                continue
            c["lastDeclineCode"] = str(code)
            c["lastDeclineAt"] = now
            if code == "insufficient_funds" and zero_on_insuff:
                # ★只【禁用】不清零 balance:置 balance=0 会让金额约束变 Infinity(未跟踪),一旦人工 enable() 该卡反而成"无限可充"
                #   → 留着原 balance,禁用即从可用池剔除;人工 enable 后金额约束仍在,可据实改余额。
                c["status"] = "disabled"
                c["disabledReason"] = "insufficient_funds"
                c["disabledAt"] = now
                log("[卡] ••%s 充值拒付=余额不足 → 禁用该卡(CARD_ZERO_BALANCE_ON_INSUFFICIENT;余额不清零,enable 后金额约束仍在)" % (str(c.get("last4") or "")[-4:]))
            break
        _atomic_write_json(paths.POOL_FILE, pool)


# ── 充值容量账本 + 充值步原子预留(与 Node billing/card-pool.js 同字段、同一把文件锁,并发安全)─────
#   字段:chargeCap(充值次数)/balance(金额$)/chargeConcurrency(同卡并发上限)/chargedTotal(已真充)/chargeInflight(在飞预留)
def _card_charge_capacity(c, amount):
    """这张卡按当前充值额的【总】容量:次数与金额【双约束取 min】(钱优先=钱不够时钱赢);都没填=inf。与 Node cardChargeCapacity 同口径。"""
    amt = max(0.01, float(amount or 5))
    by_count = float("inf")
    by_money = float("inf")
    try:
        if float(c.get("chargeCap") or 0) > 0:
            by_count = int(float(c.get("chargeCap")))
    except Exception:
        by_count = float("inf")
    try:
        if float(c.get("balance") or 0) > 0:
            by_money = int(float(c.get("balance")) // amt)
    except Exception:
        by_money = float("inf")
    return min(by_count, by_money)   # 两者都没填 → min(inf,inf)=inf = 未跟踪 = 不限(旧行为)


def _card_charge_remaining(c, amount):
    """这张卡【还能真充几次】(已扣已算):次数剩余=chargeCap-已充;金额剩余=floor(余额/充值额)(余额已在 commit 扣减,
       不再减 chargedTotal,否则双重计数)。两者【双约束取 min】(钱优先=钱不够时钱赢);未跟踪=inf。与 Node cardChargeRemaining 同口径。"""
    amt = max(0.01, float(amount or 5))
    by_count = float("inf")
    by_money = float("inf")
    try:
        if float(c.get("chargeCap") or 0) > 0:
            by_count = max(0, int(float(c.get("chargeCap"))) - int(c.get("chargedTotal") or 0))
    except Exception:
        by_count = float("inf")
    try:
        if float(c.get("balance") or 0) > 0:
            by_money = int(float(c.get("balance")) // amt)
    except Exception:
        by_money = float("inf")
    return min(by_count, by_money)


def get_card_capacity(card_id, amount):
    """只读:该卡按 amount 还能真充几次(容量 - 已充);未跟踪 → inf。卡不存在 → 0。"""
    if not card_id:
        return 0
    try:
        with open(paths.POOL_FILE, encoding="utf-8") as _f:
            pool = json.load(_f)
    except Exception:
        return 0
    for c in (pool if isinstance(pool, list) else []):
        if (c.get("id") or c.get("number")) == card_id:
            return _card_charge_remaining(c, amount)
    return 0


def reserve_charge(card_id, amount):
    """★充值步真扣【前】原子预留一次额度。返回 (True, "") / (False, reason)。
       未跟踪(无次数无金额)且未限并发 = 永远 True(默认逐字节不变)。reason∈ no-card/capacity/concurrency。"""
    if not card_id:
        return (False, "no-card")
    with _CARD_LOCK, _file_lock(paths.POOL_FILE) as _lk:
        # ★F1 修:跨进程文件锁退化为无锁(超时/句柄耗尽/无法判锁龄)→ 无法保证原子预留 →
        #   宁可【本号不真扣】也不在无锁下并发预留(否则两 worker 可能都过容量/并发闸 → 超容量/超并发真扣)。fail-closed。
        if not getattr(_lk, "_held", True):
            log("[卡][充值] ⚠ reserve 取卡池锁退化为无锁 → 本号不真扣(安全,防无锁并发超扣): %s" % card_id)
            return (False, "lock-degraded")
        try:
            with open(paths.POOL_FILE, encoding="utf-8") as _f:
                pool = json.load(_f)
        except Exception:
            return (False, "no-pool")
        for c in pool:
            if (c.get("id") or c.get("number")) != card_id:
                continue
            rem = _card_charge_remaining(c, amount)   # 已扣已算的剩余次数(次数/金额两模式各自正确)
            inflight = int(c.get("chargeInflight") or 0)
            remaining = float("inf") if rem == float("inf") else (rem - inflight)
            conc_limit = int(c.get("chargeConcurrency") or 0) or float("inf")
            if remaining < 1:
                return (False, "capacity")
            if inflight >= conc_limit:
                return (False, "concurrency")
            c["chargeInflight"] = inflight + 1
            c["_inflightAt"] = int(time.time() * 1000)   # 与 Node Date.now() 同单位(ms),供 reap 用
            # 写失败【返回 False 不抛】→ 视为预留失败【不真扣】(安全方向:宁可不充也不在没持久化预留下真扣)。
            if not _atomic_write_json(paths.POOL_FILE, pool):
                log("[卡][充值] ⚠ reserve 落盘失败 → 视为预留失败、本号不真扣(安全): %s" % card_id)
                return (False, "write-fail")
            return (True, "")
        return (False, "no-card")


def commit_charge(card_id, amount):
    """真扣【成功】后提交:chargedTotal++、balance 按金额扣、在飞 -1。落盘失败【告警】不静默(真金白银去重凭证)。"""
    if not card_id:
        return
    with _CARD_LOCK, _file_lock(paths.POOL_FILE):
        try:
            with open(paths.POOL_FILE, encoding="utf-8") as _f:
                pool = json.load(_f)
        except Exception:
            log("[卡][充值] ⚠ commit 读卡池失败,容量账本可能不准: %s" % card_id)
            return
        for c in pool:
            if (c.get("id") or c.get("number")) != card_id:
                continue
            c["chargedTotal"] = int(c.get("chargedTotal") or 0) + 1
            if float(c.get("balance") or 0) > 0:
                c["balance"] = max(0, round(float(c.get("balance")) - float(amount or 0), 2))
            c["chargeInflight"] = max(0, int(c.get("chargeInflight") or 0) - 1)
            break
        # ★_atomic_write_json 失败【返回 False 不抛】→ 必须查返回值告警(真金白银去重凭证)。
        #   失败=chargedTotal/balance 未持久化(真扣已发生)→ 该卡容量账本可能多算 1 次,reap 也救不回这次漏计。
        if not _atomic_write_json(paths.POOL_FILE, pool):
            log("[卡][充值] ⚠⚠ commit 落盘失败 → 卡 %s 的 chargedTotal/balance 未持久化,容量账本可能多算 1 次(真扣已发生,请人工核对该卡余额)" % card_id)


def release_charge(card_id):
    """真扣【失败/异常/未发生】释放预留:在飞 -1(额度还回,不计 chargedTotal)。"""
    if not card_id:
        return
    with _CARD_LOCK, _file_lock(paths.POOL_FILE):
        try:
            with open(paths.POOL_FILE, encoding="utf-8") as _f:
                pool = json.load(_f)
        except Exception:
            return
        for c in pool:
            if (c.get("id") or c.get("number")) != card_id:
                continue
            c["chargeInflight"] = max(0, int(c.get("chargeInflight") or 0) - 1)
            break
        # 写失败【返回 False 不抛】→ 告警。预留没释放干净也不致命:reap_stale_inflight 会兜底回收(只是该卡暂少 1 个名额)。
        if not _atomic_write_json(paths.POOL_FILE, pool):
            log("[卡][充值] ⚠ release 落盘失败,预留可能未释放(将由 reap 兜底回收,该卡暂少 1 名额): %s" % card_id)


def reap_stale_inflight(max_age_ms=600000):
    """回收崩溃泄漏的在飞预留:超 max_age_ms 未提交/释放的卡 inflight 清零。返回回收数。"""
    age = 600000 if max_age_ms is None else max(0, int(max_age_ms))
    now = int(time.time() * 1000)
    with _CARD_LOCK, _file_lock(paths.POOL_FILE):
        try:
            with open(paths.POOL_FILE, encoding="utf-8") as _f:
                pool = json.load(_f)
        except Exception:
            return 0
        reaped = 0
        for c in pool:
            inflight = int(c.get("chargeInflight") or 0)
            at = c.get("_inflightAt")
            if inflight > 0 and (not at or (now - int(at)) >= age):
                reaped += inflight
                c["chargeInflight"] = 0
                c.pop("_inflightAt", None)
        if reaped:
            if not _atomic_write_json(paths.POOL_FILE, pool):
                log("[卡][充值] ⚠ reap 落盘失败,在飞预留未清(下次启动会再试)")
        return reaped


def fundable_count(amount):
    """整池按当前充值额还能真充几次:Σ active 卡 min(剩余绑定数, 剩余充值容量)。未跟踪卡=仅按绑定数计。与 Node fundableCount 同口径。"""
    try:
        with open(paths.POOL_FILE, encoding="utf-8") as _f:
            pool = json.load(_f)
    except Exception:
        return 0
    n = 0
    for c in (pool if isinstance(pool, list) else []):
        if c.get("status") != "active":
            continue
        bind_left = max(0, int(c.get("maxUses") or 1) - int(c.get("usedCount") or 0))
        rem = _card_charge_remaining(c, amount)
        charge_left = bind_left if rem == float("inf") else rem
        n += min(bind_left, charge_left)
    return n


def list_active_cards():
    """给页面内卡片面板用:列出所有 active 且有余次的卡的【展示字段】(不含 PAN,安全)。
       返回 [{id,last4,bin,bound,used,max}, …](按已绑次数倒序,再按段)。"""
    try:
        with open(paths.POOL_FILE, encoding="utf-8") as _f:
            pool = json.load(_f)
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
        with open(paths.POOL_FILE, encoding="utf-8") as _f:
            pool = json.load(_f)
    except Exception:
        return None
    for c in (pool if isinstance(pool, list) else []):
        if (c.get("id") or c.get("number")) == cid:
            if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1):
                return c
            return None
    return None


__all__ = [
    "_PROXY_LOCK", "proxy_ok", "mark_proxy_result", "proxy_retired",
    "_ZIP_LOCK", "mark_zip_result", "_TAXFREE_ZIP_STATE", "zip_report",
    "_CARD_LOCK", "_bin_of", "_read_bin_usage", "_bin_today", "_save_bin_usage", "load_card",
    "_hcaptcha_file", "load_hcaptcha_hits", "mark_hcaptcha",
    "_bad_mailbox_file", "load_bad_mailboxes", "is_bad_mailbox", "mark_bad_mailbox",
    "_verify_fail_file", "load_verify_fails", "mark_verify_fail", "clear_verify_fail", "count_bad_in_domain",
    "mark_card_result", "note_decline_code", "list_active_cards", "get_card_by_id",
    # 充值容量账本 + 原子预留
    "get_card_capacity", "reserve_charge", "commit_charge", "release_charge", "reap_stale_inflight", "fundable_count",
]
