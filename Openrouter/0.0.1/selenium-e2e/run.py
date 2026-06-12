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

import common
import adspower_env
import pipeline
from common import log


def read_accounts(path):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                em, pw = line.split(":", 1)
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
    args = ap.parse_args()

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
    if os.path.exists(res_file):
        with open(res_file, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    if args.do_card:
                        # 只有【已绑】才永久跳过；弹过验证的号下一轮换 IP+指纹再试(本轮内是快速跳过不卡住)
                        if (r.get("steps") or {}).get("card") == "card-bound":
                            done.add(r.get("email"))
                    elif r.get("ok"):
                        done.add(r.get("email"))
                except Exception:
                    pass

    opts = {
        "cfg": cfg, "do_key": (not args.no_key), "do_card": args.do_card,
        "do_purchase": args.do_purchase, "amount": args.amount,
        "do_changepw": args.do_changepw, "unified_pw": args.unified_pw or None,
        "key_name": args.key_name, "manual_hcaptcha": not args.auto_hcaptcha_only,
        "delete_env": not args.no_delete_env,
    }

    for i, acct in enumerate(accounts):
        if acct["email"] in done:
            log("跳过已完成 %s" % acct["email"]); continue
        start_idx = (i + args.proxy_offset) % len(proxies)
        log("════ [%d/%d] %s （代理从池中第 %d 个起 offset=%d，失败自动轮换）════" % (
            i + 1, len(accounts), acct["email"], start_idx, args.proxy_offset))
        r = pipeline.run_account(acct, proxies, start_idx, group_id, opts)
        r["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(res_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
        log("════ 结果 ok=%s steps=%s ════" % (r.get("ok"), r.get("steps")))
        time.sleep(args.gap)

    log("全部跑完。结果见 %s" % res_file)


if __name__ == "__main__":
    main()
