'use strict';

const fs = require('fs');

/**
 * shared-utils/profile.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 从磁盘读取 JSON profile 文件，并通过外部 cacheRef 实现内存缓存。
 * ❌ 不负责 —— 理解 profile 内容的业务含义（不知道 selector / text / signal）。
 * ❌ 不负责 —— profile 的写入或热更新（只读）。
 * ❌ 不负责 —— 缓存对象的持有（cacheRef 由调用方的模块级变量持有）。
 *
 * 设计说明：
 * - 通过 cacheRef（形如 { value: null }）实现缓存，避免修改模块级变量。
 * - BOM（Byte Order Mark）字符自动去除，兼容 Windows 文本编辑器输出的 UTF-8 BOM 文件。
 * - 读取失败（文件不存在 / JSON 格式错误）时直接抛异常，属于配置错误不应静默。
 *
 * 典型用法（adapter 侧）：
 * ```js
 * const { loadJsonProfileWithCache } = require('../../shared-utils/profile');
 * const _profileCacheRef = { value: null };
 * const PROFILE_PATH = path.join(__dirname, 'profiles', 'my-profile.json');
 *
 * function loadMyProfile(options = {}) {
 *   return loadJsonProfileWithCache(PROFILE_PATH, _profileCacheRef, options);
 * }
 * ```
 */

/**
 * 从磁盘读取 JSON profile 文件，默认走内存缓存，支持强制刷新。
 *
 * 边界：
 * - cacheRef 是一个 { value: any } 形状的对象，由调用方在模块级持有，
 *   函数本身不创建也不销毁这个对象。
 * - options.forceReload = true 时强制重新读取磁盘并更新 cacheRef.value。
 * - 读取失败（fs / JSON 异常）直接向上抛出，不返回 null，必须由调用链处理。
 *
 * @param {string} filePath - JSON 文件的绝对路径
 * @param {{ value: any }} cacheRef - 调用方持有的缓存引用，形如 `{ value: null }`
 * @param {{ forceReload?: boolean }} [options={}]
 * @returns {any} 解析后的 profile 对象
 * @throws {Error} 当文件不存在或 JSON 解析失败时
 */
function loadJsonProfileWithCache(filePath, cacheRef, options = {}) {
  // 读取是否要求强制刷新缓存。
  const forceReload = Boolean(options?.forceReload);
  // 缓存命中时直接返回，避免多次 I/O。
  if (!forceReload && cacheRef.value) return cacheRef.value;
  // 从磁盘读取文件原始文本（编码 utf8）。
  const raw = fs.readFileSync(filePath, 'utf8');
  // 去除 BOM 头后解析 JSON，写入缓存引用。
  cacheRef.value = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  return cacheRef.value;
}

module.exports = {
  loadJsonProfileWithCache,
};
