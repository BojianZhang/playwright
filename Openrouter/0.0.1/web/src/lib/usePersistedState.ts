import { useState, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// 把【非凭证】的配置项持久化到 localStorage —— 刷新/重开页面后保留(控制台输入框不再清零)。
// ★只用于非敏感配置(模式/并发/阶段/资源池勾选等);绝不用于粘贴的账号、统一密码等凭证(那些保持 useState,刷新即清)。
// 复刻 ResultsExportModal 的 try/catch + JSON 写法;localStorage 不可用(隐私模式/配额满)时静默回退,不影响功能。
export function usePersistedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* 配额满/隐私模式 → 忽略,内存态仍正常 */
    }
  }, [key, val]);
  return [val, setVal];
}
