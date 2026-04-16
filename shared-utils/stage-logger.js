'use strict';

/**
 * shared-utils/stage-logger.js
 *
 * 边界说明（BOUNDARY）：
 * ✅ 负责 —— 所有 Stage 的结构化日志格式化与输出（颜色 / 图标 / 阶段标签 / 上下文后缀）。
 * ✅ 负责 —— Stage 计时器创建（createStageTimer）与耗时格式化（formatDurationMs）。
 * ✅ 负责 —— Stage 结果对象规范化（summarizeStageResult）。
 * ✅ 负责 —— 日志上下文对象构造（buildStageLogContext）。
 * ❌ 不负责 —— 任何页面交互、阶段状态决策、Worker 状态写入。
 * ❌ 不负责 —— 日志持久化（只调用 logger 回调或 console.log，不写文件）。
 * ❌ 不负责 —— 抛出异常（所有操作只读，不会失败）。
 *
 * 使用场景：
 * - 所有 Stage 文件（entry / credential / verification / profile-completion / post-auth-ready /
 *   account-delivery / proxy-precheck）的 ▶ … ✔ ✖ 日志输出
 * - Dreamina-register.js 的主链日志
 */

// ANSI 颜色转义码表，用于终端彩色输出。
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  green: '\x1b[32m',
  white: '\x1b[37m',
  brightWhite: '\x1b[97m',
  red: '\x1b[31m',
};

/**
 * 所有阶段的固定元信息表。
 *
 * 边界：
 * - key 与 Dreamina 注册主链的 stageKey 严格对齐，新增阶段时同步补充此表。
 * - index 决定阶段顺序（不影响运行逻辑，仅用于日志排序/展示）。
 * - color 与 ANSI 表中的 key 对应。
 */
const STAGE_META = {
  'proxy-precheck':             { index: 0, short: 'S0', label: 'proxy-precheck',             color: 'gray' },
  'entry':                      { index: 1, short: 'S1', label: 'entry',                      color: 'blue' },
  'credential-submit':          { index: 2, short: 'S2', label: 'credential-submit',          color: 'cyan' },
  'verification-submit':        { index: 3, short: 'S3', label: 'verification-submit',        color: 'yellow' },
  'profile-completion-submit':  { index: 4, short: 'S4', label: 'profile-completion-submit',  color: 'magenta' },
  'post-auth-ready':            { index: 5, short: 'S5', label: 'post-auth-ready',            color: 'green' },
  'account-delivery':           { index: 6, short: 'S6', label: 'account-delivery',           color: 'brightWhite' },
};

/**
 * 日志状态图标表。
 *
 * 边界：
 * - status key 与 logStageXxx 系列函数严格对应，调用方不直接使用此表。
 */
const STATE_ICON = {
  start:    '▶',
  progress: '…',
  success:  '✔',
  fail:     '✖',
  retry:    '↻',
  info:     '•',
};

/**
 * 规范化 stageKey，去除首尾空白。
 *
 * @param {string} [stageKey='']
 * @returns {string}
 */
function normalizeStageKey(stageKey = '') {
  return String(stageKey || '').trim();
}

/**
 * 根据 stageKey 获取阶段元信息。
 *
 * 边界：
 * - 未知 stageKey 时返回 fallback（index=-1 / short='S?' / label=输入值）。
 * - 不抛异常，始终返回可用结构。
 *
 * @param {string} [stageKey='']
 * @returns {{ index: number, short: string, label: string, color: string }}
 */
function getStageMeta(stageKey = '') {
  const key = normalizeStageKey(stageKey);
  // 优先从表中精确匹配，命中则直接返回。
  if (STAGE_META[key]) return STAGE_META[key];
  // 未知阶段时返回降级结构，保证日志格式不崩溃。
  return { index: -1, short: 'S?', label: key || 'unknown-stage', color: 'white' };
}

/**
 * 对文本应用 ANSI 颜色 / 加粗 / 暗淡修饰。
 *
 * 边界：
 * - 只做字符串拼接，不做任何 I/O。
 * - colorName 不在 ANSI 表中时 colorCode 为空字符串（无颜色，不报错）。
 *
 * @param {string} text
 * @param {string} [colorName='white']
 * @param {{ bold?: boolean, dim?: boolean }} [options={}]
 * @returns {string}
 */
function colorize(text, colorName = 'white', options = {}) {
  const colorCode = ANSI[colorName] || '';
  const boldCode = options.bold ? ANSI.bold : '';
  const dimCode = options.dim ? ANSI.dim : '';
  return `${boldCode}${dimCode}${colorCode}${text}${ANSI.reset}`;
}

/**
 * 构造带颜色的阶段标签，格式为 "[S1 entry]"。
 *
 * 边界：
 * - options.color === false 时返回纯文本（用于写入文件 / 无颜色环境）。
 * - 始终返回字符串，不抛异常。
 *
 * @param {string} [stageKey='']
 * @param {{ color?: boolean }} [options={}]
 * @returns {string}
 */
