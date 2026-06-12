#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 环境兜底 GC:删掉 AdsPower 里【孤儿 hyb-* 环境】—— 结果文件里不再需要重开的:
#   · PW失败没拿到key的号(留了env却永不重开,如 larrymiller)
#   · 已绑/被拒/永久放弃 但环境没删干净的
#   · 进程被 Ctrl-C/崩 打断、env_id 没来得及落盘的(彻底没记录的孤儿)
# 安全三护栏:① 跳过续跑还会重开的(有key+没绑上+非banned+非永久放弃) ② 跳过正开着的
#            ③ 跳过建龄 < min_age 的(可能是并发进程刚建、还没落盘)。只动 hyb-* + selpipe 组。
# 用法: python cleanup_envs.py            (dry-run 只看要删谁,不真删)
#       python cleanup_envs.py --apply    (真删)
import sys, os, json, time, argparse
import common, adspower_env

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "state", "hybrid_results.jsonl")


def _latest():
    out = {}
    if os.path.exists(RES):
        for l in open(RES, encoding="utf-8"):
            try:
                r = json.loads(l)
            except Exception:
                continue
            if r.get("email"):
                out[r["email"]] = r
    return out


def _reopenable_env_ids(latest):
    """续跑还会去重开、必须【保留】的 env_id:有 env_id+key 且 没绑上 且 非banned 且 非永久放弃。"""
    keep = set()
    for e, r in latest.items():
        st = r.get("steps") or {}
        bound = st.get("card") == "card-bound"
        banned = bool(r.get("not_allowed")) or common.is_banned_reason(st.get("pw_reason"), st.get("auth"))
        if r.get("env_id") and r.get("api_key") and not bound and not banned and not r.get("giveup_permanent"):
            keep.add(r["env_id"])
    return keep


def _all_hyb_envs():
    envs, page = [], 1
    while True:
        d = common.ads_call("/api/v1/user/list?page=%d&page_size=100" % page, method="GET")
        lst = (d.get("data") or {}).get("list") or []
        envs += [u for u in lst if (u.get("name") or "").startswith("hyb-")]
        if len(lst) < 100:
            break
        page += 1
    return envs


def gc_envs(min_age_min=30, dry_run=True, log=print):
    """回收孤儿 hyb-* 环境。返回删除数。dry_run=True 只打印不删。"""
    latest = _latest()
    keep = _reopenable_env_ids(latest)
    open_ids = set()
    try:
        a = common.ads_call("/api/v1/browser/local-active", method="GET")
        open_ids = {x.get("user_id") for x in (a.get("data") or {}).get("list") or []}
    except Exception:
        pass
    try:
        envs = _all_hyb_envs()
    except Exception as e:
        log("[GC] 查环境失败,跳过: %s" % str(e)[:80])
        return 0
    cutoff = time.time() - min_age_min * 60
    todel = []
    for u in envs:
        uid = u.get("user_id")
        if uid in keep:          # 续跑要重开 → 留
            continue
        if uid in open_ids:      # 正开着 → 不碰(可能别的进程在用)
            continue
        try:
            ct = float(u.get("created_time") or 0)
        except Exception:
            ct = 0
        if ct and ct > cutoff:   # 建龄太新 → 留(防误删并发刚建、还没落盘的)
            continue
        todel.append(u)
    kept_now = sum(1 for u in envs if u.get("user_id") in keep)
    log("[GC] hyb-* 环境 %d 个 | 续跑保留 %d | 正开着 %d | 待删孤儿 %d (建龄>%d分钟)" % (
        len(envs), kept_now, len(open_ids), len(todel), min_age_min))
    for u in todel:
        log("  %s %s (serial=%s)" % ("[dry-run 不删]" if dry_run else "删→", u.get("name"), u.get("serial_number")))
        if not dry_run:
            try:
                common.adspower_stop(u.get("user_id"))
                time.sleep(0.3)
                adspower_env.delete_env(u.get("user_id"))
            except Exception as e:
                log("  删失败: %s" % str(e)[:50])
    return len(todel)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="环境兜底 GC:回收孤儿 hyb-* 环境")
    ap.add_argument("--min-age-min", type=int, default=30, help="只删建龄超过这么多分钟的(默认30,防误删并发刚建的)")
    ap.add_argument("--apply", action="store_true", help="真删(默认 dry-run 只看)")
    args = ap.parse_args()
    n = gc_envs(min_age_min=args.min_age_min, dry_run=not args.apply)
    if not args.apply and n:
        print("\n(以上是 dry-run。确认无误后加 --apply 真删)")
