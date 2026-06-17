# -*- coding: utf-8 -*-
"""按需批量改 Firstmail 邮箱密码 —— 供 web 控制台「结果聚合 · 更新邮箱密码」调用。

为什么走 Python 而不在 Node 直接 fetch:firstmail 走 Chrome TLS/JA3 客户端(requests-go),
Node 的 TLS 指纹不同,可能被风控拦;复用 services.firstmail.change_mailbox_password 还自带
「旧密码被拒→用新密码当 current 幂等确认」的成熟逻辑,零重复实现。

输入(stdin,JSON):  {"items":[{"email","current","next"}, ...], "concurrency":6}
输出(stdout,逐行 JSON,每项一行):  {"email": "...", "ok": true|false, "reason": ""}
  —— 只回 email + ok,【绝不回密码明文】;凭据只在内存与 firstmail API 之间流动。
进程级错误回一行 {"_fatal": "..."}。退出码恒 0(逐项成败靠 ok 字段,不靠退出码)。
"""
import sys
import os
import json
import threading
from concurrent.futures import ThreadPoolExecutor

# 本文件在 selenium-e2e/tools/ 下;把 selenium-e2e 根加进 sys.path 才能 import common/services。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from common import config as _config      # noqa: E402
from services import firstmail            # noqa: E402

# 多线程下逐行打印加锁,避免两条 JSON 结果行交错破行(firstmail 自身的 log 也是整行 print,
# 行与行之间最多顺序交错、不会撕裂单行内容 → Node 端按行 JSON.parse 过滤即可)。
_plock = threading.Lock()


def _emit(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with _plock:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError, ValueError):
            # 父进程(Node)已关闭 stdout(超时 SIGKILL / 断连)→ 无人接收,静默丢弃,绝不让写失败崩工作线程。
            pass


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

    try:
        conc = int(req.get("concurrency") or 6)
    except (TypeError, ValueError):
        conc = 6
    conc = max(1, min(conc, 16))

    cfg = _config.load_config()
    mail_key = cfg.get("mail_key")
    mail_base = cfg.get("mail_base") or firstmail.DEFAULT_BASE
    if not mail_key:
        _emit({"_fatal": "no-mail-key(config.local.json 的 mailbox.apiKey 未配置 / 也未设 OPENROUTER_FIRSTMAIL_KEY)"})
        return

    def _one(it):
        email = (it.get("email") or "").strip() if isinstance(it, dict) else ""
        cur = (it.get("current") or "") if isinstance(it, dict) else ""
        nxt = (it.get("next") or "") if isinstance(it, dict) else ""
        if not email or not nxt:
            _emit({"email": email, "ok": False, "reason": "missing-email-or-next(缺邮箱或新密码)"})
            return
        try:
            ok = firstmail.change_mailbox_password(email, cur, nxt, mail_key, mail_base)
            _emit({"email": email, "ok": bool(ok), "reason": "" if ok else "firstmail-rejected(改密被拒,见服务端日志)"})
        except Exception as e:
            _emit({"email": email, "ok": False, "reason": str(e)[:120]})

    if not items:
        return
    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(_one, items))


if __name__ == "__main__":
    main()
