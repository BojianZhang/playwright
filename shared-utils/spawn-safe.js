'use strict';
// ⟦共享规范实现 · 改这里;各项目 web/spawn-safe.js 是 re-export shim,勿改⟧ 边界/准入/清单见 shared-utils/README.md

// ═══════════════════════════════════════════════════════════════════════
// 统一 spawn 封装(一劳永逸防「Windows 弹黑色控制台窗」 · 规范实现 · 历史出处 Openrouter/0.0.1/web/spawn-safe.js)
//
// 背景:Windows 上 child_process.spawn 一个控制台程序(python.exe 等)若不设 windowsHide,
//   系统就给它开一个【可见的黑色控制台窗】。本项目反复在不同 spawn 点踩这个坑(每加一处新
//   spawn 就可能忘设)。根治办法 = 所有起子进程都走这里,默认 windowsHide:true;需要可见窗的
//   特例(如 Node 自重启共用用户终端)显式传 { windowsHide: false } 表明意图。
//
// 配套:test 里有 spawn-guard 扫描——任何【裸】child_process.spawn/spawnSync/execFile* 调用若
//   没带 windowsHide 就让测试失败,逼新代码要么走 safeSpawn、要么显式声明 windowsHide。
//
// 注:windowsHide 仅影响【是否给子进程开新控制台窗】;stdio(管道/继承)、子进程自己开的浏览器
//   窗口(AdsPower/Selenium)都不受影响,照常工作。非 Windows 平台该参数无副作用。
// ═══════════════════════════════════════════════════════════════════════
const { spawn, spawnSync } = require('child_process');

function safeSpawn(command, args, options) {
  return spawn(command, args, { windowsHide: true, ...(options || {}) });
}

function safeSpawnSync(command, args, options) {
  return spawnSync(command, args, { windowsHide: true, ...(options || {}) });
}

module.exports = { safeSpawn, safeSpawnSync };
