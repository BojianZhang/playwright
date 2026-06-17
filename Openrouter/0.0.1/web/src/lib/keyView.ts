import type { KeyOverride } from './types';

// API Key 取值(「获取新Key」覆盖账本优先,否则用结果行原值)——结果页列、复制按钮、自定义导出、缺Key 判定共用同一口径。
//   覆盖来自 key-changes-store(登录已有号后新建的 Key);原行的账单/卡末4/充值信息完全不动。
export function keyView(a: { apiKey?: string }, ov?: KeyOverride): string {
  return (ov?.apiKey ?? '') || (a.apiKey || '');
}
