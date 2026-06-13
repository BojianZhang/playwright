#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# batch3d 最终报表:开始/结束/耗时 + 总绑成 + 两引擎对比 + hcaptcha求解实况 + 坏邮箱。
import json, collections, subprocess, datetime, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tools/→父目录 selenium-e2e(移动后锚定,与移动前同值)


def _read(p, d=""):
    try:
        return open(os.path.join(HERE, p), encoding="utf-8").read().strip()
    except Exception:
        return d


def tally(fn, base):
    n = bound = key = 0
    rc = collections.Counter(); hc = collections.Counter()
    try:
        for ln in open(os.path.join(HERE, fn), encoding="utf-8").read().splitlines()[base:]:
            try:
                r = json.loads(ln); st = r.get("steps") or {}; n += 1
                c = st.get("card")
                # 绑成只认 card 步真为 card-bound;不能 `or r.get("ok")` —— card 模式下 ok 即便加卡被拒也可能为 True
                # (见 pipeline.py:ok 不含 card 项),那样会把 declined 误计成绑成,绑成率虚高。
                if c == "card-bound":
                    bound += 1
                else:
                    rc[c or "?"] += 1
                if st.get("key") is True or r.get("api_key"):
                    key += 1
                if r.get("hcap_mode"):
                    hc[r.get("hcap_mode")] += 1
            except Exception:
                pass
    except FileNotFoundError:
        pass
    return n, bound, key, rc, hc


def cnt(pat, f):
    try:
        return int(subprocess.run(["grep", "-c", pat, os.path.join(HERE, f)],
                                  capture_output=True, text=True).stdout.strip() or 0)
    except Exception:
        return 0


def _pct(x, y):
    return 100.0 * x / max(1, y)


def deep(fn):
    """全量(不切片)聚合更多维度: 失败原因占比 / per-代理 / per-card_id / 求解模式绑成率。
    只聚合 results.jsonl 真实存在的字段; 缺字段的维度自动留空, 绝不抛错。"""
    card_fail = collections.Counter()   # card 步失败原因 (unknown/hcaptcha/declined/server-error/card-502...)
    auth_fail = collections.Counter()   # auth 步失败原因 (REGISTER_UNCONFIRMED/VERIFY_LINK/OTP/SIGNIN_UNCONFIRMED)
    proxy = collections.defaultdict(lambda: [0, 0])   # proxy -> [绑成, 失败]
    card = collections.defaultdict(lambda: [0, 0])    # card_id -> [绑成, 失败]
    mode = collections.defaultdict(lambda: [0, 0])    # hcap_mode -> [绑成, 失败]
    n = 0
    try:
        for ln in open(os.path.join(HERE, fn), encoding="utf-8").read().splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                r = json.loads(ln)
            except Exception:
                continue
            n += 1
            st = r.get("steps") or {}
            c = st.get("card")
            bound = (c == "card-bound")  # 只认 card-bound;`or r.get("ok")` 会把加卡被拒(ok 仍可能 True)误计成绑成
            if not bound:
                if c and c != "card-bound":
                    card_fail[str(c)] += 1
                a = st.get("auth")
                if a and str(a).startswith("fail:"):
                    auth_fail[str(a)[5:]] += 1
            px = r.get("proxy")
            if px:
                proxy[px][0 if bound else 1] += 1
            cid = r.get("card_id")
            if cid:
                card[cid][0 if bound else 1] += 1
            hm = r.get("hcap_mode")
            if hm:
                mode[str(hm)][0 if bound else 1] += 1
    except FileNotFoundError:
        pass
    return n, card_fail, auth_fail, proxy, card, mode


def _merge_pair(a, b):
    """合并两个 defaultdict([绑成,失败]) -> 普通 dict。"""
    out = collections.defaultdict(lambda: [0, 0])
    for d in (a, b):
        for k, v in d.items():
            out[k][0] += v[0]
            out[k][1] += v[1]
    return out


def _fail_lines(c, label):
    if not c:
        return "  %s: (无)" % label
    tot = sum(c.values())
    parts = ["%s %d (%.0f%%)" % (k, v, _pct(v, tot)) for k, v in c.most_common()]
    return "  %s(共%d): %s" % (label, tot, " · ".join(parts))


