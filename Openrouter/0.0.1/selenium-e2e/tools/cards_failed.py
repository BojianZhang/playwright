#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 列出【绑卡失败/有问题】的卡 + 【已绑满到 capacity】的卡。
# 终端只打末4位+段BIN(防刷屏/截图泄露);【完整卡号/有效期/CVC/ZIP 写进 _failed_cards.log】
# (被 .gitignore 的 *.log 兜住,绝不入库),格式 = 卡号 MMYY CVC ZIP,可直接复制去手动测或喂 fixc_bind.py。
import json, datetime, sys
import os as _os, sys as _sys  # tools/ 下直接跑时,把父目录 selenium-e2e/ 插进 sys.path 让 import common 可解析
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import common

DETAIL_FILE = "_failed_cards.log"   # *.log → gitignored
FAIL = {"server-error", "declined", "hcaptcha", "unknown", "card-502", "error"}


def _mmyy(c):
    try:
        return "%02d%s" % (int(c.get("expMonth")), str(c.get("expYear"))[-2:])
    except Exception:
        return "%s%s" % (c.get("expMonth"), c.get("expYear"))


def main():
    d = json.load(open(common.POOL_FILE, encoding="utf-8"))
    cards = d if isinstance(d, list) else d.get("cards", list(d.values()) if isinstance(d, dict) else [])
    now = datetime.datetime.utcnow().isoformat() + "Z"
    failed, full = [], []
    for c in cards:
        sc = c.get("successCount", 0); uc = c.get("usedCount", 0); mx = c.get("maxUses", 10)
        lr = c.get("lastResult")
        if sc >= mx or uc >= mx:
            full.append(c)
        if (lr in FAIL) or c.get("errorCount", 0) or c.get("declineCount", 0) or c.get("captchaCount", 0):
            failed.append(c)
    failed.sort(key=lambda c: -(c.get("errorCount", 0) + c.get("declineCount", 0) + c.get("captchaCount", 0)))

    # 终端:打掩码摘要
    print("=" * 78)
    print("  绑卡失败/有问题的卡  (共 %d 张) —— 完整卡号见 %s" % (len(failed), DETAIL_FILE))
    print("=" * 78)
    print("%-6s %-7s %-9s %3s %3s %-12s %3s %3s %3s %-7s" % ("末4", "段BIN", "状态", "绑", "用", "上次结果", "错", "拒", "框", "冷却中"))
    for c in failed:
        l4 = str(c.get("last4") or (c.get("number") or "")[-4:]); binp = (c.get("number") or "")[:6]
        cu = c.get("cooldownUntil"); cool = "是" if (cu and cu > now) else ""
        print("••%-4s %-7s %-9s %3d %3d %-12s %3d %3d %3d %-7s" % (
            l4, binp, str(c.get("status")), c.get("successCount", 0), c.get("usedCount", 0),
            str(c.get("lastResult"))[:12], c.get("errorCount", 0), c.get("declineCount", 0),
            c.get("captchaCount", 0), cool))

    # 文件:写完整明细(gitignored)
    with open(DETAIL_FILE, "w", encoding="utf-8") as f:
        f.write("# 绑卡失败的卡完整明细(本地测试用,*.log 已 gitignore,勿提交)\n")
        f.write("# 格式: 卡号 MMYY CVC ZIP    # 末4 段BIN 状态 绑X/用Y 上次=结果 错E 拒D 框C [冷却中]\n")
        f.write("# 可直接复制前4列去手动绑,或: python fixc_bind.py <env_id> <卡号> <MMYY> <CVC> <ZIP>\n\n")
        for c in failed:
            l4 = str(c.get("last4") or (c.get("number") or "")[-4:]); binp = (c.get("number") or "")[:6]
            cu = c.get("cooldownUntil"); cool = " 冷却中" if (cu and cu > now) else ""
            zipc = str(c.get("zip") or "59601")
            f.write("%s %s %s %s    # ••%s 段%s %s 绑%d/用%d 上次=%s 错%d 拒%d 框%d%s\n" % (
                c.get("number"), _mmyy(c), c.get("cvc"), zipc, l4, binp, c.get("status"),
                c.get("successCount", 0), c.get("usedCount", 0), c.get("lastResult"),
                c.get("errorCount", 0), c.get("declineCount", 0), c.get("captchaCount", 0), cool))
    print("\n✓ 完整卡号/有效期/CVC/ZIP 已写入 %s(gitignored)—— 打开它手动测这些卡能不能绑" % DETAIL_FILE)

    print("\n已绑满到 capacity(≥maxUses,不该再用) %d 张:" % len(full))
    for c in full[:40]:
        print("  ••%s 段%s %s 绑%d/用%d (max%d)" % (
            str(c.get("last4")), (c.get("number") or "")[:6], c.get("status"),
            c.get("successCount", 0), c.get("usedCount", 0), c.get("maxUses", 10)))


if __name__ == "__main__":
    main()
