#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 救活被 502/检测冤枉禁掉的卡。
# 判据:status∈{disabled,paused,used} 且 declineCount==0 且 lastResult!='declined'(没真拒付过)。
#   → status='active';usedCount=successCount(消耗按【真实绑成数】算,失败的502不再白占槽);
#     清掉 cooldownUntil/errorCount/lastError/lastResult。successCount/firstUsedAt 作为历史保留。
# 真有拒付(declineCount>0 或 lastResult=='declined')的卡【不动】。先备份 card-pool.json。
import json, time, shutil, sys
import os as _os, sys as _sys  # tools/ 下直接跑时,把父目录 selenium-e2e/ 插进 sys.path 让 import common 可解析
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
import common

DRY = "--apply" not in sys.argv  # 默认 dry-run,加 --apply 才真写


def main():
    d = json.load(open(common.POOL_FILE, encoding="utf-8"))
    if isinstance(d, list):
        seq = d
    elif isinstance(d, dict) and "cards" in d:
        c = d["cards"]; seq = c if isinstance(c, list) else list(c.values())
    elif isinstance(d, dict):
        seq = list(d.values())
    else:
        print("无法识别卡池结构"); return

    revived, skipped_decline, kept_active = 0, 0, 0
    for c in seq:
        st = c.get("status")
        if st == "active":
            kept_active += 1; continue
        if st not in ("disabled", "paused", "used"):
            continue
        if c.get("declineCount", 0) > 0 or str(c.get("lastResult")) == "declined":
            skipped_decline += 1; continue
        # 救活
        c["status"] = "active"
        c["usedCount"] = c.get("successCount", 0)
        for k in ("cooldownUntil", "errorCount", "lastError"):
            if k in c:
                c[k] = 0 if k == "errorCount" else None
        c["lastResult"] = None
        revived += 1

    print("active(原本就在)=%d  本次救活=%d  保留禁用(真拒付)=%d" % (kept_active, revived, skipped_decline))
    print("救活后 active 总数 = %d  → 绑定槽约 %d" % (kept_active + revived, (kept_active + revived) * 10))
    if DRY:
        print("== DRY-RUN(没写盘)。确认无误后加 --apply 真写 ==")
        return
    bak = common.POOL_FILE + ".bak.%d" % int(time.time())
    shutil.copyfile(common.POOL_FILE, bak)
    print("已备份 →", bak)
    # 只用原子写(它内部已 tmp+fsync+os.replace、失败也原子兜底、绝不抛);★绝不再 open(POOL_FILE,"w") 直写——
    #   那会在被杀/盘满时把卡池留成半截损坏文件(正是要防的)。失败仅提示走 .bak 恢复,不二次截断。
    if common._atomic_write_json(common.POOL_FILE, d):
        print("已写回 card-pool.json,救活 %d 张。" % revived)
    else:
        print("写回失败(原子写未成功),卡池未改动,可从备份恢复 → %s" % bak)


if __name__ == "__main__":
    main()
