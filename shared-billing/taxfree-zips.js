// ⟦共享规范实现 · 改这里;各项目 billing/taxfree-zips.js 是 re-export shim,勿改⟧ 边界/准入/清单见 shared-billing/README.md
// 免税州 ZIP(declined 自救:AVS 不匹配时换这些 ZIP 重试同一张卡,实测成功率高)。
// Node 侧单一来源,对齐 Selenium selenium-e2e/steps_billing.py:256-260。
// MT=Montana / OR=Oregon / NH=NewHampshire / DE=Delaware / AK=Alaska(均无销售税)。
'use strict';

const TAXFREE_ZIPS = ['59601', '97301', '03301', '19711', '99501', '59718', '97401', '19901'];

// 构造 ZIP 候选顺序:卡自带有效5位US邮编优先 → 免税州ZIP;去重。
// 返回数组首个 = 初填用,其后 = declined 后逐个重试(对齐 Selenium 的 alt_zips=_zlist[1:]).
function buildZipCandidates(cardZip) {
  const cz = String(cardZip || '').replace(/\D/g, '');
  const head = cz.length === 5 ? [cz] : [];
  const seen = new Set();
  const out = [];
  for (const z of [...head, ...TAXFREE_ZIPS]) {
    if (!seen.has(z)) { seen.add(z); out.push(z); }
  }
  return out;
}

module.exports = { TAXFREE_ZIPS, buildZipCandidates };
