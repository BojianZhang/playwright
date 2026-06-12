'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 填卡引擎调度器 + 失败兜底链
//
// 文件定位：Openrouter/0.0.1/billing/card-fill/index.js
//
// 引擎契约：每个引擎导出 async fillCard({ page, card, address, log, opts, runtime })
//   → { num:bool, exp:bool, cvc:bool, zip?:bool, engine:string, error?:string }。
//   引擎【只】把 number/exp/cvc/zip 填进"当前已打开的表单"，不碰弹窗导航/Save/验证码。
// 镜像 captcha-solver.js 的 provider 调度风格，但用【惰性注册表】：某引擎依赖缺失/语法问题
//   只会禁用该引擎、绝不报错拖垮默认 playwright 路径。
// ═══════════════════════════════════════════════════════════════════════

const LOADERS = {
  playwright: () => require('./engines/playwright'),
  osinput: () => require('./engines/osinput'),
  extension: () => require('./engines/extension'),
  selenium: () => require('./engines/selenium'),
  api: () => require('./engines/api'),
};

// 惰性加载某引擎模块；依赖缺失/文件不存在/语法问题 → 返回 null(禁用该引擎，不影响其它)。
function load(name) {
  const loader = LOADERS[name];
  if (!loader) return null;
  try { return loader(); } catch (_e) { return null; }
}

// 把 "playwright,osinput" 或 ['playwright','osinput'] 解析成引擎名数组；空则默认 ['playwright']。
function parseChain(spec) {
  const arr = Array.isArray(spec) ? spec : String(spec == null ? '' : spec).split(',');
  const out = arr.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? out : ['playwright'];
}

// 按链从左到右试填；首个把 num/exp/cvc 全填上的引擎胜出。全失败返回最后一个结果，
// 让上层既有的 Save 前重填 / manualBillingFallback 照常接管。proven 的 playwright 放链首。
async function fillCard({ page, card, address, log, runtime, engine }) {
  const chain = parseChain(engine);
  let last = null;
  for (let i = 0; i < chain.length; i += 1) {
    const name = chain[i];
    const eng = load(name);
    if (!eng || typeof eng.fillCard !== 'function') {
      log && log(`未知/不可用填卡引擎「${name}」，跳过`);
      continue;
    }
    if (chain.length > 1) log && log(`填卡引擎尝试: ${name}`);
    try {
      const r = await eng.fillCard({ page, card, address, log, runtime });
      last = r || { num: false, exp: false, cvc: false, engine: name };
      if (last.num && last.exp && last.cvc) {
        if (i > 0) log && log(`填卡引擎「${name}」兜底成功`);
        return last;
      }
      log && log(`填卡引擎「${name}」未填全(num=${!!last.num} exp=${!!last.exp} cvc=${!!last.cvc})，尝试下一个`);
    } catch (e) {
      last = { num: false, exp: false, cvc: false, engine: name, error: String((e && e.message) || e).slice(0, 200) };
      log && log(`填卡引擎「${name}」异常: ${last.error}`);
    }
  }
  return last || { num: false, exp: false, cvc: false, engine: 'none', error: 'NO_ENGINE_RAN' };
}

module.exports = { fillCard, parseChain, load };
