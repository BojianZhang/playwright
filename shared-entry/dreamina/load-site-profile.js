'use strict';

/**
 * load-site-profile.js
 *
 * 杩欎釜鏂囦欢鍙礋璐ｄ竴浠朵簨锛? * 浠?shared-entry/profiles 鐩綍閲屽畨鍏ㄨ鍙栫珯鐐?profile銆? *
 * 瀹冪殑鑱岃矗闈炲父鏄庣‘锛? * 1. 鎷?profile 鏂囦欢璺緞
 * 2. 璇诲彇 JSON 鏂囦欢
 * 3. 澶勭悊 UTF-8 BOM
 * 4. 瑙ｆ瀽 JSON
 * 5. 鍋氭渶鍩虹鐨勭粨鏋勬牎楠? * 6. 杩斿洖 profile 瀵硅薄
 *
 * 瀹冧笉璐熻矗锛? * - 鎵撳紑娴忚鍣? * - 鎵撳紑椤甸潰
 * - 鍋?ready 鍒ゆ柇
 * - 鍋氫笟鍔℃祦绋? */

const fs = require('fs');
const path = require('path');

/**
 * profiles 鐩綍缁濆璺緞銆? *
 * 浣滅敤锛? * - 淇濊瘉鍚庣画璇诲彇 profile 鏃讹紝涓嶄緷璧栬皟鐢ㄦ柟褰撳墠 cwd銆? * - 濮嬬粓浠ュ綋鍓嶆枃浠舵墍鍦ㄧ洰褰曚负鍩哄噯瀹氫綅 profiles 鐩綍銆? */
const PROFILES_DIR = path.join(__dirname, 'profiles');

/**
 * 绉婚櫎 UTF-8 BOM銆? *
 * 浣滅敤锛? * - 鏌愪簺缂栬緫鍣?鍐欐枃浠舵柟寮忎細鍦?JSON 澶撮儴鍐欏叆 BOM銆? * - 鐩存帴 JSON.parse 鏃朵細鎶ラ敊銆? * - 鎵€浠ヨ繖閲岀粺涓€鍏堝幓 BOM锛屽啀 parse銆? */
function stripBom(text = '') {
  return String(text || '').replace(/^\uFEFF/, '');
}

/**
 * 鎶婄珯鐐瑰悕瑙勮寖鎴愭枃浠跺悕鍙嬪ソ鐨?slug銆? *
 * 渚嬪锛? * - Dreamina -> dreamina
 * - OpenAI -> openai
 * - Claude AI -> claude-ai
 *
 * 浣滅敤锛? * - 鍏佽璋冪敤鏂逛紶鍏ョ珯鐐瑰悕锛岃€屼笉鏄墜鍐欏畬鏁存枃浠惰矾寰勩€? */
function normalizeSiteNameToSlug(siteName = '') {
  return String(siteName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 鏍规嵁绔欑偣鍚嶆帹瀵?profile 鏂囦欢璺緞銆? *
 * 瑙勫垯锛? * - siteName = Dreamina
 * - 鏂囦欢鍚?=> dreamina-entry-profile.json
 *
 * 浣滅敤锛? * - 璁╀笂灞傝皟鐢ㄧ畝鍗曪紝鍙紶绔欑偣鍚嶅嵆鍙€? */
function resolveSiteProfilePath(siteName = '') {
  const slug = normalizeSiteNameToSlug(siteName);
  if (!slug) {
    throw new Error('SITE_PROFILE_NAME_EMPTY');
  }
  return path.join(PROFILES_DIR, `${slug}-entry-profile.json`);
}

/**
 * 瀵?profile 鍋氭渶鍩虹鐨勭粨鏋勬牎楠屻€? *
 * 杩欓噷鍙仛鏈€灏忔牎楠岋紝涓嶅仛澶嶆潅 schema 鏍￠獙銆? * 浣滅敤锛? * - 灏芥棭鍙戠幇 profile 缂哄け鏍稿績瀛楁鐨勯棶棰? * - 缁欎笂灞傝繑鍥炴洿鏄庣‘鐨勯敊璇? */
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
 * 浠庡畬鏁存枃浠惰矾寰勮鍙?profile銆? *
 * 浣滅敤锛? * - 璇诲彇鏂囦欢
 * - 鍘?BOM
 * - parse JSON
 * - 鍋氬熀纭€鏍￠獙
 *
 * 浣跨敤鍦烘櫙锛? * - 宸茬粡鐭ラ亾瀹屾暣璺緞鏃惰皟鐢? */
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
 * 鎸夌珯鐐瑰悕璇诲彇 profile銆? *
 * 浣跨敤鏂瑰紡锛? * - loadSiteProfile('Dreamina')
 * - loadSiteProfile('OpenAI')
 * - loadSiteProfile('Claude AI')
 *
 * 鍐呴儴娴佺▼锛? * 1. 绔欑偣鍚嶈浆 slug
 * 2. 鎺ㄥ profile 璺緞
 * 3. 璋冪敤 loadSiteProfileFromPath
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

