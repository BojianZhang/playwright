#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# 密钥/敏感数据扫描器 —— 提交前拦截真卡号/API key/密码/代理凭证误入库。
#
# 用法:
#   python scripts/secret_scan.py            # 扫【已暂存(staged)】内容(pre-commit 钩子用)
#   python scripts/secret_scan.py --all      # 扫【全部已跟踪文件】(CI 用)
#   python scripts/secret_scan.py <file...>  # 扫指定文件
#
# 命中任何真实敏感数据 → 退出码 1(钩子据此阻止提交)。已 gitignore 的文件本就不在 staged/tracked 里,天然跳过。
# 设计目标:【低误报】—— 明显假数据(测试卡 4111…、example.com、127.0.0.1、占位 host:port)放行。
# ═══════════════════════════════════════════════════════════════════════
import re
import sys
import subprocess

# 明显假/占位,放行(不算泄露)
FAKE_CARDS = {"4111111111111111", "4242424242424242", "4000000000000002",
              "4001110000000000", "4361200000000000", "5555555555554444"}
ALLOW_SUBSTR = ("example.com", "example.", "host:port", "user:pass", "127.0.0.1",
                "0.0.0.0", "localhost", "<your", "your-", "xxx", "abcdef0123456789",
                "<set>", "yyyy", "1234 1234 1234 1234")

# 二进制/产物/文档示例:不扫
SKIP_EXT = (".png", ".jpg", ".jpeg", ".ico", ".zip", ".7z", ".rar", ".pdf",
            ".lock", ".min.js", ".map", ".woff", ".woff2", ".ttf")
SKIP_PATH = ("node_modules/", ".git/", "secret_scan.py", "package-lock.json",
             "web/public/assets/",  # Vite 构建产物(哈希命名 index-*.js/css):由已扫描的 src/ 生成,压缩代码会误报(如 "token="+encode…),服务端密钥不入客户端 bundle
             "Dreamina/history/")  # 历史运行数据归档(浏览器存储dump/结果,非源码;含早期已提交数据,另行清理)


def luhn_ok(num: str) -> bool:
    s, alt = 0, False
    for d in reversed(num):
        if not d.isdigit():
            return False
        x = int(d)
        if alt:
            x *= 2
            if x > 9:
                x -= 9
        s += x
        alt = not alt
    return s % 10 == 0


def scan_text(text: str):
    hits = []
    for ln, line in enumerate(text.splitlines(), 1):
        low = line.lower()
        if any(a in low for a in ALLOW_SUBSTR):
            continue
        # ① 银行卡号:必须【3-6 开头(真实卡 IIN:Amex3/Visa4/MC5/Discover6)】+ 13-19位 + 过 Luhn + 非测试卡。
        #    收紧到 3-6 开头,排除浏览器存储里碰巧过 Luhn 的非卡数字(1x/7x/8x/9x 开头一律不是卡)。
        for m in re.finditer(r"(?<!\d)([3-6](?:[ -]?\d){12,18})(?!\d)", line):
            digits = re.sub(r"\D", "", m.group())
            if 13 <= len(digits) <= 19 and digits not in FAKE_CARDS and luhn_ok(digits):
                hits.append((ln, "疑似真实银行卡号", digits[:6] + "…" + digits[-2:]))
        # ② OpenRouter API key 明文
        for m in re.finditer(r"sk-or-[A-Za-z0-9-]{24,}", line):
            if "abcdef0123456789" not in m.group():
                hits.append((ln, "OpenRouter API key", m.group()[:16] + "…"))
        # ③ 密钥赋值:apiKey/token/secret/password = '非空非占位的长串'
        for m in re.finditer(r"(?i)(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['\"]([^'\"]{12,})['\"]", line):
            val = m.group(2)
            if not re.search(r"(?i)(example|your|placeholder|xxxx|\$\{|process\.env|os\.environ|<.*>)", val):
                hits.append((ln, "硬编码密钥(%s)" % m.group(1), val[:6] + "…"))
        # ④ 代理内嵌凭证:socks5://user:pass@host  或  host:port:user:pass
        if re.search(r"socks5?://[^:/\s]+:[^@/\s]+@", line) or re.search(r"\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}:\w{3,}:\w{3,}", line):
            hits.append((ln, "代理内嵌凭证", line.strip()[:40]))
    return hits


def staged_files():
    out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
                         capture_output=True, text=True).stdout
    return [f for f in out.splitlines() if f.strip()]


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout
    return [f for f in out.splitlines() if f.strip()]


def staged_content(path):
    r = subprocess.run(["git", "show", ":" + path], capture_output=True, text=True, errors="replace")
    return r.stdout if r.returncode == 0 else ""


def main():
    args = sys.argv[1:]
    mode_all = "--all" in args
    explicit = [a for a in args if not a.startswith("--")]
    if explicit:
        files = explicit
        getter = lambda p: open(p, encoding="utf-8", errors="replace").read()
    elif mode_all:
        files = tracked_files()
        getter = lambda p: open(p, encoding="utf-8", errors="replace").read()
    else:
        files = staged_files()
        getter = staged_content  # 扫暂存版本(不是工作区),严谨

    bad = 0
    for f in files:
        if any(f.endswith(e) for e in SKIP_EXT) or any(s in f.replace("\\", "/") for s in SKIP_PATH):
            continue
        try:
            text = getter(f)
        except Exception:
            continue
        for ln, kind, sample in scan_text(text):
            print("  🔴 %s:%d  %s  → %s" % (f, ln, kind, sample))
            bad += 1

    if bad:
        print("\n❌ 扫到 %d 处疑似敏感数据,已阻止提交。" % bad)
        print("   确属误报 → 加进 secret_scan.py 的 FAKE_CARDS/ALLOW_SUBSTR;真密钥 → 移到 config.local/环境变量并 gitignore。")
        print("   紧急绕过(慎用): git commit --no-verify")
        return 1
    print("✅ secret-scan 通过,未发现明文密钥/真卡号。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
