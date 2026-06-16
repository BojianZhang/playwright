#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · Page:跨 iframe 钻取填表/选择/点击/读文本(Stripe 跨域 iframe 必需)。
# 仅依赖 base 的 log/digits;Selenium 在实例化时按需 import。
import time
import random

from .base import log, digits
from .uikeys import clear_input   # 跨平台清空输入框(Mac 用 Cmd+A,Win/Linux 用 Ctrl+A)


# ── Page：跨 iframe 钻取（Stripe 跨域 iframe 必需） ─────────────────────
class Page:
    def __init__(self, driver):
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support.ui import Select
        self.d = driver
        self.By = By
        self.Keys = Keys
        self.Select = Select

    def goto(self, url, wait=2.0):
        # set_page_load_timeout 生效后,慢页面会让 d.get() 抛 TimeoutException —— 这里吞掉:
        # 页面通常已"够用"(readyState 可能仍是 interactive),交给 wait_loaded 兜底,绝不让一次慢加载崩掉整号。
        try:
            self.d.get(url)
        except Exception as e:
            log("  [goto] 加载超时/中断(继续): %s" % str(e)[:60])
        self.wait_loaded()
        if wait:
            time.sleep(wait)

    def url(self):
        try:
            return self.d.current_url
        except Exception:
            return ""

    def js(self, script, *a):
        try:
            return self.d.execute_script(script, *a)
        except Exception:
            return None

    def cdp_click(self, x, y):
        """CDP 可信点击(x/y 为 viewport CSS 像素,与 getBoundingClientRect 同坐标系 → 分辨率/DPR/缩放无关)。
        z.ai 的 React 控件对 Selenium .click()/JS click 可能不触发 onClick,可信鼠标事件才稳。"""
        try:
            self.d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": float(x), "y": float(y)})
            time.sleep(random.uniform(0.04, 0.10))
            self.d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": float(x), "y": float(y), "button": "left", "clickCount": 1})
            time.sleep(random.uniform(0.05, 0.12))
            self.d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": float(x), "y": float(y), "button": "left", "clickCount": 1})
            return True
        except Exception as e:
            log("  [cdp_click] %s" % str(e)[:80])
            return False

    def press_escape(self):
        """发 ESC(很多弹窗支持 Esc 关闭;零误点风险,作关闭键的兜底)。"""
        try:
            from selenium.webdriver.common.action_chains import ActionChains
            ActionChains(self.d).send_keys(self.Keys.ESCAPE).perform()
            return True
        except Exception:
            try:
                self.d.switch_to.active_element.send_keys(self.Keys.ESCAPE); return True
            except Exception:
                return False

    def clear_promo(self):
        """★关 z.ai 促销弹窗(GLM Coding Plan / Value Subscription)——该弹窗【每次刷新页面都会冒出来】,
        出现就关、绝不影响主流程(用户定)。做法:按【促销文案】定位弹层 → 先点关闭 X(自然)→ 兜底移除弹层根 + 全屏遮罩;
        只动含促销文案的弹层和大遮罩,【绝不点 Join Now/Learn More】(那是付费/跳走);无弹窗时空操作(幂等)。返回是否检测到弹窗。
        ★复用:登录/取Key 任何进到 z.ai 页之后都该调一次(detect_session / get_api_key 等),把弹窗清掉再干活。"""
        try:
            return bool(self.d.execute_script(r"""return (function(){
              try{
                // ★只认【弹窗独有】文案 —— 绝不用 'coding plan'(左栏导航也叫 "GLM Coding Plan",会误删导航/整页!)。
                //   两类:旧促销(value subscription…)+ 新版本公告弹窗(GLM-5.2 Now Available / Model Upgraded,登录后冒出来盖住首页+API入口)。
                //   新弹窗用它【独有 bullet 文案】认,绝不用裸 "now available"(页面横幅 "GLM-5.1 is now available" 会误伤)。
                var RE=/(value subscription|code beyond boundaries|join now|flagship models?|enjoy high quotas|model upgraded|ai slides upgraded|better artifacts|immersive roleplay|long-document boost|fluent long-form writing)/i;
                var W=window.innerWidth||1280, H=window.innerHeight||800, AREA=W*H;
                function vis(e){ try{ var r=e.getBoundingClientRect(); var s=getComputedStyle(e);
                  return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; }catch(_){ return false; } }
                function small(e){ try{ var r=e.getBoundingClientRect(); return (r.width*r.height) < AREA*0.55; }catch(_){ return false; } }
                // 命中=【短文本(弹窗标签,非整页) + 独有文案 + 可见】的最内层元素
                var hit=null, all=[].slice.call(document.querySelectorAll('div,section,aside'));
                for(var i=0;i<all.length;i++){ var e=all[i]; var t=((e.innerText||'')+'').trim();
                  if(t && t.length<300 && RE.test(t) && vis(e)){ hit=e; break; } }
                if(!hit) return false;
                // 上溯弹层根:fixed/absolute 祖先;★一旦祖先超过半屏就停(那是 app 容器,不是弹窗)
                var root=hit;
                for(var u=0;u<8 && root.parentElement;u++){
                  var p=root.parentElement, s=getComputedStyle(p);
                  if(s && (s.position==='fixed'||s.position==='absolute')){ if(!small(p)) break; root=p; } else break;
                }
                // 先点关闭 X(最自然、最安全)
                var x=root.querySelector('[aria-label*="close" i],button[class*="close" i],[class*="close" i] svg,svg[class*="close" i]');
                if(x){ try{ (x.closest('button')||x).click(); }catch(_){} return true; }
                // 点不到 X:只在 root【尺寸安全(<半屏)】时才移除,绝不删大容器
                if(small(root)){ try{ root.remove(); }catch(_){ try{ root.style.display='none'; }catch(__){} } }
                // 兜底:移除【大且无文本】的纯遮罩(有文本=app内容容器,绝不删)
                [].slice.call(document.querySelectorAll('[class*="mask" i],[class*="overlay" i],[class*="backdrop" i]')).forEach(function(m){
                  try{ var r=m.getBoundingClientRect(); var mt=((m.innerText||'')+'').trim();
                    if(r.width>W*0.6 && r.height>H*0.6 && mt.length<5) m.remove(); }catch(_){}
                });
                return true;
              }catch(e){ return false; }
            })();"""))
        except Exception:
            return False

    def wait_loaded(self, timeout=25):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.d.execute_script("return document.readyState") == "complete":
                    return True
            except Exception:
                pass
            time.sleep(0.5)
        return False

    def shot(self, path):
        try:
            self.d.save_screenshot(path)
            log("已截图 %s" % path)
        except Exception:
            pass

    def all_frames_text(self):
        By = self.By
        txt = []
        try:
            self.d.switch_to.default_content()
            for f in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
                try:
                    if f is not None:
                        self.d.switch_to.frame(f)
                    # 用 execute_script 读 innerText(受 set_script_timeout 约束,超时即抛被接住),
                    # 而非 find_element(body).text —— 后者是不受脚本超时管的 WebDriver 命令,
                    # 遇到不响应的跨域 iframe(Turnstile/Stripe)会无限挂住,整号卡死。
                    txt.append(self.d.execute_script(
                        "return (document.body&&document.body.innerText)||''") or "")
                except Exception:
                    pass
                finally:
                    self.d.switch_to.default_content()
        except Exception:
            pass
        return "\n".join(txt)

    def click_text(self, labels, timeout=8):
        """按文案点按钮 —— ★大小写不敏感(XPath translate 转小写比对):z.ai 把「Sign in」改成「Sign In/SIGN IN」、
        或大小写微调时,不至于"换个写法就不认识"。仍按传入候选逐个试(调用方给同义词列表更稳)。
        匹配 button / [role=button] / a / [type=submit](按钮可能是 a 或 div[role=button])。"""
        By = self.By
        _UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; _LO = "abcdefghijklmnopqrstuvwxyz"
        end = time.time() + timeout
        while time.time() < end:
            for lab in labels:
                low = str(lab).lower().replace("'", "")   # 去单引号防 XPath 注入/语法破裂
                try:
                    xp = ("//button[contains(translate(normalize-space(.),'%s','%s'),'%s')]"
                          " | //*[@role='button'][contains(translate(normalize-space(.),'%s','%s'),'%s')]"
                          " | //a[contains(translate(normalize-space(.),'%s','%s'),'%s')]"
                          " | //*[@type='submit'][contains(translate(normalize-space(.),'%s','%s'),'%s')]"
                          ) % ((_UP, _LO, low) * 4)
                    els = self.d.find_elements(By.XPATH, xp)
                    for el in els:
                        if el.is_displayed() and el.is_enabled():
                            el.click()
                            return True
                except Exception:
                    pass
            time.sleep(0.6)
        return False

    def click_card_tab(self, timeout=8):
        """OpenRouter「Add a Payment Method」有时弹支付方式选择器(Cash App Pay/Card/Bank/Klarna),
        默认选中 Cash App Pay → 卡表单不出。这里跨 iframe(含一层嵌套)找并点【Card】这块。
        click_text 只在当前 frame 找,够不到 Stripe iframe 里的 tab,所以单写一个跨帧版。返回是否点到。"""
        By = self.By
        JS = r"""
          var els=[].slice.call(document.querySelectorAll(
            'button,[role=button],[role=tab],[role=radio],label,div[tabindex],a'));
          function norm(b){return ((b.innerText||b.textContent||'').replace(/\s+/g,' ')).trim();}
          // 1) 文本精确等于 Card / Credit Card(避免误中 "Card number" 这类标签)
          var t=els.find(function(b){var x=norm(b);return x==='Card'||x==='Credit Card'||x==='Debit or Credit Card'||x==='Credit or debit card';});
          // 2) 兜底:Stripe tab 的 id/data-testid 含 card
          if(!t) t=els.find(function(b){var id=((b.id||'')+' '+((b.getAttribute&&b.getAttribute('data-testid'))||'')).toLowerCase();
                 return /(^|[-_ ])card($|[-_ ])|tab-card|item-card/.test(id);});
          if(t){try{t.scrollIntoView({block:'center'});}catch(e){} t.click(); return true;}
          return false;
        """
        end = time.time() + timeout
        while time.time() < end:
            frames = [None] + self.d.find_elements(By.TAG_NAME, "iframe")
            for f in frames:
                try:
                    self.d.switch_to.default_content()
                    if f is not None:
                        self.d.switch_to.frame(f)
                    if self.d.execute_script(JS):
                        self.d.switch_to.default_content()
                        return True
                    # 再下钻一层(Stripe 常是 iframe 里还有 iframe)
                    if f is not None:
                        for ifr in self.d.find_elements(By.TAG_NAME, "iframe"):
                            try:
                                self.d.switch_to.frame(ifr)
                                if self.d.execute_script(JS):
                                    self.d.switch_to.default_content()
                                    return True
                                self.d.switch_to.parent_frame()
                            except Exception:
                                self.d.switch_to.default_content()
                                if f is not None:
                                    self.d.switch_to.frame(f)
                except Exception:
                    pass
            self.d.switch_to.default_content()
            time.sleep(0.5)
        self.d.switch_to.default_content()
        return False

    def _try_fill(self, sels, value, want):
        By, Keys = self.By, self.Keys
        for s in sels:
            try:
                for el in self.d.find_elements(By.CSS_SELECTOR, s):
                    if el.is_displayed():
                        el.click()
                        clear_input(el, Keys)   # 跨平台全选清空(Mac Ctrl+A≠全选 → 必须 Cmd+A,否则残值拼脏=invalid card)
                        # 逐字符敲 + 随机间隔(拟人化):整串 0ms 粘贴是机器特征,Stripe Radar 的行为遥测
                        # 会看填卡节奏(填卡耗时<人类下限=高风险)。卡号16位约 ~1.3s,代价小、压风险分。
                        for ch in str(value):
                            el.send_keys(ch)
                            time.sleep(random.uniform(0.04, 0.13))
                        time.sleep(0.2)
                        got = digits(el.get_attribute("value"))
                        if not want or len(got) >= len(want):
                            return True
            except Exception:
                continue
        return False

    def fill_in_frames(self, sels, value):
        By = self.By
        if not value:
            return None
        want = digits(value)
        for _ in range(2):
            self.d.switch_to.default_content()
            if self._try_fill(sels, value, want):
                return True
            for fr in self.d.find_elements(By.TAG_NAME, "iframe"):
                try:
                    self.d.switch_to.default_content(); self.d.switch_to.frame(fr)
                    if self._try_fill(sels, value, want):
                        return True
                    for ifr in self.d.find_elements(By.TAG_NAME, "iframe"):
                        try:
                            self.d.switch_to.frame(ifr)
                            if self._try_fill(sels, value, want):
                                return True
                            self.d.switch_to.parent_frame()
                        except Exception:
                            try: self.d.switch_to.parent_frame()
                            except Exception: pass
                except Exception:
                    continue
            time.sleep(0.5)
        self.d.switch_to.default_content()
        return False

    def select_in_frames(self, sels, label):
        By = self.By
        self.d.switch_to.default_content()
        for f in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                if f is not None:
                    self.d.switch_to.frame(f)
                for s in sels:
                    for el in self.d.find_elements(By.CSS_SELECTOR, s):
                        try:
                            self.Select(el).select_by_visible_text(label)
                            self.d.switch_to.default_content(); return True
                        except Exception:
                            pass
            except Exception:
                pass
            finally:
                self.d.switch_to.default_content()
        return False

    def field_present(self, sels):
        By = self.By
        self.d.switch_to.default_content()
        try:
            for fr in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
                try:
                    if fr is not None:
                        self.d.switch_to.frame(fr)
                    for s in sels:
                        for el in self.d.find_elements(By.CSS_SELECTOR, s):
                            if el.is_displayed():
                                return True
                except Exception:
                    pass
                finally:
                    self.d.switch_to.default_content()
        except Exception:
            pass
        return False

    def wait_field_present(self, sels, timeout=30, label="字段"):
        end = time.time() + timeout
        while time.time() < end:
            if self.field_present(sels):
                return True
            time.sleep(0.6)
        log("  ✗ 等【%s】出现超时(%ss)" % (label, timeout))
        return False

    def wait_and_fill(self, sels, value, timeout=15, label="字段"):
        if value is None or value == "":
            return None
        end = time.time() + timeout
        while time.time() < end:
            if self.field_present(sels) and self.fill_in_frames(sels, value):
                log("  ✓ %s 已填" % label)
                return True
            time.sleep(0.6)
        log("  ✗ %s 超时未填上" % label)
        return False

    def wait_and_select(self, sels, label_text, timeout=12, label="下拉"):
        end = time.time() + timeout
        while time.time() < end:
            if self.field_present(sels) and self.select_in_frames(sels, label_text):
                log("  ✓ %s 已选(%s)" % (label, label_text))
                return True
            time.sleep(0.6)
        log("  ✗ %s 超时未选上" % label)
        return False

    def tab_blur(self, sels):
        """给匹配到的输入框发 TAB 使其失焦——触发 Stripe Address/Payment Element 字段校验。跨帧。
        Stripe 元件只在 blur 后才把字段算 complete，否则 Update Address/Save 点了不动。"""
        By, Keys = self.By, self.Keys
        self.d.switch_to.default_content()
        for fr in [None] + self.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                if fr is not None:
                    self.d.switch_to.frame(fr)
                for s in sels:
                    for el in self.d.find_elements(By.CSS_SELECTOR, s):
                        if el.is_displayed():
                            try:
                                el.send_keys(Keys.TAB)
                            except Exception:
                                pass
                            self.d.switch_to.default_content()
                            return True
            except Exception:
                pass
            finally:
                self.d.switch_to.default_content()
        return False

    def uncheck_all_frames(self):
        """跨 2 层 iframe 取消所有勾选（Stripe Link 复选框在 iframe 里）。返回取消个数。"""
        By = self.By
        def here():
            cnt = 0
            for cb in self.d.find_elements(By.CSS_SELECTOR, "input[type=checkbox]"):
                try:
                    if cb.is_selected():
                        try:
                            cb.click()
                        except Exception:
                            self.d.execute_script("arguments[0].click()", cb)
                        cnt += 1
                except Exception:
                    pass
            return cnt
        nu = 0
        self.d.switch_to.default_content()
        nu += here()
        for fr in self.d.find_elements(By.TAG_NAME, "iframe"):
            try:
                self.d.switch_to.default_content(); self.d.switch_to.frame(fr)
                nu += here()
                for ifr in self.d.find_elements(By.TAG_NAME, "iframe"):
                    try:
                        self.d.switch_to.frame(ifr); nu += here(); self.d.switch_to.parent_frame()
                    except Exception:
                        try: self.d.switch_to.parent_frame()
                        except Exception: pass
            except Exception:
                pass
        self.d.switch_to.default_content()
        return nu


__all__ = ["Page"]
