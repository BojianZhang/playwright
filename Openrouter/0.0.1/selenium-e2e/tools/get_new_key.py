# -*- coding: utf-8 -*-
"""按需「获取新 API Key」—— 供 web 控制台「结果聚合 · 获取新Key」调用。

场景:跑完全流程后,个别号【已注册+已绑卡(card-bound)】但取 Key 那刻没抓到明文 key
(WIZARD_KEY_NOT_CAPTURED / NEWKEY_*),聚合页 API Key 列为空。这些是好号,只缺一把可用 Key。
本工具:登录已有账号 → 在 keys 工作台新建一把 Key(OpenRouter 旧 key 明文不可再取回 → 只能新建)。

★边界:只 登录 + 建Key。绝不 加卡/充值/改密 → 零扣款风险。不写 results.jsonl(由 web 侧
  key-changes-store 覆盖账本承接展示,不污染聚合去重)。

★登录会触发邮箱验证码(Clerk factor-two「Check your email」)—— 登录已有号一样要过 OTP,
  不是「账号已验证就免」。steps_auth.login 已内建 factor-two 处理:读各号邮箱(Firstmail)里
  本次的新验证码填入。读验证码需【该号真实邮箱密码 mailbox_pw】(firstmail messages/latest 的 body
  要 email+password,密码错回 401)→ 所以本工具必须收到 mailbox_pw(结果页「邮箱现密码」=mbCur)。
  op_pw 作 alt_password 兜底(改过密的号邮箱密码已=统一密码,等于 op_pw)。缺 mailbox_pw 时退回用
  op_pw 当邮箱密码尝试(仅统一密码号能成),其余号会 login=fail:OTP(诚实失败,非静默假成功)。

复用 pipeline 现成 helper(pipeline.py 一行不改):_acquire_browser(代理轮换/校验/退役评分)、
登录前 setup(inject_key_capture + captcha hooks + Turnstile 拦截)、steps_auth.register_or_login
(registered=True 只登录,内含 factor-two OTP)、steps_key.get_api_key(自动走 New Key 工作台路径)、环境清理。

输入(stdin,JSON):
  {"items":[{"email","op_pw","mailbox_pw"}, ...], "proxies":["host:port:user:pass", ...],
   "concurrency":6, "proxy_offset":0, "key_name":null}
  —— op_pw = OpenRouter 登录密码(结果页「OR现密码」列,填 #password-field + OTP 兜底密码);
     mailbox_pw = 该号当前真实邮箱密码(结果页「邮箱现密码」mbCur),【读 factor-two 验证码必需】;
     缺省时退回用 op_pw 当邮箱密码(仅统一密码号可读到 OTP)。
输出(stdout,逐行 JSON,每号一行):
  {"email","ok":true|false,"key":"sk-or-...","reason":"","key_path":"newkey|wizard|capture-fallback"}
  —— key 经本地管道回父进程(与 results.jsonl 存 key 同信任边界);失败 ok=false 带 reason。
进程级错误回一行 {"_fatal":"..."}。退出码恒 0(逐号成败靠 ok 字段)。
"""
import sys
import os
import json
import threading
import queue
from concurrent.futures import ThreadPoolExecutor

# 本文件在 selenium-e2e/tools/ 下;把 selenium-e2e 根加进 sys.path 才能 import common/pipeline/steps。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import common                                  # noqa: E402
import pipeline                                # noqa: E402 复用 _acquire_browser(代理轮换/退役评分)
from services import adspower_env              # noqa: E402
from services import captcha                   # noqa: E402
from services import cdp_fetch                 # noqa: E402
from steps import steps_auth                   # noqa: E402
from steps import steps_key                    # noqa: E402
from common import log                         # noqa: E402

# 多线程下逐行打印加锁,避免两条 JSON 结果行交错破行(子函数 log 也是整行 print → Node 端按行 JSON.parse 过滤)。
_plock = threading.Lock()


def _emit(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with _plock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError, ValueError):
            # 父进程(Node)已关闭 stdout(45min 超时 SIGKILL / HTTP 断连)→ 本就无人接收。
            # 静默丢弃:绝不让写失败抛出去崩工作线程(否则 list(ex.map) 重抛、main 崩且发不出 _fatal、
            # 还会漏掉 finally 里的 slot 归还/env 清理 → 孤儿环境)。
            pass


