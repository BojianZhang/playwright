// 绑卡可调参数读取:process.env 优先 → cfg.billing.<camelCase> 兜底 → 硬默认垫底。
// 默认值对齐 Selenium 侧(common.py/hybrid_run.py),保证两端语义一致(共用同一份 card-pool.json)。
// card-pool.js 是无 cfg 入参的纯模块 → 只传 process.env(cfg 省略),天然走 env→默认。
'use strict';

function _rawEnv(name) {
  const v = process.env[name];
  return (v === undefined || v === '') ? undefined : v;
}

// ZIP_RETRY → zipRetry ; CARD_DECLINE_DISABLE_AT → cardDeclineDisableAt
function _camel(envName) {
  return String(envName).toLowerCase().replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

function _cfgVal(name, cfg) {
  const b = cfg && cfg.billing;
  if (!b) return undefined;
  const v = b[_camel(name)];
  return (v === undefined || v === null || v === '') ? undefined : v;
}

function envInt(name, def, cfg) {
  for (const raw of [_rawEnv(name), _cfgVal(name, cfg)]) {
    if (raw !== undefined) { const n = parseInt(raw, 10); if (!Number.isNaN(n)) return n; }
  }
  return def;
}

function envFloat(name, def, cfg) {
  for (const raw of [_rawEnv(name), _cfgVal(name, cfg)]) {
    if (raw !== undefined) { const n = parseFloat(raw); if (!Number.isNaN(n)) return n; }
  }
  return def;
}

module.exports = { envInt, envFloat };
