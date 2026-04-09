import { test, expect } from '@playwright/test';

test('dreamina email login', async ({ page }) => {
  // 1) 打开 Dreamina 首页，只等到 DOM 出来，避免把等待完全压在 goto 上
  await page.goto('https://dreamina.capcut.com/ai-tool/home', {
    waitUntil: 'domcontentloaded',
  });

  // 2) 等登录入口真正可见后再点击
  const signInButton = page.getByText('Sign in');
  await expect(signInButton).toBeVisible({ timeout: 30000 });
  await signInButton.click();

  // 3) 等邮箱登录入口出现后再点击
  const continueWithEmailButton = page
    .locator('div')
    .filter({ hasText: /^Continue with email$/ })
    .nth(1);
  await expect(continueWithEmailButton).toBeVisible({ timeout: 30000 });
  await continueWithEmailButton.click();

  // 4) 等邮箱输入框真正可见后再填写
  const emailInput = page.getByRole('textbox', { name: 'Enter email' });
  await expect(emailInput).toBeVisible({ timeout: 30000 });
  await emailInput.click();
  await emailInput.fill('htyqnsn481@outlook.com');

  // 5) 等密码输入框真正可见后再填写
  const passwordInput = page.getByRole('textbox', { name: 'Enter password' });
  await expect(passwordInput).toBeVisible({ timeout: 30000 });
  await passwordInput.click();
  await passwordInput.fill('rVA2i0WErus7lz');

  // 6) 等 Continue 按钮可见且可用后再点击
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeVisible({ timeout: 30000 });
  await expect(continueButton).toBeEnabled({ timeout: 30000 });
  await continueButton.click();

  // 7) 点击登录后，先等页面基础加载完成
  await page.waitForLoadState('domcontentloaded');

  // 8) 再补一个短暂的网络稳定等待，给前端路由/接口回填一点时间
  await page.waitForTimeout(3000);

  // 9) 保存当前登录态，供后续测试复用
  await page.context().storageState({ path: 'user.json' });
});
