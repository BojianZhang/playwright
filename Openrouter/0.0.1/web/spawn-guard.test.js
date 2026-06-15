// ★一劳永逸守卫:扫描所有 Node 源码,任何【裸】child_process spawn/spawnSync/execFile*/execSync 调用
//   若没带 windowsHide,就让测试失败 —— 逼新代码要么走 safeSpawn(默认 windowsHide),要么显式声明
//   windowsHide(true 隐藏 / false 表明"故意要可见窗")。根治「Windows 点执行弹 python.exe 黑窗」这类反复踩的坑。
// 跑: cd web && node --test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 扫描范围:起子进程的 Node 顶层源码目录。safeSpawn 调用(大写 S)天然不匹配下面的小写关键字,自动豁免。
const ROOT = path.join(__dirname, '..');
const DIRS = ['web', 'billing', 'playwright'];
// 豁免:封装器本身(里面就是那唯一允许的裸 spawn)、测试文件、构建产物。
const EXEMPT = new Set(['spawn-safe.js']);

function listJs(dir) {
  const abs = path.join(ROOT, dir);
  let out = [];
  let names = [];
  try { names = fs.readdirSync(abs); } catch (_e) { return out; }
  for (const n of names) {
    if (!n.endsWith('.js')) continue;
    if (n.endsWith('.test.js')) continue;          // 测试文件本身不算
    if (EXEMPT.has(n)) continue;
    out.push(path.join(abs, n));
  }
  return out;
}

// 把注释整段抹成空白(保留换行,行号不变)→ 避免注释里写的 "spawn(taskkill)" 之类被误判。
function stripComments(src) {
  let out = '', i = 0, str = null, line = false, block = false;
  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (line) { if (ch === '\n') { line = false; out += ch; } else out += ' '; i += 1; continue; }
    if (block) { if (ch === '*' && nx === '/') { block = false; out += '  '; i += 2; } else { out += (ch === '\n' ? '\n' : ' '); i += 1; } continue; }
    if (str) { out += ch; if (ch === str && src[i - 1] !== '\\') str = null; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; out += ch; i += 1; continue; }
    if (ch === '/' && nx === '/') { line = true; out += '  '; i += 2; continue; }
    if (ch === '/' && nx === '*') { block = true; out += '  '; i += 2; continue; }
    out += ch; i += 1;
  }
  return out;
}

// 从 '(' 处做括号配平(跳过字符串字面量),返回整段调用文本 → 用于检查是否含 windowsHide。
function callText(src, openIdx) {
  let depth = 0, str = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (str) { if (ch === str && prev !== '\\') str = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx, openIdx + 800);   // 配平失败兜底:取一段
}

// 裸 child_process 调用关键字(小写);(?<![.\w]) 排除 re.exec(正则) 与 safeSpawn(大写 S)。
const RE = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/g;

test('spawn-guard: 所有裸 child_process spawn 调用都必须带 windowsHide(防 Windows 弹黑窗)', () => {
  const violations = [];
  for (const dir of DIRS) {
    for (const file of listJs(dir)) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));   // 抹注释,免注释里的 spawn(...) 误判
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(src)) !== null) {
        const openIdx = m.index + m[0].length - 1;        // 指向关键字后的 '('
        const text = callText(src, openIdx);
        if (!/windowsHide/.test(text)) {
          const line = src.slice(0, m.index).split('\n').length;
          violations.push(`${path.relative(ROOT, file)}:${line} → ${m[1]}(... 缺 windowsHide`);
        }
      }
    }
  }
  assert.deepStrictEqual(violations, [],
    '发现未带 windowsHide 的裸 spawn 调用(会在 Windows 弹黑色控制台窗)。请改用 require("./spawn-safe").safeSpawn,' +
    '或在选项里显式写 windowsHide(true 隐藏 / false 表明故意要可见窗):\n  ' + violations.join('\n  '));
});

// 同时锁住封装器契约:safeSpawn 默认确实把 windowsHide 设成 true(且可被覆盖)。
test('spawn-safe: safeSpawn 默认 windowsHide=true 且可显式覆盖', () => {
  const captured = [];
  const Module = require('module');
  const realLoad = Module._load;
  // 拦截 child_process,捕获 safeSpawn 透传下去的 options(不真起进程)。
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return { spawn: (_c, _a, o) => { captured.push(['spawn', o]); return { _stub: true }; },
               spawnSync: (_c, _a, o) => { captured.push(['spawnSync', o]); return { _stub: true }; } };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  let safe;
  try {
    delete require.cache[require.resolve('./spawn-safe')];
    safe = require('./spawn-safe');
    safe.safeSpawn('x', []);                                   // 不传 options
    safe.safeSpawn('x', [], { cwd: '/tmp' });                  // 传别的 options
    safe.safeSpawn('x', [], { windowsHide: false });           // 显式覆盖
  } finally {
    Module._load = realLoad;
    delete require.cache[require.resolve('./spawn-safe')];     // 还原,免污染其它测试
  }
  assert.strictEqual(captured[0][1].windowsHide, true, '默认 windowsHide=true');
  assert.strictEqual(captured[1][1].windowsHide, true, '带其它 options 时仍默认 true');
  assert.strictEqual(captured[2][1].windowsHide, false, '显式 windowsHide:false 可覆盖');
});
