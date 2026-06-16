'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎 — api（研究 · 实验 · best-effort）
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/engines/api.js
//
// 设想：用页面的 pk_live + SetupIntent client_secret，直接调 Stripe API 建 PaymentMethod 再 confirm，
//   完全绕过表单(可能连验证码也省了)。但：
//   ① client_secret 由 OpenRouter 后端在开卡表单时下发，稳定嗅取困难(每次变、无固定全局)；
//   ② Stripe 正逐步限制"客户端裸卡建 PaymentMethod"，且 confirm 可能要求源自 Elements。
//   故此引擎为 best-effort：尽力探测 pk/client_secret，拿不全/不可行就【优雅落链】(返回未填)。
//   真要做通需逆向 OpenRouter 内部账单接口，脆且易随其改动失效——按需自行扩展本文件。
// ═══════════════════════════════════════════════════════════════════════

async function fillCard({ page, log }) {
  let pk = null;
  let hasSecret = false;
  try {
    const probe = await page.evaluate(() => {
      const html = document.documentElement.innerHTML || '';
      const pkMatch = html.match(/pk_live_[A-Za-z0-9]+/);
      // SetupIntent client_secret 形如 seti_..._secret_...；尽力从页面/全局找(多半找不到)。
      const secMatch = html.match(/seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/);
      return { pk: pkMatch ? pkMatch[0] : null, secret: !!secMatch };
    }).catch(() => ({ pk: null, secret: false }));
    pk = probe.pk; hasSecret = !!probe.secret;
  } catch (_e) { /* */ }

  log && log(`api 引擎(实验): pk=${pk ? String(pk).slice(0, 16) + '…' : '未找到'} | client_secret=${hasSecret ? '疑似在页面' : '未探到'}`);
  log && log('api 引擎：完整 API 旁路需稳定的 SetupIntent client_secret(后端下发)+ Stripe 允许客户端建卡，当前不满足 → 落链(交给链上 playwright)');
  return { num: false, exp: false, cvc: false, engine: 'api', error: 'API_BYPASS_NOT_WIRED' };
}

module.exports = { name: 'api', fillCard };
