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
        # ★F7:_atomic_write_json 失败【返回 False 不抛】→ 必须查返回值告警(原来纯 try/except 抓不到,静默丢 checkpoint
        #   → 续跑漏判已充 → 真金白银重扣)。写失败时大声告警,运维可人工核对。
        try:
            if not common._atomic_write_json(_PROGRESS_FILE, d):
                log("[checkpoint] ⚠⚠ save_progress 落盘失败(续跑可能漏判已充→重扣风险),请人工核对: %s" % email)
        except Exception as _e:
            try: log("[checkpoint] ⚠ save_progress 异常: %s" % str(_e)[:80])
            except Exception: pass


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
    # ★充值容量闸(全默认关=逐字节不变):real-charge 真扣 / card-charge-gate 开卡容量账本(充值步原子预留) /
    #   charge-count 整批最多真充 N 次(测试帽,0=不限) / limit-by-capacity 按卡总容量自动限批
    ap.add_argument("--real-charge", action="store_true", help="真实充值(真点 Purchase 扣款);不传=dry-run 走到充值步不真扣")
    ap.add_argument("--card-charge-gate", action="store_true", help="开卡充值容量账本闸(充值步原子预留:容量不够/同卡并发满→钱不够 END 不扣)")
    ap.add_argument("--charge-count", type=int, default=0, help="整批最多真充 N 次(测试帽);0=不限")
    ap.add_argument("--limit-by-capacity", action="store_true", help="按卡总充值容量自动限批(够几个跑几个)")
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
                    # ★AR-1/MP-02 修(防二次扣款):charged 第二独立信号必须覆盖【两条扣款路径】——
                    #   ① billing purchase 成功(steps.purchase==success);② 向导内 add-credits 充值(pipeline 写 res["charged"]=10,
                    #   但【不写 steps.purchase】)。原来只认 purchase → 向导充值号的 res["charged"] 成死信号 → checkpoint 丢即重扣。
                    if (r.get("steps") or {}).get("purchase") == "success" or (r.get("charged") or 0) > 0:
                        charged.add(r.get("email"))   # 充值成功落过 results → 即便 checkpoint 没记上,也绝不再扣
                    # 被 OpenRouter 永久拒绝(NOT_ALLOWED)→ 标完成永久跳过,别每轮重试白烧 env/IP(--no-resume 仍可强制重试)
                    if r.get("not_allowed") or common.is_banned_reason((r.get("steps") or {}).get("auth")):
                        done.add(r.get("email"))   # 口径与混合统一(is_banned_reason),不再用脆弱的 endswith("NOT_ALLOWED")
                    if args.do_card:
                        # 只有【已绑】才永久跳过；弹过验证的号下一轮换 IP+指纹再试(本轮内是快速跳过不卡住)
                        if (r.get("steps") or {}).get("card") == "card-bound":
                            # ★card 干净绑成,但 do_purchase 开且本号没充成(没扣过)→ 不标完成,留续跑【补充值】
                            #   (卡已绑:pipeline 据 prior 跳过重绑、只补购,不重复扣款也不重复绑卡)。与新成功口径一致。
                            _pur_ok = (r.get("steps") or {}).get("purchase") == "success" or (r.get("charged") or 0) > 0
                            if not args.do_purchase or _pur_ok:
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
        if _a["email"] in charged:                   # ★第二独立信号:充值成功落过 results → 接到 acct(原来漏挂=死代码),pipeline 防重复扣款才真生效
            _a["charged"] = True
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

    # ★整批最多真充 N 次(测试帽):跨 worker 线程安全计数。真扣【前】(reserve 成功后)调一次占名额,达 N 即拒。
    _charge_lock = threading.Lock()
    _charge_used = [0]
    def try_batch_charge():
        n = max(0, int(args.charge_count or 0))
        if n <= 0:
            return True   # 0=不限
        with _charge_lock:
            if _charge_used[0] >= n:
                return False
            _charge_used[0] += 1
            return True

    opts = {
        "cfg": cfg, "do_key": (not args.no_key), "do_card": args.do_card,
        "do_purchase": args.do_purchase, "amount": args.amount,
        "do_changepw": args.do_changepw, "unified_pw": args.unified_pw or None,
        "key_name": args.key_name, "manual_hcaptcha": not args.auto_hcaptcha_only,
        "delete_env": not args.no_delete_env,
        # 充值容量闸:real_charge 真扣 / card_charge_gate 开容量账本预留 / charge_count 测试帽 / 批级真充计数回调
        "real_charge": args.real_charge, "card_charge_gate": args.card_charge_gate,
        "charge_count": max(0, int(args.charge_count or 0)), "try_batch_charge": try_batch_charge,
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

    # ★先回收上次崩溃/中断遗留的在飞预留:只要开了【容量闸】就可能有遗留(reserve 在 gate 开时就会发生,与 real_charge 无关)→
    #   不再要求 real_charge+do_purchase 同时开,否则 dry-run/关真扣那批崩溃后的在飞预留永不回收、永久占住卡额度(DEFECT-05)。
    if args.card_charge_gate:
        try:
            _reaped = common.reap_stale_inflight()
            if _reaped:
                log("[充值] 回收上次遗留的在飞预留 %d 笔(卡额度释放)" % _reaped)
        except Exception:
            pass
    # 充值容量读数 + 可选自动限批(只在 real_charge+do_purchase+gate 开时有意义)。
    if args.real_charge and args.do_purchase and args.card_charge_gate:
        try:
            _fundable = common.fundable_count(args.amount)
            log("[充值] 卡总充值容量:按 $%d 还能真充 %d 次(待跑 %d 个号)" % (args.amount, _fundable, len(pending)))
            if args.limit_by_capacity and _fundable < len(pending):
                _before = len(pending)
                pending = pending[:max(0, _fundable)]
                log("[充值] --limit-by-capacity:卡容量只够 %d 个 → 本批从 %d 砍到 %d 个(够几个跑几个)" % (_fundable, _before, len(pending)))
        except Exception as _e:
            log("[充值] 容量读数失败(不影响跑): %s" % str(_e)[:80])

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
                # ★DEFECT-02:单次 os.write 原子追加(O_APPEND)整行 → 多个 job 的进程并发写【同一】results.jsonl 时,
                #   读方(Node)绝不会读到本行的半截(buffered f.write 可能把大行拆成多次 write syscall → 被并发读到撕裂)。fsync 防 SIGKILL 丢尾。
                _line = (json.dumps(r, ensure_ascii=False) + "\n").encode("utf-8")
                _fd = os.open(res_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
                try:
                    os.write(_fd, _line); os.fsync(_fd)
                finally:
                    os.close(_fd)
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

    # ════ 自动重试失败号(开关 AUTO_RETRY_FAILED;默认关 → 下面 range(0) 不执行,行为逐字节不变)════
    #   一批跑完后,重读 results/checkpoint 重算"已完成"→ 只剩【本批失败且可重试】的号,以 resume 语义再跑 N 轮,降失败率。
    #   ★resume 语义(复用 prior_key/charged/_prior_done)保证:已取key不重建、已充值不重扣、已绑卡跳过 → 只补做失败那一步。
    #   ★永久跳过的不重试:NOT_ALLOWED/banned(口径 is_banned_reason)与坏邮箱(load_bad_mailboxes)都计入"完成"不再跑。
    _retry_times = 0
    if str(os.environ.get("AUTO_RETRY_FAILED", "")).strip().lower() in ("1", "on", "true", "yes"):
        try:
            _retry_times = max(0, int(os.environ.get("AUTO_RETRY_FAILED_TIMES", "1") or 1))
        except Exception:
            _retry_times = 1
    for _rt in range(_retry_times):
        # ★AR-4:每轮换起始代理/出口IP重试(环境性失败=declined/Radar/网络 大概率因换IP而过;同IP重试大概率复现)。
        args.proxy_offset += 1
        # 重算 done/registered/charged(口径同初始扫描;这里【不受 --no-resume 清空】——必须跳过本批已成功的号)
        _done2, _reg2, _chg2 = set(), set(), set()
        _fs2 = {}   # email → 最近一条结果行的 fail_stage(Stage 1B 归因)→ 给恢复策略按类型决定是否重试
        if os.path.exists(res_file):
            with open(res_file, "r", encoding="utf-8") as _rf:
                for _ln in _rf:
                    try:
                        _rr = json.loads(_ln)
                    except Exception:
                        continue
                    _st = (_rr.get("steps") or {})
                    if _rr.get("fail_stage"):
                        _fs2[_rr.get("email")] = _rr.get("fail_stage")   # 取最近一行(同号多行后写覆盖)
                    if _st.get("auth") == "ok":
                        _reg2.add(_rr.get("email"))
                    if _st.get("purchase") == "success" or (_rr.get("charged") or 0) > 0:   # AR-1:向导充值第二信号
                        _chg2.add(_rr.get("email"))
                    if _rr.get("not_allowed") or common.is_banned_reason(_st.get("auth")):
                        _done2.add(_rr.get("email"))
                    if args.do_card:
                        _card = _st.get("card")
                        # 已绑=完成;★RETRY-CARD-01:已点 Save 的【歧义态】(server-error/card-502/needphone)卡可能已提交 Stripe,
                        #   自动重跑会再提交【另一张卡】=重复绑卡 + 烧 BIN(违反铁律③)→ 计入完成【不自动重试】,留人工核验,绝不盲重绑。
                        if _card in ("card-bound", "server-error", "card-502", "needphone"):
                            # ★只对【干净 card-bound】:do_purchase 开且没充成 → 不标完成,留续跑补充值(卡已绑不重绑,纯补购)。
                            #   歧义态(server-error/card-502/needphone)仍标完成不自动重绑(保留 RETRY-CARD-01 铁律)。
                            _pur_ok = _st.get("purchase") == "success" or (_rr.get("charged") or 0) > 0
                            if _card != "card-bound" or not args.do_purchase or _pur_ok:
                                _done2.add(_rr.get("email"))
                    elif args.do_purchase:
                        # ★AR-2:纯充值模式(do_purchase 无 do_card)完成须【充值成功】(purchase==success 或 charged>0),
                        #   不能只看 ok(ok 不含 purchase)→ 否则取到key但充值失败的号被误判完成、永不重试。
                        if _st.get("purchase") == "success" or (_rr.get("charged") or 0) > 0:
                            _done2.add(_rr.get("email"))
                    elif _rr.get("ok"):
                        _done2.add(_rr.get("email"))
        try:
            with open(_PROGRESS_FILE, encoding="utf-8") as _pf:
                _prog2 = json.load(_pf)
        except Exception:
            _prog2 = {}
        # ★AR-3:并入 checkpoint 的 registered 标记(对齐初始扫描)→ 已注册号重试直接登录,不再点注册(否则卡 verify→UNCONFIRMED)
        for _em0, _rec0 in (_prog2.items() if isinstance(_prog2, dict) else []):
            if _rec0.get("registered"):
                _reg2.add(_em0)
        _bad2 = common.load_bad_mailboxes()
        _retry_pending = []
        _skip_by_policy = 0
        for _i, _acct in enumerate(accounts):
            if _acct["email"] in _done2 or common.is_bad_mailbox(_acct["email"], _bad2):
                continue
            # ★恢复策略(可配):按该号失败类型(fail_stage)决定是否参与本轮重试。默认全 True=现状重试所有非完成号;
            #   只有用户在「恢复策略」页把某类型(注册/取Key/加卡/充值)配成 off 才跳过。歧义态早已计入 _done2(RETRY-CARD-01)不到这。
            if not common.recovery.should_retry(_fs2.get(_acct["email"])):
                _skip_by_policy += 1
                continue
            # 刷新该号 resume 状态:注册过→直登不重注册、充过→不重扣、有key→复用不重建(防重复劳动/扣款)
            if _acct["email"] in _reg2:
                _acct["registered"] = True
            if _acct["email"] in _chg2:
                _acct["charged"] = True
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
        log("════ 自动重试 第 %d/%d 轮:%d 个失败号 resume 重跑(已成功/永久跳过的不再跑)════" % (
            _rt + 1, _retry_times, len(_retry_pending)))
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