function buildStageTag(stageKey = '', options = {}) {
  const meta = getStageMeta(stageKey);
  const tag = `[${meta.short} ${meta.label}]`;
  // color 选项为 false 时跳过 colorize，返回纯文本（无 ANSI 码）。
  return options.color === false ? tag : colorize(tag, meta.color, { bold: true });
}

/**
 * 把任意值转换为可嵌入日志行的紧凑字符串。
 *
 * 边界：
 * - null / undefined → 空字符串
 * - 对象 → key=value 的空格分隔串（过滤空值）
 * - 数组 → 递归处理后空格拼接
 * - 其他 → String() 转换后 trim
 *
 * @param {any} value
 * @returns {string}
 */
function compactValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    // 对象序列化为 key=value 串，过滤掉空值字段。
    return Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => `${k}=${String(v).trim()}`)
      .join(' ');
  }
  return String(value).trim();
}

/**
 * 构造日志行的上下文后缀，格式为 " | account=xxx | worker=1 | attempt=1 | ..."。
 *
 * 边界：
 * - 只读取 context 对象中已有字段，不做任何 DOM / 状态修改。
 * - context 字段缺失时对应部分不拼入后缀，不报错。
 * - color === false 时不包裹 ANSI 码。
 *
 * @param {{ account?: string, workerId?: any, attempt?: any, retry?: any, proxy?: string }} [context={}]
 * @param {{ color?: boolean }} [options={}]
 * @returns {string}
 */
function buildContextSuffix(context = {}, options = {}) {
  if (!context || typeof context !== 'object') return '';
  const parts = [];
  if (context.account) parts.push(`account=${context.account}`);
  if (context.workerId !== undefined && context.workerId !== null && String(context.workerId) !== '') parts.push(`worker=${context.workerId}`);
  if (context.attempt !== undefined && context.attempt !== null && String(context.attempt) !== '') parts.push(`attempt=${context.attempt}`);
  if (context.retry !== undefined && context.retry !== null && String(context.retry) !== '') parts.push(`retry=${context.retry}`);
  if (context.proxy) parts.push(`proxy=${context.proxy}`);
  const suffix = parts.join(' | ');
  if (!suffix) return '';
  // color 选项为 false 时返回纯文本后缀。
  return options.color === false ? ` | ${suffix}` : colorize(` | ${suffix}`, 'gray', { dim: true });
}

/**
 * 构造完整日志行字符串。
 *
 * 格式：`{icon} {stageTag} {message} [| {extra}] [| account=... worker=... ...]`
 *
 * 边界：
 * - 所有字段均可选，缺失时对应部分不输出。
 * - 只做字符串拼接，不做任何 I/O 或状态修改。
 *
 * @param {{ stage: string, status?: string, message?: string, extra?: string, context?: object, color?: boolean }} param
 * @returns {string}
 */
function buildMessage({ stage, status = 'info', message = '', extra = '', context = {}, color = true }) {
  const icon = STATE_ICON[status] || STATE_ICON.info;
  const stageTag = buildStageTag(stage, { color });
  const main = compactValue(message);
  const extraText = compactValue(extra);
  const contextSuffix = buildContextSuffix(context, { color });
  const pieces = [icon, stageTag, main];
  // extra 不为空时以暗淡灰色追加到主消息后面。
  if (extraText) {
    pieces.push(color ? colorize(`| ${extraText}`, 'gray', { dim: true }) : `| ${extraText}`);
  }
  return `${pieces.filter(Boolean).join(' ')}${contextSuffix}`;
}

/**
 * 返回当前时间戳（毫秒）。
 *
 * 边界：只读，不修改任何状态。
 *
 * @returns {number}
 */
function nowMs() {
  return Date.now();
}

/**
 * 创建一个阶段计时器，记录创建时刻并提供 elapsedMs() 方法。
 *
 * 边界：
 * - 不依赖外部状态，每次调用独立计时。
 * - elapsedMs() 始终返回非负整数。
 *
 * @returns {{ startedAt: number, elapsedMs: () => number }}
 */
function createStageTimer() {
  const startedAt = nowMs();
  return {
    startedAt,
    // 返回从创建时刻到当前的毫秒数（最小为 0）。
    elapsedMs() {
      return Math.max(0, nowMs() - startedAt);
    },
  };
}

/**
 * 把毫秒数格式化为可读字符串（如 "1234ms"）。
 *
 * 边界：
 * - 非有效数字时返回空字符串。
 * - 始终返回非负整数的毫秒表示。
 *
 * @param {number} durationMs
 * @returns {string}
 */
function formatDurationMs(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value)) return '';
  return `${Math.max(0, Math.round(value))}ms`;
}

/**
 * 去除字符串中的 ANSI 转义码，还原为纯文本。
 *
 * 边界：只做字符串替换，不做 I/O。用于将带颜色的日志行写入文件时去色。
 *
 * @param {string} [input='']
 * @returns {string}
 */
