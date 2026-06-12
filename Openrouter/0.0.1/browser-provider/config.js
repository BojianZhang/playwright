'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 指纹浏览器 Provider — 配置解析
//
// 文件定位：Openrouter/0.0.1/browser-provider/config.js
//
// 精度(从低到高)：内置默认 < config.json[browserProviders][name] < config.local.json 同段 < 环境变量。
// ⚠ token 等敏感项【只走环境变量或 config.local.json(已 gitignore)】，绝不写进 config.json。
//   env 命名：OPENROUTER_<NAME>_API / OPENROUTER_<NAME>_TOKEN，如 OPENROUTER_BITBROWSER_API。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// 各家本地 API 的内置默认基址(可被 config / env 覆盖)。
const BUILTIN = {
  adspower: { apiBase: 'http://local.adspower.net:50325' },
  bitbrowser: { apiBase: 'http://127.0.0.1:54345' },
  dolphin: { apiBase: 'http://localhost:3001' },
  gologin: { apiBase: 'https://api.gologin.com' },
  hubstudio: { apiBase: 'http://127.0.0.1:6873' },
  morelogin: { apiBase: 'http://127.0.0.1:40000' },
  multilogin: { apiBase: 'http://127.0.0.1:35000' }, // Multilogin 6 本地启动器；ML X 用 launcher.mlx.yt:45001 + token
  vmlogin: { apiBase: 'http://127.0.0.1:35000' },
};

let _fileSection = null;
function fileSection() {
  if (_fileSection) return _fileSection;
  const dir = path.join(__dirname, '..'); // Openrouter/0.0.1/
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_e) { return {}; } };
  const base = read('config.json').browserProviders || {};
  const local = read('config.local.json').browserProviders || {};
  // 浅合并各 provider 段(local 覆盖 base)。
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(local)])) out[k] = Object.assign({}, base[k], local[k]);
  _fileSection = out;
  return out;
}

/** 取某 provider 的有效配置 { apiBase, token?, ... }。 */
function providerConfig(name) {
  const U = String(name || '').toUpperCase();
  const env = {};
  if (process.env[`OPENROUTER_${U}_API`]) env.apiBase = process.env[`OPENROUTER_${U}_API`];
  if (process.env[`OPENROUTER_${U}_TOKEN`]) env.token = process.env[`OPENROUTER_${U}_TOKEN`];
  if (process.env[`OPENROUTER_${U}_APPID`]) env.appId = process.env[`OPENROUTER_${U}_APPID`]; // MoreLogin 等需 appId/secret 签名
  if (process.env[`OPENROUTER_${U}_SECRET`]) env.secret = process.env[`OPENROUTER_${U}_SECRET`];
  return Object.assign({}, BUILTIN[name] || {}, fileSection()[name] || {}, env);
}

module.exports = { providerConfig, BUILTIN };
