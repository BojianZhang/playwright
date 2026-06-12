'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — osinput（实验 · 兜底 · 帧无关）
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/engines/osinput.js
//
// 思路：用 Playwright 把目标输入框【聚焦】，再用【OS 级键盘】真实敲键——OS 不认 iframe，跨域照填。
//   仅作 playwright(CDP 输入)将来被 Stripe 封时的最后手段；脆：需 AdsPower 浏览器窗口【前台】+ 字段聚焦。
// 依赖：Windows 用内置 PowerShell SendKeys(零安装)；如需更稳可换 @nut-tree-fork/nut-js(预编译)。
//   非 Windows 暂未实现 → 优雅落链(返回未填，链上 playwright 接管)。
// ═══════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const sels = require('../selectors');

// 跨主框架 + 所有子 iframe 找首个可见字段，点击聚焦，返回 locator(供回读)；找不到返回 null。
async function focusField(page, selectors) {
  for (const sel of selectors) {
    for (const f of [page.mainFrame(), ...page.frames()]) {
      try {
        const loc = f.locator(sel).first();
        if (!(await loc.count().catch(() => 0))) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 1500 }).catch(() => {});
        return loc;
      } catch (_e) { /* next */ }
    }
  }
  return null;
}

// Windows：经 PowerShell SendKeys 向【前台窗口】发按键(应是刚被 Playwright 点过的 AdsPower 浏览器)。
// 先 Ctrl+A + Delete 清空，再逐字符发(数字串对 SendKeys 安全，无需转义)。
function sendKeysWindows(text) {
  return new Promise((resolve) => {
    const keys = String(text).split('').map((c) => `[System.Windows.Forms.SendKeys]::SendWait('${c}'); Start-Sleep -Milliseconds 70;`).join(' ');
    const ps = 'Add-Type -AssemblyName System.Windows.Forms; '
      + "[System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 60; "
      + "[System.Windows.Forms.SendKeys]::SendWait('{DELETE}'); Start-Sleep -Milliseconds 60; "
      + keys;
    let p;
    try { p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }); }
    catch (_e) { resolve(false); return; }
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(true));
  });
}

async function fillOne(page, selectors, value) {
  if (!value) return undefined;
  const loc = await focusField(page, selectors);
  if (!loc) return false;
  await page.bringToFront().catch(() => {}); // 每字段发键前再提前台一次
  await sendKeysWindows(String(value));
  await page.waitForTimeout(300);
  const want = String(value).replace(/\D/g, '');
  const got = ((await loc.inputValue().catch(() => '')) || '').replace(/\D/g, '');
  return !want || got.length >= want.length;
}

async function fillCard({ page, card, address, log }) {
  if (process.platform !== 'win32') {
    log && log('osinput 引擎目前仅实现 Windows(SendKeys)；本平台跳过 → 落链');
    return { num: false, exp: false, cvc: false, engine: 'osinput', error: 'OSINPUT_WIN_ONLY' };
  }
  // ⚠ 安全门：osinput 把卡号/CVC 经 OS 级 SendKeys 发给【前台窗口】——浏览器不在前台时会泄到终端/IDE。
  //   必须显式 OPENROUTER_OSINPUT_OK=1 声明"已确保浏览器前台/隔离环境"才发键；否则直接落链(绝不发任何键)。
  if (process.env.OPENROUTER_OSINPUT_OK !== '1') {
    log && log('osinput 未启用(防卡号泄漏到错误窗口)：设 OPENROUTER_OSINPUT_OK=1 且确保浏览器前台才用 → 落链');
    return { num: false, exp: false, cvc: false, engine: 'osinput', error: 'OSINPUT_DISABLED' };
  }
  await page.bringToFront().catch(() => {}); // 尽力把浏览器标签/窗口提到前台
  log && log('osinput 引擎：经 Playwright 聚焦字段 + OS 级 SendKeys 敲键(已开 OPENROUTER_OSINPUT_OK)');
  const exp = `${card.expMonth}${card.expYear}`;
  const num = await fillOne(page, sels.number, card.number);
  const ex = await fillOne(page, sels.expiry, exp);
  const cvc = await fillOne(page, sels.cvc, card.cvc);
  const zip = card.zip || (address && address.zip) || '';
  let z;
  if (zip) z = await fillOne(page, sels.postal, zip);
  return { num: !!num, exp: !!ex, cvc: !!cvc, zip: zip ? !!z : undefined, engine: 'osinput' };
}

module.exports = { name: 'osinput', fillCard };
