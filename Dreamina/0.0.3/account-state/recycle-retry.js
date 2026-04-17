'use strict';
/**
 * recycle-retry.js
 *
 * 职责：将 retry-accounts.json 中的软失败账号回注到 local-accounts.json。
 *
 * 执行方式：
 *   node Dreamina/0.0.3/account-state/recycle-retry.js
 *
 * 逻辑：
 *   1. 读取 retry-accounts.json（软失败账号列表）
 *   2. 读取 local-accounts.json（当前待注册池）
 *   3. 去重后追加到 local-accounts.json
 *   4. 清空 retry-accounts.json（重置为 []）
 *   5. 输出操作摘要
 *
 * 触发条件（建议）：
 *   - 每次 batch-runner 启动前手动执行一次
 *   - 或在下一批账号未准备好时，先 recycle 上一批软失败账号再跑
 *
 * 不会处理：
 *   - blacklisted-accounts.json（硬失败，不回注）
 *   - registered-accounts.json（已完成，不回注）
 */

const fs = require('fs');
const path = require('path');

const ACCOUNT_STATE_DIR = path.join(__dirname);
const LOCAL_FILE = path.join(ACCOUNT_STATE_DIR, 'local-accounts.json');
const RETRY_FILE = path.join(ACCOUNT_STATE_DIR, 'retry-accounts.json');

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
}

function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

async function recycleRetry() {
  const retryAccounts = readJsonArray(RETRY_FILE);
  if (!retryAccounts.length) {
    console.log('[recycle-retry] retry-accounts.json 为空，无需回注。');
    return;
  }

  const localAccounts = readJsonArray(LOCAL_FILE);
  const existingEmails = new Set(localAccounts.map(function(a) { return normalizeEmail(a.email); }));

  let injected = 0;
  let skipped = 0;
  const injectedList = [];

  retryAccounts.forEach(function(entry) {
    const email = normalizeEmail(entry.email);
    if (!email || !entry.password) { skipped++; return; }
    if (existingEmails.has(email)) { skipped++; return; }
    // 只保留 email + password 放回池，其余失败元数据不带入
    localAccounts.push({ email: entry.email || email, password: entry.password });
    existingEmails.add(email);
    injected++;
    injectedList.push(email);
  });

  if (injected > 0) {
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(localAccounts, null, 2) + '\n', 'utf8');
    fs.writeFileSync(RETRY_FILE, '[]\n', 'utf8');
    console.log('[recycle-retry] 回注完成');
    console.log('  新增到 local-accounts:', injected, '条');
    console.log('  跳过（已存在或无效）:', skipped, '条');
    console.log('  retry-accounts 已清空');
    console.log('  回注账号:');
    injectedList.forEach(function(e) { console.log('    -', e); });
  } else {
    console.log('[recycle-retry] 所有 retry 账号均已存在于 local-accounts，无需回注。skipped:', skipped);
  }
}

recycleRetry().catch(function(err) {
  console.error('[recycle-retry] 执行失败:', err.message);
  process.exit(1);
});
