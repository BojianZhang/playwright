#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# IP/代理质量评分 —— 按每个代理的历史加卡战绩(state/proxy-stats.json)打质量分(0-100)、分档、排名,
# 帮你挑出【好 IP 给更重的任务】、揪出【烧热的 IP 该歇/换】。
#
# 评分思路(只看"代理能不能让卡顺利绑上",declined 是卡的问题不算代理头上):
#   card-bound 强加分;hcaptcha 重扣(IP信任分低的头号信号);card-502 扣;server-error/unknown/fill-fail 轻扣;
#   declined 不计(卡级)。样本太少标"待测"。连败≥阈值=已退役。
#
# 用法:
#   python proxy_score.py                      # 打印排名报表
#   python proxy_score.py --proxies proxies.live.txt   # 映射回完整代理行
#   python proxy_score.py --export good.txt     # 导出 A+B 档(最好的在前)给流水线用
#   python proxy_score.py --top 20              # 只看前 20
#   python proxy_score.py --min-samples 3       # 只评样本≥N 的(默认1)
import os, sys, io, json, argparse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
STATS = os.path.join(HERE, "state", "proxy-stats.json")

# 各结果对"代理质量"的权重(declined=卡级,不算代理;dead=最差)
W = {"card-bound": 1.0, "hcaptcha": -0.8, "card-502": -0.5,
     "server-error": -0.25, "unknown": -0.4, "fill-fail": -0.4, "dead": -1.0, "declined": 0.0}
RETIRE_STREAK = int(os.environ.get("PROXY_RETIRE_STREAK", "5"))


def score_proxy(s):
    """传入一个代理的 stats dict → 返回 {score,tier,bind,total,bind_rate,hcap_rate,retired,...}。"""
    counts = {k: int(s.get(k, 0) or 0) for k in W}
    total = sum(counts.values())
    bind = counts["card-bound"]
    hcap = counts["hcaptcha"]
    retired = int(s.get("fail_streak", 0) or 0) >= RETIRE_STREAK
    if total == 0:
        return {"score": None, "tier": "未测试", "bind": 0, "total": 0,
                "bind_rate": 0.0, "hcap_rate": 0.0, "retired": retired}
    raw = sum(counts[k] * W[k] for k in W) / total          # -1..+1
    score = round(max(0.0, min(100.0, (raw + 1) / 2 * 100)))
    bind_rate = bind / total
    hcap_rate = hcap / total
    # 分档
    if retired:
        tier = "退役"
    elif total < 3:
        tier = "待测"                                       # 样本太少,质量未知 → 可继续试
    elif score >= 65 and bind >= 1 and hcap_rate < 0.35:
        tier = "A优质"                                      # 适合重任务/集中灌卡
    elif score >= 45:
        tier = "B可用"
    else:
        tier = "C差/烧热"                                   # 弹框多/绑不上 → 歇几天或换新IP
    return {"score": score, "tier": tier, "bind": bind, "total": total,
            "bind_rate": bind_rate, "hcap_rate": hcap_rate, "retired": retired,
            "card502": counts["card-502"], "declined": int(s.get("declined", 0) or 0),
            "last": s.get("last", "")}


def load_stats():
    try:
        return json.load(open(STATS, encoding="utf-8"))
    except Exception:
        return {}


def _full_line_map(proxy_file):
    """host:port → 完整代理行(host:port:user:pass),用于导出可直接用的代理清单。"""
    m = {}
    if proxy_file and os.path.exists(proxy_file):
        for l in open(proxy_file, encoding="utf-8"):
            l = l.strip()
            if not l or l.startswith("#"):
                continue
            parts = l.split(":")
            if len(parts) >= 2:
                m["%s:%s" % (parts[0], parts[1])] = l
    return m


def ranked(min_samples=1):
    """返回 [(key, scoreinfo)] 按分数降序(待测排中间,退役/差档靠后)。"""
    stats = load_stats()
    rows = []
    for k, s in stats.items():
        si = score_proxy(s)
        if si["total"] < min_samples:
            continue
        rows.append((k, si))
    # 排序键:A>B>待测>C>退役,同档按 score 降序、绑成多优先
    order = {"A优质": 0, "B可用": 1, "待测": 2, "C差/烧热": 3, "退役": 4}
    rows.sort(key=lambda kv: (order.get(kv[1]["tier"], 9),
                              -(kv[1]["score"] or 0), -kv[1]["bind"]))
    return rows


