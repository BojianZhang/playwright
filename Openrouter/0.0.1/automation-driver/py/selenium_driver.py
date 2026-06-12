#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Selenium 驱动默认任务：经 debuggerAddress 接管同一浏览器，打开 url、回标题。
# 由 drivers/selenium.js 经 child_process 调用。换成你自己的任务：复制本文件，读相同 stdin、打印 OR_RESULT。
#   stdin : {"debuggerAddress":"127.0.0.1:PORT", "url"?:"..."}
#   stdout: OR_RESULT:{"ok":true,"driver":"selenium","title":"...","url":"..."} 或 {"error":"..."}
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
    addr = data.get("debuggerAddress")
    url = data.get("url") or "https://example.com"
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
    except Exception as e:
        emit({"error": "selenium 未安装: " + str(e)[:100]})
        return
    opts = Options()
    opts.add_experimental_option("debuggerAddress", addr)
    try:
        driver = webdriver.Chrome(options=opts)
    except Exception as e:
        emit({"error": "连接失败(chromedriver 版本?): " + str(e)[:120]})
        return
    try:
        driver.get(url)
        emit({"ok": True, "driver": "selenium", "title": driver.title, "url": driver.current_url})
    except Exception as e:
        emit({"error": str(e)[:160]})


if __name__ == "__main__":
    main()
