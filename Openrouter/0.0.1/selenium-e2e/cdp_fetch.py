#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# ═══════════════════════════════════════════════════════════════════════
# CDP Fetch 拦截 Turnstile api.js，把 RENDER_WRAPPER 拼进 api.js 正文。
#
# 文件定位：Openrouter/0.0.1/selenium-e2e/cdp_fetch.py
#
# 为什么需要它：Playwright 用 context.route 拦 api.js 注入 wrapper（见 openrouter-turnstile.js）。
# Selenium 的 execute_cdp_cmd 是一问一答、收不到 Fetch.requestPaused 事件，所以单靠
# Page.addScriptToEvaluateOnNewDocument 的文档级 wrapper 抓不到 Clerk 的隐式渲染(implicit
# render)——render 没走 window.turnstile.render 公开入口，__cfParams/tsCallback 抓不到，注册卡死。
# 这里另开一条到浏览器 CDP 的原始 websocket，后台线程 Target.setAutoAttach + Fetch.enable，
# 拦到 api.js → getResponseBody → 头尾拼 wrapper → fulfillRequest。等价 Playwright route。
# ═══════════════════════════════════════════════════════════════════════

import json
import base64
import threading
import urllib.request

import websocket  # websocket-client 1.x


class TurnstileApiPatcher:
    """后台线程拦 Turnstile api.js，把 wrapper 拼进正文。start()/stop()。"""

    def __init__(self, debug_port, wrapper, log=print, url_needles=("turnstile", "api.js"), extra_rules=None, init_scripts=None):
        # debug_port 可能是 "61082" 或 "127.0.0.1:61082"，统一成 int
        self.port = int(str(debug_port).rsplit(":", 1)[-1])
        self.wrapper = wrapper
        self.log = log
        self.url_needles = url_needles
        # 多规则:[(needles_tuple, wrapper), ...]。默认 turnstile;extra_rules 可加 hcaptcha 等。
        # 拦到某 api.js → 按 needles 命中的规则,把对应 wrapper 拼进正文(到每个 OOPIF 都生效)。
        self.rules = [(tuple(url_needles), wrapper)] + list(extra_rules or [])
        # init_scripts:在【每个 attach 上的 target(含跨域 OOPIF)】用 Page.addScriptToEvaluateOnNewDocument
        # 注入(等价 Playwright addInitScript)——不依赖拦 api.js、不怕缓存,是把 hcaptcha hook 装进
        # Stripe 跨域 iframe 的可靠途径(拦 api.js 那条会被缓存/打包漏掉)。
        self.init_scripts = list(init_scripts or [])
        self.ws = None
        self.thread = None
        self._id = 0
        self._idlock = threading.Lock()
        self._running = False
        self.sessions = set()
        self.patched = 0          # 成功改写过几次 api.js
        self.seen = 0             # 拦到过几次匹配请求
        self._pending = {}        # cmd_id -> (fetch_request_id, session_id, url, wrapper)  等 getResponseBody 回包
        # CDP Runtime.evaluate 跨 OOPIF 执行/取值(Selenium switch_to.frame 进不去 OOPIF,CDP session 能)
        self._eval_evt = {}       # cid -> threading.Event
        self._eval_res = {}       # cid -> value
        self._eval_lock = threading.Lock()

    # ── 低层 ──────────────────────────────────────────────────────────
    def _next_id(self):
        with self._idlock:
            self._id += 1
            return self._id

    def _send(self, method, params=None, session_id=None):
        cid = self._next_id()
        msg = {"id": cid, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id
        try:
            self.ws.send(json.dumps(msg))
        except Exception as e:
            if not getattr(self, "_send_err", False):   # 只记首次,免刷屏
                self.log("[apipatch] ws.send 失败,api.js 拦截可能已失效: %s" % str(e)[:60])
                self._send_err = True
        return cid

    # ── 生命周期 ──────────────────────────────────────────────────────
    def start(self):
        try:
            ver = json.load(urllib.request.urlopen(
                "http://127.0.0.1:%d/json/version" % self.port, timeout=6))
            ws_url = ver["webSocketDebuggerUrl"]
        except Exception as e:
            self.log("[apipatch] 取浏览器 CDP ws 失败: %s" % str(e)[:80])
            return False
        try:
            # suppress_origin=True：不发 Origin 头，否则 Chrome111+ DevTools 回 403
            # （未带 --remote-allow-origins=* 时只接受无 Origin 的非浏览器客户端）
            self.ws = websocket.create_connection(ws_url, max_size=None, timeout=8,
                                                  suppress_origin=True)
            self.ws.settimeout(None)
        except Exception as e:
            self.log("[apipatch] 连 CDP ws 失败: %s" % str(e)[:80])
            return False
        self._running = True
        # 浏览器级 auto-attach（flatten），既有 + 新建 target 都会 attachedToTarget
        self._send("Target.setAutoAttach",
                   {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True})
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        self.log("[apipatch] Turnstile api.js 拦截已启动")
        return True

    def stop(self):
        self._running = False
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass

    # ── 跨 OOPIF 执行/取值(Selenium switch_to.frame 进不去 Stripe 跨域 iframe,CDP session 能)──
    def eval_all(self, expression):
        """对【所有已附加 target(页面+iframe+OOPIF)】fire-and-forget 执行 JS。
           用于把 2Captcha token 注入 + 调 window.hcCallback(token) 到 Stripe 跨域 iframe 里。返回执行的 session 数。"""
        n = 0
        for sid in list(self.sessions):
            self._send("Runtime.evaluate", {"expression": expression, "userGesture": True, "awaitPromise": False}, sid)
            n += 1
        return n

    def eval_collect(self, expression, timeout=6):
        """对所有 target 执行 JS(应返回字符串),收集非空结果。用于跨 OOPIF 读 sitekey/rqdata。"""
        import time as _t
        cids = []
        for sid in list(self.sessions):
            cid = self._next_id()
            evt = threading.Event()
            with self._eval_lock:
                self._eval_evt[cid] = evt
            msg = {"id": cid, "method": "Runtime.evaluate", "sessionId": sid,
                   "params": {"expression": expression, "returnByValue": True, "awaitPromise": False}}
            try:
                self.ws.send(json.dumps(msg))
                cids.append((cid, evt))
            except Exception:
                with self._eval_lock:
                    self._eval_evt.pop(cid, None)
        out = []
        deadline = _t.time() + timeout
        for cid, evt in cids:
            evt.wait(max(0.0, deadline - _t.time()))
            with self._eval_lock:
                v = self._eval_res.pop(cid, None)
                self._eval_evt.pop(cid, None)
            if v:
                out.append(v)
        return out

    # ── 事件循环 ──────────────────────────────────────────────────────
    def _enable_fetch(self, session_id):
        # 为每条规则的 api.js 各开一个 Response 阶段的拦截 pattern(turnstile + hcaptcha …)
        patterns = []
        for needles, _w in self.rules:
            patterns.append({"urlPattern": "*%s*api.js*" % needles[0], "requestStage": "Response"})
        self._send("Fetch.enable", {"patterns": patterns}, session_id)

    def _match_wrapper(self, url):
        """URL 命中哪条规则就返回它的 wrapper(注入对应包装器);都不命中返回 None。"""
        for needles, w in self.rules:
            if all(n in url for n in needles):
                return w
        return None

    def _inject_init_scripts(self, session_id):
        """把 init_scripts 注进这个 target(含跨域 OOPIF):addScriptToEvaluateOnNewDocument 管未来文档,
           Runtime.evaluate 立刻在已加载帧装一次(wrapper 是自安装轮询器,会持续 hook hcaptcha.render)。"""
        if not self.init_scripts:
            return
        self._send("Page.enable", {}, session_id)
        self._send("Runtime.enable", {}, session_id)
        for src in self.init_scripts:
            self._send("Page.addScriptToEvaluateOnNewDocument", {"source": src}, session_id)
            self._send("Runtime.evaluate", {"expression": src}, session_id)

    def _loop(self):
        while self._running:
            try:
                raw = self.ws.recv()
            except Exception as e:
                self.log("[apipatch] CDP ws 断开,拦截线程退出(此后不再注入 api.js wrapper): %s" % str(e)[:60])
                self._running = False   # 状态自洽:线程已死则 _running 同步置假
                break
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mid = msg.get("id")
            if mid is not None and mid in self._pending:
                self._on_body(mid, msg)
                continue
            if mid is not None and mid in self._eval_evt:   # Runtime.evaluate 回包
                try:
                    val = (((msg.get("result") or {}).get("result")) or {}).get("value")
                    with self._eval_lock:
                        self._eval_res[mid] = val
                    self._eval_evt[mid].set()
                except Exception:
                    pass
                continue
            method = msg.get("method")
            if method == "Target.attachedToTarget":
                p = msg.get("params", {})
                ti = p.get("targetInfo", {})
                sid = p.get("sessionId")
                if sid and ti.get("type") in ("page", "iframe"):
                    self.sessions.add(sid)
                    self._enable_fetch(sid)
                    self._inject_init_scripts(sid)   # 把 hcaptcha hook 注进这个 OOPIF(等价 addInitScript)
                    # 继续向下 auto-attach（OOPIF/嵌套帧）
                    self._send("Target.setAutoAttach",
                               {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True}, sid)
            elif method == "Fetch.requestPaused":
                self._on_paused(msg.get("params", {}), msg.get("sessionId"))

    def _on_paused(self, params, session_id):
        req_id = params.get("requestId")
        url = (params.get("request") or {}).get("url", "")
        status = params.get("responseStatusCode")
        wrapper = self._match_wrapper(url)
        # 只改写【真正的 api.js 正文】= 200 且无错误。重定向(3xx)/其它一律放行，
        # 让浏览器跟到 /turnstile/v0/g/<build>/api.js 那条真正带 JS 的 200 上(它仍命中 pattern)。
        if wrapper and status == 200 and not params.get("responseErrorReason"):
            self.seen += 1
            cid = self._send("Fetch.getResponseBody", {"requestId": req_id}, session_id)
            self._pending[cid] = (req_id, session_id, url, wrapper)
        else:
            self._send("Fetch.continueResponse", {"requestId": req_id}, session_id)

    def _on_body(self, cid, msg):
        req_id, session_id, url, wrapper = self._pending.pop(cid, (None, None, "", None))
        if req_id is None:
            return
        # getResponseBody 失败/空 → 别拿空串去 fulfill(会打断重定向/破坏脚本)，放行原响应
        if msg.get("error") or not (msg.get("result") or {}).get("body"):
            err = (msg.get("error") or {}).get("message", "空 body")
            self.log("[apipatch] getResponseBody 没拿到正文(%s)→放行 %s" % (str(err)[:40], url[-48:]))
            self._send("Fetch.continueResponse", {"requestId": req_id}, session_id)
            return
        result = msg["result"]
        body = result.get("body", "")
        try:
            if result.get("base64Encoded"):
                body = base64.b64decode(body).decode("utf-8", "replace")
        except Exception:
            pass
        if len(body) < 100:                       # 真正的 api.js 有几十KB；过短必是占位/错误
            self.log("[apipatch] api.js 正文仅 %d 字节,疑似非正文→放行 %s" % (len(body), url[-48:]))
            self._send("Fetch.continueResponse", {"requestId": req_id}, session_id)
            return
        new_body = "%s\n%s\n%s" % (wrapper, body, wrapper)
        b64 = base64.b64encode(new_body.encode("utf-8")).decode("ascii")
        headers = [
            {"name": "Content-Type", "value": "application/javascript; charset=utf-8"},
            {"name": "Cache-Control", "value": "no-store"},
            {"name": "Access-Control-Allow-Origin", "value": "*"},
        ]
        self._send("Fetch.fulfillRequest", {
            "requestId": req_id, "responseCode": 200,
            "responseHeaders": headers, "body": b64,
        }, session_id)
        self.patched += 1
        self.log("[apipatch] ✓ wrapper 拼进 api.js（第 %d 次，原文 %d 字节）%s" % (
            self.patched, len(body), url[-48:]))
