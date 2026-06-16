'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 指纹浏览器 Provider — 注册表 + 编排器
//
// 文件定位：Openrouter/0.0.1/browser-provider/index.js
//
// 镜像 billing/card-fill/index.js 的【惰性注册表】：某家 provider 缺依赖/语法问题只会禁用它自己，
// 绝不拖垮默认 adspower 路径。业务侧只用 createRuntime/stopRuntime，不关心是哪家浏览器。
//
// 接管返回的 runtime 上挂 providerMeta={provider,envId,ws,debugPort}，并设 adspower 别名指向它——
// 这样 card-fill/engines/selenium.js 读 runtime.adspower.debugPort 对【所有 provider】都生效，selenium 引擎一行不改。
// ═══════════════════════════════════════════════════════════════════════

const base = require('./base');
const { createEnvPool } = require('./env-pool');

const LOADERS = {
  adspower: () => require('./providers/adspower'),
  bitbrowser: () => require('./providers/bitbrowser'),
  dolphin: () => require('./providers/dolphin'),
  gologin: () => require('./providers/gologin'),
  hubstudio: () => require('./providers/hubstudio'),
  morelogin: () => require('./providers/morelogin'),
  multilogin: () => require('./providers/multilogin'),
  vmlogin: () => require('./providers/vmlogin'),
};

function listProviders() { return Object.keys(LOADERS); }

// 惰性加载某 provider；依赖缺失/文件问题 → 返回 null(禁用该家，不影响其它)。
function getProvider(name) {
  const loader = LOADERS[name];
  if (!loader) return null;
  try { const m = loader(); return (m && typeof m.start === 'function') ? m : null; } catch (_e) { return null; }
}

async function healthOf(name) {
  const p = getProvider(name);
  if (!p) return false;
  try { return await p.isHealthy(); } catch (_e) { return false; }
}

/**
 * 启动某 provider 的某环境并用 Playwright 接管，返回 runtime(形似 createAdsPowerRuntime / createBrowserRuntime)。
 * @returns { browser, context, page, ipCheck, providerMeta, adspower }
 */
async function createRuntime(name, envId, opts = {}) {
  const { headless = false, windowLayout = null, log = () => {} } = opts;
  const p = getProvider(name);
  if (!p) { const e = new Error(`UNKNOWN_BROWSER_PROVIDER:${name}`); e._provider = true; throw e; }
  const started = await p.start(envId, { headless, log });
  if (!started || !started.ok) { const e = new Error((started && started.error) || `${name}:START_FAILED`); e._provider = true; throw e; }
  let rt;
  try {
    rt = await base.connectRuntime(started.ws, {
      windowLayout,
      log,
      ipSource: name,
      proxy: opts?.proxy || null,
      account: opts?.account || null,
      runtime: opts?.runtime || {},
      browserIdentity: opts?.browserIdentity || null,
      identity: opts?.identity || null,
    });
  } catch (e) {
    await p.stop(envId).catch(() => {}); // 连接失败兜底停环境(provider-agnostic，放编排器)
    e._provider = true;
    throw e;
  }
  const meta = { provider: name, envId, ws: started.ws, debugPort: started.debugPort };
  rt.providerMeta = meta;
  rt.adspower = meta; // 向后兼容别名：selenium 填卡引擎读 runtime.adspower.debugPort
  return rt;
}

async function stopRuntime(name, envId) {
  const p = getProvider(name);
  if (!p) return;
  await p.stop(envId).catch(() => {});
}

module.exports = { listProviders, getProvider, healthOf, createRuntime, stopRuntime, createEnvPool, base };
