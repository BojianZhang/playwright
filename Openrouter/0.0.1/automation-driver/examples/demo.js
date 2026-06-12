'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 演示 —— 任意指纹浏览器 × 任意自动化驱动
//
// 用法: node Openrouter/0.0.1/automation-driver/examples/demo.js <provider> <envId> <driver> [url]
//   例: node Openrouter/0.0.1/automation-driver/examples/demo.js adspower k1dd0f71 playwright
//       node Openrouter/0.0.1/automation-driver/examples/demo.js adspower k1dd0f71 puppeteer
//       node Openrouter/0.0.1/automation-driver/examples/demo.js adspower k1dd0f71 selenium
//       node Openrouter/0.0.1/automation-driver/examples/demo.js adspower k1dd0f71 playwright-python
//
// 流程：provider.start(envId) → 拿 CDP 端点 → 用所选 driver 接管 → 开 url、回标题 → 清理(停环境)。
// 零副作用(只打开 example.com)。证明"换 driver / 换指纹浏览器，业务代码不变"。
// ═══════════════════════════════════════════════════════════════════════

const bp = require('../../browser-provider');
const ad = require('../index');
const { makeOps } = require('../ops');

(async () => {
  const provider = process.argv[2] || 'adspower';
  const envId = process.argv[3];
  const driver = process.argv[4] || 'playwright';
  const url = process.argv[5] || 'https://example.com';
  if (!envId) { console.log('用法: node demo.js <provider> <envId> <driver> [url]'); process.exit(1); }

  const p = bp.getProvider(provider);
  if (!p) { console.log('未知 provider:', provider); process.exit(1); }
  console.log(`provider=${provider} envId=${envId} driver=${driver} → 启动环境…`);
  const started = await p.start(envId, {});
  if (!started.ok) { console.log('环境启动失败:', started.error); process.exit(1); }
  const endpoint = { ws: started.ws, debugPort: started.debugPort };
  console.log('CDP 端点:', JSON.stringify(endpoint));

  try {
    const d = ad.getDriver(driver);
    if (!d) {
      console.log('未知/不可用 driver:', driver, '(可用:', ad.listDrivers().join('/') + ')');
    } else if (d.kind === 'node') {
      const h = await ad.attach(driver, endpoint);
      const ops = makeOps(h);
      await ops.goto(url);
      console.log(`✅ [${driver}] 接管成功 → title="${await ops.title()}" url=${ops.url()}`);
      await h.detach();
    } else {
      const r = await ad.run(driver, endpoint, null, { url }, { log: (m) => console.log('  ' + m) });
      console.log(`[${driver}] python 结果:`, JSON.stringify(r));
    }
  } catch (e) { console.log('驱动异常:', (e && e.message) || e); }

  await p.stop(envId);
  console.log('已停环境。');
  process.exit(0);
})();
