#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · 底层原语(被各域共用):日志 / 通用常量与正则 / 通用 HTTP / 原子写 / 跨进程文件锁。
# 本模块只依赖 stdlib,不依赖包内其它模块——是依赖图的根。
import sys
import os
import json
import time
import re
import threading
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 127.0.0.1（不是 local.adspower.net）：后者不在系统代理绕过名单，开了本地代理(VPN/clash)会被转走→502。
API_BASE = os.environ.get("OPENROUTER_ADSPOWER_API", "http://127.0.0.1:50325")
_NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 强制不走系统代理
# AdsPower 鉴权令牌(本机网关一般无需 → 默认空,不加头;指向远程/带鉴权网关时,web 经 engine-runner
# 注入 OPENROUTER_ADSPOWER_TOKEN)。头名/前缀可覆盖以适配不同网关(默认 Authorization: Bearer <token>)。
ADS_TOKEN = (os.environ.get("OPENROUTER_ADSPOWER_TOKEN", "") or "").strip()
ADS_AUTH_HEADER = os.environ.get("OPENROUTER_ADSPOWER_AUTH_HEADER", "Authorization") or "Authorization"
ADS_AUTH_PREFIX = os.environ.get("OPENROUTER_ADSPOWER_AUTH_PREFIX", "Bearer ")  # 设空=发裸 token

CREDITS_URL = "https://openrouter.ai/settings/credits"
KEYS_URL = "https://openrouter.ai/settings/keys"
SIGNUP_URL = "https://openrouter.ai/sign-up"
SIGNIN_URL = "https://openrouter.ai/sign-in"

# Stripe 卡字段选择器（跨 iframe）
NUM = ['input[name="number"]', 'input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[id*="numberInput"]']
EXP = ['input[name="expiry"]', 'input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[id*="expiryInput"]']
CVC = ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[id*="cvcInput"]']
ZIP = ['input[name="postalCode"]', 'input[name="postal"]', 'input[autocomplete="postal-code"]', 'input[id*="postalCodeInput"]']

# 结果判定
RE_502 = re.compile(r"error\s*5\d\d|unable to authenticate|bad gateway", re.I)
RE_DECL = re.compile(r"card was declined|insufficient funds|declined|payment failed|could not complete|do not honor|expired", re.I)
RE_OK = re.compile(r"payment is processing|credits will be added|check back shortly|payment method added|succeeded|payment successful|purchase complete", re.I)
RE_NEEDPHONE = re.compile(r"provide a mobile phone|provide a phone number", re.I)
# 可见人机验证框的【外壳文案】(在主文档,iframe 检测抓不到时靠它兜底识别)——
# 实测 OpenRouter 加卡弹的是 "One more step before you're done / Select the checkbox below / I am human"。
RE_HCAPTCHA = re.compile(r"I am human|Select the checkbox below|One more step before you'?re done", re.I)

_LOG_PREFIX = "[sel]"
# 并发 worker(线程)同时写 stdout 时,print 会把内容/分隔符/换行分多次 write → 两条日志被拼成一行
# (日志里看到的"两个时间戳挤一行")。改:加锁 + 把整行(含换行)一次性写出,多线程也不交错。
_LOG_LOCK = threading.Lock()


def set_log_prefix(p):
    global _LOG_PREFIX
    _LOG_PREFIX = p


def _emit(line):
    """整行(含换行)在锁内【单次】写 stdout + flush —— 并发也不会把两条日志拼成一行;失败绝不抛。"""
    try:
        with _LOG_LOCK:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
    except Exception:
        pass


def log(*a):
    # 行首带 HH:MM:SS —— 没时间戳就量不出每步耗时(注册/取key/绑地址/Save/切IP各几秒)
    body = " ".join(str(x) for x in a)
    _emit("%s %s%s" % (time.strftime("%H:%M:%S"), _LOG_PREFIX, (" " + body) if body else ""))


