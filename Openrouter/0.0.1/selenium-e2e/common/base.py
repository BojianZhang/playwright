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


def set_log_prefix(p):
    global _LOG_PREFIX
    _LOG_PREFIX = p


def log(*a):
    # 行首带 HH:MM:SS —— 没时间戳就量不出每步耗时(注册/取key/绑地址/Save/切IP各几秒)
    print("%s %s" % (time.strftime("%H:%M:%S"), _LOG_PREFIX), *a, flush=True)


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
        try:
            json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
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
            except FileExistsError:
                if _t.time() > end:                 # 超时:不再无条件清锁(两进程会同时删→双双 O_EXCL 成功→双进临界区)
                    # 只有 lockfile 足够老(>STALE 秒、持有者大概率已死)才当陈旧锁清,且清完不立即 continue 抢——
                    # 让下一轮循环正常 O_EXCL,避免和别的等待者撞删;否则放弃锁退化为无锁(记 log,不阻塞主流程)。
                    stale = float(os.environ.get("FILELOCK_STALE_SEC", "30"))
                    try:
                        age = _t.time() - os.path.getmtime(self._lf)
                    except Exception:
                        age = None
                    if age is not None and age > stale:
                        try: os.remove(self._lf)      # 删的是真·陈旧锁(mtime 校验过),不是活锁
                        except Exception: pass
                        end = _t.time() + min(self._to, 2)   # 给一点窗口重抢(可能被别的等待者抢走→那也只是退化无锁)
                        _t.sleep(0.03)
                        continue
                    # 锁还新(别的进程正持有)或拿不到 mtime → 放弃,退化为无锁(不删活锁、不双进入)
                    try: log("[lock] 等待 %s 超时(锁未过期),退化为无锁继续" % os.path.basename(self._lf))
                    except Exception: pass
                    return self
                _t.sleep(0.03)
            except Exception:
                return self                         # 取锁异常不阻塞主流程(退化为无锁)

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
    "set_log_prefix", "log", "digits", "http_post_json",
    "_atomic_write_json", "_FileLock", "_file_lock",
]