def report(proxy_file=None, top=None, min_samples=1):
    rows = ranked(min_samples)
    fmap = _full_line_map(proxy_file)
    import collections
    tc = collections.Counter(si["tier"] for _, si in rows)
    print("═" * 76)
    print("  IP 质量评分  (基于 %s, %d 个代理有战绩)" % (os.path.relpath(STATS, HERE), len(rows)))
    print("═" * 76)
    print("  %-22s %4s %5s %6s %6s %4s  %s" % ("IP:port", "分", "档", "绑成率", "弹框率", "样本", "战绩"))
    print("  " + "-" * 72)
    shown = rows[:top] if top else rows
    for k, si in shown:
        sc = si["score"] if si["score"] is not None else "-"
        tag = "★" if k in fmap else " "
        print("  %-22s %4s %-6s %5.0f%% %5.0f%% %4d  绑%d/502:%d/拒:%d %s" % (
            k, sc, si["tier"], si["bind_rate"] * 100, si["hcap_rate"] * 100,
            si["total"], si["bind"], si["card502"], si["declined"], tag))
    print("  " + "-" * 72)
    print("  汇总: " + " | ".join("%s %d" % (t, tc[t]) for t in ["A优质", "B可用", "待测", "C差/烧热", "退役"] if tc[t]))
    a = tc["A优质"]; c = tc["C差/烧热"] + tc["退役"]
    print("\n  建议:")
    if a:
        print("    · 重任务/集中灌卡 → 优先用 A优质档这 %d 个 IP" % a)
    if c:
        print("    · C差/退役档这 %d 个 IP 已烧热 → 歇几天或换新住宅IP(继续用只会一直弹框)" % c)
    if tc["待测"]:
        print("    · 待测 %d 个样本太少 → 可继续派任务摸清质量" % tc["待测"])
    return rows


def export_good(out_file, proxy_file, min_samples=1):
    """把 A+B 档(最好的在前)导出成可直接喂流水线的代理清单。需要 --proxies 映射完整行。"""
    rows = ranked(min_samples)
    fmap = _full_line_map(proxy_file)
    good = [k for k, si in rows if si["tier"] in ("A优质", "B可用")]
    lines = [fmap[k] for k in good if k in fmap]
    with open(out_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    print("已导出 %d 个 A+B 档代理(最好的在前)→ %s" % (len(lines), out_file))
    if len(good) > len(lines):
        print("  (%d 个在 stats 里但 proxies 文件没匹配到完整行,已跳过)" % (len(good) - len(lines)))
    return lines


def snapshot(out=None, proxy_file=None):
    """把当前评分快照写到 state/proxy-scores.json(供程序/后续读取),返回 rows。批量跑完自动调。"""
    out = out or os.path.join(HERE, "state", "proxy-scores.json")
    rows = ranked(min_samples=1)
    data = {"proxies": [
        {"proxy": k, "score": si["score"], "tier": si["tier"], "bind": si["bind"],
         "total": si["total"], "bind_rate": round(si["bind_rate"], 3),
         "hcap_rate": round(si["hcap_rate"], 3), "retired": si["retired"]}
        for k, si in rows]}
    try:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    except Exception:
        pass
    return rows


def after_batch(log=print, proxy_file=None):
    """批量跑完自动打分:打印精简排名 + 写 state/proxy-scores.json。供 hybrid_run 收尾调用。"""
    rows = snapshot(proxy_file=proxy_file)
    import collections
    tc = collections.Counter(si["tier"] for _, si in rows)
    log("─" * 60)
    log("[IP评分] 跑完按实时战绩打分(%d 个有战绩代理):" % len(rows))
    log("  汇总: " + " | ".join("%s %d" % (t, tc[t]) for t in ["A优质", "B可用", "待测", "C差/烧热", "退役"] if tc[t]))
    a = [k for k, si in rows if si["tier"] == "A优质"][:5]
    if a:
        log("  A优质(重任务优先用): " + ", ".join(a))
    burned = [k for k, si in rows if si["tier"] in ("C差/烧热", "退役")][:6]
    if burned:
        log("  烧热建议歇/换: " + ", ".join(burned) + (" …" if tc["C差/烧热"] + tc["退役"] > 6 else ""))
    log("  完整报表: python proxy_score.py --proxies <代理文件>")
    log("─" * 60)
    return rows


def main():
    ap = argparse.ArgumentParser(description="IP/代理质量评分 + 分档 + 排名")
    ap.add_argument("--proxies", help="代理文件(host:port:user:pass),用于映射完整行/导出")
    ap.add_argument("--export", help="导出 A+B 档代理到此文件(最好的在前)")
    ap.add_argument("--top", type=int, help="只看前 N 个")
    ap.add_argument("--min-samples", type=int, default=1, help="只评样本≥N 的代理(默认1)")
    a = ap.parse_args()
    report(a.proxies, a.top, a.min_samples)
    if a.export:
        if not a.proxies:
            print("\n⚠ --export 需要配合 --proxies 才能拿到完整代理行")
        else:
            print()
            export_good(a.export, a.proxies, a.min_samples)


if __name__ == "__main__":
    main()
