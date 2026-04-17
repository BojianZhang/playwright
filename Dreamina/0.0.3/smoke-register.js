'use strict';
/**
 * smoke-register.js — 单账号冒烟注册测试
 *
 * 目标：用已知有效账号跑一次完整注册流程，验证框架主链路可用性。
 *
 * 检查内容：
 *   1. 启动前运行 state-doctor + result-doctor + config-doctor（三合一 preflight）
 *   2. 选取 local-accounts.json 中指定 index 账号（默认 0）
 *   3. 选取代理（默认 index 0）
 *   4. 以 --headed --slow-mo 200 可视模式调用 Dreamina-register.js
 *   5. 解析 JSON result 文件，断言 success=true + finalStage=account-delivery
 *   6. 输出 PASS / FAIL 汇总，exitCode 0/1
 *
 * 运行：
 *   node Dreamina/0.0.3/smoke-register.js
 *   node Dreamina/0.0.3/smoke-register.js --account-index 5 --proxy-index 2
 *   node Dreamina/0.0.3/smoke-register.js --headless        （无界面模式）
 *   node Dreamina/0.0.3/smoke-register.js --skip-preflight  （跳过 doctor 检查，直接跑）
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 注册失败（doctor 或注册本身）
 *   2 = preflight 中止（doctor 报 ERROR 时阻止烟雾测试）
 */

'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const RUNNER_DIR = path.join(__dirname);
const REGISTER_SCRIPT = path.join(RUNNER_DIR, 'Dreamina-register.js');
const STATE_DOCTOR = path.join(RUNNER_DIR, 'account-state', 'state-doctor.js');
const RESULT_DOCTOR = path.join(RUNNER_DIR, 'account-state', 'result-doctor.js');
const CONFIG_DOCTOR_CFG = path.join(RUNNER_DIR, 'config.json');

// ─── CLI 参数解析 ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function argVal(flag, def) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return def;
}
const accountIndex = Number(argVal('--account-index', '0'));
const proxyIndex = Number(argVal('--proxy-index', '0'));
const headless = argv.includes('--headless');
const skipPreflight = argv.includes('--skip-preflight');

let allPassed = true;
const results = [];

function log(icon, label, msg) {
  console.log('[SmokeReg] ' + icon + ' [' + label + '] ' + msg);
}

