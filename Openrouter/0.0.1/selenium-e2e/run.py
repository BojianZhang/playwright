#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 纯 Selenium 流水线入口：读账号/代理池/配置 → 逐账号建环境跑全流程 → 删环境。
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/run.py
#
# 账号文件：每行 email:邮箱密码    代理池文件：每行 host:port:user:pass(或 socks5://user:pass@host:port)
#
# 例：python selenium-e2e/run.py --accounts accts.txt --proxies proxies.txt --do-key --do-card --unified-pw 'NewPw!2026' --do-changepw
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

# ── 增量 checkpoint(对齐 hybrid_run.save_progress)──────────────────────────
# 原来结果只在一个号【完整跑完】才写 results.jsonl;中途被杀/异常 → 进度全丢、下轮当新号重注册,
# 但号已在 OpenRouter 存在 → 重注册卡 verify → "重跑跑不动"。这里一到里程碑(注册成功/拿到key)就存盘,
# 下次启动合并进 registered → 直接登录、复用进度。run.py 多 worker 线程,_PROGRESS_LOCK 串行化;独立进程文件
# 不与 hybrid 共享(避免 split 模式两进程并发 RMW 丢更新)。
_PROGRESS_FILE = os.path.join(common.HERE, "state", "sel_account_progress.json")
_PROGRESS_LOCK = threading.Lock()


