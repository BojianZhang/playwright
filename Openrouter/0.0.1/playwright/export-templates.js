'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / export-templates
//
// 文件定位：Openrouter/0.0.1/export-templates.js
//
// 边界说明（BOUNDARY）：
// ✅ 负责 —— 把交付 payload 按用户指定的 {{token}} 模板渲染成一行字符串。
// ✅ 负责 —— 实时回显（SSE）与落盘导出共用同一渲染逻辑，保证两处一致。
// ❌ 不负责 —— 决定 payload 里有哪些字段（由 S6 buildAccountDeliveryPayload 决定）。
//
// 安全：渲染时对敏感字段（卡号/cvc）默认脱敏，避免随回显/日志泄露。
// ═══════════════════════════════════════════════════════════════════════

// 永远不允许出现在模板输出里的敏感字段（即使模板显式引用也脱敏）。
const SENSITIVE_KEYS = new Set([
  'cardNumber',
  'card_number',
  'cvc',
  'cvv',
  'cardCvc',
]);

/**
 * 把对象拍平成 { 'a.b.c': value } 形式，便于模板用点号路径取值。
 * @param {object} obj
 * @param {string} [prefix='']
 * @param {object} [out={}]
 * @returns {object}
 */
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

/**
 * 对单个值做脱敏：敏感字段只保留末 4 位。
 * @param {string} key
 * @param {*} value
 * @returns {string}
 */
function maskIfSensitive(key, value) {
  const leaf = String(key).split('.').pop();
  if (SENSITIVE_KEYS.has(leaf)) {
    const str = String(value == null ? '' : value);
    if (str.length <= 4) return '****';
    return `****${str.slice(-4)}`;
  }
  return value == null ? '' : String(value);
}

/**
 * 渲染模板。支持 {{key}} 与 {{a.b.c}} 点号路径；未命中保持空串。
 *
 * @param {string} template
 * @param {object} payload
 * @returns {string}
 */
function render(template, payload = {}) {
  const tpl = typeof template === 'string' && template.trim()
    ? template
    : '{{email}} | {{apiKey}}';
  const flat = flatten(payload || {});
  return tpl.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_match, key) => {
    if (!(key in flat)) return '';
    return maskIfSensitive(key, flat[key]);
  });
}

/**
 * 列出模板里引用到的所有 token，便于前端提示可用字段。
 * @param {string} template
 * @returns {string[]}
 */
function extractTokens(template) {
  if (typeof template !== 'string') return [];
  const tokens = [];
  const re = /\{\{\s*([\w.$-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) tokens.push(m[1]);
  return Array.from(new Set(tokens));
}

module.exports = {
  render,
  extractTokens,
  SENSITIVE_KEYS,
};
