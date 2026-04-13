'use strict';

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

const STAGE_META = {
  'proxy-precheck': { index: 0, short: 'S0', label: 'proxy-precheck', color: 'gray' },
  'entry': { index: 1, short: 'S1', label: 'entry', color: 'blue' },
  'credential-submit': { index: 2, short: 'S2', label: 'credential-submit', color: 'cyan' },
  'verification-submit': { index: 3, short: 'S3', label: 'verification-submit', color: 'yellow' },
  'profile-completion-submit': { index: 4, short: 'S4', label: 'profile-completion-submit', color: 'magenta' },
  'post-auth-ready': { index: 5, short: 'S5', label: 'post-auth-ready', color: 'green' },
  'account-delivery': { index: 6, short: 'S6', label: 'account-delivery', color: 'brightWhite' },
};

const STATE_ICON = {
  start: '▶',
  progress: '…',
  success: '✔',
  fail: '✖',
  retry: '↻',
  info: '•',
};

function normalizeStageKey(stageKey = '') {
  return String(stageKey || '').trim();
}

function getStageMeta(stageKey = '') {
  const key = normalizeStageKey(stageKey);
  if (STAGE_META[key]) return STAGE_META[key];
  return { index: -1, short: 'S?', label: key || 'unknown-stage', color: 'white' };
}

function colorize(text, colorName = 'white', options = {}) {
  const colorCode = ANSI[colorName] || '';
  const boldCode = options.bold ? ANSI.bold : '';
  const dimCode = options.dim ? ANSI.dim : '';
  return `${boldCode}${dimCode}${colorCode}${text}${ANSI.reset}`;
}

function buildStageTag(stageKey = '', options = {}) {
  const meta = getStageMeta(stageKey);
  const tag = `[${meta.short} ${meta.label}]`;
  return options.color === false ? tag : colorize(tag, meta.color, { bold: true });
}

function compactValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => `${k}=${String(v).trim()}`)
      .join(' ');
  }
  return String(value).trim();
}

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
  return options.color === false ? ` | ${suffix}` : colorize(` | ${suffix}`, 'gray', { dim: true });
}

function buildMessage({ stage, status = 'info', message = '', extra = '', context = {}, color = true }) {
  const icon = STATE_ICON[status] || STATE_ICON.info;
  const stageTag = buildStageTag(stage, { color });
  const main = compactValue(message);
  const extraText = compactValue(extra);
  const contextSuffix = buildContextSuffix(context, { color });
  const pieces = [icon, stageTag, main];
  if (extraText) {
    pieces.push(color ? colorize(`| ${extraText}`, 'gray', { dim: true }) : `| ${extraText}`);
  }
  return `${pieces.filter(Boolean).join(' ')}${contextSuffix}`;
}

function toPlainMessage(input = '') {
  return String(input || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function emit(logger, line) {
  if (typeof logger === 'function') {
    logger(line);
    return;
  }
  console.log(line);
}

function logStageStart(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'start', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

function logStageProgress(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'progress', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

function logStageSuccess(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'success', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

function logStageFail(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'fail', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

function logStageRetry(stage, message, options = {}) {
  const line = buildMessage({ stage, status: 'retry', message, extra: options.extra, context: options.context, color: options.color !== false });
  emit(options.logger, line);
  return line;
}

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

function buildStageLogContext(options = {}, extra = {}) {
  return {
    account: String(options?.account?.email || options?.context?.account?.email || '').trim(),
    workerId: options?.context?.workerId ?? options?.runtime?.workerId ?? null,
    attempt: options?.context?.attempt ?? options?.runtime?.attempt ?? null,
    retry: extra.retry ?? null,
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
  summarizeStageResult,
  buildStageLogContext,
  logStageStart,
  logStageProgress,
  logStageSuccess,
  logStageFail,
  logStageRetry,
};
