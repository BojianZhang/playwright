'use strict';

/**
 * shared-utils/birthday.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 生日相关的纯数学计算和数据格式转换。
 * ❌ 不负责 —— 任何 page / locator 操作（不填写、不点击、不读取 DOM）。
 * ❌ 不负责 —— 具体站点的交互逻辑（不知道 Dreamina / TikTok 的 birthday 控件）。
 * ❌ 不负责 —— 密码学强随机数（使用 Math.random()，仅用于生成合法生日）。
 * ❌ 不负责 —— 多语言本地化（月份名称基于英语，January ~ December）。
 *
 * 使用场景：
 * - profile-completion adapter 的生日计划生成层
 * - 其他站点 adapter 如需生成随机成人生日，可直接复用本模块
 */

/**
 * 规范化生日年份范围，确保 min/max 有效且不倒置。
 *
 * 边界：
 * - 只做范围归正（min/max 互换 / 非数字兜底），不做随机采样。
 * - 默认范围 1980~2008，可通过 options 覆盖。
 * - 输出的 minYear / maxYear 均为整数。
 *
 * @param {{ birthdayMinYear?: number, birthdayMaxYear?: number }} [options={}]
 * @returns {{ minYear: number, maxYear: number }}
 */
function normalizeBirthdayYearRange(options = {}) {
  // 读取 min/max year 配置，出错时使用默认值。
  let minYear = Number(options?.birthdayMinYear || 1980);
  let maxYear = Number(options?.birthdayMaxYear || 2008);
  // 非数字（NaN / Infinity）兜底为默认值。
  if (!Number.isFinite(minYear)) minYear = 1980;
  if (!Number.isFinite(maxYear)) maxYear = 2008;
  // 取整，避免小数年份。
  minYear = Math.floor(minYear);
  maxYear = Math.floor(maxYear);
  // 若 min > max 则互换，防止调用方传入倒置范围。
  if (minYear > maxYear) {
    const temp = minYear;
    minYear = maxYear;
    maxYear = temp;
  }
  return { minYear, maxYear };
}

/**
 * 把月份输入（数字 / 英文全称 / 英文缩写）转换为所有候选格式变体。
 *
 * 边界：
 * - 输入支持："1" / "01" / "January" / "Jan"（大小写不敏感）。
 * - 输出 candidates 含去重的所有有效变体：带前导零数字、不带前导零数字、英文全称、英文缩写。
 * - 基于英语月份名，不支持多语言扩展。
 * - 无法解析时 monthIndex 返回 null，candidates 只含原始输入（不为空）。
 * - 此函数被 profile-completion adapter 的 birthday plan 生成层调用。
 *
 * @param {string|number} monthInput
 * @returns {{
 *   raw: string,
 *   numeric: string,
 *   numericNoPad: string,
 *   shortName: string,
 *   fullName: string,
 *   monthIndex: number|null,
 *   candidates: string[]
 * }}
 */
function buildMonthVariants(monthInput) {
  const raw = String(monthInput || '').trim();
  // 空输入时返回空结构，避免后续空字符串引发错误。
  if (!raw) {
    return {
      raw: '',
      numeric: '',
      numericNoPad: '',
      shortName: '',
      fullName: '',
      monthIndex: null,
      candidates: [],
    };
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthShortNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  let monthIndex = null;

  // 1. 优先尝试数字解析（支持 "1" / "01" / "12"）。
  const numericMatch = raw.match(/^0?(\d{1,2})$/);
  if (numericMatch) {
    const parsed = Number(numericMatch[1]);
    if (parsed >= 1 && parsed <= 12) monthIndex = parsed;
  }

  // 2. 数字解析失败时，尝试英文全称匹配（忽略大小写）。
  if (monthIndex == null) {
    const byFull = monthNames.findIndex(name => name.toLowerCase() === raw.toLowerCase());
    if (byFull >= 0) monthIndex = byFull + 1;
  }

  // 3. 全称匹配失败时，尝试英文缩写匹配（忽略大小写）。
  if (monthIndex == null) {
    const byShort = monthShortNames.findIndex(name => name.toLowerCase() === raw.toLowerCase());
    if (byShort >= 0) monthIndex = byShort + 1;
  }

  // 根据 monthIndex 派生各格式变体。
  const numeric = monthIndex != null ? String(monthIndex).padStart(2, '0') : raw;
  const numericNoPad = monthIndex != null ? String(monthIndex) : raw.replace(/^0+/, '') || raw;
  const fullName = monthIndex != null ? monthNames[monthIndex - 1] : '';
  const shortName = monthIndex != null ? monthShortNames[monthIndex - 1] : '';

  // 合并所有有效变体，去重，过滤空字符串。
  const candidates = [
    ...new Set(
      [raw, numeric, numericNoPad, fullName, shortName]
        .map(item => String(item || '').trim())
        .filter(Boolean)
    ),
  ];

  return {
    raw,
    numeric,
    numericNoPad,
    shortName,
    fullName,
    monthIndex,
    candidates,
  };
}

/**
 * 在安全天数范围（1~28）内随机生成 birthday day 字符串。
 *
 * 边界：
 * - 取值范围强制夹取在 1~28 内，规避二月末日 / 大小月边界问题。
 * - 默认范围 1~28，可通过 options.birthdayMinDay / birthdayMaxDay 缩窄范围。
 * - 入参超出 1~28 范围时，强制夹取，不报错。
 * - 出参为字符串（与 DOM fill / type 场景兼容）。
 *
 * @param {{ birthdayMinDay?: number, birthdayMaxDay?: number }} [options={}]
 * @returns {string} 1~28 之间的随机天数字符串（不含前导零）
 */
function buildSafeBirthdayDay(options = {}) {
  // 读取 min/max day，出错时使用默认值。
  let minDay = Number(options?.birthdayMinDay || 1);
  let maxDay = Number(options?.birthdayMaxDay || 28);
  // 非数字（NaN）兜底。
  if (!Number.isFinite(minDay)) minDay = 1;
  if (!Number.isFinite(maxDay)) maxDay = 28;
  // 取整，避免小数。
  minDay = Math.floor(minDay);
  maxDay = Math.floor(maxDay);
  // 强制夹取在 1~28 的安全范围内，超出部分直接截断。
  minDay = Math.max(1, Math.min(28, minDay));
  maxDay = Math.max(1, Math.min(28, maxDay));
  // 若 min > max 则互换。
  if (minDay > maxDay) {
    const temp = minDay;
    minDay = maxDay;
    maxDay = temp;
  }
  // 在安全区间内随机取一个 day，以字符串形式返回（不含前导零）。
  return String(minDay + Math.floor(Math.random() * Math.max(1, maxDay - minDay + 1)));
}

module.exports = {
  normalizeBirthdayYearRange,
  buildMonthVariants,
  buildSafeBirthdayDay,
};
