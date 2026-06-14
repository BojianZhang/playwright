'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 孤儿驱动清理 — Openrouter / web / proc-cleanup
//
// 文件定位:Openrouter/0.0.1/web/proc-cleanup.js
//
// 背景:Windows 下子进程不随父死(REL-5)。每次 server 被强杀/重启,在跑的 Selenium/Fix C
// 启的 chromedriver / chromedriver_stealth 会成孤儿,一轮轮累积(实测堆到 60+)。本机正常
// Ctrl+C 退出由 server.js 的 gracefulShutdown 走 proc-registry 清子进程树兜底;但强杀触发不到,
// 故提供这个【一键清理】:杀本机所有 chromedriver(_stealth) —— 它们只是自动化驱动,不是用户的
// Chrome、不是 AdsPower 客户端,清掉安全。
//
// ★安全护栏:本机【有任务在跑】(proc-registry 非空)时默认拒绝清理(那些驱动可能在用),
// 需 force=true 才强清。零依赖、CommonJS。
// ═══════════════════════════════════════════════════════════════════════

const { execFileSync, execSync } = require('child_process');
const procRegistry = require('./proc-registry');

const WIN = process.platform === 'win32';
// 只清这两类自动化驱动;绝不碰 chrome.exe(用户浏览器 / AdsPower 指纹浏览器)。
const IMAGES = WIN ? ['chromedriver.exe', 'chromedriver_stealth.exe'] : ['chromedriver', 'chromedriver_stealth'];

// 统计某进程名当前实例数(跨平台,失败回 0,绝不抛)。
function countProc(image) {
  try {
    if (WIN) {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
      return (out.match(new RegExp(image.replace('.', '\\.'), 'gi')) || []).length;   // 每行一个实例;无匹配时输出"信息:…"不含镜像名
    }
    // -xc 精确进程名计数(对齐下面 `pkill -9 -x` 的精确名杀):-fc 会按整条命令行子串匹配,
    // 'chromedriver' 会把每个 'chromedriver_stealth' 也算进去 → 与 stealth 项重复计数,清理弹窗数字虚高。
    const out = execSync(`pgrep -xc ${image.replace(/[^\w.-]/g, '')} 2>/dev/null || true`, { encoding: 'utf8' });
    return Number(String(out).trim()) || 0;
  } catch (_e) { return 0; }
}

// 一键清理:杀本机所有 chromedriver(_stealth)。opts.force=true 时忽略"有任务在跑"护栏。
// 返回 { ok, refused?, activeJobs, before, killed, total }。
function killOrphanDrivers(opts = {}) {
  const active = (() => { try { return procRegistry.list(); } catch (_e) { return []; } })();
  if (active.length && !opts.force) {
    return { ok: false, refused: true, activeJobs: active.length,
      reason: `本机有 ${active.length} 个任务在跑,清理可能杀掉在用的驱动 → 已拒绝。确认无误请用 force。` };
  }
  const before = {};
  for (const img of IMAGES) before[img] = countProc(img);
  for (const img of IMAGES) {
    try {
      if (WIN) execFileSync('taskkill', ['/IM', img, '/F'], { stdio: 'ignore', windowsHide: true });
      else execSync(`pkill -9 -x ${img.replace(/[^\w.-]/g, '')} 2>/dev/null || true`);
    } catch (_e) { /* 没有该进程时 taskkill 非零退出 → 忽略 */ }
  }
  const killed = {}; let total = 0;
  for (const img of IMAGES) { const after = countProc(img); killed[img] = Math.max(0, (before[img] || 0) - after); total += killed[img]; }
  return { ok: true, activeJobs: active.length, before, killed, total };
}

module.exports = { killOrphanDrivers, countProc, IMAGES };
