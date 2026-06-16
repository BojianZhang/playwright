// recovery-store seed/迁移回归(零依赖,node:test)。跑: cd web && node --test  或 npm test
// 守:① 老安装(只有 r_default)→ 幂等补齐 3 个新内置方案,绝不动 activeId / 已有 r_default.opts;
//     ② 跑两次迁移不产生重复;③ 空文件 → seed 全部内置,activeId=r_default(默认逐字节不变)。
// 用 OPENROUTER_RECOVERY_FILE 指向临时文件,绝不碰生产 data/recovery-strategies.json。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_PATH = require.resolve('./recovery-store');
// 用临时文件 + 清 require 缓存,模拟「全新进程读这个文件」(_db / FILE 都在模块加载时定)。
function freshStore(file) {
  process.env.OPENROUTER_RECOVERY_FILE = file;
  delete require.cache[STORE_PATH];
  return require('./recovery-store');
}
function tmpFile(tag) { return path.join(os.tmpdir(), `recovery-store-test-${process.pid}-${tag}.json`); }

test('空文件 → seed 全部内置方案,activeId=r_default', () => {
  const f = tmpFile('empty');
  try { fs.unlinkSync(f); } catch (_e) { /* ignore */ }
  const store = freshStore(f);
  const rec = store.getAll().recovery;
  assert.strictEqual(rec.activeId, 'r_default');
  const ids = rec.presets.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['r_default', 'r_swap_card', 'r_swap_env', 'r_swap_ip'].sort());
  // r_default 动作字段全空 = 默认等价
  const def = rec.presets.find((p) => p.id === 'r_default');
  assert.strictEqual(def.opts.ipRounds, '');
  assert.strictEqual(def.opts.zipRetry, '');
});

test('老安装(只有 r_default,无动作字段)→ 幂等补齐新内置,activeId 不变、r_default.opts 不变', () => {
  const f = tmpFile('legacy');
  // 模拟功能上线前的真实落盘:r_default 没有动作字段
  fs.writeFileSync(f, JSON.stringify({ version: 1, recovery: { activeId: 'r_default', presets: [
    { id: 'r_default', name: '默认(全部重试)', builtin: true, opts: { retryRegister: 'on', retryKey: 'on', retryCard: 'on', retryCharge: 'on' } },
  ] } }));
  const store = freshStore(f);
  const rec = store.getAll().recovery;
  assert.strictEqual(rec.activeId, 'r_default', 'activeId 必须保持 r_default(默认行为不变)');
  for (const id of ['r_swap_env', 'r_swap_card', 'r_swap_ip']) assert.ok(rec.presets.find((p) => p.id === id), `应补齐内置 ${id}`);
  const def = rec.presets.find((p) => p.id === 'r_default');
  assert.deepStrictEqual(def.opts, { retryRegister: 'on', retryKey: 'on', retryCard: 'on', retryCharge: 'on' }, '已存在的 r_default.opts 不被改写');
  // 换环境方案带正确动作
  const env = rec.presets.find((p) => p.id === 'r_swap_env');
  assert.strictEqual(env.opts.zipRetry, '3');
  assert.strictEqual(env.opts.ipRounds, '2');
});

test('迁移幂等:同文件再开一次进程不产生重复内置', () => {
  const f = tmpFile('idempotent');
  try { fs.unlinkSync(f); } catch (_e) { /* ignore */ }
  freshStore(f).getAll();                 // 第一次:seed
  const rec = freshStore(f).getAll().recovery;   // 第二次:读已迁移文件
  const counts = {};
  for (const p of rec.presets) counts[p.id] = (counts[p.id] || 0) + 1;
  for (const id of ['r_default', 'r_swap_env', 'r_swap_card', 'r_swap_ip']) assert.strictEqual(counts[id], 1, `${id} 只应有一份`);
});

test('activeOpts(激活内置换环境)= 默认 merge 动作覆盖', () => {
  const f = tmpFile('activeopts');
  try { fs.unlinkSync(f); } catch (_e) { /* ignore */ }
  const store = freshStore(f);
  store.setActive('r_swap_env');
  const opts = store.activeOpts();
  assert.strictEqual(opts.retryCharge, 'on');   // retry.* 继承默认
  assert.strictEqual(opts.zipRetry, '3');       // 动作覆盖
  assert.strictEqual(opts.ipRounds, '2');
});

test.after(() => { delete process.env.OPENROUTER_RECOVERY_FILE; });
