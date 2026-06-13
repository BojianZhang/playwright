#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 混合方案批量自重试循环 + 【冷却队列】：一轮轮跑 hybrid_run,跳过 已绑/被拒/冷却中 的号;
# 当没有可跑号、剩下的全在冷却时 →【等到最近一个冷却到点再继续】(不空转、不连刷)。
# 加卡给不上(切IP无效=卡velocity)的号会被 hybrid_run 打 cooldown_until 时间戳,本循环据此排队。
# 文件/参数走环境变量,便于换批: HYB_ACCOUNTS / HYB_PROXIES / HYB_OP_PW / HYB_CONCURRENCY / HYB_COOLDOWN_H
import subprocess, sys, os, json, time, signal
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common   # 复用 banned 判定,口径与 hybrid_run/cleanup_envs 一致


def _res_sig():
    """结果文件签名(mtime,size):用于判断一轮 hybrid_run 是否真写出了进展。"""
    try:
        s = os.stat(RES)
        return (s.st_mtime, s.st_size)
    except OSError:
        return None


def _kill_tree(proc):
    """杀整棵进程树(hybrid_run 派生的 chromedriver/node 孙进程),否则它们成孤儿堆积。
       subprocess 的 timeout 只杀直接子进程,不走树。"""
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

HERE = os.path.dirname(os.path.abspath(__file__))
ACCTS = os.path.join(HERE, os.environ.get("HYB_ACCOUNTS", "accounts.batch19.txt"))
PROXIES = os.path.join(HERE, os.environ.get("HYB_PROXIES", "proxies.local.txt"))
RES = os.path.join(HERE, "state", "hybrid_results.jsonl")
PY = sys.executable
OP_PW = os.environ.get("HYB_OP_PW", "")  # OpenRouter 账号密码:从 HYB_OP_PW 环境变量读,绝不硬编码进库
CONCURRENCY = int(os.environ.get("HYB_CONCURRENCY", "3"))
COOLDOWN_H = float(os.environ.get("HYB_COOLDOWN_H", "3"))         # 切IP无效→冷却几小时
MAX_RUN_PASSES = int(os.environ.get("HYB_MAX_PASSES", "20"))      # 实际跑 hybrid_run 的轮数上限(不含等待)


def targets():
    with open(ACCTS, encoding="utf-8") as _f:
        return [l.split(":", 1)[0].strip() for l in _f if ":" in l and not l.startswith("#")]


def _latest():
    out = {}
    if os.path.exists(RES):
        with open(RES, encoding="utf-8") as _f:
            _lines = list(_f)
        for l in _lines:
            try:
                r = json.loads(l)
            except Exception:
                continue
            if r.get("email"):
                out[r["email"]] = r
    return out


def bound(latest):
    """已绑卡 ∪ 被拒(not allowed) ∪ 永久放弃(needphone/hcaptcha/重开够多次)——都不该再跑。"""
    b = set()
    for e, r in latest.items():
        st = r.get("steps") or {}
        if (st.get("card") == "card-bound" or r.get("not_allowed")
                or r.get("giveup_permanent")
                or common.is_banned_reason(st.get("pw_reason"), st.get("auth"))):
            b.add(e)
    return b


def cooling(latest, now):
    """{email: 冷却到点 epoch} —— 切IP无效给不上、还在冷却窗内的号。"""
    return {e: r["cooldown_until"] for e, r in latest.items()
            if r.get("cooldown_until") and not r.get("ok") and r["cooldown_until"] > now}