def _rekey_one(email, op_pw, mailbox_pw, proxies, start_idx, group_id, key_name, slot, slots_total):
    """登录已有账号 → 新建一把 Key。复刻 pipeline.run_account 的登录前 setup,但只跑到取 Key 即止。
    mailbox_pw=该号真实邮箱密码(读 factor-two 验证码必需);缺省退回 op_pw(仅统一密码号可读 OTP)。"""
    env_id = None
    driver = None
    patcher = None
    try:
        env_id, port, proxy = pipeline._acquire_browser(
            proxies, start_idx, group_id, "rekey-" + email.split("@")[0][:18])
        driver = common.attach_chrome(port, common.resolve_chromedriver(port))
        try:
            common.place_window(driver, common.grid_rect(slot, slots_total))
        except Exception:
            pass
        try:
            # 预授剪贴板权限 → 避免页面读剪贴板弹 Chrome 权限框卡死(对齐 pipeline)
            driver.execute_cdp_cmd("Browser.grantPermissions",
                                   {"permissions": ["clipboardReadWrite", "clipboardSanitizedWrite"]})
        except Exception:
            pass
        # 一劳永逸:goto 前注入 key 网络抓取钩子(后端返回明文 sk-or- 即存 sessionStorage,取key UI 无关)。
        steps_key.inject_key_capture(driver)
        captcha.inject_hooks(driver)
        # 登录页可能弹 Turnstile → 必须在导航前启动拦截(等价 Playwright route)。只注 Turnstile,不注 hcaptcha
        #   hook(本工具不加卡,无需破坏免检会话)。
        patcher = cdp_fetch.TurnstileApiPatcher(port, captcha.WRAPPER_TURNSTILE, log=log)
        patcher.start()
        page = common.Page(driver)
        page.goto(common.KEYS_URL, wait=2)

        cfg = common.load_config()
        # registered=True → 只登录、不点注册(号已存在,重注册会卡 verify)。
        # ★mailbox_pw 传该号真实邮箱密码:login 命中 factor-two 时 _enter_otp 用它读邮箱 OTP(密码错→401 读不到);
        #   op_pw 作 register_or_login 的 op_password(填 #password-field + OTP alt_password 兜底统一密码号)。
        mb_pw = mailbox_pw or op_pw   # 缺真实邮箱密码时退回 op_pw(仅统一密码号能读到 OTP,其余诚实 fail:OTP)
        auth = steps_auth.register_or_login(page, email, op_pw, mb_pw, cfg, registered=True)
        if auth != "ok":
            return {"email": email, "ok": False, "key": "", "reason": "login-" + str(auth)}

        k = steps_key.get_api_key(page, name=key_name)
        ok = bool(k.get("ok") and k.get("key"))
        return {
            "email": email, "ok": ok, "key": k.get("key") or "",
            "reason": "" if ok else (k.get("reason") or k.get("name") or "no-key"),
            "key_path": k.get("key_path") or "", "key_name": k.get("name") or "",
        }
    except Exception as e:
        return {"email": email, "ok": False, "key": "", "reason": str(e)[:160]}
    finally:
        try:
            if patcher:
                patcher.stop()
        except Exception:
            pass
        try:
            if driver:
                driver.quit()
        except Exception:
            pass
        if env_id:
            # 清理各自 try 包住,失败只记日志(绝不冒泡顶替结果)。默认删环境(干净)。
            try:
                common.adspower_stop(env_id)
            except Exception:
                pass
            try:
                adspower_env.delete_env(env_id)
            except Exception as _e:
                log("删环境失败(忽略): %s" % str(_e)[:60])


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception as e:
        _emit({"_fatal": "bad-input: %s" % str(e)[:120]})
        return

    items = req.get("items") or []
    if not isinstance(items, list):
        _emit({"_fatal": "items 必须是数组"})
        return
    if not items:
        return

    try:
        conc = int(req.get("concurrency") or 6)
    except (TypeError, ValueError):
        conc = 6
    conc = max(1, min(conc, 16))
    try:
        offset = max(0, int(req.get("proxy_offset") or 0))
    except (TypeError, ValueError):
        offset = 0
    key_name = req.get("key_name") or None

    # 代理:行 → dict(复用 adspower_env._parse_one,与主流程同口径)。
    proxy_lines = req.get("proxies") or []
    proxies = []
    for ln in proxy_lines:
        try:
            p = adspower_env._parse_one(str(ln))
            if p:
                proxies.append(p)
        except Exception:
            pass
    if not proxies:
        _emit({"_fatal": "no-proxies(代理池为空 —— 新建 AdsPower 环境必须配代理)"})
        return

    # ensure_group 可能抛(AdsPower API code!=0)→ 必须捕获发 _fatal,否则 main 裸崩、不发任何行、
    # Node 端干等到 45min 超时才报错(对齐本函数其它 _fatal 出口的契约)。
    try:
        group_id = adspower_env.ensure_group("rekey")
    except Exception as e:
        _emit({"_fatal": "ensure-group-failed: %s" % str(e)[:120]})
        return
    # 并发窗口槽位 0..conc-1,跑完归还复用 → grid_rect 按并发平铺(对齐 run.py)。
    slot_q = queue.Queue()
    for _s in range(conc):
        slot_q.put(_s)

    def _worker(i, it):
        email = (it.get("email") or "").strip() if isinstance(it, dict) else ""
        op_pw = (it.get("op_pw") or "") if isinstance(it, dict) else ""
        mailbox_pw = (it.get("mailbox_pw") or "") if isinstance(it, dict) else ""   # 读 factor-two OTP 用;缺则退回 op_pw
        if not email or not op_pw:
            _emit({"email": email, "ok": False, "key": "",
                   "reason": "missing-email-or-password(缺邮箱或 OR 登录密码)"})
            return
        slot = slot_q.get()
        try:
            start_idx = (i + offset) % len(proxies)
            r = _rekey_one(email, op_pw, mailbox_pw, proxies, start_idx, group_id, key_name, slot, conc)
            _emit(r)
        finally:
            slot_q.put(slot)

    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(lambda iv: _worker(iv[0], iv[1]), list(enumerate(items))))


if __name__ == "__main__":
    main()
