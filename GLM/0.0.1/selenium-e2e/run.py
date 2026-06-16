#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 纯 Selenium 流水线入口(z.ai)：读账号/代理池/配置 → 逐账号建环境跑全流程 → 删环境。
#
# 文件定位：GLM/0.0.1/selenium-e2e/run.py
#
# 账号文件：每行 email:邮箱密码    代理池文件：每行 host:port:user:pass(或 socks5://user:pass@host:port)
#
# 例：python selenium-e2e/run.py --accounts accts.txt --proxies proxies.txt \
#       --do-apikey --do-subscribe --plan max --cycle monthly --real-charge
# ═══════════════════════════════════════════════════════════════════════

import sys
import os
import json
import time
import argparse
import threading
import concurrent.futures
import queue

import common
from services import adspower_env
import pipeline
from common import log

# ── 增量 checkpoint(逐阶段状态机:register/login/apikey/subscribe)──────────────
_PROGRESS_FILE = os.path.join(common.HERE, "state", "sel_account_progress.json")
_PROGRESS_LOCK = threading.Lock()


def save_progress(email, **fields):
    if not email:
        return
    # ★线程锁 + 跨进程文件锁双保险:并发跑(多 worker / 多 run.py 进程)对 checkpoint 的读-改-写若只用线程锁,
    #   两个【进程】会丢更新 → 已订阅/已完成阶段漏记 → 续跑重做(重扣风险)。与 ledger 同口径加 _file_lock。
    with _PROGRESS_LOCK, common._file_lock(_PROGRESS_FILE):
        try:
            with open(_PROGRESS_FILE, encoding="utf-8") as _f:
                d = json.load(_f)
        except Exception:
            d = {}
        rec = d.setdefault(email, {})
        st = fields.pop("_stage", None)
        if st:
            rec.setdefault("stages", {})[st[0]] = st[1]
        for k, v in fields.items():
            if v not in (None, ""):
                rec[k] = v
        rec["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            if not common._atomic_write_json(_PROGRESS_FILE, d):
                log("[checkpoint] ⚠⚠ save_progress 落盘失败(续跑可能漏判已订阅→重扣风险),请人工核对: %s" % email)
        except Exception as _e:
            try: log("[checkpoint] ⚠ save_progress 异常: %s" % str(_e)[:80])
            except Exception: pass


def read_accounts(path):
    out = []
    seen = set()   # ★按 email 去重:同一邮箱写两行会被两个 worker 各跑一次 → 真扣模式下【重复扣款】。保留首次出现。
    dups = 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                em, pw = line.split(":", 1)
                em = em.strip(); pw = pw.strip()
                if not em or not pw:
                    log("跳过缺 email 或邮箱密码的账号行: %s" % line[:40])
                    continue
                _k = em.lower()
                if _k in seen:
                    dups += 1
                    continue
                seen.add(_k)
                out.append({"email": em, "mailbox_pw": pw})
            else:
                log("跳过格式不对的账号行: %s" % line[:40])
    if dups:
        log("账号文件去重:剔除 %d 个重复邮箱(同邮箱多行 → 真扣模式会重复扣款,只保留首次)" % dups)
    return out


def _price_for(cfg, plan, cycle):
    try:
        return float(((cfg.get("subscribe_prices") or {}).get(plan) or {}).get(cycle) or 0)
    except Exception:
        return 0


def main():
    ap = argparse.ArgumentParser(description="纯 Selenium z.ai 流水线")
    ap.add_argument("--accounts", required=True, help="账号文件 (email:邮箱密码 每行)")
    ap.add_argument("--proxies", required=True, help="代理池文件")
    # 创建 API Key(默认开;--no-apikey 关)。独立于订阅:可只取 key 不订阅。
    ap.add_argument("--do-apikey", action="store_true", help="创建并抓取 API Key(默认行为)")
    ap.add_argument("--no-apikey", action="store_true", help="跳过创建 API Key")
    # 订阅 GLM Coding Plan + 信用卡支付
    ap.add_argument("--do-subscribe", action="store_true", help="订阅 GLM Coding Plan(选套餐+信用卡支付)")
    ap.add_argument("--plan", default="", choices=["", "lite", "pro", "max"], help="套餐 lite|pro|max(默认取 config.subscribe.defaultPlan)")
    ap.add_argument("--cycle", default="", choices=["", "monthly", "quarterly", "yearly"], help="计费周期(默认取 config.subscribe.defaultCycle)")
    # 真实支付容量闸(全默认关=dry-run 不真扣)
    ap.add_argument("--real-charge", action="store_true", help="真实支付(真点 Confirm 扣款);不传=dry-run 走到 Confirm 不真扣")
    ap.add_argument("--card-charge-gate", action="store_true", help="开卡容量账本闸(支付步原子预留:容量不够/同卡并发满→钱不够 END 不扣)")
    ap.add_argument("--charge-count", type=int, default=0, help="整批最多真扣 N 次(测试帽);0=不限")
    ap.add_argument("--limit-by-capacity", action="store_true", help="按卡总容量自动限批(够几个跑几个)")
    ap.add_argument("--unified-pw", default="", help="统一密码(z.ai 账号密码;不设=用邮箱密码)")
    ap.add_argument("--key-name", default=None, help="API Key 名称(默认随机)")
    ap.add_argument("--no-delete-env", action="store_true", help="跑完不删环境(调试用)")
    ap.add_argument("--gap", type=int, default=5, help="账号间隔秒(默认5)")
    ap.add_argument("--proxy-offset", type=int, default=0, help="代理起始下标偏移(每轮重试+1换不同IP)")
    ap.add_argument("--concurrency", type=int, default=1, help="并发数(同时跑几个号,默认1=串行)")
    ap.add_argument("--no-resume", action="store_true", help="忽略已完成/坏邮箱状态,强制整组重跑")
    ap.add_argument("--job-id", default="", help="本次任务 jobId:写进结果行 job_id,供 web 按 job 隔离取结果")
    args = ap.parse_args()
    args.gap = max(0, args.gap)
    args.concurrency = max(1, args.concurrency)
    do_apikey = (not args.no_apikey)   # 默认创建 key;--no-apikey 关

    cfg = common.load_config()
    if not cfg["mail_key"]:
        log("⚠ config.local.json 缺 mailbox.apiKey(firstmail) — 邮箱验证将失败")
    if args.do_subscribe and not cfg["captcha_key"]:
        log("⚠ config.local.json 缺 captcha.apiKey(2captcha) — 滑块验证将失败")
    plan = (args.plan or cfg.get("subscribe_default_plan") or "pro").lower()
    cycle = (args.cycle or cfg.get("subscribe_default_cycle") or "monthly").lower()
    batch_amt = _price_for(cfg, plan, cycle)

    accounts = read_accounts(args.accounts)
    proxies = adspower_env.load_proxies(args.proxies)
    if not accounts:
        log("没读到账号"); return
    if not proxies:
        log("代理池为空 —— 新建环境必须配代理"); return
    log("账号 %d 个, 代理 %d 条%s" % (len(accounts), len(proxies),
        ("; 订阅 %s/%s ($%s)" % (plan, cycle, batch_amt)) if args.do_subscribe else ""))

    group_id = adspower_env.ensure_group("glmpipe")
    state_dir = os.path.join(common.HERE, "state")
    os.makedirs(state_dir, exist_ok=True)
    res_file = os.path.join(state_dir, "results.jsonl")

    # ── 续跑扫描:registered(注册过) / subscribed(订阅过=防重扣第二信号) / done(已完成) ──
    done = set(); registered = set(); subscribed = set()
    if os.path.exists(res_file):
        with open(res_file, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                st = (r.get("steps") or {})
                if st.get("auth") == "ok":
                    registered.add(r.get("email"))
                if st.get("subscribe") == "success" or (r.get("subscribed") or 0):
                    subscribed.add(r.get("email"))   # 订阅成功落过 results → 绝不再扣(即便 checkpoint 没记)
                if r.get("not_allowed") or common.is_banned_reason(st.get("auth")):
                    done.add(r.get("email"))
                elif r.get("ok"):
                    done.add(r.get("email"))         # r.ok 已含「已开启阶段全成功」的门(apikey/subscribe)
    if args.no_resume:
        done = set()
        log("--no-resume:忽略已完成状态,整组强制重跑")
    # 合并 checkpoint:补回 registered + 带上 prior/prior_key(逐阶段跳过/复用)
    try:
        with open(_PROGRESS_FILE, encoding="utf-8") as _f:
            _prog = json.load(_f)
        for _em, _rec in (_prog.items() if isinstance(_prog, dict) else []):
            if _rec.get("registered"):
                registered.add(_em)
    except Exception:
        _prog = {}
    _reused = 0
    for _a in accounts:
        if _a["email"] in registered:
            _a["registered"] = True
        if _a["email"] in subscribed:
            _a["subscribed"] = True
        _rec = (_prog or {}).get(_a["email"]) or {}
        if _rec:
            _a["prior"] = _rec
            if _rec.get("api_key"):
                _a["prior_key"] = _rec["api_key"]
                if ((((_rec.get("stages") or {}).get("apikey") or {}).get("status")) == "ok"):
                    _reused += 1
    if registered:
        log("已注册标记:%d 个号历史 auth=ok,重跑将直接登录(不再点注册)" % len(registered))
    if _reused:
        log("阶段续跑:%d 个号已有 API Key,重跑将复用(不重复创建)" % _reused)

    # ── 整批最多真扣 N 次(测试帽,跨线程安全)──
    _charge_lock = threading.Lock(); _charge_used = [0]
    def try_batch_charge():
        n = max(0, int(args.charge_count or 0))
        if n <= 0:
            return True
        with _charge_lock:
            if _charge_used[0] >= n:
                return False
            _charge_used[0] += 1
            return True

    opts = {
        "cfg": cfg, "do_apikey": do_apikey, "do_subscribe": args.do_subscribe,
        "plan": plan, "cycle": cycle, "unified_pw": args.unified_pw or None,
        "key_name": args.key_name, "delete_env": not args.no_delete_env,
        "real_charge": args.real_charge, "card_charge_gate": args.card_charge_gate,
        "charge_count": max(0, int(args.charge_count or 0)), "try_batch_charge": try_batch_charge,
    }

    write_lock = threading.Lock()
    conc = max(1, args.concurrency)
    slot_q = queue.Queue()
    for _s in range(conc):
        slot_q.put(_s)
    bad_mb = {} if args.no_resume else common.load_bad_mailboxes()
    _skipbad = [a["email"] for a in accounts if common.is_bad_mailbox(a["email"], bad_mb)]
    if _skipbad:
        log("跳过坏邮箱 %d 个(收不到验证邮件): %s" % (len(_skipbad), ", ".join(x.split("@")[0] for x in _skipbad)))
    for _a in accounts:
        if _a["email"] in done:
            log("跳过已完成 %s" % _a["email"])
    pending = [(i, acct) for i, acct in enumerate(accounts)
               if acct["email"] not in done and not common.is_bad_mailbox(acct["email"], bad_mb)]

    # ── 容量读数 + 可选自动限批(只在真扣+订阅+gate 开时)──
    if args.real_charge and args.do_subscribe and args.card_charge_gate:
        try:
            _reaped = common.reap_stale_inflight()
            if _reaped:
                log("[订阅] 回收上次遗留的在飞预留 %d 笔(卡额度释放)" % _reaped)
        except Exception:
            pass
        try:
            _amt_int = max(1, int(round(batch_amt)))
            _fundable = common.fundable_count(_amt_int)
            log("[订阅] 卡总容量:按 $%s 还能真扣 %d 次(待跑 %d 个号)" % (batch_amt, _fundable, len(pending)))
            if args.limit_by_capacity and _fundable < len(pending):
                _before = len(pending)
                pending = pending[:max(0, _fundable)]
                log("[订阅] --limit-by-capacity:卡容量只够 %d 个 → 本批从 %d 砍到 %d 个" % (_fundable, _before, len(pending)))
        except Exception as _e:
            log("[订阅] 容量读数失败(不影响跑): %s" % str(_e)[:80])

    def worker(i, acct):
        slot = slot_q.get()
        try:
            start_idx = (i + args.proxy_offset) % len(proxies)
            log("════ [%d/%d] %s （代理从池中第 %d 个起 offset=%d，窗口槽位 %d/%d）════" % (
                i + 1, len(accounts), acct["email"], start_idx, args.proxy_offset, slot, conc))
            r = pipeline.run_account(acct, proxies, start_idx, group_id, opts, slot=slot, slots_total=conc, checkpoint=save_progress)
            r["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            if args.job_id:
                r["job_id"] = args.job_id
            with write_lock, common._file_lock(res_file):   # 线程锁(本进程)+ 文件锁(跨进程)防并发追加交错成半行
                with open(res_file, "a", encoding="utf-8") as f:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    f.flush(); os.fsync(f.fileno())
            log("════ 结果 %s ok=%s steps=%s ════" % (acct["email"].split("@")[0], r.get("ok"), r.get("steps")))
            return r
        finally:
            slot_q.put(slot)

    if conc <= 1:
        for i, acct in pending:
            try:
                worker(i, acct)
            except Exception as e:
                log("账号异常 %s: %s" % (acct["email"], str(e)[:80]))
            time.sleep(args.gap)
    else:
        log("并发 %d 跑 %d 个号(纯Selenium z.ai)" % (conc, len(pending)))
        with concurrent.futures.ThreadPoolExecutor(max_workers=conc) as ex:
            futs = []
            for i, acct in pending:
                futs.append(ex.submit(worker, i, acct))
                time.sleep(min(args.gap, 3))
            for fu in concurrent.futures.as_completed(futs):
                try:
                    fu.result()
                except Exception as e:
                    log("worker 异常: %s" % str(e)[:80])

    # ════ 自动重试失败号(AUTO_RETRY_FAILED;默认关 → range(0) 不执行)════
    _retry_times = 0
    if str(os.environ.get("AUTO_RETRY_FAILED", "")).strip().lower() in ("1", "on", "true", "yes"):
        try:
            _retry_times = max(0, int(os.environ.get("AUTO_RETRY_FAILED_TIMES", "1") or 1))
        except Exception:
            _retry_times = 1
    for _rt in range(_retry_times):
        args.proxy_offset += 1
        _done2, _reg2, _sub2, _fs2 = set(), set(), set(), {}
        if os.path.exists(res_file):
            with open(res_file, "r", encoding="utf-8") as _rf:
                for _ln in _rf:
                    try:
                        _rr = json.loads(_ln)
                    except Exception:
                        continue
                    _st = (_rr.get("steps") or {})
                    if _rr.get("fail_stage"):
                        _fs2[_rr.get("email")] = _rr.get("fail_stage")
                    if _st.get("auth") == "ok":
                        _reg2.add(_rr.get("email"))
                    if _st.get("subscribe") == "success" or (_rr.get("subscribed") or 0):
                        _sub2.add(_rr.get("email"))
                    if _rr.get("not_allowed") or common.is_banned_reason(_st.get("auth")):
                        _done2.add(_rr.get("email"))
                    elif _rr.get("ok"):
                        _done2.add(_rr.get("email"))
        try:
            with open(_PROGRESS_FILE, encoding="utf-8") as _pf:
                _prog2 = json.load(_pf)
        except Exception:
            _prog2 = {}
        for _em0, _rec0 in (_prog2.items() if isinstance(_prog2, dict) else []):
            if _rec0.get("registered"):
                _reg2.add(_em0)
        _bad2 = common.load_bad_mailboxes()
        _retry_pending = []; _skip_by_policy = 0
        for _i, _acct in enumerate(accounts):
            if _acct["email"] in _done2 or common.is_bad_mailbox(_acct["email"], _bad2):
                continue
            if not common.recovery.should_retry(_fs2.get(_acct["email"])):
                _skip_by_policy += 1
                continue
            if _acct["email"] in _reg2:
                _acct["registered"] = True
            if _acct["email"] in _sub2:
                _acct["subscribed"] = True
            _rec = (_prog2 or {}).get(_acct["email"]) or {}
            if _rec:
                _acct["prior"] = _rec
                if _rec.get("api_key"):
                    _acct["prior_key"] = _rec["api_key"]
            _retry_pending.append((_i, _acct))
        if _skip_by_policy:
            log("自动重试:按恢复策略跳过 %d 个号(其失败类型被配成「不重试」)" % _skip_by_policy)
        if not _retry_pending:
            log("自动重试:无失败号待重试 → 结束")
            break
        log("════ 自动重试 第 %d/%d 轮:%d 个失败号 resume 重跑 ════" % (_rt + 1, _retry_times, len(_retry_pending)))
        if conc <= 1:
            for _i, _acct in _retry_pending:
                try:
                    worker(_i, _acct)
                except Exception as _e:
                    log("重试账号异常 %s: %s" % (_acct["email"], str(_e)[:80]))
                time.sleep(args.gap)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=conc) as _ex2:
                _futs2 = []
                for _i, _acct in _retry_pending:
                    _futs2.append(_ex2.submit(worker, _i, _acct))
                    time.sleep(min(args.gap, 3))
                for _fu in concurrent.futures.as_completed(_futs2):
                    try:
                        _fu.result()
                    except Exception as _e:
                        log("重试 worker 异常: %s" % str(_e)[:80])

    log("全部跑完%s。结果见 %s" % ((" (含自动重试 %d 轮)" % _retry_times) if _retry_times else "", res_file))


if __name__ == "__main__":
    main()
