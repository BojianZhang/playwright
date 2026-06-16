'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — osinput（实验 · 兜底 · 帧无关）
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/engines/osinput.js
//
// 思路：用 Playwright 把目标输入框【聚焦】，再用【OS 级键盘】真实敲键——OS 不认 iframe，跨域照填。
//   仅作 playwright(CDP 输入)将来被 Stripe 封时的最后手段；脆：需 AdsPower 浏览器窗口【前台】+ 字段聚焦。
// 依赖：Windows 用内置 PowerShell SendKeys；macOS 用系统自带 osascript(System Events keystroke)。皆零安装。
//   ★macOS 需在「系统设置 → 隐私与安全性 → 辅助功能」给启动本进程的程序(终端/Node)授权,否则键发不出去。
//   其它平台(Linux)暂未实现 → 优雅落链(返回未填，链上 playwright 接管)。
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

// macOS：经 osascript(System Events)向【前台窗口】敲键。先 Cmd+A + Delete 清空，再逐字符发(数字串安全)。
// 需辅助功能权限;失败(权限未授/超时)resolve(false)，由回读判定决定是否落链。
function sendKeysMac(text) {
  return new Promise((resolve) => {
    const esc = (c) => String(c).replace(/(["\\])/g, '\\$1');   // 转义 " 和 \(数字串其实用不到，防御性)
    const typed = String(text).split('').map((c) => `keystroke "${esc(c)}"\ndelay 0.07`).join('\n');
    const script = 'tell application "System Events"\n'
      + 'keystroke "a" using command down\n'
      + 'delay 0.06\n'
      + 'key code 51\n'        // 51 = Delete(退格)，清掉选中内容
      + 'delay 0.06\n'
      + typed + '\n'
      + 'end tell';
    let p;
    try { p = spawn('osascript', ['-e', script]); }
    catch (_e) { resolve(false); return; }
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(true));
  });
}

// 按平台分派 OS 级键盘:win32→PowerShell SendKeys;darwin→osascript;其它→不发(false)。
function sendKeys(text) {
  if (process.platform === 'win32') return sendKeysWindows(text);
  if (process.platform === 'darwin') return sendKeysMac(text);
  return Promise.resolve(false);
}

// macOS：把【窗口标题含 titleSubstr 的浏览器 App】提到 OS 前台。osascript keystroke 打的是 OS 前台窗口,
// 而 Playwright page.bringToFront() 只抬浏览器内的标签页、不保证 App 在系统最前 → 不先 activate,卡号会被
// 打进当时的前台 App(终端/IDE)。需辅助功能权限;失败 resolve(false)，由调用方的 inputValue 回读兜底。
function activateBrowserMac(titleSubstr) {
  return new Promise((resolve) => {
    const safe = String(titleSubstr || '').replace(/["\\]/g, '').slice(0, 40);
    // 标题子串过短(<4)会误命中终端/Finder 等窗口 → 当作失败,绝不发键(否则把错误窗口抬前台再打卡号)。
    if (safe.length < 4) { resolve(false); return; }
    const script = 'tell application "System Events"\n'
      + '  repeat with p in (every process whose background only is false)\n'
      + '    repeat with w in (windows of p)\n'
      + '      try\n'
      + `        if (name of w) contains "${safe}" then\n`
      + '          set frontmost of p to true\n'
      + '          try\n            perform action "AXRaise" of w\n          end try\n'
      + '          return "ok"\n'
      + '        end if\n'
      + '      end try\n'
      + '    end repeat\n'
      + '  end repeat\n'
      + 'end tell\nreturn "no"';
    let pr, out = '';
    try { pr = spawn('osascript', ['-e', script]); }
    catch (_e) { resolve(false); return; }
    if (pr.stdout) pr.stdout.on('data', (d) => { out += d; });
    pr.on('error', () => resolve(false));
    pr.on('close', () => resolve(out.trim() === 'ok'));   // 真按 osascript 回的 ok/no 判定是否确实把浏览器提到前台
  });
}

async function fillOne(page, selectors, value) {
  if (!value) return undefined;
  const loc = await focusField(page, selectors);
  if (!loc) return false;
  await page.bringToFront().catch(() => {}); // 每字段发键前再提前台一次
  if (process.platform === 'darwin') {
    // ★把浏览器 App 提到 OS 最前,且【确认成功才发键】:否则 osascript keystroke 会打进当前前台 App(终端/IDE)
    //   → 卡号泄漏。没确认提到前台就返回 false(落链给 Playwright),宁可不填也绝不泄漏。
    const t = await page.title().catch(() => '');
    const raised = await activateBrowserMac(t);
    if (!raised) return false;
  }
  await sendKeys(String(value));
  await page.waitForTimeout(300);
  const want = String(value).replace(/\D/g, '');
  const got = ((await loc.inputValue().catch(() => '')) || '').replace(/\D/g, '');
  return !want || got.length >= want.length;
}

async function fillCard({ page, card, address, log }) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    log && log('osinput 引擎目前仅实现 Windows(SendKeys)/macOS(osascript)；本平台跳过 → 落链');
    return { num: false, exp: false, cvc: false, engine: 'osinput', error: 'OSINPUT_UNSUPPORTED_OS' };
  }
  // ⚠ 安全门：osinput 把卡号/CVC 经 OS 级 SendKeys 发给【前台窗口】——浏览器不在前台时会泄到终端/IDE。
  //   必须显式 GLM_OSINPUT_OK=1 声明"已确保浏览器前台/隔离环境"才发键；否则直接落链(绝不发任何键)。
  if (process.env.GLM_OSINPUT_OK !== '1') {
    log && log('osinput 未启用(防卡号泄漏到错误窗口)：设 GLM_OSINPUT_OK=1 且确保浏览器前台才用 → 落链');
    return { num: false, exp: false, cvc: false, engine: 'osinput', error: 'OSINPUT_DISABLED' };
  }
  await page.bringToFront().catch(() => {}); // 尽力把浏览器标签/窗口提到前台
  log && log(`osinput 引擎：经 Playwright 聚焦字段 + OS 级键盘敲键(${process.platform === 'darwin' ? 'osascript' : 'SendKeys'}，已开 GLM_OSINPUT_OK)`);
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
