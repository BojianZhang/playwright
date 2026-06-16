'use strict';

// ═══════════════════════════════════════════════════════════════════════
// web 引擎驱动 —— Node-only（区别于 OpenRouter 的 Python 子进程版）
//
// 文件定位：Dreamina/0.0.4/web/engine-runner.js
//
// Dreamina 引擎是纯 Node，故这里【不 spawn Python】。runJob 直接以子进程方式拉起
// playwright/Dreamina-batch-runner.js，把其 stdout/stderr 按行转成 SSE 事件
// （event-bus.publish），退出时发 job-done。
//
// 之所以走子进程而非进程内调用：批量跑会开真实浏览器、长时间运行，隔离进程更稳，
// 且与「一键命令行」行为完全一致（同一入口、同一参数）。
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const readline = require('readline');
const { safeSpawn } = require('./spawn-safe');
const eventBus = require('./event-bus');

const BATCH_RUNNER = path.join(__dirname, '..', 'playwright', 'Dreamina-batch-runner.js');

// 已知阶段标签（用于从日志行里粗略识别进度阶段；纯展示，不影响执行）。
const STAGE_TOKENS = [
  'proxy-precheck', 'entry', 'credential-submit', 'verification-submit',
  'profile-completion-submit', 'post-auth-ready', 'upgrade', 'payment', 'account-delivery',
];

function detectStage(line) {
  const low = String(line).toLowerCase();
  for (const s of STAGE_TOKENS) { if (low.includes(s)) return s; }
  return null;
}

// 把一行日志转成事件类型（粗分：success / failed / stage / log）。
function classifyLine(line) {
  const low = String(line).toLowerCase();
  if (/✔|success|delivery_complete|payment_success|registered/.test(low)) return 'account-success';
  if (/✖|fail|error|declined|rejected|exception/.test(low)) return 'account-failed';
  const stage = detectStage(line);
  if (stage) return 'worker-update';
  return 'log';
}

function runJob(jobId, args = [], opts = {}) {
  eventBus.publish(jobId, 'job-start', { jobId, args, at: new Date().toISOString() });

  const child = safeSpawn('node', [BATCH_RUNNER, ...args], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
  });

  const pipe = (stream, streamName) => {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (raw) => {
      const line = String(raw);
      if (!line.trim()) return;
      const type = classifyLine(line);
      const stage = detectStage(line);
      eventBus.publish(jobId, type, { line, stream: streamName, stage, at: new Date().toISOString() });
    });
  };
  pipe(child.stdout, 'stdout');
  pipe(child.stderr, 'stderr');

  child.on('error', (err) => {
    eventBus.publish(jobId, 'job-error', { jobId, error: String((err && err.message) || err) });
  });
  child.on('close', (code) => {
    eventBus.publish(jobId, 'job-done', { jobId, code, ok: code === 0, at: new Date().toISOString() });
  });

  return { jobId, pid: child.pid, child };
}

module.exports = { runJob, BATCH_RUNNER, STAGE_TOKENS };
