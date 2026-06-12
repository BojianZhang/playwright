'use strict';

// 驱动 — Selenium（Python 子进程）。经 debuggerAddress 接管 CDP 浏览器。需 python + `pip install selenium`。
// run(endpoint, taskFile?, input): taskFile 是你的 Python 任务脚本(读 stdin {debuggerAddress, ...input}，
//   打印 OR_RESULT:{...})；不传则用内置 py/selenium_driver.py(默认任务：开 url、回标题)。
const path = require('path');
const { runPython } = require('../py-run');

function portOf(s) { const m = String(s || '').match(/:(\d+)(?:\/|$)/); return m ? m[1] : undefined; }

module.exports = {
  name: 'selenium',
  kind: 'python',
  run: async (endpoint = {}, taskFile, input = {}, opts = {}) => {
    const port = endpoint.debugPort || portOf(endpoint.ws);
    if (!port) return { error: 'selenium:NO_DEBUG_PORT' };
    const script = taskFile || path.join(__dirname, '..', 'py', 'selenium_driver.py');
    return runPython(script, Object.assign({ debuggerAddress: `127.0.0.1:${port}` }, input), opts.log);
  },
};
