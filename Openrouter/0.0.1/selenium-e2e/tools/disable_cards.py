#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 把指定卡号从卡池【禁用】(status=disabled,load_card 不再选中,已分配该卡的号会自动改派)。
# 卡数据保留(留审计),只是不再启用。
# 用法:
#   python disable_cards.py 4111111111111111 4111111111111111 ...   # 直接给卡号(可带 |MM/YY|cvc)
#   python disable_cards.py --file nums.txt                          # 每行一个卡号
import sys, os, json, re, datetime, tempfile
import os as _os, sys as _sys  # tools/ 下直接跑时,把父目录 selenium-e2e/ 插进 sys.path 让 import common 可解析
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import common


def norm(s):
    """取卡号的纯数字(允许 '4496...|03/30|819' 这种带过期/CVC 的整行)。"""
    return re.sub(r"\D", "", str(s).split("|")[0])


def main(argv):
    args = argv[1:]
    nums = set()
    if args and args[0] == "--file":
        for l in open(args[1], encoding="utf-8"):
            n = norm(l)
            if len(n) >= 12:
                nums.add(n)
    else:
        for a in args:
            n = norm(a)
            if len(n) >= 12:
                nums.add(n)
    if not nums:
        print("没给有效卡号。用法: python disable_cards.py <卡号...> 或 --file nums.txt")
        return

    with common._CARD_LOCK:
        pool = json.load(open(common.POOL_FILE, encoding="utf-8"))
        now = datetime.datetime.utcnow().isoformat() + "Z"
        hit, remaining = [], set(nums)
        for c in pool:
            if c.get("number") in nums:
                c["status"] = "disabled"
                c["disabledReason"] = "manual-removed"
                c["disabledAt"] = now
                hit.append(str(c.get("last4") or c.get("number", "")[-4:]))
                remaining.discard(c.get("number"))
        # 原子写(temp + replace),避免并发进程读到半截文件
        d = os.path.dirname(common.POOL_FILE)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(pool, f, ensure_ascii=False, indent=2)
        os.replace(tmp, common.POOL_FILE)

    active = [c for c in pool if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)]
    print("已禁用 %d 张: %s" % (len(hit), ", ".join("**" + h for h in hit)))
    if remaining:
        print("卡池里没找到(已忽略) %d 个: %s" % (len(remaining), ", ".join("..." + m[-4:] for m in remaining)))
    print("卡池剩余 active 可用: %d 张 (容量约 %d 个号)" % (len(active), sum(c.get("maxUses", 1) - c.get("usedCount", 0) for c in active)))


if __name__ == "__main__":
    main(sys.argv)
