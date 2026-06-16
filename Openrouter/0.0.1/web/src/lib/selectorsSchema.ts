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

// scope 标签/颜色与高级参数共用 → 单一来源 lib/labels(re-export 保持 SEL_SCOPE_* 导入名不变)。
export { SCOPE_LABEL as SEL_SCOPE_LABEL, SCOPE_COLOR as SEL_SCOPE_COLOR } from './labels';
export const SEL_KIND_LABEL: Record<string, string> = { css: 'CSS 选择器', text: '文本匹配' };
