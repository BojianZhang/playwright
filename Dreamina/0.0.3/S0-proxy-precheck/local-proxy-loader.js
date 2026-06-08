'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 运行内容层（RUNTIME CONTENT LAYER）— Dreamina/0.0.3/S0-proxy-precheck
//
// 文件定位：Dreamina/0.0.3/S0-proxy-precheck/local-proxy-loader.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 加载并解析 data/proxies.txt，输出统一代理对象列表。
// ✅ 负责 —— 从 username 中自动提取国家码（cc-XX 模式）。
// ✅ 负责 —— 屏蔽注释行（# 开头）和格式错误行。
// ❌ 不负责 —— 任何网络请求（不做连通性检测）。
// ❌ 不负责 —— 代理健康评分（该层在 proxy-health-store.js）。
// ❌ 不负责 —— 代理池筛选策略（分配逻辑在 Dreamina-batch-runner.js）。
//
// 数据文件：data/proxies.txt（格式：host:port:user:pass）
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// 代理池数据文件路径（单一来源）
const LOCAL_PROXY_LIST_PATH = path.join(__dirname, 'data', 'proxies.txt');


/**
 * 国家码 → 中文名称映射表。
 * 用于从代理 username 中自动推导 countryName。
 * 如需扩充国家，在此生典中添加即可。
 */
const COUNTRY_NAME_BY_CODE = {
  BR: '巴西',
  CA: '加拿大',
  US: '美国',
  JP: '日本',
  GB: '英国',
  DE: '德国',
  FR: '法国',
  SG: '新加坡',
  HK: '中国香港',
  TW: '中国台湾',
  KR: '韩国',
  AU: '澳大利亚',
  ES: '西班牙',
  IT: '意大利',
  PL: '波兰',
  NL: '荷兰',
  SE: '瑞典',
  BE: '比利时',
  CH: '瑞士',
  AT: '奥地利',
  PT: '葡萄牙',
  IL: '以色列',
  PH: '菲律宾',
};

/**
 * 屏蔽代理密码，仅保留首尾各 1 字符，中间用 *** 替代。
 * 用于日志输出，避免明文密码泄漏。
 * @param {string} password
 * @returns {string}
 */
function maskProxyPassword(password) {
  const value = String(password || '');
  if (!value) return '';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

/**
 * 从代理 username 中提取国家元数据（countryCode / countryName）。
 * 支持格式：`cc-XX` 或 `-cc-XX-`（XX 为 ISO 3166-1 两字母国家码）。
 * 匹配不到时 countryCode 返回空字符串。
 * @param {string} username
 * @returns {{ countryCode: string, countryName: string }}
 */
function resolveCountryMetaFromUsername(username = '') {
  const normalizedUsername = String(username || '').trim();
  const match = normalizedUsername.match(/(?:^|-)cc-([A-Za-z]{2})(?:-|$)/i);
  const countryCode = String(match?.[1] || '').trim().toUpperCase();
  return {
    countryCode,
    countryName: countryCode ? String(COUNTRY_NAME_BY_CODE[countryCode] || countryCode).trim() : '',
  };
}

/**
 * 解析单行代理字符串，输出代理对象。
 *
 * 支持格式：`host:port:username:password`
 * 密码中如包含 `:`，取最后一层分割结果作为密码。
 * 解析失败时返回 `{ ok: false, error }`，不抛异常。
 *
 * @param {string} line - 原始代理行字符串
 * @param {number} [index=0] - 在文件中的行号（从 0 计）
 * @returns {{ ok: boolean, index: number, proxy?: object, error?: string }}
 */
function parseProxyLine(line, index = 0) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 4) {
    return {
      ok: false,
      index,
      raw,
      error: 'PROXY_LINE_FORMAT_INVALID',
    };
  }

  const host = String(parts[0] || '').trim();
  const port = Number(parts[1]);
  const username = String(parts[2] || '').trim();
  const password = String(parts.slice(3).join(':') || '').trim();

  if (!host || !Number.isFinite(port) || !username || !password) {
    return {
      ok: false,
      index,
      raw,
      error: 'PROXY_LINE_FIELDS_INVALID',
    };
  }

  const countryMeta = resolveCountryMetaFromUsername(username);

  return {
    ok: true,
    index,
    proxy: {
      id: `local-proxy-${index + 1}`,
      provider: 'local-proxies.txt',
      protocol: 'http',
      // server 字段供 Playwright chromium.launch({ proxy: { server } }) 使用。
      // 格式：protocol://host:port（不含用户名密码，认证由 username/password 字段独立传入）。
      // 修复：v0.0.2 runner.js:L243 等效逻辑，补齐 shared-browser-runtime/create-browser-runtime.js:L66
      //       的 if(proxy?.server) 守卫条件所需字段，否则 launchOptions.proxy 不会被设置。
      server: `http://${host}:${port}`,
      host,
      port,
      username,
      password,
      raw,
      countryCode: countryMeta.countryCode,
      countryName: countryMeta.countryName,
      countryLabel: countryMeta.countryName || countryMeta.countryCode,
      proxyCountryCode: countryMeta.countryCode,
      proxyCountryName: countryMeta.countryName,
    },
  };
}

/**
 * 读取 proxies.txt 文件，返回有效行数组（已去注释 / 去空行 / 去 BOM）。
 * @param {{ filePath?: string }} [options={}]
 * @returns {string[]}
 */
function loadLocalProxyLines(options = {}) {
  const filePath = String(options.filePath || LOCAL_PROXY_LIST_PATH);
  const raw = fs.readFileSync(filePath, 'utf8');
  return String(raw || '')
    .replace(/^\uFEFF/, '')          // 去 BOM
    .split(/\r?\n/)
    .map(line => String(line || '').trim())
    .filter(line => line && !line.startsWith('#')); // 过滤注释行和空行
}

/**
 * 加载并解析代理列表。
 * 过滤调格式错误的行，只返回 ok=true 的代理对象。
 * @param {{ filePath?: string }} [options={}]
 * @returns {Array<object>} 代理对象数组
 */
function loadLocalProxies(options = {}) {
  const lines = loadLocalProxyLines(options);
  const parsed = lines.map((line, index) => parseProxyLine(line, index));
  return parsed.filter(item => item && item.ok).map(item => item.proxy);
}

/**
 * 生成代理摘要对象（屏蔽密码，去除敏感字段）。
 * 用于日志输出 / Worker 状态面板展示，不含密码明文。
 * @param {object} [proxy={}]
 * @returns {object}
 */
function summarizeProxy(proxy = {}) {
  return {
    id: String(proxy.id || '').trim(),
    provider: String(proxy.provider || '').trim(),
    protocol: String(proxy.protocol || 'http').trim(),
    host: String(proxy.host || '').trim(),
    port: Number(proxy.port),
    username: String(proxy.username || '').trim(),
    passwordMasked: maskProxyPassword(proxy.password),
    countryCode: String(proxy.countryCode || proxy.proxyCountryCode || '').trim(),
    countryName: String(proxy.countryName || proxy.proxyCountryName || '').trim(),
  };
}

module.exports = {
  LOCAL_PROXY_LIST_PATH,
  maskProxyPassword,
  parseProxyLine,
  loadLocalProxyLines,
  loadLocalProxies,
  summarizeProxy,
  resolveCountryMetaFromUsername,
};
