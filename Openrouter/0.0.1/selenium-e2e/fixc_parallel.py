#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Fix C 并行绑卡跑器:N 个环境【同时】用原生CDP绑卡。
# 每个浏览器各连各的 CDP websocket、各发各的 Input 事件,不抢物理鼠标、不要窗口前台 → 真并行
# (这正是 Fix C 比 Fix B/pyautogui 强的地方:后者单鼠标+前台,只能串行)。
# 用法:
#   python fixc_parallel.py <env1> <env2> ... [--workers N] [--card 卡号 MMYY CVC ZIP]
#   不给 --card → 自动从卡池挑一张干净卡,整批共用(1卡→10号,符合实测 10:1)。
import sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
import fixc_bind


def parse_args(argv):
    envs, workers, card = [], 4, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--workers":
            workers = int(argv[i + 1]); i += 2
        elif a == "--card":
            card = tuple(argv[i + 1:i + 5]); i += 5
        else:
            envs.append(a); i += 1
    return envs, workers, card


def main():
    envs, workers, card = parse_args(sys.argv[1:])
    if not envs:
        print("用法: python fixc_parallel.py <env1> <env2> ... [--workers N] [--card 卡号 MMYY CVC ZIP]")
        return
    if card:
        num, exp, cvc, zipc = card
    else:
        num, exp, cvc, zipc, _ = fixc_bind._pick_clean_card()
    last4 = num[-4:]
    workers = min(workers, len(envs))
    print("并行绑卡:%d 个环境,共用卡 ••%s,workers=%d(同时最多这么多在跑)" % (len(envs), last4, workers), flush=True)

    t0 = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fixc_bind.bind_one, e, num, exp, cvc, zipc, 25, e): e for e in envs}
        for f in as_completed(futs):
            try:
                results.append(f.result())
            except Exception as e:
                results.append({"env": futs[f], "last4": last4, "bound": False, "reason": "线程异常:" + str(e)[:50]})

    ok = [r for r in results if r.get("bound")]
    cap_yes = [r for r in results if r.get("captcha")]
    print("\n===== 并行绑卡汇总(耗时 %.0fs)=====" % (time.time() - t0), flush=True)
    for r in results:
        print("  %-10s ••%s → %s  弹验证框=%s  %s" % (r.get("env"), r.get("last4"),
              "✅ 绑成" if r.get("bound") else "❌ 没绑", r.get("captcha"), r.get("reason")), flush=True)
    print("★ 成功 %d / %d(1 张卡并行绑了 %d 个号);并发中弹验证框的 %d 个" % (
        len(ok), len(results), len(ok), len(cap_yes)), flush=True)


if __name__ == "__main__":
    main()
