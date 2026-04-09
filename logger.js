const COLORS = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function paint(color, text) {
  return `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

function logSystem(text) {
  console.log(paint('cyan', `【系统】${text}`));
}

function logAccount(text) {
  console.log(paint('blue', `【账号】${text}`));
}

function logProxy(text) {
  console.log(paint('yellow', `【代理】${text}`));
}

function logStage(text) {
  console.log(paint('magenta', `【阶段】${text}`));
}

function logSuccess(text) {
  console.log(paint('green', `【成功】${text}`));
}

function logFail(text) {
  console.log(paint('red', `【失败】${text}`));
}

function logWarn(text) {
  console.log(paint('yellow', `【警告】${text}`));
}

function logInfo(text) {
  console.log(paint('gray', `【信息】${text}`));
}

module.exports = {
  logSystem,
  logAccount,
  logProxy,
  logStage,
  logSuccess,
  logFail,
  logWarn,
  logInfo,
};
