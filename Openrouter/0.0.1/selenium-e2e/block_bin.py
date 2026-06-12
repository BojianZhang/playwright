#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 拉黑卡段 + 禁用该段所有卡 + 清掉指向它的账号分配。一条命令搞定坏卡段。
# 用法:
#   python block_bin.py 4111111111111111           # 给完整卡号,自动取前6位BIN
#   python block_bin.py 539502 532959              # 直接给6位BIN,可多个
import sys, io, os, json, datetime, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import common

HERE = os.path.dirname(os.path.abspath(__file__))
BL = os.path.join(HERE, "card-blacklist-bins.txt")


def main():
    bins = []
    for a in sys.argv[1:]:
        d = "".join(ch for ch in a if ch.isdigit())
        if len(d) >= 6:
            bins.append(d[:6])
    if not bins:
        print("用法: python block_bin.py <卡号或6位BIN> [更多...]")
        return
    bins = list(dict.fromkeys(bins))   # 去重保序

    # 1) 加黑名单(load_card 取卡强制跳过)
    existing = set()
    if os.path.exists(BL):
        for l in open(BL, encoding="utf-8"):
            s = l.strip()
            if s and not s.startswith("#"):
                existing.add(s[:6])
    today = datetime.date.today().isoformat()
    added = []
    with open(BL, "a", encoding="utf-8") as f:
        for b in bins:
            if b not in existing:
                f.write("# %s block_bin 标记坏段。\n%s\n" % (today, b))
                existing.add(b); added.append(b)

    # 2) 禁用该段所有卡(任何状态→disabled)
    pool = json.load(open(common.POOL_FILE, encoding="utf-8"))
    now = datetime.datetime.now(datetime.UTC).isoformat().replace("+00:00", "Z")
    bset = set(bins)
    per = collections.Counter()
    n = 0
    for c in pool:
        if (c.get("number") or "")[:6] in bset:
            per[(c.get("number") or "")[:6]] += 1
            if c.get("status") != "disabled":
                c["status"] = "disabled"; c["disabledReason"] = "blacklist-bin"; c["disabledAt"] = now; n += 1

    # 3) 清掉账号分配里指向这些段卡的(免得续跑还按老分配取)
    af = getattr(common, "CARD_ASSIGN_FILE", None); ac = 0
    if af and os.path.exists(af):
        try:
            asg = json.load(open(af, encoding="utf-8"))
            byid = {(c.get("id") or c.get("number")): c for c in pool}
            for k in list(asg.keys()):
                c = byid.get(asg[k])
                if c and (c.get("number") or "")[:6] in bset:
                    del asg[k]; ac += 1
            common._atomic_write_json(af, asg)
        except Exception:
            pass
    common._atomic_write_json(common.POOL_FILE, pool)

    print("拉黑段: %s%s" % (",".join(bins), ("(新加黑名单: %s)" % ",".join(added) if added else "(都已在黑名单)")))
    print("禁用: 涉及 %d 张卡(%s),本次新禁 %d 张,清账号分配 %d 个" % (
        sum(per.values()), dict(per), n, ac))
    good = [c for c in pool if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)]
    gb = collections.Counter((c.get("number") or "")[:6] for c in good)
    print("剩余可用好卡 %d 张 / %d 槽,好BIN分布: %s" % (
        len(good), sum(c.get("maxUses", 1) - c.get("usedCount", 0) for c in good), gb.most_common(8)))


if __name__ == "__main__":
    main()
