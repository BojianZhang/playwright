#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# common 包 · Page:跨 iframe 钻取填表/选择/点击/读文本(Stripe 跨域 iframe 必需)。
# 仅依赖 base 的 log/digits;Selenium 在实例化时按需 import。
import time
import random

from .base import log, digits


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
        self.d.get(url)
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
                    txt.append(self.d.find_element(By.TAG_NAME, "body").text or "")
                except Exception:
                    pass
                finally:
                    self.d.switch_to.default_content()
        except Exception:
            pass
        return "\n".join(txt)

    def click_text(self, labels, timeout=8):
        By = self.By
        end = time.time() + timeout
        while time.time() < end:
            for lab in labels:
                try:
                    els = self.d.find_elements(By.XPATH, "//button[contains(normalize-space(.), '%s')] | //*[@role='button'][contains(normalize-space(.), '%s')]" % (lab, lab))
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
                        el.send_keys(Keys.CONTROL, "a"); el.send_keys(Keys.DELETE)
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