def save_progress(email, **fields):
    if not email:
        return
    with _PROGRESS_LOCK:
        try:
            with open(_PROGRESS_FILE, encoding="utf-8") as _f:
                d = json.load(_f)
        except Exception:
            d = {}
        rec = d.setdefault(email, {})
        # _stage=(name, obj):把某阶段写进 rec["stages"][name]——逐阶段状态机(register/login/key/address/card/charge/changepw),
        # 续跑据此跳过/复用每个已完成阶段(只认 status=="ok"),不再"整号 done/registered 两档"。
        st = fields.pop("_stage", None)
        if st:
            rec.setdefault("stages", {})[st[0]] = st[1]
        for k, v in fields.items():
            if v not in (None, ""):
                rec[k] = v
        rec["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        try:
            common._atomic_write_json(_PROGRESS_FILE, d)
        except Exception:
            pass


def read_accounts(path):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                em, pw = line.split(":", 1)
                if not em.strip() or not pw.strip():   # 尾随/前导冒号 → email 或邮箱密码为空,与无冒号行一样跳过告警
                    log("跳过缺 email 或邮箱密码的账号行: %s" % line[:40])
                    continue
                out.append({"email": em.strip(), "mailbox_pw": pw.strip()})
            else:
                log("跳过格式不对的账号行: %s" % line[:40])
    return out


def main():
    ap = argparse.ArgumentParser(description="纯 Selenium OpenRouter 流水线")
    ap.add_argument("--accounts", required=True, help="账号文件 (email:邮箱密码 每行)")
    ap.add_argument("--proxies", required=True, help="代理池文件")
    ap.add_argument("--do-key", action="store_true", help="取 API Key")
    ap.add_argument("--no-key", action="store_true", help="跳过取 Key(补加卡时用,避免重复建 key)")
    ap.add_argument("--do-card", action="store_true", help="加卡")
    ap.add_argument("--do-purchase", action="store_true", help="充值")
    ap.add_argument("--amount", type=int, default=5, help="充值金额(美元, 默认5)")
    ap.add_argument("--do-changepw", action="store_true", help="改邮箱密码(需 --unified-pw)")
    ap.add_argument("--unified-pw", default="", help="统一密码(OpenRouter 密码 + 改密目标)")
    ap.add_argument("--key-name", default=None)
    ap.add_argument("--no-delete-env", action="store_true", help="跑完不删环境(调试用)")
    ap.add_argument("--auto-hcaptcha-only", action="store_true", help="hCaptcha 只走 2captcha,不转人工")
    ap.add_argument("--gap", type=int, default=5, help="账号间隔秒(默认5)")
    ap.add_argument("--proxy-offset", type=int, default=0, help="代理起始下标偏移(每轮重试+1换不同IP)")
    ap.add_argument("--concurrency", type=int, default=1, help="并发数(同时跑几个号,默认1=串行;Fix C 每浏览器独立CDP连接、窗口无关,可并发)")
    ap.add_argument("--no-resume", action="store_true", help="忽略已完成/坏邮箱状态,强制整组重跑(控制台「断点续跑」取消勾选时传入)")
    ap.add_argument("--job-id", default="", help="本次任务 jobId:写进结果行 job_id,供 web 按 job 隔离取结果(防同引擎并发串号)")
    args = ap.parse_args()
    args.gap = max(0, args.gap)                   # 负 --gap → time.sleep(负数) 抛 ValueError,会中断整批(在 per-account try 之外)
    args.concurrency = max(1, args.concurrency)   # 负/0 并发 → ThreadPoolExecutor 直接报错

    cfg = common.load_config()
    if not cfg["captcha_key"] or not cfg["mail_key"]:
        log("⚠ config.local.json 缺 captcha.apiKey 或 mailbox.apiKey")
    accounts = read_accounts(args.accounts)
    proxies = adspower_env.load_proxies(args.proxies)
    if not accounts:
        log("没读到账号"); return
    if not proxies:
        log("代理池为空 —— 新建环境必须配代理"); return
    log("账号 %d 个, 代理 %d 条" % (len(accounts), len(proxies)))

    group_id = adspower_env.ensure_group("selpipe")
    state_dir = os.path.join(common.HERE, "state")
    os.makedirs(state_dir, exist_ok=True)
    res_file = os.path.join(state_dir, "results.jsonl")
    # 续跑判定：加卡模式下「卡已绑」才算完成；否则 ok=True 算完成
    done = set()
    registered = set()        # 历史上注册成功过(auth=ok)的号 → 重跑直接登录,不再点注册(避免已存在号卡 verify→REGISTER_UNCONFIRMED)
    charged = set()           # 历史上充值成功过的号 → 防重复扣款的【第二独立信号】(与 checkpoint stages.charge 互补,任一为真即跳过)
    if os.path.exists(res_file):
        with open(res_file, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    if (r.get("steps") or {}).get("auth") == "ok":
                        registered.add(r.get("email"))
                    if (r.get("steps") or {}).get("purchase") == "success":
                        charged.add(r.get("email"))   # 充值成功落过 results → 即便 checkpoint 没记上,也绝不再扣
                    if args.do_card:
                        # 只有【已绑】才永久跳过；弹过验证的号下一轮换 IP+指纹再试(本轮内是快速跳过不卡住)
                        if (r.get("steps") or {}).get("card") == "card-bound":
                            done.add(r.get("email"))
                    elif r.get("ok"):
                        done.add(r.get("email"))
                except Exception:
                    pass
    if args.no_resume:
        done = set()   # 强制重跑:不按"已完成"跳过(registered 仍保留 → 已存在的号直接登录、不重注册)
        log("--no-resume:忽略已完成状态,整组强制重跑")
    # 合并增量 checkpoint:中途被杀/异常、还没写进 results.jsonl 的号从这里补回 registered →
    # 下次直接登录、不再重注册(号已在 OpenRouter 存在,重注册会卡 verify;这是"重跑跑不动"的根因)。
    try:
        with open(_PROGRESS_FILE, encoding="utf-8") as _f:
            _prog = json.load(_f)
        for _em, _rec in (_prog.items() if isinstance(_prog, dict) else []):
            if _rec.get("registered"):
                registered.add(_em)
    except Exception:
        _prog = {}
    # 把整条 prior 进度(stages 子树 + api_key)带给每个 acct → pipeline 逐阶段跳过/复用:
    #   已取key→复用不重建、已绑卡/已充值/已改密→跳过(防重复劳动 + 防重复扣款 + 防改密失败)。
    #   注:--no-resume 只清 done(强制重跑业务步骤),但 prior/prior_key 仍保留 —— 绝不重建key、绝不重复扣款。
    _reused = 0
    for _a in accounts:                              # 给已注册过的号打标记 → pipeline 据此直接登录
        if _a["email"] in registered:
            _a["registered"] = True
        _rec = (_prog or {}).get(_a["email"]) or {}
        if _rec:
            _a["prior"] = _rec
            if _rec.get("api_key"):
                _a["prior_key"] = _rec["api_key"]
                if (((_rec.get("stages") or {}).get("key") or {}).get("status")) == "ok":
                    _reused += 1
    if registered:
        log("已注册标记:%d 个号历史 auth=ok,重跑将直接登录(不再点注册)" % len(registered))
    if _reused:
        log("阶段续跑:%d 个号已有 key,重跑将复用(不重复建 key)" % _reused)

    opts = {
        "cfg": cfg, "do_key": (not args.no_key), "do_card": args.do_card,
        "do_purchase": args.do_purchase, "amount": args.amount,
        "do_changepw": args.do_changepw, "unified_pw": args.unified_pw or None,
        "key_name": args.key_name, "manual_hcaptcha": not args.auto_hcaptcha_only,
        "delete_env": not args.no_delete_env,
    }

    write_lock = threading.Lock()                 # 并发写 results.jsonl 加锁,防多 worker 交错
    conc = max(1, args.concurrency)
    slot_q = queue.Queue()                        # 并发窗口槽位 0..conc-1,跑完归还复用 → grid_rect 按并发平铺
    for _s in range(conc):
        slot_q.put(_s)
    bad_mb = {} if args.no_resume else common.load_bad_mailboxes()  # 坏邮箱(404收不到验证邮件)→ 永久跳过;--no-resume 时也强制重试
    _skipbad = [a["email"] for a in accounts if common.is_bad_mailbox(a["email"], bad_mb)]
    if _skipbad:
        log("跳过坏邮箱 %d 个(已登记收不到验证邮件): %s" % (len(_skipbad), ", ".join(x.split("@")[0] for x in _skipbad)))
    for _i, _a in enumerate(accounts):
        if _a["email"] in done:
            log("跳过已完成 %s" % _a["email"])
    pending = [(i, acct) for i, acct in enumerate(accounts)
               if acct["email"] not in done and not common.is_bad_mailbox(acct["email"], bad_mb)]

    def worker(i, acct):
        slot = slot_q.get()                       # 占一个网格槽位(决定本号窗口在屏幕哪格)
        try:
            start_idx = (i + args.proxy_offset) % len(proxies)
            log("════ [%d/%d] %s （代理从池中第 %d 个起 offset=%d，失败自动轮换，窗口槽位 %d/%d）════" % (
                i + 1, len(accounts), acct["email"], start_idx, args.proxy_offset, slot, conc))
            r = pipeline.run_account(acct, proxies, start_idx, group_id, opts, slot=slot, slots_total=conc, checkpoint=save_progress)
            r["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            if args.job_id:
                r["job_id"] = args.job_id   # web 按 job 隔离取结果(同引擎并发不串号)
            with write_lock:
                with open(res_file, "a", encoding="utf-8") as f:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    f.flush(); os.fsync(f.fileno())   # 进程被 SIGKILL 也不丢末尾缓冲行(并发 append 结果)
            log("════ 结果 %s ok=%s steps=%s ════" % (acct["email"].split("@")[0], r.get("ok"), r.get("steps")))
            return r
        finally:
            slot_q.put(slot)                      # 归还槽位给后续账号复用

    if conc <= 1:
        # 串行(默认):一个个跑,保留 --gap 间隔(原行为)
        for i, acct in pending:
            try:
                worker(i, acct)
            except Exception as e:
                log("账号异常 %s: %s" % (acct["email"], str(e)[:80]))
            time.sleep(args.gap)
    else:
        # 并发:N 个号同时跑(Fix C 每浏览器独立 CDP、窗口无关,可并行;AdsPower 本地API 在 common.ads_call 已全局限频)
        log("并发 %d 跑 %d 个号(纯Selenium全套)" % (conc, len(pending)))
        with concurrent.futures.ThreadPoolExecutor(max_workers=conc) as ex:
            futs = []
            for i, acct in pending:
                futs.append(ex.submit(worker, i, acct))
                time.sleep(min(args.gap, 3))      # 错峰提交,避免同时猛建环境
            for fu in concurrent.futures.as_completed(futs):
                try:
                    fu.result()
                except Exception as e:
                    log("worker 异常: %s" % str(e)[:80])

    log("全部跑完。结果见 %s" % res_file)


if __name__ == "__main__":
    main()
