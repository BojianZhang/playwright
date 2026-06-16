'use strict';
// ⟦共享规范实现 · 改这里;各项目 billing/card-fill/fill-primitive.js 是 re-export shim,勿改⟧ 见 shared-billing/README.md

// ═══════════════════════════════════════════════════════════════════════
// 填卡底层原语 —— 从 stages.js 抽出（与 playwright 引擎共用，避免重复 · 规范实现）
//
// 历史出处：Openrouter/0.0.1/billing/card-fill/fill-primitive.js(现已收口到 shared-billing)
//
// fillAcross: 跨主框架 + 所有子 iframe 寻找首个可见输入框并填值（Stripe 输入需 focus+type）。
//   opts.human=true 时逐字符带随机延迟输入 + 回读校验位数 + 不全清空重试(最多4次)——
//   这是穿跨域 js.stripe.com iframe 的核心(fill() 不被 Stripe 识别，必须真实按键)。
// 两个函数都只用 page 入参，是纯函数；stages.js 内 ~10 处调用点(地址/金额/州/国家/zip)继续复用。
// ═══════════════════════════════════════════════════════════════════════

// 全选快捷键：macOS 是 Meta+a，其余 Control+a(Windows/AdsPower 生产环境就是 Control+a)。
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';

// 随机停顿(模拟真人节奏)。
function humanPause(page, minMs = 250, maxMs = 800) {
  return page.waitForTimeout(minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)));
}

// 跨主框架 + 所有子 iframe 寻找首个可见输入框并填值。
// opts.human=true 时逐字符带随机延迟输入，模拟真人打字——降低 Stripe 行为风控(尤其卡号/CVC)。
async function fillAcross(page, selectors, value, log, opts = {}) {
  if (value == null || value === '') return false;
  const frames = [page.mainFrame(), ...page.frames()];
  for (const sel of selectors) {
    for (const f of frames) {
      try {
        const loc = f.locator(sel).first();
        if (!(await loc.count().catch(() => 0))) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 1500 }).catch(() => {});
        await loc.fill('').catch(() => {});
        if (opts.human) {
          // Stripe 卡字段必须走真实按键(fill 不被其识别)；逐字符输入后【回读校验位数】，
          // 不全就清空重试(最多 4 次)——修复"卡号只填进前几位 → card incomplete"的截断 bug。
          const want = String(value).replace(/\D/g, '');
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await loc.click({ timeout: 1500 }).catch(() => {});
            await loc.press(SELECT_ALL).catch(() => {});
            await loc.press('Delete').catch(() => {});
            await loc.type(String(value), { delay: 55 + Math.floor(Math.random() * 60) }).catch(() => {});
            const got = ((await loc.inputValue().catch(() => '')) || '').replace(/\D/g, '');
            if (!want || got.length >= want.length) return true;
            if (log) log(`字段输入不完整(${got.length}/${want.length} 位)，清空重试 ${attempt + 1}/4`);
            await page.waitForTimeout(200);
          }
          return false; // 多次仍填不全：上层据此知道卡未填好，不会带着残缺卡号去保存
        }
        const typed = await loc.fill(String(value)).then(() => true).catch(() => false);
        if (!typed) { await loc.type(String(value), { delay: 25 }).catch(() => {}); }
        return true;
      } catch (_e) { /* try next */ }
    }
  }
  return false;
}

module.exports = { fillAcross, humanPause };
