'use strict';

// 驱动 — playwright-python（Python 子进程）。connect_over_cdp(ws) 接管。需 `pip install playwright`(+ playwright install)。
// run(endpoint, taskFile?, input): taskFile 读 stdin {ws, ...input}，打印 OR_RESULT:{...}；
//   不传则用内置 py/pw_python_driver.py(默认任务：开 url、回标题)。
const path = require('path');
const { runPython } = require('../py-run');

module.exports = {
  name: 'playwright-python',
  kind: 'python',
  run: async (endpoint = {}, taskFile, input = {}, opts = {}) => {
    const ws = endpoint.ws || (endpoint.debugPort && `http://127.0.0.1:${endpoint.debugPort}`);
    if (!ws) return { error: 'playwright-python:NO_ENDPOINT' };
    const script = taskFile || path.join(__dirname, '..', 'py', 'pw_python_driver.py');
    return runPython(script, Object.assign({ ws }, input), opts.log);
  },
};
