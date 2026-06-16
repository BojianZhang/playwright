#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 运营仪表盘:一屏看全【现在该干什么】——总进度 / 冷却队列倒计时 / 被拒+永久放弃 / 卡池余量(够不够) /
# 今日各 BIN 战绩(哪个 BIN 被刷穿) / 各代理战绩(哪些IP退役/好用)。不用启动整条流水线,随时可跑。
# 用法:
#   python status.py [accounts.xxx.txt]          快照(给账号文件→只看这批;不给→看全部)
#   python status.py --watch [秒]  [accounts...]  实时刷新(默认每 15s 刷一次,Ctrl-C 退出)
import sys, os, json, time, datetime
import os as _os, sys as _sys  # tools/ 下直接跑时,把父目录 selenium-e2e/ 插进 sys.path 让 import common 可解析
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import common

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tools/→父目录 selenium-e2e(移动后锚定,与移动前同值)
RES = os.path.join(HERE, "state", "hybrid_results.jsonl")


def latest_by_email():
    out = {}
    if os.path.exists(RES):
        with open(RES, encoding="utf-8") as _f:
            for l in _f:
                try:
                    r = json.loads(l)
                except Exception:
                    continue
                if r.get("email"):
                    out[r["email"]] = r
    return out


def _scope_set(path):
    if not path:
        return None
    p = path if os.path.isabs(path) else os.path.join(HERE, path)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as _f:
        return set(l.split(":", 1)[0].strip() for l in _f if ":" in l and not l.startswith("#"))