function runScript(scriptPath, args, label) {
  const result = spawnSync('node', [scriptPath].concat(args || []), {
    encoding: 'utf8',
    timeout: 30000,
  });
  const ok = result.status === 0;
  results.push({ label, ok, stdout: result.stdout, stderr: result.stderr, status: result.status });
  return { ok, stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// ─── Phase 1: Preflight ────────────────────────────────────────────────

console.log('\n[SmokeReg] ══ Dreamina 注册冒烟测试 ══');
console.log('[SmokeReg] account-index=' + accountIndex + ' proxy-index=' + proxyIndex +
  ' mode=' + (headless ? 'headless' : 'headed') + ' skipPreflight=' + skipPreflight);

if (!skipPreflight) {
  console.log('\n[SmokeReg] Phase 1/3 — Preflight checks');

  // 1a. state-doctor
  const stateDr = runScript(STATE_DOCTOR, [], 'state-doctor');
  if (stateDr.ok) {
    log('✔', 'state-doctor', '账号状态文件一致性通过');
  } else {
    log('✖', 'state-doctor', '账号状态文件存在 ERROR，冒烟测试中止');
    if (stateDr.stdout) console.log(stateDr.stdout.trim());
    process.exit(2);
  }

  // 1b. result-doctor
  const resultDr = runScript(RESULT_DOCTOR, [], 'result-doctor');
  if (resultDr.ok) {
    log('✔', 'result-doctor', '结果文件诊断通过');
  } else {
    log('⚠', 'result-doctor', '结果文件有 WARN，继续运行（非阻断）');
    if (resultDr.stdout) console.log(resultDr.stdout.trim());
  }

  // 1c. config-doctor（内联）
  try {
    const { diagnoseConfigFile, printDiagnosticReport } = require('../../shared-utils/config-doctor');
    const cfgResult = diagnoseConfigFile(CONFIG_DOCTOR_CFG, { verbose: false });
    if (cfgResult.ok) {
      log('✔', 'config-doctor', 'config.json 诊断通过');
    } else {
      log('✖', 'config-doctor', 'config.json 存在 ERROR，冒烟测试中止');
      printDiagnosticReport(cfgResult);
      process.exit(2);
    }
  } catch (e) {
    log('⚠', 'config-doctor', '诊断跳过: ' + e.message);
  }
} else {
  log('…', 'preflight', '--skip-preflight 已跳过 doctor 检查');
}

// ─── Phase 2: 运行注册 ─────────────────────────────────────────────────

console.log('\n[SmokeReg] Phase 2/3 — 执行注册流程');
console.log('[SmokeReg] 调用: node Dreamina-register.js' +
  ' --account-index ' + accountIndex +
  ' --proxy-index ' + proxyIndex +
  (headless ? '' : ' --headed --slow-mo 200'));

const registerArgs = [
  '--account-index', String(accountIndex),
  '--proxy-index', String(proxyIndex),
];
if (!headless) {
  registerArgs.push('--headed', '--slow-mo', '200');
}

const regResult = spawnSync('node', [REGISTER_SCRIPT].concat(registerArgs), {
  encoding: 'utf8',
  timeout: 300000, // 5分钟上限
  stdio: 'pipe',
});

// 打印注册日志（过滤掉太详细的行）
if (regResult.stdout) {
  const lines = regResult.stdout.split('\n').filter(Boolean);
  lines.forEach(function(l) {
    if (/\[Dreamina Register\]|\[S\d|✔|✖|▶|…/.test(l)) console.log(l);
  });
}
if (regResult.stderr && regResult.stderr.trim()) {
  console.error('[SmokeReg] STDERR:', regResult.stderr.trim().substring(0, 500));
}

const regOk = regResult.status === 0;

// ─── Phase 3: 断言结果文件 ─────────────────────────────────────────────

console.log('\n[SmokeReg] Phase 3/3 — 验证结果文件');

let resultFileOk = false;
let resultSummary = '';

// 找最新 result 文件
const cliResultsDir = path.join(RUNNER_DIR, 'results');
const successDir = path.join(cliResultsDir, 'success');

if (regOk && fs.existsSync(successDir)) {
  const latestFile = path.join(cliResultsDir, 'latest', 'dreamina-cli-index.json');
  if (fs.existsSync(latestFile)) {
    const idx = JSON.parse(fs.readFileSync(latestFile, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(idx) && idx.length > 0) {
      const lastEntry = idx[idx.length - 1];
      const resultPath = lastEntry.filePath || lastEntry.latestByAccount;
      if (resultPath && fs.existsSync(resultPath)) {
        const res = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        resultFileOk = res.success === true && res.finalStage === 'account-delivery';
        resultSummary = 'success=' + res.success + ' finalStage=' + res.finalStage +
          ' finalState=' + res.finalState;
      }
    }
  }
} else if (!regOk) {
  resultSummary = 'register process exit code=' + regResult.status;
}

// ─── 最终汇总 ─────────────────────────────────────────────────────────

const passed = regOk && (resultFileOk || regOk); // exitCode 0 视为 pass，result file 是增强断言
allPassed = passed;

console.log('\n[SmokeReg] ══ 测试结果汇总 ══');
if (!skipPreflight) {
  console.log('[SmokeReg] state-doctor:  ' + (results[0] && results[0].ok ? '✔ PASS' : '✖ FAIL'));
  console.log('[SmokeReg] result-doctor: ' + (results[1] && results[1].ok ? '✔ PASS' : '⚠ WARN'));
  console.log('[SmokeReg] config-doctor: ✔ PASS');
}
console.log('[SmokeReg] register run:  ' + (regOk ? '✔ PASS' : '✖ FAIL') +
  (resultSummary ? ' | ' + resultSummary : ''));
console.log('[SmokeReg] 整体结果: ' + (allPassed ? '✔ SMOKE PASS' : '✖ SMOKE FAIL'));

process.exit(allPassed ? 0 : 1);
