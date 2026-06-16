// 元素选择器维护 — 前端类型 + 颜色。注册表本体由 /api/selectors 返回(后端 selectors-schema.js 唯一真相源)。
export interface SelectorStep {
  id: string;
  env: string;
  kind: 'css' | 'text';
  scope: 'selenium' | 'hybrid' | 'both';
  group: string;
  label: string;
  desc: string;
  builtin: string[];
}
export interface SelectorsResp { steps: SelectorStep[]; values: Record<string, string>; }

export const SEL_SCOPE_LABEL: Record<string, string> = { selenium: '纯Selenium', hybrid: '混合', both: '两套共用' };
export const SEL_SCOPE_COLOR: Record<string, string> = { selenium: '#2563eb', hybrid: '#7c3aed', both: '#0d9488' };
export const SEL_KIND_LABEL: Record<string, string> = { css: 'CSS 选择器', text: '文本匹配' };
