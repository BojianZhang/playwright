#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 实时事件流:tail state/hybrid_results.jsonl,每出一个号的【终态】就打一行(成功+各类失败全覆盖)。
# 专给监控用(Claude 的 Monitor 工具 / 人眼盯屏):每行一个事件,行缓冲即时刷出。
#   python watch_results.py            从现在起只看新结果(批量跑时盯实时进展)
#   python watch_results.py --all      把已有结果也回放一遍(对账历史)
#   python watch_results.py --poll 2   轮询间隔秒(默认1)
# 覆盖所有终态(成功不是唯一信号):绑成 / server-error / unknown / declined / hcaptcha /
#   needphone / consec-server-error / no-good-proxy / 浏览器崩 / 被拒banned / 冷却 / 异常。
import sys, os, json, time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tools/→父目录 selenium-e2e(移动后锚定,与移动前同值)
RES = os.path.join(HERE, "state", "hybrid_results.jsonl")


def classify(r):
    """把一条结果映射成 (标记, 说明)。覆盖成功与各类失败,绝不漏报失败(静默≠成功)。"""
    st = r.get("steps") or {}
    card = st.get("card")
    rots = len(r.get("rotations") or [])
    rotnote = (" rot=%d" % rots) if rots else ""
    if card == "card-bound":
        return "✓ 绑成", "card-bound%s" % rotnote
    if r.get("not_allowed"):
        return "⛔ 被拒", "banned(not-allowed)"
    if r.get("giveup_permanent"):
        return "⨯ 永久放弃", str(st.get("giveup") or st.get("card") or "permanent")
    if r.get("cooldown_until") and r["cooldown_until"] > time.time():
        mins = int((r["cooldown_until"] - time.time()) / 60)
        return "⏸ 冷却", "%s 还剩%d分 (%s)" % (st.get("giveup") or card or "", mins, rotnote.strip())
    err = str(r.get("error") or "")
    if any(s in err.lower() for s in ("invalid session", "no such window", "not reachable", "disconnected", "session deleted")):
        return "☠ 浏览器崩", err[:50]
    giveup = st.get("giveup")
    if giveup:
        m = {"consec-server-error": "连续502(疑卡velocity)", "no-good-proxy": "无可用代理可切",
             "hcaptcha": "校验框过不去", "server-error": "加卡卡顿(Saving)"}.get(giveup, giveup)
        return "✗ 失败", "%s%s" % (m, rotnote)
    if card:
        return "✗ 失败", "%s%s" % (card, rotnote)
    if err:
        return "✗ 异常", err[:50]
    return "· 进行中", st.get("resume") or "?"


def line(r):
    tag, note = classify(r)
    em = (r.get("email") or "?").split("@")[0]
    t = (r.get("timings") or {}).get("total")
    tnote = (" %.0fs" % t) if t else ""
    return "%s  %-12s %-26s %s%s" % (time.strftime("%H:%M:%S"), tag, em, note, tnote)


def main():
    replay_all = "--all" in sys.argv
    poll = 1.0
    if "--poll" in sys.argv:
        try:
            poll = float(sys.argv[sys.argv.index("--poll") + 1])
        except Exception:
            pass
    # 起始位置:--all 从头;否则从当前文件末尾(只看新事件)
    pos = 0
    if not replay_all and os.path.exists(RES):
        pos = os.path.getsize(RES)
    while True:
        try:
            if os.path.exists(RES):
                size = os.path.getsize(RES)
                if size < pos:       # 文件被重建/截断 → 从头
                    pos = 0
                if size > pos:
                    with open(RES, "r", encoding="utf-8") as f:
                        f.seek(pos)
                        for l in f:
                            l = l.strip()
                            if not l:
                                continue
                            try:
                                r = json.loads(l)
                            except Exception:
                                continue
                            print(line(r), flush=True)
                        pos = f.tell()
        except Exception as e:
            print("%s  [watch] 读取异常: %s" % (time.strftime("%H:%M:%S"), str(e)[:60]), flush=True)
        time.sleep(poll)


if __name__ == "__main__":
    main()