def run():
    T = targets()
    run_passes = 0
    consec_crash = 0   # 连续"非零退出且无进展"的轮数:用于识别启动即崩(导入/参数错)→ 及时停,别空转重启
    while run_passes < MAX_RUN_PASSES:
        now = time.time()
        latest = _latest()
        b = bound(latest)
        pend = [e for e in T if e not in b]
        if not pend:
            print("✅ 全部 %d 个号都绑卡完成。" % len(T), flush=True)
            break
        cd = cooling(latest, now)
        runnable = [e for e in pend if cd.get(e, 0) <= now]
        cooling_now = [e for e in pend if cd.get(e, 0) > now]
        print("════ 已绑 %d/%d | 可跑 %d | 冷却中 %d ════" % (
            len(T) - len(pend), len(T), len(runnable), len(cooling_now)), flush=True)
        if runnable:
            run_passes += 1
            # 本轮上限:按 ceil(可跑号/并发) 波 × 单号最坏 ~900s + 缓冲,封顶 4h。
            # 必须有 timeout —— 否则某 worker 卡在挂死的 Selenium 命令(Selenium 无客户端超时),
            # 线程池 shutdown(wait=True) 永等 → hybrid_run 不退出 → 这里 subprocess.run 永久阻塞 → 无人值守死锁。
            waves = max(1, -(-len(runnable) // CONCURRENCY))
            pass_timeout = int(os.environ.get("HYB_PASS_TIMEOUT", str(min(4 * 3600, waves * 900 + 600))))
            print("── Pass %d：跑 %d 个可跑号(并发%d,冷却%.1fh,本轮上限%d分) ──" % (
                run_passes, len(runnable), CONCURRENCY, COOLDOWN_H, pass_timeout // 60), flush=True)
            sig_before = _res_sig()
            proc = subprocess.Popen([PY, "-u", "hybrid_run.py", "--accounts", ACCTS, "--proxies", PROXIES,
                                     "--op-pw", OP_PW, "--proxy-offset", str(run_passes), "--gap", "8",
                                     "--concurrency", str(CONCURRENCY), "--cooldown-hours", str(COOLDOWN_H),
                                     "--max-rotations", "3"], cwd=HERE,
                                    start_new_session=(os.name != "nt"))  # POSIX:独立进程组,便于整树回收
            rc = None
            try:
                rc = proc.wait(timeout=pass_timeout)
            except subprocess.TimeoutExpired:
                # 杀本轮(疑 Selenium 卡死)——连同 chromedriver/node 孙进程整树杀,否则孤儿堆积;
                # 下一轮重读 state 续跑:卡住号的环境已保留、可重开;开跑前 gc_envs 回收孤儿环境。
                print("⚠️ 本轮超过 %d 分钟未结束(疑 Selenium 卡死)→ 杀本轮(含子孙进程),下轮重读state续跑" % (pass_timeout // 60), flush=True)
                _kill_tree(proc)
                try: proc.wait(timeout=15)
                except Exception: pass
                rc = None   # 视作"被杀",非崩溃
            # busy-spin 防护:非零退出码原来被静默吞 → 启动即崩(导入/参数错)会空转重启耗尽整轮预算。
            # 非零退出且 state 文件无变化(本轮没写出任何进展)才计为崩;连续两轮就停,避免 ~7 分钟空转。
            if rc not in (0, None):
                print("⚠️ hybrid_run 非零退出 rc=%s" % rc, flush=True)
                if _res_sig() == sig_before:
                    consec_crash += 1
                else:
                    consec_crash = 0
                if consec_crash >= 2:
                    print("✗ 连续 %d 轮 hybrid_run 非零退出且无进展(疑启动即崩:导入/参数错)→ 停止循环,请查上方 traceback" % consec_crash, flush=True)
                    break
            else:
                consec_crash = 0
            time.sleep(20)   # 轮间小歇
        elif cooling_now:
            nearest = min(cd[e] for e in cooling_now)
            wait = max(60, min(int(nearest - now) + 30, 3600))   # 等到最近一个冷却到点;最多等1h后重查
            print("⏳ 没有可跑号,%d 个在冷却队列。等 %d 分钟到最近一个到点再继续…" % (len(cooling_now), int(wait / 60)), flush=True)
            time.sleep(wait)
        else:
            break
    latest = _latest()
    b = bound(latest)
    print("循环结束。已绑 %d/%d。" % (len([e for e in T if e in b]), len(T)), flush=True)


if __name__ == "__main__":
    run()
