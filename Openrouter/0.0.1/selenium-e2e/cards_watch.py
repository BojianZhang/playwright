#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 实时卡片面板:盯 card-pool.json,展示每张卡【已绑几次/余量/状态/段】,并高亮【当前正在用的卡】
# (从 state/_vol.log 最新一条 "分配卡 ••XXXX" 解析)。绑卡时另开一个终端跑着它,实时看哪张卡绑了几次。
#   python cards_watch.py            每 3 秒刷新
#   python cards_watch.py 5          每 5 秒刷新
#   python cards_watch.py 3 xx.log   指定日志文件(默认 state/_vol.log)
import sys, os, json, time, re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
import common
POOL = common.POOL_FILE
DEFAULT_LOG = os.path.join(HERE, "state", "_vol.log")


def _last4(c):
    return str(c.get("last4") or c.get("number", ""))[-4:]


def _bin(c):
    return (c.get("number") or "")[:6]


def _cool_min(c, now):
    """冷却剩余分钟(0=没冷却)。"""
    cu = c.get("cooldownUntil")
    if not cu:
        return 0
    try:
        import datetime
        dt = datetime.datetime.fromisoformat(str(cu).replace("Z", ""))
        return max(0, int((dt - now).total_seconds() / 60) + 1)
    except Exception:
        return 0


def current_card_last4(logfile):
    """从日志尾部解析最新一条 '分配卡 ••1234' → 当前正在用的卡末4位。"""
    try:
        with open(logfile, encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()[-500:]
    except Exception:
        return None
    last4 = None
    for l in lines:
        m = re.search(r"分配卡\s*••\s*(\d{4})", l)
        if m:
            last4 = m.group(1)
    return last4


def render(refresh, logfile):
    while True:
        try:
            pool = json.load(open(POOL, encoding="utf-8"))
        except Exception:
            pool = []
        cur = current_card_last4(logfile)
        cur_card = None
        for c in pool:
            if _last4(c) == cur:
                cur_card = c
                break

        os.system("cls" if os.name == "nt" else "clear")
        print("=" * 72)
        print("  实时卡片面板  %s   每%ds刷新  Ctrl-C退出" % (time.strftime("%H:%M:%S"), refresh))
        print("=" * 72)

        # —— 当前用卡:醒目展示"已绑几次" ——
        if cur_card is not None:
            print(">> 当前用卡 ••%s  段%s  【已绑 %d 次】  余量 %d/%d  状态 %s  最近 %s" % (
                _last4(cur_card), _bin(cur_card),
                cur_card.get("successCount", 0),
                cur_card.get("usedCount", 0), cur_card.get("maxUses", 1),
                cur_card.get("status", "?"), cur_card.get("lastResult", "-")))
        elif cur:
            print(">> 当前用卡 ••%s (卡池里没找到这张)" % cur)
        else:
            print(">> 当前用卡: —(还没分配/没在跑)")
        print("-" * 72)

        # —— 汇总 ——
        seg = defaultdict(lambda: {"cards": 0, "active": 0, "bound": 0, "used": 0})
        total_bound = 0
        for c in pool:
            b = _bin(c)
            sc = c.get("successCount", 0)
            seg[b]["cards"] += 1
            seg[b]["bound"] += sc
            seg[b]["used"] += c.get("usedCount", 0)
            total_bound += sc
            if c.get("status") == "active":
                seg[b]["active"] += 1
        print("累计绑成(全卡 successCount 之和): %d 次" % total_bound)
        print("各卡段(段 / active可用 / 累计绑成 / 用量):")
        for b, s in sorted(seg.items(), key=lambda x: -x[1]["bound"]):
            flag = "  🔥0绑成" if (s["bound"] == 0 and s["used"] >= 5) else ""
            print("   段%-7s active%-3d  绑成%-4d  用量%-4d%s" % (b, s["active"], s["bound"], s["used"], flag))
        print("-" * 72)

        # —— 可用卡明细:没冷却的在前(按已绑倒序),冷却中的排后面(标剩余分钟),高亮当前 ——
        import datetime as _dt
        now = _dt.datetime.utcnow()
        actives = [c for c in pool if c.get("status") == "active"]
        n_cool = sum(1 for c in actives if _cool_min(c, now) > 0)
        n_ready = len(actives) - n_cool
        print("可用卡明细(🟢可用 %d 张 / ❄冷却中 %d 张,最多列30):" % (n_ready, n_cool))
        print("   %-9s %-8s %-6s %-9s %-12s %s" % ("末4位", "段", "已绑", "余量", "最近结果", "状态"))
        rows = sorted(actives, key=lambda c: (_cool_min(c, now) > 0, -c.get("successCount", 0), _bin(c)))
        for c in rows[:30]:
            cm = _cool_min(c, now)
            state = ("❄冷却%dm" % cm) if cm > 0 else "🟢可用"
            mark = " ◀当前" if (cur and _last4(c) == cur) else ""
            print("   ••%-7s %-8s %-6d %d/%-7d %-12s %s%s" % (
                _last4(c), _bin(c), c.get("successCount", 0),
                c.get("usedCount", 0), c.get("maxUses", 1),
                c.get("lastResult", "-"), state, mark))

        dis = [c for c in pool if c.get("status") != "active"]
        print("-" * 72)
        print("🟢可用 %d / ❄冷却 %d / 已禁用 %d(仅 declined 才禁)| active 总 %d 张" % (
            n_ready, n_cool, len(dis), len(actives)))
        time.sleep(refresh)


if __name__ == "__main__":
    args = sys.argv[1:]
    refresh = 3
    logfile = DEFAULT_LOG
    for a in args:
        if a.isdigit():
            refresh = int(a)
        else:
            logfile = a if os.path.isabs(a) else os.path.join(HERE, a)
    try:
        render(max(1, refresh), logfile)
    except KeyboardInterrupt:
        pass
