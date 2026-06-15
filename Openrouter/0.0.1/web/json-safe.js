'use strict';

// ═══════════════════════════════════════════════════════════════════════
// 安全读 JSON — Openrouter / web / json-safe.js
//
// ★H4 修复:多数 store 旧写法 `try { JSON.parse(read) } catch { _x = [] / {} }` —— 文件【损坏】(断电/磁盘满/手改出错
//   导致 JSON.parse 抛错)时静默退空,【下一次 mutation 立即用空值原子覆盖,永久抹掉全部数据】。对持明文密钥的
//   store(captcha/mailbox/adspower-endpoint)与全部预设 store(schemes/strategies/engine-config/advanced/selectors/runs/setup)
//   尤其致命:用户一次例行「测全部余额/端点」就会触发 mutation → 密钥/预设无声蒸发。
//
// 统一行为(与 address-store / proxy-store 原有守卫一致):解析失败且文件【存在】时,先备份为 <file>.corrupt 再返回
//   fallback —— 既不卡死启动(仍以默认值起),又永不丢原始数据(坏文件留底可人工抢救)。文件【不存在】=正常首启,
//   直接返回 fallback、不备份。永不抛错,调用方拿到值后照旧做形状校验即可。
// ═══════════════════════════════════════════════════════════════════════

const fs = require('fs');

function readJsonOr(file, fallback, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fs.existsSync(file)) {
      // 文件存在却解析失败 = 损坏(非首启)→ 备份留底再退默认,杜绝下一次写入把坏文件原子覆盖成空。
      try {
        console.error(`[${label || 'json-safe'}] ${file} 解析失败,已备份为 .corrupt 并以默认值启动:`, e.message);
        fs.copyFileSync(file, file + '.corrupt');
      } catch (_e2) { /* 备份失败也不能卡死启动 */ }
    }
    return fallback;
  }
}

module.exports = { readJsonOr };
