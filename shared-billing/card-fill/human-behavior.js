'use strict';
// ⟦共享规范实现 · 改这里;各项目 billing/card-fill/human-behavior.js 是 re-export shim,勿改⟧ 见 shared-billing/README.md

// ═══════════════════════════════════════════════════════════════════════
// 拟人行为原语（行为/时序维度的反风控补充 · 规范实现）
//
// 历史出处：Openrouter/0.0.1/billing/card-fill/human-behavior.js(现已收口到 shared-billing)
//
// 为什么：静态指纹(navigator.webdriver/WebGL/CDP 残留…)用 AdsPower 已经干净(见 _botprobe.js)，
//   但 Stripe Radar 还会评估【行为/时序】——填卡速度、是否有鼠标轨迹、是否注册完秒加卡。
//   本模块补这一层：真鼠标分步移动(产生 mousemove 轨迹) + 提交前阅读停顿 + 页面预热滚动。
//
// 边界：纯行为模拟，全部失败安全(找不到元素/超时就跳过，绝不抛)。opt-in —— 仅 humanLike 时启用，
//   默认关闭(更快、行为与今天一致)。填卡字段的逐字符输入已在 fill-primitive/playwright 引擎里(始终开)。
// ═══════════════════════════════════════════════════════════════════════

function rand(min, max) { return min + Math.floor(Math.random() * Math.max(1, max - min)); }

// 把真鼠标光标【分多步】移到某元素中心附近(产生真实 mousemove 轨迹，而非瞬移)。
// boundingBox 对跨域 iframe 内元素也返回视口坐标，所以 Stripe 卡框/Save 按钮都适用。失败安全。
async function moveMouseTo(page, locator, log) {
  try {
    const box = await locator.boundingBox({ timeout: 1500 });
    if (!box) return false;
    const tx = box.x + box.width * (0.3 + Math.random() * 0.4);
    const ty = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(tx, ty, { steps: rand(8, 22) });
    await page.waitForTimeout(rand(80, 240));
    return true;
  } catch (_e) { return false; }
}

// 阅读/思考停顿(真人提交前会看一眼表单)。
function readingDwell(page, min = 600, max = 1800) { return page.waitForTimeout(rand(min, max)); }

// 页面预热：真人不会进页面就立刻加卡——滚动看几眼、停留几秒，给行为遥测留下"在浏览"的痕迹。失败安全。
async function warmup(page, log) {
  try {
    for (let i = 0; i < rand(2, 4); i += 1) {
      await page.mouse.wheel(0, rand(200, 650)).catch(() => {});
      await page.waitForTimeout(rand(400, 1100));
    }
    await page.mouse.wheel(0, -rand(120, 450)).catch(() => {});
    await page.waitForTimeout(rand(500, 1300));
    if (log) log('拟人预热：滚动浏览+停留');
  } catch (_e) { /* ignore */ }
}

module.exports = { moveMouseTo, readingDwell, warmup, rand };
