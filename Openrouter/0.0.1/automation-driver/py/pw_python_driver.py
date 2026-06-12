#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# playwright-python 驱动默认任务：connect_over_cdp(ws) 接管同一浏览器，打开 url、回标题。
# 由 drivers/playwright_python.js 经 child_process 调用。换任务：复制本文件，读相同 stdin、打印 OR_RESULT。
#   stdin : {"ws":"ws://127.0.0.1:PORT/devtools/..." 或 "http://127.0.0.1:PORT", "url"?:"..."}
#   stdout: OR_RESULT:{"ok":true,"driver":"playwright-python","title":"...","url":"..."} 或 {"error":"..."}
import sys
import json


def emit(o):
    sys.stdout.write("OR_RESULT:" + json.dumps(o) + "\n")
    sys.stdout.flush()


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        emit({"error": "bad stdin: " + str(e)[:80]})
        return
    ws = data.get("ws")
    url = data.get("url") or "https://example.com"
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        emit({"error": "playwright(python) 未安装(pip install playwright): " + str(e)[:100]})
        return
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(ws)
            ctx = browser.contexts[0] if browser.contexts else browser.new_context()
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(url, wait_until="domcontentloaded")
            emit({"ok": True, "driver": "playwright-python", "title": page.title(), "url": page.url})
            browser.close()
    except Exception as e:
        emit({"error": str(e)[:160]})


if __name__ == "__main__":
    main()