function toPlainMessage(input = '') {
  return String(input || '').replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 通过 logger 回调或 console.log 输出一行日志。
 *
 * 边界：
 * - logger 是函数时委托给调用方的 logger（如 Dreamina-register 的主链日志）。
 * - logger 不是函数时 fallback 到 console.log。
 *
 * @param {Function|null} logger
 * @param {string} line
 */
function emit(logger, line) {
  if (typeof logger === 'function') {
    logger(line);
    return;
  }
  console.log(line);
}

/**
 * 输出阶段开始日志（▶ 图标）。
 *
 * @param {string} stage
 * @param {string} message
 * @param {{ extra?: string, context?: object, color?: boolean, logger?: Function }} [options={}]
 * @returns {string} 已输出的日志行
 */
function logStageStart(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'start', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

/**
 * 输出阶段进行中日志（… 图标）。
 *
 * @param {string} stage
 * @param {string} message
 * @param {{ extra?: string, context?: object, color?: boolean, logger?: Function }} [options={}]
 * @returns {string}
 */
function logStageProgress(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'progress', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

/**
 * 输出阶段成功日志（✔ 图标）。
 *
 * @param {string} stage
 * @param {string} message
 * @param {{ extra?: string, context?: object, color?: boolean, logger?: Function }} [options={}]
 * @returns {string}
 */
function logStageSuccess(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'success', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

/**
 * 输出阶段失败日志（✖ 图标）。
 *
 * @param {string} stage
 * @param {string} message
 * @param {{ extra?: string, context?: object, color?: boolean, logger?: Function }} [options={}]
 * @returns {string}
 */
function logStageFail(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'fail', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

/**
 * 输出阶段重试日志（↻ 图标）。
 *
 * @param {string} stage
 * @param {string} message
 * @param {{ extra?: string, context?: object, color?: boolean, logger?: Function }} [options={}]
 * @returns {string}
 */
function logStageRetry(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'retry', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

/**
 * 规范化 Stage 执行结果对象，过滤掉 undefined / 非法值。
 *
 * 边界：
 * - 只做字段提取和类型归正，不做任何 I/O。
 * - 所有字段均有 fallback，不会返回含 undefined 的结构。
 *
 * @param {object} [result={}]
 * @returns {{ success: boolean, stage: string, state: string, reason: string, nextStage: string, signalStrength: string, settleStage: string, detectionSource: string, retryCount: number }}
 */
function summarizeStageResult(result = {}) {
  return {
    success: Boolean(result?.success),
    stage: String(result?.stage || '').trim(),
    state: String(result?.state || '').trim(),
    reason: String(result?.reason || '').trim(),
    nextStage: String(result?.nextStage || '').trim(),
    signalStrength: String(result?.signalStrength || '').trim(),
    settleStage: String(result?.settleStage || '').trim(),
    detectionSource: String(result?.detectionSource || '').trim(),
    retryCount: Number.isFinite(Number(result?.retryCount)) ? Number(result.retryCount) : 0,
  };
}

/**
 * 从 options 中提取标准化的日志上下文对象。
 *
 * 边界：
 * - 只读取 options 中已有字段，不写入任何状态。
 * - proxy 字段支持多种来源，按优先级依次尝试提取。
 * - 所有字段均有 fallback（空字符串 / null），结构固定。
 *
 * @param {object} [options={}]
 * @param {{ retry?: number }} [extra={}]
 * @returns {{ account: string, workerId: any, attempt: any, retry: any, proxy: string }}
 */
function buildStageLogContext(options = {}, extra = {}) {
  return {
    // 账号邮箱从 options.account.email 或 options.context.account.email 中取。
    account: String(options?.account?.email || options?.context?.account?.email || '').trim(),
    // workerId 优先从 context 取，降级到 runtime。
    workerId: options?.context?.workerId ?? options?.runtime?.workerId ?? null,
    // attempt 优先从 context 取，降级到 runtime。
    attempt: options?.context?.attempt ?? options?.runtime?.attempt ?? null,
    // retry 由调用方通过 extra 传入（每一轮重试中动态变化）。
    retry: extra.retry ?? null,
    // proxy.server 按多种来源优先级提取，全部缺失时返回空字符串。
    proxy: String(
      options?.proxy?.server
      || options?.context?.proxy?.server
      || options?.context?.proxySummary?.server
      || options?.context?.proxyPrecheckResult?.detail?.proxySummary?.server
      || ''
    ).trim(),
  };
}

module.exports = {
  STAGE_META,
  getStageMeta,
  buildStageTag,
  buildMessage,
  toPlainMessage,
  nowMs,
  createStageTimer,
  formatDurationMs,
  summarizeStageResult,
  buildStageLogContext,
  logStageStart,
  logStageProgress,
  logStageSuccess,
  logStageFail,
  logStageRetry,
};
