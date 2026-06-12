#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 看每张卡【实测绑了多少个账号 / 容量到没到上限】。读 account-state/card-pool.json 的统计字段
# (successCount=绑成数, declineCount=被拒数, status/disabledReason)。容量测试跑完看这个。
# 用法: python card_capacity.py
import json
import common


def cap_state(c):
    """推断单张卡的容量结论。"""
    succ = c.get("successCount", 0)
    st = c.get("status")
    reason = c.get("disabledReason", "")
    used = c.get("usedCount", 0)
    mx = c.get("maxUses", 1)
    cap = c.get("captchaCount", 0)
    if st == "disabled" and reason == "declined":
        return ("实测容量=%d" % succ, "✅到上限(绑成%d个后被拒)" % succ)
    if st == "disabled" and reason == "too-many-captcha":
        return ("≈%d(验证墙)" % succ, "🔁弹验证框%d次→已切下张(绑成%d个)" % (cap, succ))
    if st == "disabled" and reason == "too-many-502":
        return ("≈%d(疑坏卡)" % succ, "⚠️连续502被禁,可能坏卡/被Radar拉黑")
    if st == "disabled" and reason == "manual-removed":
        return ("-", "手动移除")
    if st == "disabled":
        return ("≈%d" % succ, "已禁(%s)" % (reason or "?"))
    if st == "active" and used >= mx:
        return ("绑成%d/上限%d" % (succ, mx), "已用满(绑卡≥%d未被拒,按付款上限封顶%d)" % (succ, mx))
    if st == "active":
        return ("%d(进行中)" % succ, "测试中…")
    return ("%d" % succ, st or "?")


def main():
    pool = json.load(open(common.POOL_FILE, encoding="utf-8"))
    rows = []
    for c in pool:
        succ = c.get("successCount", 0)
        dec = c.get("declineCount", 0)
        capn = c.get("captchaCount", 0)
        cap, note = cap_state(c)
        measured = (c.get("status") == "disabled" and c.get("disabledReason") == "declined")
        rows.append((c.get("last4", "????"), c.get("holder", ""), succ, dec, capn,
                     c.get("status", "?"), cap, note, measured))
    rows.sort(key=lambda r: (-r[2], str(r[0])))   # 绑成数多的在前

    print("卡片绑定容量实测 (共 %d 张)" % len(rows))
    print("%-6s %-20s %5s %5s %5s %-9s %-13s %s" % ("卡尾4", "持卡人", "绑成", "被拒", "验证框", "状态", "容量", "备注"))
    print("-" * 100)
    tot_succ = tot_done = 0
    for last4, holder, succ, dec, capn, status, cap, note, measured in rows:
        tot_succ += succ
        if measured:
            tot_done += 1
        print("%-6s %-20s %5d %5d %5d %-9s %-13s %s" % ("**" + str(last4), holder[:20], succ, dec, capn, status, cap, note))
    print("-" * 100)
    active = [c for c in pool if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)]
    print("总绑成 %d 个账号；已测出上限的卡 %d 张；当前 active 可用 %d 张" % (tot_succ, tot_done, len(active)))


if __name__ == "__main__":
    main()
