'use strict';

const fs = require('fs');
const path = require('path');

const LOCAL_PROXY_LIST_PATH = path.join(__dirname, 'local-proxies.txt');

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
};

function maskProxyPassword(password) {
  const value = String(password || '');
  if (!value) return '';
  if (value.length <= 2) return '*'.repeat(value.length);
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

function resolveCountryMetaFromUsername(username = '') {
  const normalizedUsername = String(username || '').trim();
  const match = normalizedUsername.match(/(?:^|-)cc-([A-Za-z]{2})(?:-|$)/i);
  const countryCode = String(match?.[1] || '').trim().toUpperCase();
  return {
    countryCode,
    countryName: countryCode ? String(COUNTRY_NAME_BY_CODE[countryCode] || countryCode).trim() : '',
  };
}

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

function loadLocalProxyLines(options = {}) {
  const filePath = String(options.filePath || LOCAL_PROXY_LIST_PATH);
  const raw = fs.readFileSync(filePath, 'utf8');
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map(line => String(line || '').trim())
    .filter(line => line && !line.startsWith('#'));
}

function loadLocalProxies(options = {}) {
  const lines = loadLocalProxyLines(options);
  const parsed = lines.map((line, index) => parseProxyLine(line, index));
  return parsed.filter(item => item && item.ok).map(item => item.proxy);
}

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