def render(scope_path=None):
    latest = latest_by_email()
    scope = _scope_set(scope_path)
    emails = sorted(scope) if scope else sorted(latest.keys())
    now = time.time()
    bound = banned = perm = cooling = others = 0
    cd, durs = [], []
    for e in emails:
        r = latest.get(e)
        if not r:
            others += 1
            continue
        card = (r.get("steps") or {}).get("card")
        t = (r.get("timings") or {}).get("total")
        if t:
            durs.append(t)
        if card == "card-bound":
            bound += 1
        elif r.get("not_allowed"):
            banned += 1
        elif r.get("giveup_permanent"):
            perm += 1
        elif r.get("cooldown_until") and r["cooldown_until"] > now:
            cooling += 1
            cd.append((e, r["cooldown_until"]))
        else:
            others += 1
    tot = len(emails)
    print("=" * 60)
    print("  运营状态总览  (%s)%s" % (time.strftime("%Y-%m-%d %H:%M:%S"),
                                  ("  [%s]" % os.path.basename(scope_path)) if scope_path else ""))
    print("=" * 60)
    print("进度: 绑成 %d / 共 %d   (%.0f%%)" % (bound, tot, 100.0 * bound / tot if tot else 0))
    print("  被拒 %d  永久放弃 %d  冷却中 %d  待跑/其它 %d" % (banned, perm, cooling, others))
    if durs:
        durs.sort()
        print("  单号端到端耗时: 中位 %.0fs, 最长 %.0fs (有计时的 %d 个)" % (durs[len(durs) // 2], durs[-1], len(durs)))

    # 失败原因分布(一眼看撞的是啥墙:卡velocity / 代理 / 校验框 / 被拒)
    reasons = {}
    for e in emails:
        r = latest.get(e) or {}
        st = r.get("steps") or {}
        if st.get("card") == "card-bound" or r.get("not_allowed"):
            continue
        why = st.get("giveup") or st.get("card") or ("needphone" if st.get("needphone") else None) or r.get("error")
        if why:
            key = str(why)[:24]
            reasons[key] = reasons.get(key, 0) + 1
    if reasons:
        print("\n未绑成原因分布(最近一次):")
        for k, v in sorted(reasons.items(), key=lambda x: -x[1])[:8]:
            print("   %-26s %d" % (k, v))

    if cd:
        print("\n冷却队列(到点自动可跑):")
        for e, t in sorted(cd, key=lambda x: x[1])[:12]:
            print("   %-32s 还剩 %d 分钟" % (e.split("@")[0], max(0, int((t - now) / 60))))

    # 卡池
    try:
        with open(common.POOL_FILE, encoding="utf-8") as _f:
            pool = json.load(_f)
        act = [c for c in pool if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)]
        capleft = sum(c.get("maxUses", 1) - c.get("usedCount", 0) for c in act)
        runnable = max(0, tot - bound - banned - perm)
        binset = set((c.get("number") or "")[:6] for c in act)
        warn = ""
        if capleft < runnable:
            warn = "  ⚠️ 余量<待绑号数,补卡!"
        if len(binset) <= 1:
            warn += "  ⚠️ 只剩 %d 个 BIN(撞 velocity 墙,需多BIN卡)" % len(binset)
        print("\n卡池: active可用 %d 张 / %d 个不同 BIN, 剩余可绑 %d 个号%s" % (len(act), len(binset), capleft, warn))
    except Exception as e:
        print("卡池读取失败:", str(e)[:60])

    # per-BIN 今日战绩
    try:
        bu = common._read_bin_usage()
        today = datetime.date.today().isoformat()
        tu = bu.get(today, {})
        rows = []
        for b, s in tu.items():
            if isinstance(s, int):
                s = {"assigned": s}
            a = s.get("assigned", 0)
            bd = s.get("card-bound", 0)
            se = s.get("server-error", 0) + s.get("unknown", 0)
            rows.append((a, b, bd, se))
        if rows:
            print("\n今日各 BIN 战绩(发号/绑成/卡顿):")
            for a, b, bd, se in sorted(rows, reverse=True)[:12]:
                rate = (" 成功率%.0f%%" % (100.0 * bd / a)) if a else ""
                # 只在【够样本 且 0 绑成 且 卡顿过半】才判疑烧穿;有绑成只是低效不叫烧穿(避免误标好BIN)
                if a >= 5 and bd == 0 and se >= a * 0.5:
                    tag = "  🔥疑烧穿(0绑成)"
                elif a >= 6 and bd > 0 and bd < a * 0.2:
                    tag = "  ⚠️低效"
                else:
                    tag = ""
                print("   BIN %s: 发%-3d 绑%-3d 卡顿%-3d%s%s" % (b, a, bd, se, rate, tag))
    except Exception as e:
        print("bin-usage 读取失败:", str(e)[:60])

    # per-proxy 战绩(哪些IP退役/好用)
    try:
        with open(common.PROXY_STATS_FILE, encoding="utf-8") as _f:
            stats = json.load(_f)
        if stats:
            retire = int(os.environ.get("PROXY_RETIRE_STREAK", "5"))
            rows = []
            for k, s in stats.items():
                bd = s.get("card-bound", 0)
                se = s.get("server-error", 0)
                dead = s.get("dead", 0) + s.get("unknown", 0)
                fs = s.get("fail_streak", 0)
                rows.append((bd, se, dead, fs, k))
            print("\n各代理战绩(绑成/卡顿/死/连击):")
            live = sum(1 for r in rows if r[3] < retire)
            print("   可用 %d / 退役 %d (退役阈值连击≥%d)" % (live, len(rows) - live, retire))
            for bd, se, dead, fs, k in sorted(rows, key=lambda x: (-x[0], x[3]))[:12]:
                tag = "  ⛔退役" if fs >= retire else ("  ✓好用" if bd > 0 else "")
                print("   %-22s 绑%-2d 卡顿%-2d 死%-2d 连击%d%s" % (k, bd, se, dead, fs, tag))
    except Exception:
        pass  # 还没跑过/无文件 → 不显示


def main():
    args = sys.argv[1:]
    watch, interval, scope_path = False, 15, None
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--watch", "-w"):
            watch = True
            if i + 1 < len(args) and args[i + 1].isdigit():
                interval = int(args[i + 1]); i += 1
        elif not a.startswith("-"):
            scope_path = a
        i += 1
    if not watch:
        render(scope_path)
        return
    try:
        while True:
            os.system("cls" if os.name == "nt" else "clear")
            render(scope_path)
            print("\n(每 %ds 刷新 · Ctrl-C 退出)" % interval)
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n已退出监控。")


if __name__ == "__main__":
    main()
