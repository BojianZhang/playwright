#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 把所有【有问题的账号】(没绑上卡的)标记出来：读 hybrid_results.jsonl 取每号最近一次,
# 按问题分类写到 state/hybrid_flagged.txt(人看) + state/hybrid_flagged.json(程序用)。
# 用法: python flag_accounts.py        (随时可跑; hybrid_run 跑完也会自动刷新)
import os, json

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "state", "hybrid_results.jsonl")
TXT = os.path.join(HERE, "state", "hybrid_flagged.txt")
JSN = os.path.join(HERE, "state", "hybrid_flagged.json")

# 问题分类(card 状态 → 人话 + 建议)
ISSUE = {
    "not-allowed":  ("账号被OpenRouter拒绝(not allowed to access)", "永久跳过,别再注册/登录试错(白烧环境IP)"),
    "hcaptcha":     ("弹人机验证", "换IP/换指纹重试,或人工过；2captcha 对隐形 hCaptcha 常解不动"),
    "server-error": ("Save卡Radar审核", "换IP冷却后重试(同号同卡短时连刷会更糟)"),
    "unknown":      ("没出卡表单", "重试(多为加载慢/Profile框挡)"),
    "declined":     ("卡被拒(该卡已自动禁用)", "换一张卡——declined 的卡已从卡池禁用"),
    "needphone":    ("要手机号(Link没取消)", "重试加卡(取消 Link 勾选)"),
    "fill-fail":    ("卡字段没填全", "重试"),
}


def _is_not_allowed(r):
    """账号是否被 OpenRouter 拒绝:新结果带 not_allowed,旧结果原因在 pw_reason/auth(ACCOUNT_NOT_ALLOWED)。"""
    if r.get("not_allowed"):
        return True
    st = r.get("steps") or {}
    blob = "%s %s" % (st.get("pw_reason") or "", st.get("auth") or "")
    return "NOT_ALLOWED" in blob.upper()


def latest_by_email(res_file=RES):
    out = {}
    if os.path.exists(res_file):
        for l in open(res_file, encoding="utf-8"):
            try:
                r = json.loads(l)
            except Exception:
                continue
            if r.get("email"):
                out[r["email"]] = r
    return out


def classify(r):
    """返回 (是否有问题, 问题码, 人话, 建议)。card-bound=没问题。"""
    card = (r.get("steps") or {}).get("card")
    if card == "card-bound":
        return (False, "ok", "已绑卡", "")
    # 账号被平台拒绝 → 最高优先级,永久跳过(不是卡/网络问题,重试无意义)
    if _is_not_allowed(r):
        return (True, "not-allowed", ISSUE["not-allowed"][0], ISSUE["not-allowed"][1])
    if card in ISSUE:
        return (True, card, ISSUE[card][0], ISSUE[card][1])
    # 没到加卡步
    if not r.get("api_key"):
        return (True, "pw-fail", "注册/取Key失败", "整号重试(全新走注册,已注册走登录)")
    return (True, "auth-fail", "登录/续跑失败", "重试(已有key,只需登录补加卡)")


def write_flagged(res_file=RES, txt=TXT, jsn=JSN, log=print):
    latest = latest_by_email(res_file)
    flagged = []
    for em, r in latest.items():
        bad, code, human, advice = classify(r)
        if bad:
            flagged.append({
                "email": em, "issue": code, "issue_cn": human, "advice": advice,
                "has_key": bool(r.get("api_key")), "api_key": r.get("api_key", ""),
                "billing": r.get("billing_status", ""), "card": (r.get("steps") or {}).get("card"),
                "proxy": r.get("proxy", ""), "at": r.get("at", ""),
            })
    os.makedirs(os.path.dirname(txt), exist_ok=True)
    # 人看的 txt
    lines = ["# 有问题的账号(没绑上卡)——按问题分类。共 %d 个" % len(flagged), ""]
    bycode = {}
    for f in flagged:
        bycode.setdefault(f["issue"], []).append(f)
    for code, items in sorted(bycode.items(), key=lambda kv: -len(kv[1])):
        lines.append("## [%s] %s —— %d 个 (建议: %s)" % (code, items[0]["issue_cn"], len(items), items[0]["advice"]))
        for f in items:
            lines.append("  %-36s key=%s 地址=%s 卡=%s 代理=%s %s" % (
                f["email"], "有" if f["has_key"] else "无", f["billing"] or "-", f["card"], f["proxy"] or "-", f["at"]))
        lines.append("")
    if not flagged:
        lines.append("(没有有问题的账号,全绑上了)")
    open(txt, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    json.dump(flagged, open(jsn, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    # 被 OpenRouter 拒绝(not allowed)的账号单独登记到 banned_accounts.txt → 编排层据此永久跳过,防重复试错
    banned = sorted(f["email"] for f in flagged if f["issue"] == "not-allowed")
    if banned:
        bf = os.path.join(os.path.dirname(txt), "banned_accounts.txt")
        old = set()
        if os.path.exists(bf):
            old = set(l.strip() for l in open(bf, encoding="utf-8") if l.strip() and not l.startswith("#"))
        allb = sorted(old | set(banned))
        with open(bf, "w", encoding="utf-8") as f:
            f.write("# OpenRouter 拒绝(not allowed to access)的账号——已永久跳过,勿再注册试错\n")
            f.write("\n".join(allb) + "\n")
        log("被拒账号 %d 个 → state/banned_accounts.txt(永久跳过)" % len(banned))
    log("已标记 %d 个有问题的账号 → state/hybrid_flagged.txt" % len(flagged))
    return flagged


if __name__ == "__main__":
    fl = write_flagged()
    # 打印分类汇总
    from collections import Counter
    c = Counter(f["issue"] for f in fl)
    print("分类:", dict(c))
