#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# z.ai 滑块【实时监控】—— tail state/slider-trace.log,按 AdsPower 环境聚合每个号的实时状态。
#
# 文件定位：GLM/0.0.1/selenium-e2e/tools/slider_monitor.py
# 用法：    python tools/slider_monitor.py            # 实时刷新(默认 1s)
#           python tools/slider_monitor.py --once     # 打印一次快照就退出(给脚本/CI 用)
#           python tools/slider_monitor.py --stuck 25 # 静默超过 25s 判「卡住」(默认 25)
#
# 解决「卡死? 谁的锅? 拉到位置还报错?」:不靠猜,直接把 slider.py 落的逐步 trace 渲染成
#   ① 每个号实时:阶段 / 缺口三法值(sat·ncc·cap→选定) / 拖拽残差 / 判定 / 静默时长(卡住高亮)
#   ② 底部聚合诊断:★「落点已达标(<2px)却仍 FAIL」的次数 —— 这就是「坐标没问题、是行为/环境拒绝」的铁证。
#
# 零依赖、纯 stdlib。trace 由 services/slider.py 的 _trace() 持续追加(每号每步:开没开/缺口/拖了多少/过没过)。
# ═══════════════════════════════════════════════════════════════════════

import os
import re
import sys
import time

TRACE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state", "slider-trace.log")

# trace 行格式:  HH:MM:SS [env] message
_LINE = re.compile(r"^(\d\d):(\d\d):(\d\d)\s+\[([^\]]+)\]\s+(.*)$")
_DECIDE = re.compile(r"att(\d+)\s+缺口决策:\s+(.*?)\s+\|\s+sat=(.*?)\s+ncc=(.*?)\s+cap=(.*)$")
_DRAG = re.compile(r"att(\d+)\s+拖完\s+残差=([\-\d.?]+)\s+判定=(PASS|FAIL)")
_PHASE_MARK = re.compile(r"att(\d+)\s+▶(.*)$")   # slider.py 新增的阶段标记(等稳定图/CapSolver/拖拽/等验证)

# ── ANSI(Windows 10+ 终端支持;关掉色彩用 NO_COLOR=1)──
_NC = os.environ.get("NO_COLOR")
def _c(s, code):
    return s if _NC else "\x1b[%sm%s\x1b[0m" % (code, s)
RED = lambda s: _c(s, "31"); GRN = lambda s: _c(s, "32"); YEL = lambda s: _c(s, "33")
CYN = lambda s: _c(s, "36"); DIM = lambda s: _c(s, "90"); BOLD = lambda s: _c(s, "1")


def _secs(h, m, s):
    return int(h) * 3600 + int(m) * 60 + int(s)


def _now_secs():
    t = time.localtime()
    return t.tm_hour * 3600 + t.tm_min * 60 + t.tm_sec


def _fmt_gap(raw):
    """sat=(174, 6.77) / ncc=(174, 0.759, 0.398) / cap=152.0 / None → 紧凑显示首值。"""
    raw = (raw or "").strip()
    if raw in ("None", "", "?"):
        return "·"
    m = re.match(r"\(([-\d.]+)", raw)
    if m:
        return m.group(1).split(".")[0]
    return raw.split(".")[0]


def parse(path):
    """整文件解析(trace 封顶很小),按 env 聚合最新状态。返回 (envs_dict, landed_fail_count, total_drags)。"""
    envs = {}        # env -> state dict
    landed_fail = 0  # 残差<2px 却 FAIL 的次数(行为/环境拒绝铁证)
    total_drags = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return {}, 0, 0
    for ln in lines:
        m = _LINE.match(ln.rstrip("\n"))
        if not m:
            continue
        hh, mm, ss, env, msg = m.groups()
        ts = _secs(hh, mm, ss)
        st = envs.setdefault(env, {"phase": "—", "att": 0, "sat": "·", "ncc": "·", "cap": "·",
                                   "chosen": "", "resid": None, "verdict": "", "ts": ts, "done": False})
        st["ts"] = ts
        if "solve 开始" in msg:
            pm = re.search(r"provider=(\S+)\s+attempts=(\d+)", msg)
            st.update({"phase": "打开拼图", "att": 0, "resid": None, "verdict": "", "done": False,
                       "provider": pm.group(1) if pm else "?", "attempts": int(pm.group(2)) if pm else 0})
            continue
        if "solve 结束" in msg:
            st["done"] = True
            st["phase"] = GRN("✓通过") if "成功" in msg else RED("✗失败")
            continue
        dm = _DECIDE.search(msg)
        if dm:
            st.update({"att": int(dm.group(1)), "chosen": dm.group(2).strip()[:22],
                       "sat": _fmt_gap(dm.group(3)), "ncc": _fmt_gap(dm.group(4)), "cap": _fmt_gap(dm.group(5)),
                       "phase": "已认缺口"})
            continue
        gm = _DRAG.search(msg)
        if gm:
            total_drags += 1
            r = gm.group(2)
            try:
                rv = float(r)
            except Exception:
                rv = None
            verdict = gm.group(3)
            st.update({"att": int(gm.group(1)), "resid": rv, "verdict": verdict, "phase": "拖完待判"})
            if verdict == "PASS":
                # ★成功时 solve() 直接 return,不写「solve 结束」→ 必须在这里把它判为通过(否则漏计成功)。
                st["done"] = True
                st["phase"] = GRN("✓通过")
            if rv is not None and abs(rv) < 2.0 and verdict == "FAIL":
                landed_fail += 1
            continue
        pmk = _PHASE_MARK.search(msg)
        if pmk:
            st["att"] = int(pmk.group(1))
            st["phase"] = pmk.group(2).strip()[:18]
            continue
        if "控件在但没展开" in msg:
            st["phase"] = YEL("⚠浮层打不开")
            st["att"] = (re.search(r"att(\d+)", msg) and int(re.search(r"att(\d+)", msg).group(1))) or st["att"]
            continue
        if "页面空白" in msg:
            st["phase"] = YEL("⚠页面没加载")
            continue
        if "fail-fast" in msg or "总时限" in msg:
            st["phase"] = RED("✗fail-fast")
            continue
    return envs, landed_fail, total_drags


