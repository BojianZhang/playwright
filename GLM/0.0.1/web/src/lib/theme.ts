// 主题:三态 system / light / dark(仿 OpenClaw 的 monitor/sun/moon)。
// 偏好存 localStorage('or_theme');解析后的实际明暗写到 <html data-theme="light|dark">,
// app.css 用 :root[data-theme="dark"] 整组覆盖变量。system 跟随 prefers-color-scheme。
import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'or_theme';
const ORDER: ThemePref[] = ['system', 'light', 'dark'];

const mql = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function getPref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'; } catch { return 'system'; }
}
function resolve(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') return mql && mql.matches ? 'dark' : 'light';
  return pref;
}
export function resolvedTheme(): 'light' | 'dark' { return resolve(getPref()); }

function apply(): void {
  try { document.documentElement.dataset.theme = resolve(getPref()); } catch { /* ignore */ }
}

export function setPref(p: ThemePref): void {
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  apply();
  notify();
}
export function cyclePref(): ThemePref {
  const next = ORDER[(ORDER.indexOf(getPref()) + 1) % ORDER.length];
  setPref(next);
  return next;
}

type Listener = () => void;
const listeners = new Set<Listener>();
export function onThemeChange(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function notify(): void { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

// system 模式下跟随系统切换实时生效
if (mql) { try { mql.addEventListener('change', () => { if (getPref() === 'system') { apply(); notify(); } }); } catch { /* ignore */ } }

apply(); // 模块加载即套用,避免首屏闪白

// React 便捷 hook:返回当前偏好 + 循环切换函数。
export function useThemePref(): [ThemePref, () => void] {
  const [pref, setLocal] = useState<ThemePref>(getPref);
  useEffect(() => onThemeChange(() => setLocal(getPref())), []);
  return [pref, cyclePref];
}