def log_stage(slot, email, stage, status="running"):
    """逐号阶段进度标记(结构化,供 web/engine-runner.js 解析成 worker-update 画线程进度条)。
    slot=并发槽位(0..N-1,当 workerId)；stage∈env/auth/key/card/charge/changepw；status=running|done。
    email 放末尾,Node 侧正则贪婪取到行尾。发射失败绝不影响主流程。"""
    _emit("@@STAGE@@ slot=%s stage=%s status=%s email=%s" % (slot, stage, status, email))


def fast_mode():
    """提速总开关:环境变量 OPENROUTER_FAST 为真 → 注册/登录跳过成功路径截图 + 把固定 sleep 改成轮询提前退出。
    ★默认关(未设/空)= 与现状【逐字节相同】,绝不影响老业务逻辑;web 高级参数页一键开。"""
    return (os.environ.get("OPENROUTER_FAST", "") or "").strip().lower() in ("1", "true", "on", "yes")


def digits(s):
    return "".join(ch for ch in str(s if s is not None else "") if ch.isdigit())


def http_post_json(url, body, headers=None, timeout=30):
    """通用 POST JSON（走不走代理都用本机 → 不走系统代理，直连，与 Node fetch 行为一致）。
       用于 firstmail / 2captcha 等外网 API。"""
    h = {"Content-Type": "application/json", "accept": "application/json"}
    if headers:
        h.update(headers)
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with _NOPROXY.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _atomic_write_json(path, data):
    """原子写 JSON:写临时文件→fsync→os.replace(同盘原子替换)。
       防进程被杀(尤其本轮超时 SIGKILL)写到一半把 card-pool.json/bin-usage.json 等关键状态
       留成损坏的半截文件 → 下次 load 全员炸。失败兜底退回直接写,绝不让上层抛。"""
    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = "%s.tmp.%d.%d" % (path, os.getpid(), threading.get_ident())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)   # Windows/POSIX 同盘原子替换
        return True
    except Exception:
        # 兜底也必须原子:先把整个 JSON 序列化成字符串(序列化失败不会动到目标文件),
        # 再写临时文件 + os.replace。绝不能 open(path,"w") 直接截断后再流式 dump
        # ——那会在被杀/盘满/序列化中途失败时把状态文件留成半截,正是本函数要防的事。
        try:
            s = json.dumps(data, ensure_ascii=False, indent=2)
            tmp = "%s.tmp.%d.%d" % (path, os.getpid(), threading.get_ident())
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(s)
                f.flush()
                os.fsync(f.fileno())   # ★兜底路径也 fsync,与主路径同等耐久(防崩在 replace 前留半截 tmp)
            os.replace(tmp, path)
        except Exception:
            pass
        return False