def main():
    start = _read("state/.b3d_start"); end = _read("state/.b3d_end")
    total = int(_read("state/.b3d_total", "80") or 80)
    sb = int(_read("state/.b3d_base_sel", "0") or 0); hb = int(_read("state/.b3d_base_hyb", "0") or 0)
    dur = "?"
    try:
        f = "%Y-%m-%d %H:%M:%S"
        dur = str(datetime.datetime.strptime(end, f) - datetime.datetime.strptime(start, f))
    except Exception:
        pass
    sn, sb2, sk, src, shc = tally("state/results.jsonl", sb)
    hn, hb2, hk, hrc, hhc = tally("state/hybrid_results.jsonl", hb)
    # hcaptcha 求解实况(两引擎日志合计;求解只接在 Selenium)
    img = cnt("验证框解不掉", "../logs/b3d-selenium.log")
    sttry = cnt("2captcha 解hcaptcha", "../logs/b3d-selenium.log")
    stok = cnt("成功,继续Save", "../logs/b3d-selenium.log")
    e502 = cnt("unable-to-authenticate", "../logs/b3d-selenium.log")
    capbox = cnt("弹验证框=True", "../logs/b3d-selenium.log") + cnt("弹验证框=True", "../logs/b3d-hybrid.log")

    L = "═" * 60
    print(L); print("  batch3 最终报表 (总10随机并发 · 两引擎随机 · 随机求解)"); print(L)
    print("开始: %s" % start); print("结束: %s" % end); print("耗时: %s" % dur)
    print("-" * 60)
    runbound = sb2 + hb2
    print("总投放: %d 号 | 已绑成跳过3 | 坏邮箱跳过5(@bailskips.com)" % total)
    print("本轮实跑: %d 号 | ★本轮绑成: %d (%.0f%%)" % (sn + hn, runbound, 100 * runbound / max(1, sn + hn)))
    print("-" * 60)
    print("引擎①Selenium: 跑%d 绑成%d 拿key%d  失败:%s" % (sn, sb2, sk, dict(src)))
    print("引擎②hybrid  : 跑%d 绑成%d 拿key%d  失败:%s" % (hn, hb2, hk, dict(hrc)))
    print("  支付/求解模式分布 sel=%s hyb=%s" % (dict(shc), dict(hhc)))
    print("-" * 60)
    print("hcaptcha 实况: 弹验证框%d次 | 解不掉(隐形/图片)%d次 | 走2captcha求解%d次 | 求解成功%d次 | 502信号%d" % (
        capbox, img, sttry, stok, e502))
    print("  求解成功率: 走求解%d → 成功%d (%.0f%%) | 求解率(走求解/弹框) %.0f%% | 502占走求解 %.0f%%" % (
        sttry, stok, _pct(stok, sttry), _pct(sttry, capbox), _pct(e502, sttry)))

    # ===== 增益维度(全量统计, 不切片; 用于找坏代理/坏卡/对比模式) =====
    dn, dcf, daf, dpx, dcard, dmode = deep("state/results.jsonl")
    hdn, hdcf, hdaf, hdpx, hdcard, hdmode = deep("state/hybrid_results.jsonl")
    print("-" * 60)
    print("失败原因占比 (全量 %d 条 sel + %d 条 hyb)" % (dn, hdn))
    print(" [card 步]")
    print(_fail_lines(dcf, "sel "))
    print(_fail_lines(hdcf, "hyb "))
    print(" [auth 步]")
    print(_fail_lines(daf, "sel "))
    print(_fail_lines(hdaf, "hyb "))

    # per-代理战绩(合并两引擎; 只列有失败的, 按失败数降序, 找坏代理)
    px = _merge_pair(dpx, hdpx)
    print("-" * 60)
    print("per-代理战绩 (全量 · 绑成/失败 · 仅列有失败者 Top15)")
    bad = sorted(((k, v) for k, v in px.items() if v[1] > 0),
                 key=lambda kv: (kv[1][1], -kv[1][0]), reverse=True)
    if not bad:
        print("  (无失败代理)")
    for k, v in bad[:15]:
        print("  %-22s 绑成%-3d 失败%-3d 成功率%3.0f%%" % (k, v[0], v[1], _pct(v[0], v[0] + v[1])))

    # per-card_id 战绩(无真实 BIN 字段; 用 card_id 聚合代替; 仅列有被拒者)
    cd = _merge_pair(dcard, hdcard)
    print("-" * 60)
    print("per-card 战绩 (无 BIN 字段→按 card_id · 仅列有被拒者 Top15)")
    badc = sorted(((k, v) for k, v in cd.items() if v[1] > 0),
                  key=lambda kv: (kv[1][1], -kv[1][0]), reverse=True)
    if not badc:
        print("  (无被拒卡)")
    for k, v in badc[:15]:
        print("  %-16s 绑成%-3d 被拒%-3d 成功率%3.0f%%" % (k, v[0], v[1], _pct(v[0], v[0] + v[1])))

    # 求解模式 solve vs swap 绑成率对比(仅 results.jsonl 有 hcap_mode)
    md = _merge_pair(dmode, hdmode)
    print("-" * 60)
    if md:
        print("求解模式绑成率 (hcap_mode · solve vs swap)")
        for k, v in sorted(md.items()):
            print("  %-6s 绑成%-3d 失败%-3d 绑成率%3.0f%%" % (k, v[0], v[1], _pct(v[0], v[0] + v[1])))
    else:
        print("求解模式绑成率: (无 hcap_mode 字段, 跳过)")
    print(L)


if __name__ == "__main__":
    main()
