#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 从 stdin 读卡片表,解析后【追加并启用(active)】到卡池。按卡号去重(已存在→确保 active)。
# 每行格式(空白/Tab 分隔): 卡号 持卡人 余额 MM/YY CVC 标签 [账单地址...] 创建时间
# 用法: Get-Content data.txt | python import_cards.py     (或 Bash: cat data | python import_cards.py)
import sys, os, json, re, tempfile
import common

LINE = re.compile(
    r"^(\d{15,16})\s+(\S+)\s+(\d+)\s+(\d{1,2})/(\d{2})\s+(\d{3,4})\s+(\d+)\s+(.*?)\s+"
    r"(\d{4}/\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2})\s*$"
)
# 兜底:没有账单地址那行(地址列为空)
LINE_NOADDR = re.compile(
    r"^(\d{15,16})\s+(\S+)\s+(\d+)\s+(\d{1,2})/(\d{2})\s+(\d{3,4})\s+(\d+)\s+"
    r"(\d{4}/\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2})\s*$"
)


def _from_tab_cols(line):
    """优先按 Tab 分列解析:列 = 卡号 持卡人 余额 MM/YY CVC 标签 [账单地址] 创建时间。
       这条路对【持卡人带空格】(Jade Fritsch)和【标签带后缀】(153-claude)都不敏感 ——
       正则按空白分词会把这些行整行丢掉(实测一批新卡静默少 6 张),所以有 Tab 就走这里。"""
    if "\t" not in line:
        return None
    cols = line.split("\t")
    if len(cols) < 5:
        return None
    number, holder, exp, cvc = cols[0].strip(), cols[1].strip(), cols[3].strip(), cols[4].strip()
    m = re.match(r"^(\d{1,2})/(\d{2})$", exp)
    if not (re.match(r"^\d{15,16}$", number) and m and re.match(r"^\d{3,4}$", cvc)):
        return None
    # 末列是创建时间(日期),不是地址 → 地址在第 7 列(索引6);只到标签(6列)则无地址
    addr = cols[6].strip() if len(cols) >= 8 else ""
    return number, holder, m.group(1), m.group(2), cvc, addr


def parse(line):
    # 1) 有 Tab → 按列取,持卡人/标签带空格或后缀都不怕
    r = _from_tab_cols(line)
    if r:
        return r
    # 2) 兜底正则(空格分隔的老格式)
    m = LINE.match(line)
    if m:
        number, holder, _bal, mm, yy, cvc, _label, addr, _created = m.groups()
        return number, holder, mm, yy, cvc, addr.strip()
    m = LINE_NOADDR.match(line)
    if m:
        number, holder, _bal, mm, yy, cvc, _label, _created = m.groups()
        return number, holder, mm, yy, cvc, ""
    return None


def main():
    # 容量测试用:把 maxUses 调高(默认 10),让卡能一直绑到被拒为止、而不是人为卡在 10。
    max_uses = int(os.environ.get("CARD_MAX_USES", "10"))
    rows = []
    unparsed = []
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        r = parse(line)
        if r:
            rows.append(r)
        else:
            unparsed.append(line)
    if unparsed:
        # 静默丢卡是大忌(曾因持卡人带空格/标签带后缀少导 6 张)→ 显式报告
        print("!! %d 行未能解析(已跳过,未导入):" % len(unparsed))
        for u in unparsed[:20]:
            print("   ", u[:80])
    if not rows:
        print("没解析到卡(检查格式)"); return

    with common._CARD_LOCK:
        pool = json.load(open(common.POOL_FILE, encoding="utf-8"))
        existing = {c.get("number"): c for c in pool}
        added, reactivated, dup = 0, 0, 0
        for number, holder, mm, yy, cvc, addr in rows:
            if number in existing:
                c = existing[number]
                if c.get("status") != "active":
                    c["status"] = "active"; c.pop("disabledReason", None); reactivated += 1
                else:
                    dup += 1
                continue
            card = {
                "id": "card-la-" + number[-8:],
                "last4": number[-4:],
                "number": number,
                "expMonth": mm.zfill(2),
                "expYear": yy,
                "cvc": cvc,
                "holder": holder,
                "maxUses": max_uses,
                "usedCount": 0,
                "successCount": 0,
                "declineCount": 0,
                "status": "active",
            }
            if addr:
                card["billingAddress"] = addr
            pool.append(card)
            existing[number] = card
            added += 1
        # 原子写
        d = os.path.dirname(common.POOL_FILE)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(pool, f, ensure_ascii=False, indent=2)
        os.replace(tmp, common.POOL_FILE)

    active = [c for c in pool if c.get("status") == "active" and c.get("usedCount", 0) < c.get("maxUses", 1)]
    cap = sum(c.get("maxUses", 1) - c.get("usedCount", 0) for c in active)
    print("新增 %d 张, 重新启用 %d 张, 已存在跳过 %d 张" % (added, reactivated, dup))
    print("卡池现 active 可用: %d 张 (容量约 %d 个号)" % (len(active), cap))


if __name__ == "__main__":
    main()
