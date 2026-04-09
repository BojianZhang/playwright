const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // 1) 打开 Dreamina 首页
  await page.goto('https://dreamina.capcut.com/ai-tool/home', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });

  // 2) 等登录入口真正可见后再点击
  const signInButton = page.getByText('Sign in');
  await signInButton.waitFor({ state: 'visible', timeout: 30000 });
  await signInButton.click();

  // 3) 等邮箱登录入口出现后再点击
  const emailLoginButton = page
    .locator('div')
    .filter({ hasText: /^Continue with email$/ })
    .nth(1);
  await emailLoginButton.waitFor({ state: 'visible', timeout: 30000 });
  await emailLoginButton.click();

  // 4) 等邮箱输入框真正可见后再填写
  const emailInput = page.getByRole('textbox', { name: 'Enter email' });
  await emailInput.waitFor({ state: 'visible', timeout: 30000 });
  await emailInput.fill('htyqnsn481@outlook.com');

  // 5) 等密码输入框真正可见后再填写
  const passwordInput = page.getByRole('textbox', { name: 'Enter password' });
  await passwordInput.waitFor({ state: 'visible', timeout: 30000 });
  await passwordInput.fill('rVA2i0WErus7l');

  // 6) 等 Continue 按钮可见后点击
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await continueButton.waitFor({ state: 'visible', timeout: 30000 });
  await continueButton.click();

  // 7) 给登录后的页面一点稳定时间
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);

  // 8) 保存当前登录态
  await context.storageState({ path: 'user.json' });

  console.log('Dreamina login flow executed. Storage state saved to user.json');
})();