def render(envs, landed_fail, total_drags, stuck_after):
    now = _now_secs()
    rows = sorted(envs.items(), key=lambda kv: kv[1]["ts"], reverse=True)
    out = []
    out.append(BOLD("z.ai 滑块实时监控") + DIM("  (%s · 源 state/slider-trace.log · Ctrl+C 退出)" % time.strftime("%H:%M:%S")))
    out.append("")
    hdr = "%-10s %-14s %-3s  %4s %4s %4s  %-22s %7s %-6s %7s" % (
        "环境", "阶段", "试", "sat", "ncc", "cap", "选定", "残差", "判定", "静默")
    out.append(BOLD(hdr))
    out.append(DIM("─" * 96))
    running = passed = failed = stuck = 0
    for env, st in rows:
        silent = now - st["ts"]
        if silent < 0:
            silent += 86400  # 跨午夜
        done = st.get("done")
        if done:
            if "通过" in st["phase"]:
                passed += 1
            else:
                failed += 1
        else:
            running += 1
        is_stuck = (not done) and silent >= stuck_after
        if is_stuck:
            stuck += 1
        resid = "" if st["resid"] is None else ("%.1f" % st["resid"])
        verdict = st["verdict"]
        if verdict == "PASS":
            verdict = GRN("PASS")
        elif verdict == "FAIL":
            verdict = RED("FAIL")
        sil = "%ds" % silent
        if is_stuck:
            sil = RED(sil + "⛔")
        elif (not done) and silent >= max(8, stuck_after // 2):
            sil = YEL(sil)
        # 残差<2 却 FAIL → 标红提示「到位了还挂」
        if st["resid"] is not None and abs(st["resid"]) < 2.0 and st["verdict"] == "FAIL":
            resid = RED(resid + "✗")
        line = "%-10s %-14s %-3s  %4s %4s %4s  %-22s %7s %-6s %9s" % (
            env, st["phase"], "#%d" % st["att"] if st["att"] else "-",
            st["sat"], st["ncc"], st["cap"], st["chosen"], resid, verdict, sil)
        out.append(line)
    out.append(DIM("─" * 96))
    out.append("在跑 %s   通过 %s   失败 %s   %s" % (
        CYN(str(running)), GRN(str(passed)), RED(str(failed)),
        (RED("卡住 %d ⛔" % stuck) if stuck else DIM("卡住 0"))))
    # ★诊断结论:落点达标却 FAIL 的占比 → 一句话说清「谁的锅」。
    out.append("")
    if total_drags:
        pct = 100 * landed_fail // total_drags
        if landed_fail and pct >= 60:
            out.append(RED("★诊断: %d/%d 次拖拽【落点<2px 已到位 却仍 FAIL】(%d%%)" % (landed_fail, total_drags, pct)))
            out.append(RED("       → 缺口/坐标没问题。是阿里云【行为/环境】拒绝(CDP指纹·IP·拖拽轨迹),坐标再调也没用。"))
            out.append(DIM("       发力点应是环境(更干净的指纹/IP、降 CDP 暴露),不是继续调像素。"))
        elif landed_fail:
            out.append(YEL("★诊断: %d/%d 次落点已到位却 FAIL(%d%%) —— 部分是行为/环境拒绝;其余看缺口认读。" % (landed_fail, total_drags, pct)))
        else:
            out.append(GRN("★诊断: 暂无「到位却 FAIL」—— 失败多为缺口认读/打开阶段,可继续看 sat/ncc/cap 一致性。"))
    else:
        out.append(DIM("★诊断: 还没有拖拽记录(等第一次 att 拖完)…"))
    if stuck:
        out.append(YEL("⚠ %d 个号静默≥%ds = 卡死(多为失败后浮层打不开/页面没加载)。" % (stuck, stuck_after)))
    return "\n".join(out)


def main():
    once = "--once" in sys.argv
    stuck_after = 25
    if "--stuck" in sys.argv:
        try:
            stuck_after = int(sys.argv[sys.argv.index("--stuck") + 1])
        except Exception:
            pass
    if not os.path.exists(TRACE):
        print("找不到 trace 文件: %s\n(先跑一次带滑块的任务,slider.py 会自动落 trace)" % TRACE)
        if once:
            return
    try:
        while True:
            envs, lf, td = parse(TRACE)
            screen = render(envs, lf, td, stuck_after)
            if once:
                print(screen)
                return
            os.system("cls" if os.name == "nt" else "clear")
            sys.stdout.write(screen + "\n")
            sys.stdout.flush()
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
