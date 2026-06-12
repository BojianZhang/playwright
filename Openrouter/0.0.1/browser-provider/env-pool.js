'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 平台层 — Openrouter / browser-provider / env-pool（指纹浏览器环境池·并发安全分配 + 风控轮换）
//
// 文件定位：Openrouter/0.0.1/browser-provider/env-pool.js
//
// 为什么有它：
//   每个账号原本静态绑定 envIds[i % len] 一个环境。当某环境被目标站点风控(burned env，
//   billing 阶段表现为反复 5xx/网关错)，再在同一环境上重试只会继续被拒、白烧卡。
//   本模块把环境当成一个【可租借的共享池】：
//     · 同一环境同一时刻只被一个 worker 占用(基于 createProxyLockSet 的同步原子锁，无 async 竞态)；
//     · 账号失败(retry-new-env)时换一个【未试且未烧】的干净环境重试；
//     · 被风控的环境标记 burned，本次 run 内其它账号也一并规避。
//
// 边界(BOUNDARY)：
//   ✅ 负责 —— 环境占用/释放(acquire/release)、风控标记(markBurned)、是否还有干净环境(hasFresh)。
//   ❌ 不负责 —— 启动/关闭浏览器(那是 provider.start/stop)、判定什么算 burned(那是 stages/失败策略)。
//
// 关键不变量：
//   1. 永不把同一环境同时租给两个 worker(createProxyLockSet 同步 tryAcquire 保证)。
//   2. acquire 失败(池满)返回 null —— 调用方应退回 preferred(即今天的静态环境)，做到「绝不比今天差」。
//   3. 占用必须在 attempt 结束(无论成功/抛异常)时 release —— 调用方用 finally 保证，防止环境泄漏。
// ═══════════════════════════════════════════════════════════════════════

const { createProxyLockSet } = require('../../../shared-batch-orchestration/mutex');

/**
 * 创建一个环境池分配器。
 * @param {string[]} envIds 本次 run 的全部环境ID(可空 → 原生模式，size=0，全部为安全 no-op)
 */
function createEnvPool(envIds) {
  const all = Array.from(new Set((Array.isArray(envIds) ? envIds : []).filter(Boolean)));
  const allow = new Set(all);        // 成员表：只认池内环境(防御 preferred 传入非池内值返回幽灵环境)
  const lock = createProxyLockSet(); // 同一环境同一时刻只一个持有者(同步原子，无竞态窗口)
  const burned = new Set();          // 本次 run 已判定被风控的环境(全局规避)

  const toSet = (x) => (x instanceof Set ? x : new Set(x || []));

  return {
    /** 池内去重后的环境总数（0 = 原生模式/未配环境）。 */
    get size() { return all.length; },

    /** 当前被占用的环境数（监控/日志）。 */
    get inUseCount() { return lock.lockedCount; },

    /** 已被标记风控的环境数（监控/日志）。 */
    get burnedCount() { return burned.size; },

    /**
     * 占用一个环境用于本次 attempt。
     *   优先 preferred(今天的静态分配，保持环境↔账号映射稳定)；
     *   preferred 不可用 → 取任一【未占用·未烧·未在 exclude】的环境；
     *   全都不行 → 返回 null（调用方退回 preferred，绝不比今天差）。
     * 同步原子：tryAcquire 命中即标记占用。
     * @param {string|null} preferred 首选环境(通常 = 静态分配/上一轮选定)
     * @param {Set<string>|string[]} exclude 本账号已试过的环境(避免来回换同几个)
     * @returns {string|null} 占用成功的环境ID，或 null
     */
    acquire(preferred, exclude) {
      const ex = toSet(exclude);
      const usable = (e) => e && allow.has(e) && !burned.has(e) && !ex.has(e) && !lock.isLocked(e);
      if (usable(preferred) && lock.tryAcquire(preferred)) return preferred;
      for (const e of all) { if (usable(e) && lock.tryAcquire(e)) return e; }
      return null;
    },

    /** 释放占用（attempt 结束务必调用，含抛异常路径）。空值安全。 */
    release(envId) { if (envId) lock.release(envId); },

    /**
     * 标记某环境被目标站点风控（本次 run 内全局规避，所有账号都避开）。空值安全。
     * 安全底线：绝不烧掉【最后一个】未烧环境 —— 防止一次(可能是瞬时误判的)风控把整池烧光、后续账号全军覆没。
     * (单环境池天然永不烧；每账号轮换次数另由调用侧 envRotateMax 兜底。)
     */
    markBurned(envId) {
      if (!envId || !allow.has(envId) || burned.has(envId)) return;
      if (burned.size >= all.length - 1) return; // 再烧就 0 个干净环境了 → 拒绝，至少保留一个可用
      burned.add(envId);
    },

    /**
     * 是否【此刻可占用】一个干净环境：未烧 且 不在 exclude 且 当前未被别的 worker 占用。
     * 用于决定 retry-new-env 还要不要继续换：
     *   · 有 → 换(下一轮 acquire 能拿到)；
     *   · 没有(全烧了 / 仅剩的干净环境正被别人占着) → 别空转，直接落回今天的「账单失败」处理。
     * 注意特意带上「未被占用」：避免在 envs==workers 全忙时，反复在被烧环境上空跑(不比今天更差)。
     * @param {Set<string>|string[]} exclude 本账号已试过的环境
     */
    hasFresh(exclude) {
      const ex = toSet(exclude);
      return all.some((e) => !burned.has(e) && !ex.has(e) && !lock.isLocked(e));
    },
  };
}

module.exports = { createEnvPool };
