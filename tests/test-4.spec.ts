import { test, chromium } from '@playwright/test';

test('test', async () => {
  const browser = await chromium.launch({
    headless: false,
    proxy: {
      server: 'http://gate.ipfoxy.io:58688',
      username: 'customer-XuCgvFdVQs-cc-TR-sessid-1776148969_10601',
      password: 'YBZrZzwysyHH7GU',
    },
  });

  const page = await browser.newPage();

  try {
    await page.goto('https://dreamina.capcut.com/ai-tool/login');
    await page.locator('.lv-checkbox-mask').click();
    await page.getByText('Sign in').click();
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const normalize = v => String(v || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const bodyText = normalize(document.body?.innerText || '');
      const modal = document.querySelector('.lv-modal-wrapper');
      const emailInput = document.querySelector('input[type="email"], input[placeholder*="email" i]');
      const continueNode = Array.from(document.querySelectorAll('body *')).find(node => normalize(node.innerText || '').includes('Continue with email')) || null;
      const checkboxLabel = document.querySelector('label.lv-checkbox.privacyCheck');
      return {
        url: location.href,
        modalVisible: visible(modal),
        emailInputVisible: visible(emailInput),
        continueWithEmailVisible: visible(continueNode),
        checkboxClass: normalize(checkboxLabel?.className || ''),
        bodyPreview: bodyText.slice(0, 500),
      };
    });

    console.log('PROXY_TEST4_POST_CLICK_STATE=' + JSON.stringify(state));
  } finally {
    await browser.close();
  }
});
