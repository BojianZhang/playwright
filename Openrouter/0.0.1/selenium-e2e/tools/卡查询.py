#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 卡查询：给一个卡号（带不带空格都行），告诉你这是卡池里的哪张卡、全部字段，
#        以及【现在 load_card 会不会真的选用它】（关键：选卡只看 status/usedCount/maxUses,
#        不看 disabledReason —— 所以 status=active 但 disabledReason=manual-removed 的卡仍会被选中）。
# 只读，不改卡池。不引 common（不依赖 selenium，最小环境也能跑）。
#
# 用法:
#   python 卡查询.py 4914 2602 1874 1194        # 粘贴带空格的卡号 → 识别这一张
#   python 卡查询.py 4111111111111111           # 完整卡号（无空格）
#   python 卡查询.py 4111111111111111 4111111111111111   # 一次查多张（各自完整卡号）
#   python 卡查询.py 4469                        # 4 位 → 按 last4 查
#   python 卡查询.py                             # 不给参数 → 列全卡池一览(谁现在可用一目了然)
#   python 卡查询.py --all                       # 同上,强制全量一览
import sys, os, json, re, datetime

# Windows 控制台默认 GBK，中文/符号会崩。强制 stdout 走 UTF-8（PowerShell/UTF-8 终端正常显示）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tools/→父目录 selenium-e2e(移动后锚定,与移动前同值)
ROOT = os.path.normpath(os.path.join(HERE, ".."))
POOL_FILE = os.path.join(ROOT, "data", "card-pool.json")


def digits(s):
    """取纯数字（允许 '4496...|03/30|819' 这种带过期/CVC 的整行，只要竖线前那段）。"""
    return re.sub(r"\D", "", str(s).split("|")[0])


def load_pool():
    with open(POOL_FILE, "r", encoding="utf-8") as f:
        pool = json.load(f)
    return pool if isinstance(pool, list) else []


def selectable(c, now_iso):
    """复刻 common.load_card 的取卡判定，返回 (会不会被选, 原因, 是否在冷却)。
       规则: status=='active' 且 usedCount<maxUses 才进候选；冷却中只是【延后】不是排除。
       注意: disabledReason / disabledAt 不参与判定 —— 选卡器根本不看它们。"""
    used = c.get("usedCount", 0)
    mx = c.get("maxUses", 1)
    cu = c.get("cooldownUntil")
    cooling = bool(cu and cu > now_iso)   # ISO 串可直接字典序比较
    if c.get("status") != "active":
        return False, f"status={c.get('status')!r}（非 active，不会被选）", cooling
    if used >= mx:
        return False, f"已用满 {used}/{mx} 次", cooling
    if cooling:
        return True, f"会被选（但在冷却到 {cu}，会优先轮别的卡，全在冷却时仍会回头用它）", cooling
    return True, f"会被选（active，余 {mx - used}/{mx} 次）", cooling


def show_one(c, now_iso):
    sel, why, _ = selectable(c, now_iso)
    mark = "[会被选用]" if sel else "[不会被选用]"
    print(f"  id          : {c.get('id')}")
    print(f"  卡号        : {c.get('number')}   (last4 {c.get('last4')})")
    print(f"  有效期/CVC  : {c.get('expMonth')}/{c.get('expYear')}   CVC {c.get('cvc')}")
    print(f"  次数        : usedCount={c.get('usedCount',0)}  successCount={c.get('successCount',0)}  maxUses={c.get('maxUses',1)}")
    print(f"  status      : {c.get('status')}")
    if c.get("disabledReason") or c.get("disabledAt"):
        print(f"  disabled*   : reason={c.get('disabledReason')}  at={c.get('disabledAt')}  <- 仅备注，不影响选卡")
    if c.get("pausedReason") or c.get("pausedAt"):
        print(f"  paused*     : reason={c.get('pausedReason')}  at={c.get('pausedAt')}")
    if c.get("lastResult") is not None or c.get("lastUsedAt"):
        print(f"  最近一次    : lastResult={c.get('lastResult')}  lastUsedAt={c.get('lastUsedAt')}")
    if c.get("captchaCount"):
        print(f"  captchaCount: {c.get('captchaCount')}")
    if c.get("cooldownUntil"):
        print(f"  cooldown    : {c.get('cooldownUntil')}")
    print(f"  >>  现在 {mark} —— {why}")


def list_all(pool, now_iso):
    print(f"卡池共 {len(pool)} 张  (文件 {POOL_FILE})\n")
    hdr = f"{'id':<12} {'last4':<6} {'status':<10} {'用量':<8} {'选用?':<6} 说明"
    print(hdr)
    print("-" * len(hdr))
    n_sel = 0
    for c in pool:
        sel, why, _ = selectable(c, now_iso)
        if sel:
            n_sel += 1
        use = f"{c.get('usedCount',0)}/{c.get('maxUses',1)}"
        print(f"{str(c.get('id')):<12} {str(c.get('last4')):<6} {str(c.get('status')):<10} {use:<8} {'是' if sel else '否':<6} {why}")
    print(f"\n现在会被 load_card 选用的卡: {n_sel} / {len(pool)} 张")


def parse_queries(args):
    """把命令行参数解析成查询项。支持:
       - 多个【各自完整】的卡号(>=12位)
       - 一个被空格拆成多段的卡号(全是短段,拼起来 13~19 位)
       - 单个 4 位 → 按 last4 查"""
    toks = [a for a in args if a.strip()]
    full = [digits(t) for t in toks if len(digits(t)) >= 12]
    if full:
        return [("full", n) for n in full]
    combined = "".join(digits(t) for t in toks)
    if 13 <= len(combined) <= 19:
        return [("full", combined)]
    last4 = [digits(t) for t in toks if len(digits(t)) == 4]
    if last4:
        return [("last4", n) for n in last4]
    return []


def main(argv):
    args = argv[1:]
    if not os.path.exists(POOL_FILE):
        print(f"找不到卡池文件: {POOL_FILE}")
        return 2
    pool = load_pool()
    # 与 common.py 同格式("...Z" 无偏移)，便于和 cooldownUntil 字符串字典序比较；避免 utcnow 弃用警告
    now_iso = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z"

    if not args or args[0] in ("--all", "-a", "all"):
        list_all(pool, now_iso)
        return 0

    queries = parse_queries(args)
    if not queries:
        print("没认出有效卡号。示例: python 卡查询.py 4914 2602 1874 1194")
        return 2

    for kind, q in queries:
        print(f"\n查询 {kind}: {q}")
        if kind == "full":
            hits = [c for c in pool if digits(c.get("number", "")) == q]
            if not hits:  # 退而求其次:按结尾匹配(粘贴时少打几位也能找)
                hits = [c for c in pool if digits(c.get("number", "")).endswith(q) or q.endswith(digits(c.get("number", "")))]
        else:  # last4
            hits = [c for c in pool if str(c.get("last4")) == q or digits(c.get("number", "")).endswith(q)]
        if not hits:
            print("  X 卡池里没有这张卡。")
            continue
        if len(hits) > 1:
            print(f"  匹配到 {len(hits)} 张:")
        for c in hits:
            show_one(c, now_iso)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
