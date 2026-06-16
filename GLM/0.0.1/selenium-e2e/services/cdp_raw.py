#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 极简原生 CDP 客户端(Fix C)——直连 AdsPower 调试端口的 page 目标。
# 核心原则:【绝不调用 Runtime.enable / Page.enable 等任何 *.enable】。
#   只用 Runtime.evaluate(一次性请求/响应,不订阅事件) 取坐标,
#   只用 Input.dispatchMouseEvent / Input.dispatchKeyEvent 注入【isTrusted=true 的可信输入】。
# 因此避开了 chromedriver 的两大招牌:① cdc_ 注入(根本没注入) ② runtime_enable 行为泄漏(从不 enable)。
# Input 注入【无需窗口前台、每个浏览器各连各的 websocket】→ 天生可并行。
# 坐标用【视口 CSS 像素】(getBoundingClientRect 的返回值),不需要 DPR / 屏幕边框换算。
import json, time, random, itertools, urllib.request
from websocket import create_connection
from common.osnative import IS_MAC   # 跨平台全选修饰键(CDP modifiers:Ctrl=2 / Meta=Cmd=4)


class RawCDP:
    def __init__(self):
        self.ws = None
        self._id = itertools.count(1)
        self.url = None

    def connect(self, port, url_substr="z.ai", timeout=10):
        data = json.load(urllib.request.urlopen("http://127.0.0.1:%s/json" % port, timeout=timeout))
        target = None
        for t in data:
            if t.get("type") == "page" and url_substr in (t.get("url") or ""):
                target = t; break
        if not target:                      # 退而求其次:第一个有 ws 的 page
            for t in data:
                if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                    target = t; break
        if not target:
            raise RuntimeError("没找到 page 目标(/json 里没有 z.ai 页)")
        self.url = target.get("url")
        # Chrome 反 DNS-rebinding:拒绝带 Origin 头的 ws 连接 → suppress_origin 去掉 Origin
        self.ws = create_connection(target["webSocketDebuggerUrl"],
                                    max_size=64 * 1024 * 1024, timeout=timeout,
                                    suppress_origin=True)
        return self.url

    def send(self, method, params=None, timeout=20, session_id=None):
        mid = next(self._id)
        msg = {"id": mid, "method": method, "params": params or {}}
        if session_id:
            msg["sessionId"] = session_id     # flatten 模式:把命令发到子 target(iframe)的会话
        self.ws.send(json.dumps(msg))
        self.ws.settimeout(timeout)
        while True:                          # 读到自己 id 的响应为止(没开 enable,事件极少)
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError("CDP %s 出错: %s" % (method, m["error"]))
                return m.get("result")

    def evaluate(self, expr, timeout=20, session_id=None):
        r = self.send("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True, "awaitPromise": True},
                      timeout, session_id=session_id)
        return (r or {}).get("result", {}).get("value")

    def get_targets(self):
        return (self.send("Target.getTargets") or {}).get("targetInfos", [])

    def attach_target(self, target_id):
        """flatten 挂到子 target(iframe)→ 返回 sessionId;之后 evaluate(..., session_id=) 在该 iframe 里跑。"""
        r = self.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        return (r or {}).get("sessionId")

    def node_center(self, selector, session_id=None):
        """在指定 session(iframe)里找 selector 元素,用 DOM.getContentQuads 取它的【frame本地中心坐标】。
           返回 [cx,cy] 或 None。(配合 session_click 用 → 点击跟分辨率/窗口无关)"""
        try:
            doc = self.send("DOM.getDocument", {"depth": 0}, session_id=session_id)
            root = (doc or {}).get("root", {}).get("nodeId")
            if not root:
                return None
            q = self.send("DOM.querySelector", {"nodeId": root, "selector": selector}, session_id=session_id)
            nid = (q or {}).get("nodeId")
            if not nid:
                return None
            bm = self.send("DOM.getContentQuads", {"nodeId": nid}, session_id=session_id)
            quads = (bm or {}).get("quads") or []
            if not quads:
                return None
            qd = quads[0]
            return [(qd[0] + qd[2] + qd[4] + qd[6]) / 4.0, (qd[1] + qd[3] + qd[5] + qd[7]) / 4.0]
        except Exception:
            return None

    def session_click(self, session_id, x, y):
        """经指定 session(iframe)派发鼠标点击(frame本地坐标)→ CDP 路由到该 frame。跟窗口大小/位置无关。"""
        for typ in ("mouseMoved", "mousePressed", "mouseReleased"):
            p = {"type": typ, "x": float(x), "y": float(y)}
            if typ != "mouseMoved":
                p.update({"button": "left", "clickCount": 1})
            self.send("Input.dispatchMouseEvent", p, session_id=session_id)
            time.sleep(0.04)

    def click_node(self, selector, session_id=None):
        """在指定 session(iframe)里找 selector 元素并点它。
           用 DOM.getContentQuads 取坐标——CDP 会把【多层嵌套 OOPIF 元素】的坐标自动换算到【主视口】,
           所以 hCaptcha 框嵌 2-3 层也能点准(不用手算偏移)。返回点击中心 [cx,cy] 或 None。"""
        try:
            doc = self.send("DOM.getDocument", {"depth": 0}, session_id=session_id)
            root = (doc or {}).get("root", {}).get("nodeId")
            if not root:
                return None
            q = self.send("DOM.querySelector", {"nodeId": root, "selector": selector}, session_id=session_id)
            nid = (q or {}).get("nodeId")
            if not nid:
                return None
            bm = self.send("DOM.getContentQuads", {"nodeId": nid}, session_id=session_id)
            quads = (bm or {}).get("quads") or []
            if not quads:
                return None
            qd = quads[0]
            cx = (qd[0] + qd[2] + qd[4] + qd[6]) / 4.0
            cy = (qd[1] + qd[3] + qd[5] + qd[7]) / 4.0
            self.mouse_click(cx, cy)
            return [cx, cy]
        except Exception:
            return None

    def mouse_click(self, x, y):
        x = float(x); y = float(y)
        self.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        time.sleep(0.05)
        self.send("Input.dispatchMouseEvent",
                  {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
        time.sleep(random.uniform(0.04, 0.09))
        self.send("Input.dispatchMouseEvent",
                  {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

    def mouse_drag(self, path, session_id=None, hold=0.12):
        """沿 path=[(x,y),...] 派发【可信】拖拽(滑块验证用):mousePressed@起点 → 多段 mouseMoved → mouseReleased@终点。
        path 已是拟人轨迹(由 slider.build_drag_path 生成:缓入缓出 + 抖动 + 过冲回拉);每段间随机微停=人手节奏。
        session_id 给定 → 经该 iframe 会话派发(滑块在跨域 iframe 时)。坐标=视口 CSS 像素。"""
        if not path:
            return
        x0, y0 = float(path[0][0]), float(path[0][1])
        # 落点前先 move 到起点(有的滑块要 hover 高亮把手),再按下
        self.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0, "y": y0}, session_id=session_id)
        time.sleep(random.uniform(0.05, 0.12))
        self.send("Input.dispatchMouseEvent",
                  {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "clickCount": 1}, session_id=session_id)
        time.sleep(random.uniform(0.05, hold))
        for (x, y) in path[1:]:
            self.send("Input.dispatchMouseEvent",
                      {"type": "mouseMoved", "x": float(x), "y": float(y), "button": "left"}, session_id=session_id)
            time.sleep(random.uniform(0.008, 0.03))
        xe, ye = float(path[-1][0]), float(path[-1][1])
        time.sleep(random.uniform(0.06, 0.16))   # 到位后微停(人手到位会顿一下再松)
        self.send("Input.dispatchMouseEvent",
                  {"type": "mouseReleased", "x": xe, "y": ye, "button": "left", "clickCount": 1}, session_id=session_id)

    def session_drag(self, session_id, path, hold=0.12):
        """mouse_drag 的 iframe-会话版（坐标=帧本地;CDP 路由到该 frame）。"""
        return self.mouse_drag(path, session_id=session_id, hold=hold)

    def type_digits(self, s, lo=0.06, hi=0.16, session_id=None):
        """逐字符发可信按键。session_id 给定时【经该 iframe 会话发键】——键直达该帧的聚焦元素,
           不靠主文档焦点(并发/慢代理/Link弹窗抢焦点时,主焦点发键会丢键/串位)。"""
        for c in s:
            vk = ord(c)                      # '0'-'9' → 48-57
            code = ("Digit" + c) if c.isdigit() else c
            self.send("Input.dispatchKeyEvent",
                      {"type": "keyDown", "windowsVirtualKeyCode": vk, "key": c, "code": code, "text": c},
                      session_id=session_id)
            self.send("Input.dispatchKeyEvent",
                      {"type": "keyUp", "windowsVirtualKeyCode": vk, "key": c, "code": code},
                      session_id=session_id)
            time.sleep(random.uniform(lo, hi))

    def _key(self, k, code, vk, session_id=None, mods=0):
        self.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": k, "code": code,
                  "windowsVirtualKeyCode": vk, "modifiers": mods}, session_id=session_id)
        self.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": k, "code": code,
                  "windowsVirtualKeyCode": vk, "modifiers": mods}, session_id=session_id)

    def clear_field(self, session_id, n=30):
        """可靠清空当前聚焦输入框:Ctrl+A选中删 + End定位末尾 + 连退格(Stripe iframe 可能不支持选中全部
           →退格兜底)。清不干净就会把残留+新值拼成乱码(实测出现 invalid card)→ 这里多管齐下确保清空。"""
        try:
            self._key("a", "KeyA", 65, session_id, mods=(4 if IS_MAC else 2))   # 全选(Mac=Cmd+A/Meta=4,Win·Linux=Ctrl+A/Ctrl=2)
            self._key("Backspace", "Backspace", 8, session_id)
            self._key("Delete", "Delete", 46, session_id)
            self._key("End", "End", 35, session_id)                 # 光标到末尾,逐个退格兜底
            for _ in range(n):
                self._key("Backspace", "Backspace", 8, session_id)
        except Exception:
            pass

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