class _FileLock:
    """跨进程文件锁:两个引擎进程(run.py + hybrid_run.py)共享卡池时,序列化【读-改-写】,
    让禁用/冷却/取卡占用【实时】对另一进程可见(threading.Lock 只锁进程内,跨进程无效)。lockfile O_EXCL 抢占,Win/Posix 通用。"""
    def __init__(self, target, timeout=20):
        self._lf = str(target) + ".lock"; self._to = timeout; self._fd = None
        self._held = False                          # 仅 os.open 真抢到锁才 True;退化无锁/超时放弃时 False

    def __enter__(self):
        import time as _t
        end = _t.time() + self._to
        while True:
            try:
                self._fd = os.open(self._lf, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                self._held = True                   # 真抢到了:__exit__ 才有资格删 lockfile
                return self
            except (FileExistsError, PermissionError):
                # PermissionError:Windows 下持有者把 fd 开着,竞争者 O_EXCL 会撞共享冲突(errno13)而非 FileExistsError;
                #   原来只 except FileExistsError → Windows 上每次争用都落到下面 except Exception 退化为无锁,跨进程锁形同虚设。
                #   把它当"锁被持有"同等处理(下面靠 lockfile 是否存在/mtime 区分:真权限问题时 getmtime 失败→age=None→退化)。
                if _t.time() > end:                 # 超时:不再无条件清锁(两进程会同时删→双双 O_EXCL 成功→双进临界区)
                    # 只有 lockfile 足够老(>STALE 秒、持有者大概率已死)才当陈旧锁清,且清完不立即 continue 抢——
                    # 让下一轮循环正常 O_EXCL,避免和别的等待者撞删;否则放弃锁退化为无锁(记 log,不阻塞主流程)。
                    stale = float(os.environ.get("FILELOCK_STALE_SEC", "30"))
                    try:
                        mt = os.path.getmtime(self._lf)
                        age = _t.time() - mt
                    except Exception:
                        mt = None; age = None
                    if age is not None and age > stale:
                        # ★防 TOCTOU(S5/S6):删之前再 stat 一次,确认 lockfile 仍是【刚才那把陈旧锁】(mtime 未变)。
                        #   否则可能在 getmtime→remove 之间持有者已释放+另一等待者重建了【新活锁】,os.remove 误删活锁→双进临界区丢增量。
                        try:
                            if abs(os.path.getmtime(self._lf) - mt) < 1e-6:   # mtime 未变=仍是同一把陈旧锁 → 才删
                                os.remove(self._lf)
                        except Exception: pass                                  # 已被别人删/重建 → 不强删,回去正常 O_EXCL 重抢
                        end = _t.time() + min(self._to, 2)   # 给一点窗口重抢(可能被别的等待者抢走→那也只是退化无锁)
                        _t.sleep(0.03)
                        continue
                    if age is not None:
                        # 锁还新=活持有者:【不退化为无锁】(并发读改写会丢增量)。把 deadline 延到 lockfile 变陈旧那一刻
                        # (+小余量)继续正常 O_EXCL 重试 → 要么等它释放、要么它真死后按陈旧锁清掉再抢。
                        # lockfile 创建后 mtime 不变、age 只增 → 必在 stale 处收敛,不会无限等;正常 RMW 是毫秒级,
                        # 走到这里几乎只发生在持有者卡死/超长持锁,等待(正确)远胜丢增量。
                        end = _t.time() + max(0.5, stale - age) + 0.5
                        _t.sleep(0.05)
                        continue
                    # 连 mtime 都取不到(lockfile 恰被别进程删等极少数)→ 放弃,退化为无锁(记 log)
                    try: log("[lock] ⚠ 等待 %s 超时且无法判断锁龄,退化为无锁继续——并发读改写可能丢增量" % os.path.basename(self._lf))
                    except Exception: pass
                    return self
                _t.sleep(0.03)
            except Exception as _e:
                # ★M6:非 EEXIST/Permission 的 os.open 失败(EMFILE 句柄耗尽/ENOSPC 磁盘满等)多为【瞬时】——
                #   原来立即退化无锁 → 并发读改写丢增量(碰 card-pool/账本=丢用次/扣款计数)。改:deadline 内重试,
                #   只有超时仍失败才退化无锁并大声告警(保留"不阻塞主流程"的兜底,但尽量先等出一个真锁)。
                if _t.time() <= end:
                    _t.sleep(0.05)
                    continue
                try: log("[lock] ⚠ 取锁持续异常至超时,退化为无锁继续(并发读改写可能丢增量): %s" % _e)  # 原来此路径静默退化,不可观测
                except Exception: pass
                return self                         # 超时仍失败才退化无锁(不阻塞主流程)

    def __exit__(self, *a):
        try:
            if self._fd is not None:
                os.close(self._fd)
        except Exception:
            pass
        if self._held:                              # 只删自己真持有的锁;退化无锁/超时放弃时绝不碰别进程的活锁
            try:
                os.remove(self._lf)
            except Exception:
                pass


def _file_lock(target, timeout=20):
    return _FileLock(target, timeout)


__all__ = [
    "API_BASE", "_NOPROXY",
    "CREDITS_URL", "KEYS_URL", "SIGNUP_URL", "SIGNIN_URL",
    "NUM", "EXP", "CVC", "ZIP",
    "RE_502", "RE_DECL", "RE_OK", "RE_NEEDPHONE", "RE_HCAPTCHA",
    "set_log_prefix", "log", "log_stage", "fast_mode", "digits", "http_post_json",
    "_atomic_write_json", "_FileLock", "_file_lock",
]
