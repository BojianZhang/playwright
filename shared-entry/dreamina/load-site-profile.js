'use strict';

/**
 * load-site-profile.js
 *
 * 这个文件只负责一件事：
 * 从 shared-entry/profiles 目录里安全读取站点 profile。
 *
 * 它的职责非常明确：
 * 1. 拼 profile 文件路径
 * 2. 读取 JSON 文件
 * 3. 处理 UTF-8 BOM
 * 4. 解析 JSON
 * 5. 做最基础的结构校验
 * 6. 返回 profile 对象
 *
 * 它不负责：
 * - 打开浏览器
 * - 打开页面
 * - 做 ready 判断
 * - 做业务流程
 */

const fs = require('fs');
const path = require('path');

/**
 * profiles 目录绝对路径。
 *
 * 作用：
 * - 保证后续读取 profile 时，不依赖调用方当前 cwd。
 * - 始终以当前文件所在目录为基准定位 profiles 目录。
 */
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

/**
 * 移除 UTF-8 BOM。
 *
 * 作用：
 * - 某些编辑器/写文件方式会在 JSON 头部写入 BOM。
 * - 直接 JSON.parse 时会报错。
 * - 所以这里统一先去 BOM，再 parse。
 */
function stripBom(text = '') {
  return String(text || '').replace(/^\uFEFF/, '');
}

/**
 * 把站点名规范成文件名友好的 slug。
 *
 * 例如：
 * - Dreamina -> dreamina
 * - OpenAI -> openai
 * - Claude AI -> claude-ai
 *
 * 作用：
 * - 允许调用方传入站点名，而不是手写完整文件路径。
 */
function normalizeSiteNameToSlug(siteName = '') {
  return String(siteName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 根据站点名推导 profile 文件路径。
 *
 * 规则：
 * - siteName = Dreamina
 * - 文件名 => dreamina-entry-profile.json
 *
 * 作用：
 * - 让上层调用简单，只传站点名即可。
 */
function resolveSiteProfilePath(siteName = '') {
  const slug = normalizeSiteNameToSlug(siteName);
  if (!slug) {
    throw new Error('SITE_PROFILE_NAME_EMPTY');
  }
  return path.join(PROFILES_DIR, `${slug}-entry-profile.json`);
}

/**
 * 对 profile 做最基础的结构校验。
 *
 * 这里只做最小校验，不做复杂 schema 校验。
 * 作用：
 * - 尽早发现 profile 缺失核心字段的问题
 * - 给上层返回更明确的错误
 */
function validateSiteProfile(profile = {}, filePath = '') {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error(`SITE_PROFILE_INVALID_OBJECT|path=${filePath}`);
  }

  if (!String(profile.name || '').trim()) {
    throw new Error(`SITE_PROFILE_MISSING_NAME|path=${filePath}`);
  }

  if (!String(profile.homeUrl || '').trim()) {
    throw new Error(`SITE_PROFILE_MISSING_HOME_URL|path=${filePath}`);
  }

  if (!profile.entry || typeof profile.entry !== 'object' || Array.isArray(profile.entry)) {
    throw new Error(`SITE_PROFILE_MISSING_ENTRY|path=${filePath}`);
  }

  return profile;
}

/**
 * 从完整文件路径读取 profile。
 *
 * 作用：
 * - 读取文件
 * - 去 BOM
 * - parse JSON
 * - 做基础校验
 *
 * 使用场景：
 * - 已经知道完整路径时调用
 */
function loadSiteProfileFromPath(filePath) {
  const resolvedPath = path.resolve(String(filePath || ''));

  if (!resolvedPath) {
    throw new Error('SITE_PROFILE_PATH_EMPTY');
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`SITE_PROFILE_NOT_FOUND|path=${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const clean = stripBom(raw);

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (error) {
    throw new Error(`SITE_PROFILE_JSON_PARSE_FAILED|path=${resolvedPath}|message=${error.message}`);
  }

  return validateSiteProfile(parsed, resolvedPath);
}

/**
 * 按站点名读取 profile。
 *
 * 使用方式：
 * - loadSiteProfile('Dreamina')
 * - loadSiteProfile('OpenAI')
 * - loadSiteProfile('Claude AI')
 *
 * 内部流程：
 * 1. 站点名转 slug
 * 2. 推导 profile 路径
 * 3. 调用 loadSiteProfileFromPath
 */
function loadSiteProfile(siteName = '') {
  const filePath = resolveSiteProfilePath(siteName);
  return loadSiteProfileFromPath(filePath);
}

module.exports = {
  PROFILES_DIR,
  stripBom,
  normalizeSiteNameToSlug,
  resolveSiteProfilePath,
  validateSiteProfile,
  loadSiteProfileFromPath,
  loadSiteProfile,
};
